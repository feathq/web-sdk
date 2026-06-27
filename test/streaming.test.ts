import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Datafile, FlagSpec } from "@feathq/datafile-schema";
import { FeatWebClient } from "../src/client";
import type { EventSourceConstructor, EventSourceLike } from "../src/streaming";
import type { ChangeEvent } from "../src/types";

const BASE_DATAFILE: Datafile = {
  schemaVersion: 1,
  envId: "env-1",
  envKey: "production",
  projectId: "proj-1",
  version: 1,
  etag: "abc123",
  generatedAt: new Date().toISOString(),
  flags: {
    "hello-world": {
      id: "f1",
      key: "hello-world",
      valueType: "boolean",
      salt: "0000000000000000",
      archived: false,
      isEnabled: true,
      offVariationId: "v-off",
      defaultVariationId: "v-on",
      defaultRollout: null,
      defaultBucketingContextKindKey: null,
      variations: [
        { id: "v-on", name: "on", value: true },
        { id: "v-off", name: "off", value: false },
      ],
      targets: [],
      rules: [],
    },
  },
  segments: {},
  contextKinds: {
    user: { key: "user", availableForRules: true, availableForExperiments: true },
  },
};

// Same flag, flipped default, bumped version: a strictly-newer datafile.
function flippedAtVersion(version: number): Datafile {
  return {
    ...BASE_DATAFILE,
    version,
    etag: `etag-${version}`,
    flags: {
      ...BASE_DATAFILE.flags,
      "hello-world": {
        ...BASE_DATAFILE.flags["hello-world"]!,
        defaultVariationId: "v-off",
      },
    },
  };
}

// A boolean flag mirroring "hello-world"'s variations, keyed however the test
// needs and defaulting to whichever variation is passed.
function boolFlag(key: string, defaultVariationId: "v-on" | "v-off"): FlagSpec {
  return {
    ...BASE_DATAFILE.flags["hello-world"]!,
    id: key,
    key,
    defaultVariationId,
  };
}

// Build a well-formed `patch` frame. Collections default to empty; etag is
// derived from `to` so tests can assert it advanced.
function patchFrame(opts: {
  from: number;
  to: number;
  flags?: Record<string, FlagSpec>;
  removedFlags?: string[];
}): Record<string, unknown> {
  return {
    from: opts.from,
    to: opts.to,
    etag: `etag-${opts.to}`,
    generatedAt: new Date().toISOString(),
    flags: opts.flags ?? {},
    removedFlags: opts.removedFlags ?? [],
    segments: {},
    removedSegments: [],
  };
}

// Always serves BASE_DATAFILE (version 1) so the client starts holding it and
// streaming drives every subsequent change.
const baseFetch = (async () => ({
  status: 200,
  ok: true,
  statusText: "ok",
  headers: { get: (k: string) => (k.toLowerCase() === "etag" ? BASE_DATAFILE.etag : null) },
  json: async () => BASE_DATAFILE,
})) as unknown as typeof fetch;

// Mock EventSource that records its instances so a test can inspect the URL,
// drive `put` / `error` frames, and assert teardown.
class MockEventSource implements EventSourceLike {
  url: string;
  closed = false;
  // Mirrors EventSource.readyState: 0 CONNECTING, 1 OPEN, 2 CLOSED.
  readyState = 1;
  private listeners = new Map<string, ((ev: MessageEvent) => void)[]>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  static instances: MockEventSource[] = [];

