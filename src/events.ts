import type { ContextKindObject, EvalContext } from "./types";

export const DEFAULT_EVENTS_FLUSH_INTERVAL_MS = 60_000;
export const MIN_EVENTS_FLUSH_INTERVAL_MS = 5_000;

// Cap a single request at the data plane's per-batch limit; anything beyond
// drains on the next flush.
const MAX_BATCH = 2000;
// Safety bound on the in-memory buffer so a pathological caller (or a long
// outage) can't grow it without limit. New pairs are dropped past this; the
// data plane dedups monthly so losing some is harmless, not double-counted.
const MAX_BUFFERED_PAIRS = 100_000;

// Pull unique (kind, key) pairs from an evaluation context. Mirrors the data
// plane's extraction (top-level `targetingKey` is the `user` key; every other
// object with a string `key` is its own kind) so the pairs line up with what
// the meter expects.
export function extractContextPairs(context: EvalContext): { kind: string; key: string }[] {
  const out: { kind: string; key: string }[] = [];
  const seen = new Set<string>();
  const push = (kind: string, key: string): void => {
    const id = `${kind} ${key}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ kind, key });
  };

  const userObj = context.user;
  if (userObj && typeof userObj === "object" && typeof (userObj as ContextKindObject).key === "string") {
    push("user", (userObj as ContextKindObject).key);
  } else if (typeof context.targetingKey === "string") {
    push("user", context.targetingKey);
  }
  for (const [kind, value] of Object.entries(context)) {
    if (kind === "targetingKey" || kind === "user") continue;
    if (value && typeof value === "object" && typeof (value as ContextKindObject).key === "string") {
      push(kind, (value as ContextKindObject).key);
    }
  }
  return out;
}

export interface EventSummarizerOptions {
  url: string;
  apiKey: string;
  fetchImpl: typeof fetch;
  // Browsers forbid setting User-Agent on fetch, so the SDK identifies itself
  // with a custom header (allowlisted in the data plane's CORS config).
  sdkHeader: string;
  flushIntervalMs: number;
}

// Buffers the deduplicated context pairs this browser evaluated and flushes
// them to POST /sdk/v1/events on a timer, plus once more whenever the page is
// hidden (tab switch / navigation / close) so the last contexts aren't lost on
// unload. Fire-and-forget by design: record() is a cheap synchronous map
// insert that never throws, and flush() swallows every failure.
//
// Browser-specific vs the server SDK: flushes use fetch({ keepalive: true })
// so an unload-time send survives the page going away, and the hidden-page
// hook replaces the server SDK's process-exit flush. sendBeacon is NOT used:
// it cannot carry the Authorization bearer the events endpoint requires.
//
// The buffer is per-flush-window (cleared on success); the data plane owns
// month-scope dedup, so a context seen across two windows is sent in both and
// deduped there.
export class EventSummarizer {
  private readonly pending = new Map<string, { kind: string; key: string }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private visibilityHandler: (() => void) | null = null;
  private readonly endpoint: string;

  constructor(private readonly opts: EventSummarizerOptions) {
    this.endpoint = `${opts.url.replace(/\/$/, "")}/sdk/v1/events`;
  }

  // Synchronous, never throws: safe to call inline from setContext().
  record(context: EvalContext): void {
    for (const pair of extractContextPairs(context)) {
      const id = `${pair.kind} ${pair.key}`;
      if (this.pending.has(id)) continue;
      if (this.pending.size >= MAX_BUFFERED_PAIRS) return;
      this.pending.set(id, pair);
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, this.opts.flushIntervalMs);
    // Flush on page hide so the last contexts aren't lost to a tab close or
    // navigation. visibilitychange -> hidden is the reliable cross-browser
    // signal; the keepalive flush lets the request outlive the page.
    if (typeof document !== "undefined") {
      this.visibilityHandler = () => {
        if (document.visibilityState === "hidden") void this.flush(true);
      };
      document.addEventListener("visibilitychange", this.visibilityHandler);
    }
  }

  async flush(keepalive = false): Promise<void> {
    if (this.inFlight || this.pending.size === 0) return;
    const batch = [...this.pending.values()].slice(0, MAX_BATCH);
    for (const c of batch) this.pending.delete(`${c.kind} ${c.key}`);

    this.inFlight = true;
    try {
      const res = await this.opts.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          "Content-Type": "application/json",
          "X-Feat-Sdk": this.opts.sdkHeader,
        },
        body: JSON.stringify({ contexts: batch }),
        keepalive,
      });
      // 2xx: delivered. 5xx / 429: transient, requeue for the next window.
      // Other 4xx (bad key, malformed): permanent, drop so we don't loop.
      if (!res.ok && (res.status >= 500 || res.status === 429)) {
        this.requeue(batch);
      }
    } catch {
      // Network error: transient, requeue.
      this.requeue(batch);
    } finally {
      this.inFlight = false;
    }
  }

  // Detach the page-hide hook, stop the timer, and make a best-effort final
  // flush. Fire-and-forget: the flush is not awaited so close() stays sync.
  close(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.visibilityHandler && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
      this.visibilityHandler = null;
    }
    void this.flush(true);
  }

  private requeue(batch: { kind: string; key: string }[]): void {
    for (const c of batch) {
      const id = `${c.kind} ${c.key}`;
      if (this.pending.has(id)) continue;
      if (this.pending.size >= MAX_BUFFERED_PAIRS) return;
      this.pending.set(id, c);
    }
  }
}
