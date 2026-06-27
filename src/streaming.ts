import type { Datafile, FlagSpec, SegmentSpec } from "@feathq/datafile-schema";

// An incremental datafile delta. The server emits a `patch` frame whenever a
// change can be expressed as a delta against a known prior version: `from` is
// the version the patch applies on top of, `to` is the version it produces.
// `flags` / `segments` carry added-or-changed entries; `removedFlags` /
// `removedSegments` carry keys to drop. A patch is only safe to apply when the
// client already holds version `from` (see FeatWebClient.applyPatch).
export interface DatafilePatch {
  from: number;
  to: number;
  etag: string;
  generatedAt: string;
  flags: Record<string, FlagSpec>;
  removedFlags: string[];
  segments: Record<string, SegmentSpec>;
  removedSegments: string[];
}

// Minimal structural type for the slice of EventSource the SDK touches, so
// the constructor can be injected in tests (and on non-browser hosts) without
// depending on the full DOM EventSource shape. `readyState` lets the wrapper
// tell a transient drop (EventSource auto-reconnects) from a terminal failure
// (it goes to CLOSED and stays there).
export interface EventSourceLike {
  readyState: number;
  addEventListener(type: string, listener: (ev: MessageEvent) => void): void;
  close(): void;
}

// EventSource.CLOSED. Inlined so the wrapper doesn't depend on the global
// constant being present on non-browser hosts.
const EVENT_SOURCE_CLOSED = 2;

export type EventSourceConstructor = new (
  url: string,
  init?: EventSourceInit,
) => EventSourceLike;

export interface DatafileStreamOptions {
  url: string;
  apiKey: string;
  eventSourceCtor: EventSourceConstructor;
  onPut: (datafile: Datafile) => void;
  onPatch: (patch: DatafilePatch) => void;
}

// Thin adapter over an EventSource connected to the server's datafile stream.
// The server emits a `put` frame (the full datafile JSON) on connect and a
// `patch` frame (an incremental delta) for subsequent changes that can be
// expressed as a delta; heartbeat comment lines are swallowed by
// EventSource itself. Native EventSource auto-reconnects after a transient
// drop, so this stays a thin wrapper and does not hand-roll reconnect; the
// polling loop is the safety net if the stream can't recover.
//
// Browsers can't set request headers on EventSource, so the client_side_id
// key travels in the query string; the Origin header is sent automatically.
export class DatafileStream {
  private source: EventSourceLike | null = null;
  private warned = false;
  private readonly options: DatafileStreamOptions;

  constructor(options: DatafileStreamOptions) {
    this.options = options;
  }

  open(): void {
    if (this.source) return;
    const base = this.options.url.replace(/\/$/, "");
    const streamUrl = `${base}/sdk/v1/datafile/stream?key=${encodeURIComponent(
      this.options.apiKey,
    )}`;
    const source = new this.options.eventSourceCtor(streamUrl);
    this.source = source;
    source.addEventListener("put", (ev: MessageEvent) => {
      const datafile = parsePut(ev.data);
      if (datafile) this.options.onPut(datafile);
    });
    source.addEventListener("patch", (ev: MessageEvent) => {
      const patch = parsePatch(ev.data);
      if (patch) this.options.onPatch(patch);
    });
    source.addEventListener("error", () => {
      // EventSource auto-reconnects after a transient drop (readyState stays
      // CONNECTING), so leave it be in that case. On a terminal HTTP failure
      // (401/403/429) it goes to CLOSED and never reopens on its own; drop the
      // dead source so a later policy change (e.g. a new change-subscription)
      // can open a fresh stream. Polling carries the load in the meantime.
      if (!this.warned) {
        this.warned = true;
        console.warn("feat: datafile stream error; falling back to polling");
      }
      if (this.source && this.source.readyState === EVENT_SOURCE_CLOSED) {
        this.close();
      }
    });
  }

  close(): void {
    this.source?.close();
    this.source = null;
  }
}

// Parse a `put` frame's data payload into a datafile, tolerating anything
// malformed (the next put, or polling, will catch us up).
function parsePut(data: unknown): Datafile | null {
  if (typeof data !== "string") return null;
  try {
    const parsed = JSON.parse(data) as Datafile;
    if (parsed && typeof parsed === "object" && typeof parsed.version === "number") {
      return parsed;
    }
  } catch {
    // Ignore malformed frames.
  }
  return null;
}

// Parse a `patch` frame's data payload into a delta, tolerating anything
// malformed. `from` and `to` must be integers and satisfy the wire invariant
// `to > from` (they gate the apply); a frame that violates this (degenerate or
// a replayed backwards patch) is dropped so it can never regress version/etag.
// The collection fields default to empty so a payload that omits one is still
// usable. Anything that fails these checks is dropped; the version guard in
// applyPatch and the safety poll keep the client correct.
function parsePatch(data: unknown): DatafilePatch | null {
  if (typeof data !== "string") return null;
  try {
    const p = JSON.parse(data) as Record<string, unknown>;
    if (!p || typeof p !== "object") return null;
    if (!Number.isInteger(p.from) || !Number.isInteger(p.to)) return null;
    if ((p.to as number) <= (p.from as number)) return null;
    if (typeof p.etag !== "string" || typeof p.generatedAt !== "string") return null;
    return {
      from: p.from as number,
      to: p.to as number,
      etag: p.etag,
      generatedAt: p.generatedAt,
      flags: isRecord(p.flags) ? (p.flags as Record<string, FlagSpec>) : {},
      removedFlags: isStringArray(p.removedFlags) ? p.removedFlags : [],
      segments: isRecord(p.segments) ? (p.segments as Record<string, SegmentSpec>) : {},
      removedSegments: isStringArray(p.removedSegments) ? p.removedSegments : [],
    };
  } catch {
    // Ignore malformed frames.
  }
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}
