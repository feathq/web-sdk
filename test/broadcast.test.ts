import { beforeEach, describe, expect, it } from "vitest";
import type { Datafile } from "@feathq/datafile-schema";
import { FeatWebClient } from "../src/client";

const V1: Datafile = {
  schemaVersion: 1,
  envId: "env-1",
  envKey: "p",
  projectId: "p",
  version: 1,
  etag: "v1",
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

const V2: Datafile = {
  ...V1,
  version: 2,
  etag: "v2",
  flags: {
    ...V1.flags,
    "hello-world": { ...V1.flags["hello-world"]!, defaultVariationId: "v-off" },
  },
};

function makeFetch(responses: { status: number; body?: string; etag?: string }[]): typeof fetch {
  let i = 0;
  return (async () => {
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      statusText: `s ${r.status}`,
      headers: { get: (k: string) => (k.toLowerCase() === "etag" ? (r.etag ?? null) : null) },
      json: async () => (r.body ? JSON.parse(r.body) : null),
    };
  }) as unknown as typeof fetch;
}

describe("cross-tab BroadcastChannel sync", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("a publisher tab's fetched datafile is adopted by a sibling tab", async () => {
    // Sibling tab is constructed first with a hanging fetch; without the
    // broadcast it would never have a datafile to evaluate from.
    const sibling = new FeatWebClient({
      apiKey: "feat_cs_x",
      dataPlaneUrl: "https://dp.example.com",
      context: { targetingKey: "u" },
      fetch: (() => new Promise(() => {})) as unknown as typeof fetch,
    });
    void sibling.ready();

    const publisher = new FeatWebClient({
      apiKey: "feat_cs_x",
      dataPlaneUrl: "https://dp.example.com",
      context: { targetingKey: "u" },
      fetch: makeFetch([{ status: 200, body: JSON.stringify(V1) }]),
    });
    await publisher.ready();

    // Let microtasks/macrotasks drain so the BroadcastChannel message
    // (delivered via the event loop) reaches the sibling.
    await new Promise((r) => setTimeout(r, 0));
    expect(sibling.getValue("hello-world", false)).toBe(true);

    publisher.close();
    sibling.close();
  });

  it("does not adopt an older-version broadcast", async () => {
    const tab = new FeatWebClient({
      apiKey: "feat_cs_x",
      dataPlaneUrl: "https://dp.example.com",
      context: { targetingKey: "u" },
      fetch: makeFetch([{ status: 200, body: JSON.stringify(V2) }]),
    });
    await tab.ready();
    expect(tab.getValue("hello-world", false)).toBe(false); // v2 default

    const olderTab = new FeatWebClient({
      apiKey: "feat_cs_x",
      dataPlaneUrl: "https://dp.example.com",
      context: { targetingKey: "u" },
      fetch: makeFetch([{ status: 200, body: JSON.stringify(V1) }]),
    });
    await olderTab.ready();
    // Wait for any cross-tab races to settle.
    await new Promise((r) => setTimeout(r, 0));
    // tab1 should not regress to V1 because V1.version < V2.version.
    expect(tab.getValue("hello-world", false)).toBe(false);

    tab.close();
    olderTab.close();
  });

  it("crossTabSync: false suppresses both publish and subscribe", async () => {
    const sibling = new FeatWebClient({
      apiKey: "feat_cs_x",
      dataPlaneUrl: "https://dp.example.com",
      context: { targetingKey: "u" },
      crossTabSync: false,
      fetch: (() => new Promise(() => {})) as unknown as typeof fetch,
    });
    void sibling.ready();
    const publisher = new FeatWebClient({
      apiKey: "feat_cs_x",
      dataPlaneUrl: "https://dp.example.com",
      context: { targetingKey: "u" },
      crossTabSync: false,
      fetch: makeFetch([{ status: 200, body: JSON.stringify(V1) }]),
    });
    await publisher.ready();
    await new Promise((r) => setTimeout(r, 0));
    expect(sibling.currentDatafile()).toBeNull();
    publisher.close();
    sibling.close();
  });
});
