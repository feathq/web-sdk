import type { Datafile } from "@feathq/datafile-schema";
import { evaluate } from "@feathq/feat-eval";
import type { EvalContext, EvaluationResult, FeatWebClientConfig } from "./types";

const CLIENT_SIDE_PREFIX = "feat_cs_";

// Browser polling client. Keeps the active datafile in memory, refreshes
// on a background interval, and pauses while the tab is hidden so we
// don't burn quota or MAU on backgrounded tabs.
//
// Designed to be paired with the sync eval cache in PR-6 and the
// OpenFeature web Provider in PR-11; the async `evaluate()` here is the
// low-level surface that those layers compose on top of.
export class FeatWebClient {
  private datafile: Datafile | null = null;
  private etag: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readyPromise: Promise<void> | null = null;
  private visibilityHandler: (() => void) | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly pollIntervalMs: number;
  private closed = false;

  constructor(private readonly config: FeatWebClientConfig) {
    if (!config.apiKey.startsWith(CLIENT_SIDE_PREFIX)) {
      throw new Error(
        `FeatWebClient requires a client_side_id key (prefix "${CLIENT_SIDE_PREFIX}"). ` +
          "Server and mobile keys must never ship in browser code.",
      );
    }
    this.fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis);
    this.pollIntervalMs = config.pollIntervalMs ?? 30_000;
  }

  // Resolves once the first datafile is in memory. Rejects only if the
  // very first fetch fails; subsequent polls run in the background and
  // failures keep the last-known-good datafile in place.
  async ready(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = this.bootstrap();
    }
    return this.readyPromise;
  }

  // One-shot fetch. Returns true if the in-memory datafile changed.
  async refresh(): Promise<boolean> {
    return this.fetchDatafile();
  }

  // Async eval. PR-6 will layer a sync cache on top; this stays available
  // as the low-level surface (and is what the OpenFeature provider will
  // use during initialize()).
  async evaluate<T = unknown>(
    flagKey: string,
    defaultValue: T,
    context: EvalContext,
  ): Promise<EvaluationResult<T>> {
    if (!this.datafile) {
      return {
        value: defaultValue,
        variationId: null,
        reason: "ERROR",
        errorMessage: "client not ready: call client.ready() before evaluate",
      };
    }
    const result = await evaluate(flagKey, defaultValue, context, this.datafile);
    return result as EvaluationResult<T>;
  }

  // Current snapshot for layers that read directly (the sync cache in
  // PR-6 calls this to know when to re-evaluate). Null until ready().
  currentDatafile(): Datafile | null {
    return this.datafile;
  }

  close(): void {
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.visibilityHandler && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
      this.visibilityHandler = null;
    }
  }

  private async bootstrap(): Promise<void> {
    await this.fetchDatafile();
    if (this.closed) return;
    this.startPolling();
    this.attachVisibilityHandler();
  }

  private startPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      void this.fetchDatafile().catch((err) => {
        console.warn("feat-web-sdk: background poll failed", err);
      });
    }, this.pollIntervalMs);
  }

  // Pause polling while the tab is hidden (saves the user's quota and
  // our MAU billing precision), and force an immediate refresh when the
  // tab comes back so the UI doesn't render stale values for up to a
  // full poll interval.
  private attachVisibilityHandler(): void {
    if (typeof document === "undefined") return;
    this.visibilityHandler = () => {
      if (document.hidden) {
        if (this.timer) {
          clearInterval(this.timer);
          this.timer = null;
        }
        return;
      }
      void this.fetchDatafile().catch((err) => {
        console.warn("feat-web-sdk: visibility refresh failed", err);
      });
      if (!this.timer) this.startPolling();
    };
    document.addEventListener("visibilitychange", this.visibilityHandler);
  }

  private async fetchDatafile(): Promise<boolean> {
    const url = `${this.config.dataPlaneUrl.replace(/\/$/, "")}/sdk/v1/datafile`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
    };
    if (this.etag) headers["If-None-Match"] = this.etag;
    const res = await this.fetchImpl(url, { method: "GET", headers });
    if (res.status === 304) return false;
    if (res.status === 404) {
      // No datafile yet; transient, will catch up on the next poll.
      return false;
    }
    if (res.status === 429) {
      // Rate limited. Don't tear down; back off naturally on the next tick.
      return false;
    }
    if (!res.ok) {
      throw new Error(`fetchDatafile failed: ${res.status} ${res.statusText}`);
    }
    const next = (await res.json()) as Datafile;
    this.datafile = next;
    this.etag = res.headers.get("etag");
    return true;
  }
}
