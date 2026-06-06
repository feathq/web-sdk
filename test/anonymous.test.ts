import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetAnonymousMemoryForTests,
  buildAnonymousContext,
} from "../src/anonymous";
import { FeatWebClient } from "../src/client";

const SAMPLE_DATAFILE = JSON.stringify({
  schemaVersion: 1,
  envId: "e",
  envKey: "p",
  projectId: "p",
  version: 1,
  etag: "x",
  generatedAt: new Date().toISOString(),
  flags: {},
  segments: {},
  contextKinds: {
    user: { key: "user", availableForRules: true, availableForExperiments: true },
  },
});

function passingFetch(): typeof fetch {
  return (async () => ({
    status: 200,
    ok: true,
    statusText: "ok",
    headers: { get: () => null },
    json: async () => JSON.parse(SAMPLE_DATAFILE),
  })) as unknown as typeof fetch;
}

describe("anonymous context", () => {
  beforeEach(() => {
    window.localStorage.clear();
    _resetAnonymousMemoryForTests();
  });

  it("mints and persists a uuid in localStorage", () => {
    const ctx1 = buildAnonymousContext({ storage: "localStorage" });
    const ctx2 = buildAnonymousContext({ storage: "localStorage" });
    expect(ctx1?.targetingKey).toBeDefined();
    expect(ctx1?.targetingKey).toBe(ctx2?.targetingKey);
    expect(window.localStorage.getItem("feat:anonymousKey")).toBe(ctx1?.targetingKey);
  });

  it("memory storage persists within a process but not across resets", () => {
    const ctx1 = buildAnonymousContext({ storage: "memory" });
    const ctx2 = buildAnonymousContext({ storage: "memory" });
    expect(ctx1?.targetingKey).toBe(ctx2?.targetingKey);
    _resetAnonymousMemoryForTests();
    const ctx3 = buildAnonymousContext({ storage: "memory" });
    expect(ctx3?.targetingKey).not.toBe(ctx1?.targetingKey);
  });

  it("anonymous context is shaped { targetingKey, user.key, user.anonymous }", () => {
    const ctx = buildAnonymousContext({ storage: "memory" });
    expect(ctx).toMatchObject({
      targetingKey: expect.any(String),
      user: { key: expect.any(String), anonymous: true },
    });
    expect((ctx?.user as { key: string }).key).toBe(ctx?.targetingKey);
  });

  it("explicit context overrides anonymous config", () => {
    const client = new FeatWebClient({
      apiKey: "feat_cs_x",
      url: "https://dp.example.com",
      context: { targetingKey: "explicit" },
      anonymous: { storage: "localStorage" },
      fetch: passingFetch(),
    });
    expect(client.currentContext()?.targetingKey).toBe("explicit");
    client.close();
  });

  it("client wires anonymous context when none provided", () => {
    const client = new FeatWebClient({
      apiKey: "feat_cs_x",
      url: "https://dp.example.com",
      anonymous: { storage: "localStorage" },
      fetch: passingFetch(),
    });
    expect(client.currentContext()?.targetingKey).toBe(
      window.localStorage.getItem("feat:anonymousKey"),
    );
    client.close();
  });
});
