import type { Datafile } from "@feathq/datafile-schema";

const CHANNEL_NAME = "feat:datafile";

export interface DatafileBroadcastMessage {
  type: "datafile-update";
  datafile: Datafile;
  etag: string | null;
}

// Thin wrapper around BroadcastChannel that no-ops on browsers without
// it (old Safari). When tab A fetches a new datafile it publishes the
// full payload; tab B adopts it without a network round trip, which
// halves MAU billing for users with multiple tabs open.
export class DatafileBroadcast {
  private channel: BroadcastChannel | null = null;
  private handler: ((msg: DatafileBroadcastMessage) => void) | null = null;
  private listener: ((ev: MessageEvent) => void) | null = null;

  constructor(handler: (msg: DatafileBroadcastMessage) => void) {
    if (typeof BroadcastChannel === "undefined") return;
    this.handler = handler;
    this.channel = new BroadcastChannel(CHANNEL_NAME);
    this.listener = (ev: MessageEvent) => {
      const data = ev.data as DatafileBroadcastMessage | undefined;
      if (!data || data.type !== "datafile-update" || !this.handler) return;
      this.handler(data);
    };
    this.channel.addEventListener("message", this.listener);
  }

  publish(datafile: Datafile, etag: string | null): void {
    if (!this.channel) return;
    const msg: DatafileBroadcastMessage = { type: "datafile-update", datafile, etag };
    try {
      this.channel.postMessage(msg);
    } catch {
      // DataCloneError on a really weird datafile; not worth crashing.
    }
  }

  close(): void {
    if (this.channel && this.listener) {
      this.channel.removeEventListener("message", this.listener);
    }
    this.channel?.close();
    this.channel = null;
    this.handler = null;
    this.listener = null;
  }
}
