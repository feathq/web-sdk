import type { Datafile } from "@feathq/datafile-schema";
import { evaluate } from "@feathq/feat-eval";
import { buildAnonymousContext } from "./anonymous";
import { DatafileBroadcast } from "./broadcast";
import { Emitter } from "./emitter";
import {
  DEFAULT_EVENTS_FLUSH_INTERVAL_MS,
  EventSummarizer,
  MIN_EVENTS_FLUSH_INTERVAL_MS,
} from "./events";
import { loadCachedDatafile, saveCachedDatafile } from "./persistence";
import { DatafileStream, type EventSourceConstructor } from "./streaming";
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
  private stream: DatafileStream | null = null;
  // The set of live `change` listeners. The streaming-follows-subscription
  // policy keys off whether this is non-empty; tracking the listeners (rather
  // than a counter) keeps the refcount correct whether the caller unsubscribes
  // via the returned disposer or via off().
  private changeListeners = new Set<(arg: ChangeEvent) => void>();
  private started = false;
  private warnedNoEventSource = false;
  private readonly summarizer: EventSummarizer | null;
  private readonly fetchImpl: typeof fetch;
  private readonly eventSourceCtor: EventSourceConstructor | undefined;
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
    this.eventSourceCtor =
      config.eventSource ??
      (typeof globalThis.EventSource !== "undefined"
        ? (globalThis.EventSource as unknown as EventSourceConstructor)
        : undefined);
    this.pollIntervalMs = Math.max(
      config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      MIN_POLL_INTERVAL_MS,
    );
    this.summarizer =
      config.events === false
        ? null
        : new EventSummarizer({
            url: this.url,
            apiKey: config.apiKey,
            fetchImpl: this.fetchImpl,
            sdkHeader: `web/${SDK_VERSION}`,
            flushIntervalMs: Math.max(
              config.eventsFlushIntervalMs ?? DEFAULT_EVENTS_FLUSH_INTERVAL_MS,
              MIN_EVENTS_FLUSH_INTERVAL_MS,
            ),
          });
    if (config.context) {
      this.context = config.context;
    } else if (config.anonymous) {
      this.context = buildAnonymousContext(config.anonymous);
    }
    // Record the initial end-user context for MAU metering. The browser
    // SDK's context IS the end user, so each distinct context this client
    // is given is one active user to report. Later changes go through
    // setContext(), which records too.
    if (this.context) this.summarizer?.record(this.context);
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
    // Each distinct end user this browser identifies as is one active user.
    this.summarizer?.record(context);
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
    if (event !== "change") return this.emitter.on(event, listener);
    // Track `change` subscriptions so streaming can follow them. Return a
    // disposer that funnels through off() so the refcount stays correct.
    this.emitter.on(event, listener);
    this.changeListeners.add(listener as (arg: ChangeEvent) => void);
    this.maybeUpdateStream();
    return () => this.off(event, listener);
  }

  off<K extends keyof FlagEventMap>(event: K, listener: (arg: FlagEventMap[K]) => void): void {
    this.emitter.off(event, listener);
    if (event === "change" && this.changeListeners.delete(listener as (arg: ChangeEvent) => void)) {
      this.maybeUpdateStream();
    }
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
    this.stream?.close();
    this.stream = null;
    this.changeListeners.clear();
    if (this.visibilityHandler && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
      this.visibilityHandler = null;
    }
    this.broadcast?.close();
    this.broadcast = null;
    this.summarizer?.close();
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
      this.summarizer?.start();
      // Streaming is allowed from here on. `streaming: true` opens now;
      // streaming-follows-subscription may already have opened it if a
      // `change` listener was added before ready().
      this.started = true;
      this.maybeUpdateStream();
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

  // Sibling-tab handler. Adopt without republishing: this is the receive end
  // of a BroadcastChannel message, so echoing it back would loop.
  private async adoptFromBroadcast(datafile: Datafile, etag: string | null): Promise<void> {
    await this.adoptDatafile(datafile, etag, false);
  }

  // Version-guarded adopt for datafiles that arrive outside the fetch path
  // (sibling-tab broadcast, SSE `put`). Only adopt a strictly newer version so
  // an old broadcast or out-of-order frame can't regress us; the same guard
  // stops a republished put from looping back through a sibling tab. When
  // `publish` is set we mirror the fetch path and rebroadcast so sibling tabs
  // stay fresh without their own network call.
  private async adoptDatafile(
    datafile: Datafile,
    etag: string | null,
    publish: boolean,
  ): Promise<void> {
    // A frame buffered before close() can still surface afterwards; drop it so
    // a torn-down client can't be resurrected into mutating its cache.
    if (this.closed) return;
    if (this.datafile && datafile.version <= this.datafile.version) return;
    this.datafile = datafile;
    this.etag = etag;
    if (this.config.cache) {
      saveCachedDatafile(this.config.cache, { datafile, etag });
    }
    if (publish) this.broadcast?.publish(datafile, etag);
    await this.recomputeCache();
  }

  // Reconcile the SSE connection with the current streaming policy. Called
  // whenever an input to that policy changes: ready, a `change` (un)subscribe,
  // or close.
  private maybeUpdateStream(): void {
    if (this.closed) return;
    const want = this.wantsStream();
    if (want) {
      // Idempotent: opens a stream if there isn't one, and reopens if a prior
      // terminal error dropped the underlying EventSource (the wrapper nulls
      // its source on CLOSED, so open() rebuilds it on the next policy change).
      this.openStream();
    } else if (this.stream) {
      this.stream.close();
      this.stream = null;
    }
  }

  private wantsStream(): boolean {
    // false: never; true: always (once ready); undefined: follow subscription.
    if (this.config.streaming === false) return false;
    if (this.config.streaming === true) return this.started;
    return this.changeListeners.size > 0;
  }

  private openStream(): void {
    if (!this.eventSourceCtor) {
      // No EventSource on this host (e.g. SSR / older runtime): polling carries
      // the load. Warn once when streaming was actually wanted so the omission
      // isn't silent, then let maybeUpdateStream() retry on later policy
      // changes (a host that gains EventSource is not expected, but harmless).
      if (!this.warnedNoEventSource) {
        this.warnedNoEventSource = true;
        console.warn("feat: streaming requested but EventSource is unavailable; using polling");
      }
      return;
    }
    if (!this.stream) {
      this.stream = new DatafileStream({
        url: this.url,
        apiKey: this.config.apiKey,
        eventSourceCtor: this.eventSourceCtor,
        // A `put` carries the full datafile; reuse the version-ordered adopt
        // path so a duplicate or out-of-order frame is ignored and the cache
        // recomputes (firing `change`) only on a strictly newer version. Like
        // the fetch path, a stream-adopted put republishes on the
        // BroadcastChannel so sibling tabs stay fresh without their own fetch.
        onPut: (datafile) => {
          void this.adoptDatafile(datafile, datafile.etag, true).catch((err: unknown) => {
            console.warn("feat: streamed datafile update failed:", messageOf(err));
          });
        },
      });
    }
    this.stream.open();
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
