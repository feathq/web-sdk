import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Datafile } from "@feathq/datafile-schema";
import { FeatWebClient } from "../src/client";

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

function passingFetch(): typeof fetch {
  return (async () => ({
    status: 200,
    ok: true,
    statusText: "ok",
    headers: { get: () => "abc123" },
    json: async () => BASE_DATAFILE,
  })) as unknown as typeof fetch;
}

describe("bootstrap + localStorage cache", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.useFakeTimers();
  });

  it("bootstrap seeds the datafile so getValue works before the fetch", async () => {
    const client = new FeatWebClient({
      apiKey: "feat_cs_x",
      url: "https://dp.example.com",
      context: { targetingKey: "u" },
      bootstrap: BASE_DATAFILE,
      // fetch hangs (never resolves) to prove we don't wait on it.
      fetch: (() => new Promise(() => {})) as unknown as typeof fetch,
    });
    // Trigger bootstrap explicitly; we don't await it because the fetch
    // is hanging, but the seeded datafile and the synchronously-set
    // context combine so the eval cache is computed inline.
    void client.ready();
    await Promise.resolve();
    await Promise.resolve();
    expect(client.getValue("hello-world", false)).toBe(true);
    client.close();
  });

  it("localStorage cache: second client picks up the saved datafile", async () => {
    const first = new FeatWebClient({
      apiKey: "feat_cs_x",
      url: "https://dp.example.com",
      context: { targetingKey: "u" },
      cache: { storage: "localStorage" },
      fetch: passingFetch(),
    });
    await first.ready();
    first.close();
    expect(window.localStorage.getItem("feat:datafile")).toBeTruthy();

    const second = new FeatWebClient({
      apiKey: "feat_cs_x",
      url: "https://dp.example.com",
      context: { targetingKey: "u" },
      cache: { storage: "localStorage" },
      fetch: (() => new Promise(() => {})) as unknown as typeof fetch,
    });
    void second.ready();
    await Promise.resolve();
    await Promise.resolve();
    expect(second.getValue("hello-world", false)).toBe(true);
    second.close();
  });

  it("bootstrap takes precedence over a stale cached datafile", async () => {
    window.localStorage.setItem(
      "feat:datafile",
      JSON.stringify({
        datafile: {
          ...BASE_DATAFILE,
          version: 0,
          flags: {
            ...BASE_DATAFILE.flags,
            "hello-world": {
              ...BASE_DATAFILE.flags["hello-world"]!,
              defaultVariationId: "v-off",
            },
          },
        },
        etag: "stale",
      }),
    );
    const client = new FeatWebClient({
      apiKey: "feat_cs_x",
      url: "https://dp.example.com",
      context: { targetingKey: "u" },
      bootstrap: BASE_DATAFILE,
      cache: { storage: "localStorage" },
      fetch: (() => new Promise(() => {})) as unknown as typeof fetch,
    });
    void client.ready();
    await Promise.resolve();
    await Promise.resolve();
    expect(client.getValue("hello-world", false)).toBe(true);
    client.close();
  });

  it("a missing cache key just falls through to fetch", async () => {
    const client = new FeatWebClient({
      apiKey: "feat_cs_x",
      url: "https://dp.example.com",
      context: { targetingKey: "u" },
      cache: { storage: "localStorage" },
      fetch: passingFetch(),
    });
    await client.ready();
    expect(client.getValue("hello-world", false)).toBe(true);
    client.close();
  });
});
