import type { Datafile } from "@feathq/datafile-schema";

// Minimal structural type for the slice of EventSource the SDK touches, so
// the constructor can be injected in tests (and on non-browser hosts) without
// depending on the full DOM EventSource shape.
export interface EventSourceLike {
  addEventListener(type: string, listener: (ev: MessageEvent) => void): void;
  close(): void;
}

export type EventSourceConstructor = new (
  url: string,
  init?: EventSourceInit,
) => EventSourceLike;

export interface DatafileStreamOptions {
  url: string;
  apiKey: string;
  eventSourceCtor: EventSourceConstructor;
  onPut: (datafile: Datafile) => void;
}

// Thin adapter over an EventSource connected to the data plane's datafile
// stream. The data plane emits a `put` frame (the full datafile JSON) on
// connect and again on every datafile change; heartbeat comment lines are
// swallowed by EventSource itself. Native EventSource auto-reconnects, so
// this stays a thin wrapper and does not hand-roll reconnect; the polling
// loop is the safety net if the stream can't recover.
//
// Browsers can't set request headers on EventSource, so the client_side_id
// key travels in the query string; the Origin header is sent automatically.
export class DatafileStream {
  private source: EventSourceLike | null = null;
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
    // EventSource reconnects on its own after a transient drop; swallow the
    // error so it doesn't surface as an unhandled event. Polling covers any
    // window where the stream is down.
    source.addEventListener("error", () => {});
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
