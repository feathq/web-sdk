import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Datafile } from "@feathq/datafile-schema";
import { FeatWebClient } from "../src/client";

const SAMPLE_DATAFILE: Datafile = {
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

  it("accepts feat_cs_ keys and resolves ready() after first fetch", async () => {
    const client = new FeatWebClient({
      apiKey: "feat_cs_abc",
      dataPlaneUrl: "https://dp.example.com",
      fetch: makeFetch([
        { status: 200, body: JSON.stringify(SAMPLE_DATAFILE), etag: SAMPLE_DATAFILE.etag },
      ]),
    });
    await client.ready();
    expect(client.currentDatafile()).toEqual(SAMPLE_DATAFILE);
    client.close();
  });

  it("evaluate() returns ERROR before ready()", async () => {
    const client = new FeatWebClient({
      apiKey: "feat_cs_abc",
      dataPlaneUrl: "https://dp.example.com",
      fetch: makeFetch([{ status: 200, body: JSON.stringify(SAMPLE_DATAFILE) }]),
    });
    const result = await client.evaluate("hello-world", false, { targetingKey: "u" });
    expect(result.reason).toBe("ERROR");
    expect(result.value).toBe(false);
    client.close();
  });

  it("evaluate() returns the flag value after ready()", async () => {
    const client = new FeatWebClient({
      apiKey: "feat_cs_abc",
      dataPlaneUrl: "https://dp.example.com",
      fetch: makeFetch([{ status: 200, body: JSON.stringify(SAMPLE_DATAFILE) }]),
    });
    await client.ready();
    const result = await client.evaluate("hello-world", false, { targetingKey: "u" });
    expect(result.value).toBe(true);
    expect(result.variationId).toBe("v-on");
    client.close();
  });

  it("304 preserves the in-memory datafile", async () => {
    const client = new FeatWebClient({
      apiKey: "feat_cs_abc",
      dataPlaneUrl: "https://dp.example.com",
      fetch: makeFetch([
        { status: 200, body: JSON.stringify(SAMPLE_DATAFILE), etag: SAMPLE_DATAFILE.etag },
        { status: 304 },
      ]),
    });
    await client.ready();
    const changed = await client.refresh();
    expect(changed).toBe(false);
    expect(client.currentDatafile()).toEqual(SAMPLE_DATAFILE);
    client.close();
  });

  it("404 (no datafile yet) is treated as transient", async () => {
    const client = new FeatWebClient({
      apiKey: "feat_cs_abc",
      dataPlaneUrl: "https://dp.example.com",
      fetch: makeFetch([{ status: 404 }]),
    });
    await client.ready();
    expect(client.currentDatafile()).toBeNull();
    client.close();
  });

  it("429 doesn't throw and keeps last-known datafile", async () => {
    const client = new FeatWebClient({
      apiKey: "feat_cs_abc",
      dataPlaneUrl: "https://dp.example.com",
      fetch: makeFetch([
        { status: 200, body: JSON.stringify(SAMPLE_DATAFILE) },
        { status: 429 },
      ]),
    });
    await client.ready();
    const changed = await client.refresh();
    expect(changed).toBe(false);
    expect(client.currentDatafile()).toEqual(SAMPLE_DATAFILE);
    client.close();
  });

  it("close() clears the polling timer and visibility listener", async () => {
    const client = new FeatWebClient({
      apiKey: "feat_cs_abc",
      dataPlaneUrl: "https://dp.example.com",
      fetch: makeFetch([{ status: 200, body: JSON.stringify(SAMPLE_DATAFILE) }]),
    });
    await client.ready();
    const removeSpy = vi.spyOn(document, "removeEventListener");
    client.close();
    expect(removeSpy).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
  });
});
