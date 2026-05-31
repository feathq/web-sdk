// Re-export the eval-engine types so consumers import everything from
// @feathq/feat-web-sdk and never need a direct dep on @feathq/feat-eval.
export type {
  ContextKindObject,
  EvalContext,
  EvaluationResult,
  Reason,
} from "@feathq/feat-eval";
export type { Datafile } from "@feathq/datafile-schema";

export interface FeatWebClientConfig {
  apiKey: string;
  dataPlaneUrl: string;
  // Background-poll interval in ms. Defaults to 30s, matching CF KV's
  // global-replication ceiling and the cadence the marketing site quotes.
  pollIntervalMs?: number;
  // Fetch override for tests / non-browser hosts. Defaults to
  // globalThis.fetch.
  fetch?: typeof fetch;
}
