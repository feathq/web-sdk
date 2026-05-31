export type {
  ContextKindObject,
  EvalContext,
  EvaluationResult,
  Reason,
} from "@feathq/feat-eval";
export type { Datafile } from "@feathq/datafile-schema";

import type { EvalContext } from "@feathq/feat-eval";
import type { AnonymousConfig } from "./anonymous";

export type { AnonymousConfig, AnonymousStorage } from "./anonymous";

export interface FeatWebClientConfig {
  apiKey: string;
  dataPlaneUrl: string;
  // Initial evaluation context. Can also be set later via setContext().
  // The cache stays empty (and getValue returns the default) until both
  // datafile and context are present.
  context?: EvalContext;
  // Opt-in anonymous-context generator. When set AND `context` is not
  // provided, the client mints (or reads) a stable per-browser UUID and
  // uses { targetingKey: uuid, user: { key: uuid, anonymous: true } }.
  anonymous?: AnonymousConfig;
  // Background-poll interval in ms. Defaults to 30s, matching CF KV's
  // global-replication ceiling and the cadence the marketing site quotes.
  pollIntervalMs?: number;
  // Fetch override for tests / non-browser hosts. Defaults to
  // globalThis.fetch.
  fetch?: typeof fetch;
}

export interface ChangeEvent {
  flagKey: string;
  oldValue: unknown;
  newValue: unknown;
  oldVariation: string | null;
  newVariation: string | null;
}

export interface FlagEventMap {
  ready: undefined;
  update: undefined;
  change: ChangeEvent;
  failed: Error;
}