  addEventListener(type: string, listener: (ev: MessageEvent) => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(listener);
    this.listeners.set(type, arr);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  emitPut(datafile: Datafile): void {
    this.emitRawPut(JSON.stringify(datafile));
  }

  // Drive an arbitrary `put` payload, including malformed (non-JSON) frames.
  emitRawPut(data: string): void {
    for (const l of this.listeners.get("put") ?? []) {
      l({ data } as MessageEvent);
    }
  }

  emitPatch(patch: unknown): void {
    this.emitRawPatch(JSON.stringify(patch));
  }

  // Drive an arbitrary `patch` payload, including malformed (non-JSON) frames.
  emitRawPatch(data: string): void {
    for (const l of this.listeners.get("patch") ?? []) {
      l({ data } as MessageEvent);
    }
  }

  // Transient drop: EventSource stays CONNECTING and reconnects on its own.
  emitTransientError(): void {
    this.readyState = 0;
    for (const l of this.listeners.get("error") ?? []) {
      l({} as MessageEvent);
    }
  }

  // Terminal failure (e.g. 401/403/429): EventSource goes to CLOSED for good.
  emitTerminalError(): void {
    this.readyState = 2;
    for (const l of this.listeners.get("error") ?? []) {
      l({} as MessageEvent);
    }
  }
}

const mockCtor = MockEventSource as unknown as EventSourceConstructor;

// Let queued microtasks (the version-ordered adopt + recompute) settle.
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

function makeClient(streaming?: boolean): FeatWebClient {
  return new FeatWebClient({
    apiKey: "feat_cs_abc",
    url: "https://dp.example.com",
    context: { targetingKey: "u" },
    crossTabSync: false,
    events: false,
    fetch: baseFetch,
    eventSource: mockCtor,
    ...(streaming === undefined ? {} : { streaming }),
  });
}

describe("FeatWebClient streaming", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockEventSource.instances = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("follows subscription: opens on first change listener, closes on last unsubscribe", async () => {
    const client = makeClient();
    await client.ready();
    // No listeners yet: no stream.
    expect(MockEventSource.instances).toHaveLength(0);

    const dispose1 = client.on("change", () => {});
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0]!.closed).toBe(false);

    // A second listener reuses the one stream.
    const onChange2 = (): void => {};
    client.on("change", onChange2);
    expect(MockEventSource.instances).toHaveLength(1);

    // Removing one of two keeps the stream open.
    dispose1();
    expect(MockEventSource.instances[0]!.closed).toBe(false);

    // Removing the last (via off) closes it.
    client.off("change", onChange2);
    expect(MockEventSource.instances[0]!.closed).toBe(true);

    client.close();
  });

  it("non-change listeners do not open the stream", async () => {
    const client = makeClient();
    await client.ready();
    client.on("update", () => {});
    client.on("ready", () => {});
    expect(MockEventSource.instances).toHaveLength(0);
    client.close();
  });

  it("opens the stream when a change listener is added before ready()", async () => {
    const client = makeClient();
    client.on("change", () => {});
    // Subscription opens the stream immediately, even pre-ready.
    expect(MockEventSource.instances).toHaveLength(1);
    await client.ready();
    expect(MockEventSource.instances).toHaveLength(1);
    client.close();
  });

  it("streaming:true opens on ready (not before)", async () => {
    const client = makeClient(true);
    expect(MockEventSource.instances).toHaveLength(0);
    await client.ready();
    expect(MockEventSource.instances).toHaveLength(1);
    // Stays open even with no change listeners.
    expect(MockEventSource.instances[0]!.closed).toBe(false);
    client.close();
  });

  it("streaming:false never opens, even with a change listener", async () => {
    const client = makeClient(false);
    await client.ready();
    client.on("change", () => {});
    expect(MockEventSource.instances).toHaveLength(0);
    client.close();
  });

  it("puts the client_side_id key in the stream query string", async () => {
    const client = makeClient(true);
    await client.ready();
    const url = MockEventSource.instances[0]!.url;
    expect(url).toBe("https://dp.example.com/sdk/v1/datafile/stream?key=feat_cs_abc");
    client.close();
  });

  it("adopts a newer-version put and fires change", async () => {
    const client = makeClient(true);
    await client.ready();
    expect(client.getValue("hello-world", false)).toBe(true);

    const changes: ChangeEvent[] = [];
    client.on("change", (e) => changes.push(e));

    MockEventSource.instances[0]!.emitPut(flippedAtVersion(2));
    await flush();

    expect(client.getValue("hello-world", false)).toBe(false);
    expect(client.currentDatafile()?.version).toBe(2);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      flagKey: "hello-world",
      oldValue: true,
      newValue: false,
    });
    client.close();
  });

  it("ignores an equal- or older-version put", async () => {
    const client = makeClient(true);
    await client.ready();

    // Advance to version 2 first.
    MockEventSource.instances[0]!.emitPut(flippedAtVersion(2));
    await flush();
    expect(client.getValue("hello-world", false)).toBe(false);

    const changes: ChangeEvent[] = [];
    client.on("change", (e) => changes.push(e));

    // Equal version: ignored.
    MockEventSource.instances[0]!.emitPut(flippedAtVersion(2));
    await flush();
    // Older version (the original v1, flag on): ignored, value stays off.
    MockEventSource.instances[0]!.emitPut(BASE_DATAFILE);
    await flush();

    expect(changes).toHaveLength(0);
    expect(client.getValue("hello-world", false)).toBe(false);
    expect(client.currentDatafile()?.version).toBe(2);
    client.close();
  });

  it("swallows a transient stream error and warns once (polling is the safety net)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeClient(true);
    await client.ready();
    const source = MockEventSource.instances[0]!;
    expect(() => source.emitTransientError()).not.toThrow();
    // Transient: EventSource reconnects on its own, so the wrapper keeps it.
    expect(source.closed).toBe(false);
    // A second transient error does not warn again.
    source.emitTransientError();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("feat: datafile stream error; falling back to polling");
    client.close();
    warn.mockRestore();
  });

  it("malformed put frames are ignored: datafile, cache, and listeners untouched", async () => {
    const client = makeClient(true);
    await client.ready();
    expect(client.getValue("hello-world", false)).toBe(true);

    const changes: ChangeEvent[] = [];
    client.on("change", (e) => changes.push(e));
    const source = MockEventSource.instances[0]!;

    source.emitRawPut("not json at all");
    source.emitRawPut("{ broken");
    source.emitRawPut(JSON.stringify({ flags: {} })); // no numeric version
    source.emitRawPut(JSON.stringify({ ...BASE_DATAFILE, version: "2" })); // version not a number
    await flush();

    expect(changes).toHaveLength(0);
    expect(client.getValue("hello-world", false)).toBe(true);
    expect(client.currentDatafile()?.version).toBe(1);
    client.close();
  });

  it("a terminal stream error nulls the source so a later re-subscribe opens a fresh stream", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeClient(); // follow-subscription mode
    await client.ready();

    client.on("change", () => {});
    expect(MockEventSource.instances).toHaveLength(1);
    const first = MockEventSource.instances[0]!;

    // Terminal failure: EventSource is CLOSED and will not reopen on its own.
    first.emitTerminalError();
    expect(first.closed).toBe(true);

    // Polling still works: a fetch picks up a newer datafile.
    expect(client.getValue("hello-world", false)).toBe(true);

    // Re-subscribe (a new change listener) drives a policy change, which must
    // open a fresh EventSource rather than reuse the dead one.
    client.on("change", () => {});
    expect(MockEventSource.instances).toHaveLength(2);
    expect(MockEventSource.instances[1]!.closed).toBe(false);
    client.close();
    warn.mockRestore();
  });

  it("reopens a fresh stream after the last listener tears it down", async () => {
    const client = makeClient(); // follow-subscription mode
    await client.ready();

    const dispose = client.on("change", () => {});
    expect(MockEventSource.instances).toHaveLength(1);

    // Last listener removed: stream closes.
    dispose();
    expect(MockEventSource.instances[0]!.closed).toBe(true);

    // New listener: a brand-new EventSource, not the closed one.
    client.on("change", () => {});
    expect(MockEventSource.instances).toHaveLength(2);
    expect(MockEventSource.instances[1]!.closed).toBe(false);
    client.close();
  });

  it("a stream-adopted put is republished on the BroadcastChannel for sibling tabs", async () => {
    const postMessage = vi.spyOn(BroadcastChannel.prototype, "postMessage");
    const client = new FeatWebClient({
      apiKey: "feat_cs_abc",
      url: "https://dp.example.com",
      context: { targetingKey: "u" },
      // crossTabSync left on (default) so the stream put should rebroadcast.
      events: false,
      fetch: baseFetch,
      eventSource: mockCtor,
      streaming: true,
    });
    await client.ready();
    postMessage.mockClear();

    MockEventSource.instances[0]!.emitPut(flippedAtVersion(2));
    await flush();

    expect(postMessage).toHaveBeenCalledTimes(1);
    const msg = postMessage.mock.calls[0]![0] as { type: string; datafile: Datafile };
    expect(msg.type).toBe("datafile-update");
    expect(msg.datafile.version).toBe(2);
    client.close();
    postMessage.mockRestore();
  });

  it("a put delivered after close() does not mutate the cache or fire events", async () => {
    const client = makeClient(true);
    await client.ready();
    expect(client.getValue("hello-world", false)).toBe(true);

    const source = MockEventSource.instances[0]!;
    const changes: ChangeEvent[] = [];
    client.on("change", (e) => changes.push(e));

    client.close();
    // A late put from a still-buffered frame must not resurrect the client.
    source.emitPut(flippedAtVersion(2));
    await flush();

    expect(changes).toHaveLength(0);
    expect(client.getValue("hello-world", false)).toBe(true);
    expect(client.currentDatafile()?.version).toBe(1);
  });

  it("close() tears down the stream", async () => {
    const client = makeClient(true);
    await client.ready();
    expect(MockEventSource.instances[0]!.closed).toBe(false);
    client.close();
    expect(MockEventSource.instances[0]!.closed).toBe(true);
  });

  it("applies a patch whose `from` matches: changed flag, advanced version+etag, change fires", async () => {
    const client = makeClient(true);
    await client.ready();
    expect(client.getValue("hello-world", false)).toBe(true);

    const changes: ChangeEvent[] = [];
    client.on("change", (e) => changes.push(e));

    MockEventSource.instances[0]!.emitPatch(
      patchFrame({ from: 1, to: 2, flags: { "hello-world": boolFlag("hello-world", "v-off") } }),
    );
    await flush();

    expect(client.getValue("hello-world", false)).toBe(false);
    expect(client.currentDatafile()?.version).toBe(2);
    expect(client.currentDatafile()?.etag).toBe("etag-2");
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      flagKey: "hello-world",
      oldValue: true,
      newValue: false,
    });
    client.close();
  });

  it("applies a patch that adds a new flag", async () => {
    const client = makeClient(true);
    await client.ready();
    expect(client.getValue("extra", "missing")).toBe("missing");

    MockEventSource.instances[0]!.emitPatch(
      patchFrame({ from: 1, to: 2, flags: { extra: boolFlag("extra", "v-on") } }),
    );
    await flush();

    expect(client.getValue("extra", false)).toBe(true);
    // The pre-existing flag is untouched by the additive patch.
    expect(client.getValue("hello-world", false)).toBe(true);
    expect(client.currentDatafile()?.version).toBe(2);
    client.close();
  });

  it("applies a patch that removes a flag: it is gone and `change` fires with newValue null", async () => {
    const client = makeClient(true);
    await client.ready();
    expect(client.getValue("hello-world", "default")).toBe(true);

    const changes: ChangeEvent[] = [];
    client.on("change", (e) => changes.push(e));

    MockEventSource.instances[0]!.emitPatch(
      patchFrame({ from: 1, to: 2, removedFlags: ["hello-world"] }),
    );
    await flush();

    // Gone from the cache: getValue falls back to the default.
    expect(client.getValue("hello-world", "default")).toBe("default");
    expect(client.currentDatafile()?.flags["hello-world"]).toBeUndefined();
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      flagKey: "hello-world",
      oldValue: true,
      newValue: null,
    });
    client.close();
  });

  it("ignores a patch whose `from` does not match the held version (gap or stale)", async () => {
    const client = makeClient(true);
    await client.ready();
    expect(client.getValue("hello-world", false)).toBe(true);

    const changes: ChangeEvent[] = [];
    client.on("change", (e) => changes.push(e));
    const source = MockEventSource.instances[0]!;

    // Gap: patch builds on version 2 but we hold 1.
    source.emitPatch(
      patchFrame({ from: 2, to: 3, flags: { "hello-world": boolFlag("hello-world", "v-off") } }),
    );
    await flush();
    // Stale: patch builds on version 0, older than what we hold.
    source.emitPatch(
      patchFrame({ from: 0, to: 1, flags: { "hello-world": boolFlag("hello-world", "v-off") } }),
    );
    await flush();

    expect(changes).toHaveLength(0);
    expect(client.getValue("hello-world", false)).toBe(true);
    expect(client.currentDatafile()?.version).toBe(1);
    expect(client.currentDatafile()?.etag).toBe("abc123");
    client.close();
  });

  it("ignores malformed / non-numeric patch frames", async () => {
    const client = makeClient(true);
    await client.ready();

    const changes: ChangeEvent[] = [];
    client.on("change", (e) => changes.push(e));
    const source = MockEventSource.instances[0]!;

    source.emitRawPatch("not json at all");
    source.emitRawPatch("{ broken");
    // from/to not numbers.
    source.emitPatch({ ...patchFrame({ from: 1, to: 2 }), from: "1", to: "2" });
    // missing etag.
    source.emitPatch({ ...patchFrame({ from: 1, to: 2 }), etag: 5 });
    await flush();

    expect(changes).toHaveLength(0);
    expect(client.getValue("hello-world", false)).toBe(true);
    expect(client.currentDatafile()?.version).toBe(1);
    client.close();
  });

  it("applies multiple chained patches in sequence", async () => {
    const client = makeClient(true);
    await client.ready();
    expect(client.getValue("hello-world", false)).toBe(true);

    const source = MockEventSource.instances[0]!;

    // 1 -> 2: flip hello-world off.
    source.emitPatch(
      patchFrame({ from: 1, to: 2, flags: { "hello-world": boolFlag("hello-world", "v-off") } }),
    );
    await flush();
    expect(client.getValue("hello-world", true)).toBe(false);
    expect(client.currentDatafile()?.version).toBe(2);

    // 2 -> 3: add a new flag.
    source.emitPatch(
      patchFrame({ from: 2, to: 3, flags: { extra: boolFlag("extra", "v-on") } }),
    );
    await flush();
    expect(client.getValue("extra", false)).toBe(true);
    expect(client.currentDatafile()?.version).toBe(3);

    // 3 -> 4: remove the new flag and flip hello-world back on.
    source.emitPatch(
      patchFrame({
        from: 3,
        to: 4,
        flags: { "hello-world": boolFlag("hello-world", "v-on") },
        removedFlags: ["extra"],
      }),
    );
    await flush();
    expect(client.getValue("hello-world", false)).toBe(true);
    expect(client.getValue("extra", "gone")).toBe("gone");
    expect(client.currentDatafile()?.version).toBe(4);
    expect(client.currentDatafile()?.etag).toBe("etag-4");
    client.close();
  });

  it("a patch advances the etag so the next conditional poll sends a fresh If-None-Match", async () => {
    const seen: (string | null)[] = [];
    const recordingFetch = (async (_url: string, init: RequestInit) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      seen.push(headers["If-None-Match"] ?? null);
      return {
        status: 304,
        ok: false,
        statusText: "not modified",
        headers: { get: () => null },
        json: async () => {
          throw new Error("no body on 304");
        },
      };
    }) as unknown as typeof fetch;

    const client = new FeatWebClient({
      apiKey: "feat_cs_abc",
      url: "https://dp.example.com",
      context: { targetingKey: "u" },
      crossTabSync: false,
      events: false,
      // Seed version 1 + etag abc123 without needing the first fetch to body.
      bootstrap: BASE_DATAFILE,
      fetch: recordingFetch,
      eventSource: mockCtor,
      streaming: true,
    });
    await client.ready();
    // The bootstrap's etag drove the first conditional poll.
    expect(seen[seen.length - 1]).toBe("abc123");

    MockEventSource.instances[0]!.emitPatch(
      patchFrame({ from: 1, to: 2, flags: { "hello-world": boolFlag("hello-world", "v-off") } }),
    );
    await flush();

    await client.refresh();
    // The poll after the patch carries the patch's etag, so the server can 304.
    expect(seen[seen.length - 1]).toBe("etag-2");
    client.close();
  });

  it("warns once and falls back to polling when no EventSource is available", async () => {
    // Simulate a host (SSR / older runtime) with no EventSource and no
    // override: the client should fall back to polling without throwing.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const original = (globalThis as { EventSource?: unknown }).EventSource;
    delete (globalThis as { EventSource?: unknown }).EventSource;
    try {
      const client = new FeatWebClient({
        apiKey: "feat_cs_abc",
        url: "https://dp.example.com",
        context: { targetingKey: "u" },
        crossTabSync: false,
        events: false,
        fetch: baseFetch,
        streaming: true,
      });
      await client.ready();
      // Polling carries the load; the omission is surfaced exactly once.
      expect(client.currentDatafile()?.version).toBe(1);
      expect(warn).toHaveBeenCalledWith(
        "feat: streaming requested but EventSource is unavailable; using polling",
      );
      expect(warn).toHaveBeenCalledTimes(1);
      client.close();
    } finally {
      if (original !== undefined) {
        (globalThis as { EventSource?: unknown }).EventSource = original;
      }
      warn.mockRestore();
    }
  });
});
