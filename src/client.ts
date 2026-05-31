import type { Datafile } from "@feathq/datafile-schema";
import { evaluate } from "@feathq/feat-eval";
import { buildAnonymousContext } from "./anonymous";
import { Emitter } from "./emitter";
import type {
  ChangeEvent,
  EvalContext,
  EvaluationResult,
  FeatWebClientConfig,
  FlagEventMap,
} from "./types";

const CLIENT_SIDE_PREFIX = "feat_cs_";

// Browser polling client with a synchronous evaluation cache.
//
// Sync surface (`getValue`, `getDetail`, `allFlags`) reads from a Map
// that's pre-computed every time the datafile or the context changes.
// This is what makes the OpenFeature web-sdk Provider in PR-11 possible:
// that spec requires sync `resolve*Evaluation`, but our eval engine is
// async (Web Crypto SHA-1). Pre-eval-into-cache is the standard fix
// (LaunchDarkly and Optimizely web SDKs do the same thing).
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
    if (config.context) {
      this.context = config.context;
    } else if (config.anonymous) {
      this.context = buildAnonymousContext(config.anonymous);
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
        ? `flag "${flagKey}" not found`
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

  // Snapshot of the current sync cache. Useful for devtools/debug panels
  // and for OpenFeature's `getProviderEvents` style introspection.
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
    this.emitter.removeAll();
  }

  private async bootstrap(): Promise<void> {
    try {
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
      void this.fetchDatafile().catch((err) => {
        console.warn("feat-web-sdk: background poll failed", err);
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
    if (res.status === 404) return false;
    if (res.status === 429) return false;
    if (!res.ok) {
      throw new Error(`fetchDatafile failed: ${res.status} ${res.statusText}`);
    }
    const next = (await res.json()) as Datafile;
    this.datafile = next;
    this.etag = res.headers.get("etag");
    await this.recomputeCache();
    return true;
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
    // newValue=null. Compared by JSON.stringify for deep-eq on JSON
    // values; this is the same coarse-grain check LD/Optimizely use.
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
  // Cheap deep-eq for JSON values. Cycles aren't a concern: the engine
  // only emits values from the datafile, which is itself JSON-serialized.
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
