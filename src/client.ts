import type { Datafile } from "@feathq/datafile-schema";
import { evaluate } from "@feathq/feat-eval";
import { buildAnonymousContext } from "./anonymous";
import { DatafileBroadcast } from "./broadcast";
import { Emitter } from "./emitter";
import { loadCachedDatafile, saveCachedDatafile } from "./persistence";
import { SDK_VERSION } from "./version";
import type {
  ChangeEvent,
  EvalContext,
  EvaluationResult,
  FeatWebClientConfig,
  FlagEventMap,
} from "./types";

const CLIENT_SIDE_PREFIX = "feat_cs_";
const MIN_POLL_INTERVAL_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const MAX_DATAFILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_URL = "https://data-01.feat.so";

// Browser polling client with a synchronous evaluation cache.
//
// Sync surface (`getValue`, `getDetail`, `allFlags`) reads from a Map
// that's pre-computed every time the datafile or the context changes.
// This is what makes the OpenFeature web-sdk Provider possible: that
// spec requires sync `resolve*Evaluation`, but the underlying eval
// engine is async (Web Crypto SHA-1). Pre-evaluating into a cache
// bridges the gap.
//
// Reactive `change` events fire per-flag when a value flips, so the UI
// or framework adapter can rerender without polling the SDK.
export class FeatWebClient {
  private datafile: Datafile | null = null;
  private etag: string | null = null;
  private context: EvalContext | null = null;
  private cache: Map<string, EvaluationResult> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readyPromise: Promise<void> | null = null;
  private visibilityHandler: (() => void) | null = null;
  private emitter = new Emitter<FlagEventMap>();
  private broadcast: DatafileBroadcast | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly pollIntervalMs: number;
  private readonly url: string;
  private closed = false;

