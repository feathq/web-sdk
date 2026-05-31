import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Datafile } from "@feathq/datafile-schema";
import { FeatWebClient } from "../src/client";
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

function withFlagFlipped(): Datafile {
  return {
    ...BASE_DATAFILE,
    version: 2,
    etag: "def456",
    flags: {
      ...BASE_DATAFILE.flags,
      "hello-world": {
        ...BASE_DATAFILE.flags["hello-world"]!,
        defaultVariationId: "v-off",
      },
    },
  };
}

interface MockResponse {
  status: number;
  body?: string;
  etag?: string;
}

function makeFetch(responses: MockResponse[]): typeof fetch {
  let i = 0;
  return (async () => {
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      statusText: `status ${r.status}`,
      headers: { get: (k: string) => (k.toLowerCase() === "etag" ? (r.etag ?? null) : null) },
      json: async () => (r.body ? JSON.parse(r.body) : null),
    };
  }) as unknown as typeof fetch;
}

describe("FeatWebClient", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects non-client_side_id keys at construct", () => {
    expect(
      () =>
        new FeatWebClient({
          apiKey: "feat_sdk_serverkey",
          dataPlaneUrl: "https://dp.example.com",
        }),
    ).toThrow(/client_side_id/);
  });

  it("ready() resolves after first fetch", async () => {
    const client = new FeatWebClient({
      apiKey: "feat_cs_abc",
      dataPlaneUrl: "https://dp.example.com",
      fetch: makeFetch([
        { status: 200, body: JSON.stringify(BASE_DATAFILE), etag: BASE_DATAFILE.etag },
      ]),
    });
    await client.ready();
    expect(client.currentDatafile()).toEqual(BASE_DATAFILE);
    client.close();
  });

  it("getValue returns default + ERROR before context is set", async () => {
    const client = new FeatWebClient({
      apiKey: "feat_cs_abc",
      dataPlaneUrl: "https://dp.example.com",
      fetch: makeFetch([{ status: 200, body: JSON.stringify(BASE_DATAFILE) }]),
    });
    await client.ready();
    expect(client.getValue("hello-world", false)).toBe(false);
    expect(client.getDetail("hello-world", false).reason).toBe("ERROR");
    client.close();
  });

  it("populates sync cache once both datafile and context are present", async () => {
    const client = new FeatWebClient({
      apiKey: "feat_cs_abc",
      dataPlaneUrl: "https://dp.example.com",
      context: { targetingKey: "u" },
      fetch: makeFetch([{ status: 200, body: JSON.stringify(BASE_DATAFILE) }]),
    });
    await client.ready();
    expect(client.getValue("hello-world", false)).toBe(true);
    expect(client.getDetail("hello-world", false).variationId).toBe("v-on");
    client.close();
  });

  it("setContext after ready re-evaluates", async () => {
    const client = new FeatWebClient({
      apiKey: "feat_cs_abc",
      dataPlaneUrl: "https://dp.example.com",
      fetch: makeFetch([{ status: 200, body: JSON.stringify(BASE_DATAFILE) }]),
    });
    await client.ready();
    expect(client.getValue("hello-world", false)).toBe(false);
    await client.setContext({ targetingKey: "u" });
    expect(client.getValue("hello-world", false)).toBe(true);
    client.close();
  });

  it("emits change event when a flag's value flips", async () => {
    const client = new FeatWebClient({
      apiKey: "feat_cs_abc",
      dataPlaneUrl: "https://dp.example.com",
      context: { targetingKey: "u" },
      fetch: makeFetch([
        { status: 200, body: JSON.stringify(BASE_DATAFILE) },
        { status: 200, body: JSON.stringify(withFlagFlipped()) },
      ]),
    });
    await client.ready();
    const events: ChangeEvent[] = [];
    client.on("change", (e) => events.push(e));
    const changed = await client.refresh();
    expect(changed).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      flagKey: "hello-world",
      oldValue: true,
      newValue: false,
      oldVariation: "v-on",
      newVariation: "v-off",
    });
    client.close();
  });

  it("does NOT emit change event when value is unchanged", async () => {
    const client = new FeatWebClient({
      apiKey: "feat_cs_abc",
      dataPlaneUrl: "https://dp.example.com",
      context: { targetingKey: "u" },
      fetch: makeFetch([
        { status: 200, body: JSON.stringify(BASE_DATAFILE) },
        { status: 200, body: JSON.stringify({ ...BASE_DATAFILE, version: 2, etag: "x" }) },
      ]),
    });
    await client.ready();
    const events: ChangeEvent[] = [];
    client.on("change", (e) => events.push(e));
    await client.refresh();
    expect(events).toHaveLength(0);
    client.close();
  });

  it("emits ready event on bootstrap", async () => {
    const client = new FeatWebClient({
      apiKey: "feat_cs_abc",
      dataPlaneUrl: "https://dp.example.com",
      fetch: makeFetch([{ status: 200, body: JSON.stringify(BASE_DATAFILE) }]),
    });
    const fired: boolean[] = [];
    client.on("ready", () => fired.push(true));
    await client.ready();
    expect(fired).toEqual([true]);
    client.close();
  });

  it("emits failed event when first fetch errors", async () => {
    const failingFetch: typeof fetch = async () => {
      throw new Error("network down");
    };
    const client = new FeatWebClient({
      apiKey: "feat_cs_abc",
      dataPlaneUrl: "https://dp.example.com",
      fetch: failingFetch,
    });
    const errs: Error[] = [];
    client.on("failed", (e) => errs.push(e));
    await expect(client.ready()).rejects.toThrow(/network down/);
    expect(errs).toHaveLength(1);
    client.close();
  });

  it("getBooleanValue / getStringValue coerce by type", async () => {
    const client = new FeatWebClient({
      apiKey: "feat_cs_abc",
      dataPlaneUrl: "https://dp.example.com",
      context: { targetingKey: "u" },
      fetch: makeFetch([{ status: 200, body: JSON.stringify(BASE_DATAFILE) }]),
    });
    await client.ready();
    expect(client.getBooleanValue("hello-world", false)).toBe(true);
    // Wrong type query returns the default rather than the actual boolean.
    expect(client.getStringValue("hello-world", "fallback")).toBe("fallback");
    expect(client.getNumberValue("hello-world", 0)).toBe(0);
    client.close();
  });

  it("allFlags returns a snapshot of the cache", async () => {
    const client = new FeatWebClient({
      apiKey: "feat_cs_abc",
      dataPlaneUrl: "https://dp.example.com",
      context: { targetingKey: "u" },
      fetch: makeFetch([{ status: 200, body: JSON.stringify(BASE_DATAFILE) }]),
    });
    await client.ready();
    const all = client.allFlags();
    expect(all.size).toBe(1);
    expect(all.get("hello-world")?.value).toBe(true);
    client.close();
  });

  it("304 is a no-op (no change event, datafile preserved)", async () => {
    const client = new FeatWebClient({
      apiKey: "feat_cs_abc",
      dataPlaneUrl: "https://dp.example.com",
      context: { targetingKey: "u" },
      fetch: makeFetch([
        { status: 200, body: JSON.stringify(BASE_DATAFILE), etag: BASE_DATAFILE.etag },
        { status: 304 },
      ]),
    });
    await client.ready();
    const events: ChangeEvent[] = [];
    client.on("change", (e) => events.push(e));
    const changed = await client.refresh();
    expect(changed).toBe(false);
    expect(events).toHaveLength(0);
    client.close();
  });

  it("close() clears the polling timer and visibility listener", async () => {
    const client = new FeatWebClient({
      apiKey: "feat_cs_abc",
      dataPlaneUrl: "https://dp.example.com",
      fetch: makeFetch([{ status: 200, body: JSON.stringify(BASE_DATAFILE) }]),
    });
    await client.ready();
    const removeSpy = vi.spyOn(document, "removeEventListener");
    client.close();
    expect(removeSpy).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
  });
});