  constructor(private readonly config: FeatWebClientConfig) {
    if (!config.apiKey.startsWith(CLIENT_SIDE_PREFIX)) {
      throw new Error(
        `FeatWebClient requires a client_side_id key (prefix "${CLIENT_SIDE_PREFIX}"). ` +
          "Server and mobile keys must never ship in browser code.",
      );
    }
    this.url = config.url ?? DEFAULT_URL;
    assertHttpsUrl(this.url);
    this.fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis);
    this.pollIntervalMs = Math.max(
      config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      MIN_POLL_INTERVAL_MS,
    );
    if (config.context) {
      this.context = config.context;
    } else if (config.anonymous) {
      this.context = buildAnonymousContext(config.anonymous);
    }
    // Seed order: explicit bootstrap > localStorage cache > nothing.
    // Both populate the datafile + etag pre-fetch so a render before
    // ready() resolves shows cached values rather than defaults.
    if (config.bootstrap) {
      this.datafile = config.bootstrap;
      this.etag = config.bootstrap.etag;
    } else if (config.cache) {
      const cached = loadCachedDatafile(config.cache);
      if (cached) {
        this.datafile = cached.datafile;
        this.etag = cached.etag;
      }
    }
    // Cross-tab sync defaults on. Sibling tabs adopt a fresh datafile
    // without their own network call; we still publish on every fetch
    // so a late-arriving tab catches up immediately.
    if (config.crossTabSync !== false) {
      this.broadcast = new DatafileBroadcast((msg) => {
        void this.adoptFromBroadcast(msg.datafile, msg.etag);
      });
    }
  }

  // Resolves once the first datafile is in memory AND (if context was
  // supplied) the cache has been pre-evaluated.
  async ready(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = this.bootstrap();
    }
    return this.readyPromise;
  }

  // Swap the evaluation context. Re-evaluates every flag, diffs against
  // the previous cache, and fires a `change` event per flipped flag.
  // OpenFeature's `onContextChange` lifecycle hook bridges to this.
  async setContext(context: EvalContext): Promise<void> {
    this.context = context;
    await this.recomputeCache();
  }

  currentContext(): EvalContext | null {
    return this.context;
  }

  // Sync flag access. Returns defaultValue with reason ERROR if the
  // client isn't ready or the flag is missing. Sync because the cache
  // is pre-computed; no async work happens in this path.
  getDetail<T = unknown>(flagKey: string, defaultValue: T): EvaluationResult<T> {
    const cached = this.cache.get(flagKey);
    if (cached !== undefined) return cached as EvaluationResult<T>;
    return {
      value: defaultValue,
      variationId: null,
      reason: "ERROR",
      errorMessage: this.context
        ? "flag could not be evaluated"
        : "client not ready: call setContext() and await ready()",
    };
  }

  getValue<T = unknown>(flagKey: string, defaultValue: T): T {
    return this.getDetail(flagKey, defaultValue).value;
  }

  getBooleanValue(flagKey: string, defaultValue: boolean): boolean {
    const v = this.getDetail<unknown>(flagKey, defaultValue).value;
    return typeof v === "boolean" ? v : defaultValue;
  }

  getStringValue(flagKey: string, defaultValue: string): string {
    const v = this.getDetail<unknown>(flagKey, defaultValue).value;
    return typeof v === "string" ? v : defaultValue;
  }

  getNumberValue(flagKey: string, defaultValue: number): number {
    const v = this.getDetail<unknown>(flagKey, defaultValue).value;
    return typeof v === "number" ? v : defaultValue;
  }

  getObjectValue<T = unknown>(flagKey: string, defaultValue: T): T {
    const v = this.getDetail<unknown>(flagKey, defaultValue).value;
    return typeof v === "object" && v !== null ? (v as T) : defaultValue;
  }

  // Snapshot of the current sync cache. Useful for devtools and debug panels.
  allFlags(): ReadonlyMap<string, EvaluationResult> {
    return new Map(this.cache);
  }

  on<K extends keyof FlagEventMap>(event: K, listener: (arg: FlagEventMap[K]) => void): () => void {
    return this.emitter.on(event, listener);
  }

  off<K extends keyof FlagEventMap>(event: K, listener: (arg: FlagEventMap[K]) => void): void {
    this.emitter.off(event, listener);
  }

  // Force a one-shot fetch. Returns true if the in-memory datafile changed.
  async refresh(): Promise<boolean> {
    return this.fetchDatafile();
  }

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
    this.broadcast?.close();
    this.broadcast = null;
    this.emitter.removeAll();
  }

  private async bootstrap(): Promise<void> {
    try {
      // If we already have a seeded datafile (bootstrap or cache), prime
      // the eval cache immediately so the first render after ready() has
      // real values, then refresh in the background to catch any drift.
      if (this.datafile) await this.recomputeCache();
      await this.fetchDatafile();
      if (this.closed) return;
      this.startPolling();
      this.attachVisibilityHandler();
      this.emitter.emit("ready", undefined);
    } catch (err) {
      this.emitter.emit("failed", err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  private startPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      void this.fetchDatafile().catch((err: unknown) => {
        console.warn("feat: background poll failed:", messageOf(err));
      });
    }, this.pollIntervalMs);
  }

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
      void this.fetchDatafile().catch((err: unknown) => {
        console.warn("feat: visibility refresh failed:", messageOf(err));
      });
      if (!this.timer) this.startPolling();
    };
    document.addEventListener("visibilitychange", this.visibilityHandler);
  }

  private async fetchDatafile(): Promise<boolean> {
    const url = `${this.url.replace(/\/$/, "")}/sdk/v1/datafile`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
      // Custom header because browsers forbid setting User-Agent on fetch.
      "X-Feat-Sdk": `web/${SDK_VERSION}`,
    };
    if (this.etag) headers["If-None-Match"] = this.etag;
    const res = await this.fetchImpl(url, { method: "GET", headers });
    if (res.status === 304) return false;
    if (res.status === 404) return false;
    if (res.status === 429) return false;
    if (!res.ok) {
      throw new Error(`fetchDatafile failed: ${res.status}`);
    }
    const lengthHeader = res.headers.get("content-length");
    if (lengthHeader && Number(lengthHeader) > MAX_DATAFILE_BYTES) {
      throw new Error("datafile exceeds maximum allowed size");
    }
    const next = (await res.json()) as Datafile;
    this.datafile = next;
    this.etag = res.headers.get("etag");
    if (this.config.cache) {
      saveCachedDatafile(this.config.cache, { datafile: next, etag: this.etag });
    }
    this.broadcast?.publish(next, this.etag);
    await this.recomputeCache();
    return true;
  }

  // Sibling-tab handler. Only adopt if the broadcast carries a newer
  // version (or we have nothing); old broadcasts can race with our own
  // fresh fetches and we don't want to regress.
  private async adoptFromBroadcast(datafile: Datafile, etag: string | null): Promise<void> {
    if (this.datafile && datafile.version <= this.datafile.version) return;
    this.datafile = datafile;
    this.etag = etag;
    if (this.config.cache) {
      saveCachedDatafile(this.config.cache, { datafile, etag });
    }
    await this.recomputeCache();
  }

  // Pre-evaluate every flag in the datafile against the current context
  // and diff against the previous cache. Skips silently if datafile or
  // context is missing; the caller will recompute as soon as both land.
  private async recomputeCache(): Promise<void> {
    if (!this.datafile || !this.context) return;
    const prev = this.cache;
    const next = new Map<string, EvaluationResult>();
    const datafile = this.datafile;
    const context = this.context;
    for (const flagKey of Object.keys(datafile.flags)) {
      const flag = datafile.flags[flagKey];
      if (!flag) continue;
      const result = await evaluate(flagKey, null, context, datafile);
      next.set(flagKey, result);
    }
    this.cache = next;
    // Emit a change event per flag whose evaluated value flipped. New
    // flags fire too (old undefined -> new value). Removed flags fire as
    // newValue=null. Compared via JSON.stringify, which is the coarse-
    // grained deep-eq the rest of the SDK assumes for JSON values.
    for (const [flagKey, newResult] of next) {
      const oldResult = prev.get(flagKey);
      if (!oldResult || !sameValue(oldResult.value, newResult.value)) {
        this.emitter.emit("change", {
          flagKey,
          oldValue: oldResult?.value ?? null,
          newValue: newResult.value,
          oldVariation: oldResult?.variationId ?? null,
          newVariation: newResult.variationId,
        } satisfies ChangeEvent);
      }
    }
    for (const [flagKey, oldResult] of prev) {
      if (!next.has(flagKey)) {
        this.emitter.emit("change", {
          flagKey,
          oldValue: oldResult.value,
          newValue: null,
          oldVariation: oldResult.variationId,
          newVariation: null,
        } satisfies ChangeEvent);
      }
    }
    this.emitter.emit("update", undefined);
  }
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Allow https:// and loopback over http for local dev / tests. Anything
// else gets rejected so a misconfigured consumer can't accidentally send
// the bearer token over plaintext.
function assertHttpsUrl(url: string): void {
  try {
    const u = new URL(url);
    if (u.protocol === "https:") return;
    if (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1")) {
      return;
    }
  } catch {
    // fall through to throw
  }
  throw new Error("url must use https:// (http://localhost allowed for tests)");
}
