export type {
  ContextKindObject,
  EvalContext,
  EvaluationResult,
  Reason,
} from "@feathq/feat-eval";
export type { Datafile } from "@feathq/datafile-schema";

import type { Datafile } from "@feathq/datafile-schema";
import type { EvalContext } from "@feathq/feat-eval";
import type { AnonymousConfig } from "./anonymous";
import type { DatafileCacheConfig } from "./persistence";
import type { EventSourceConstructor } from "./streaming";

export type { AnonymousConfig, AnonymousStorage } from "./anonymous";
export type { DatafileCacheConfig, DatafileCacheStorage } from "./persistence";
export type { EventSourceConstructor } from "./streaming";

export interface FeatWebClientConfig {
  apiKey: string;
  // Optional. Defaults to the production endpoint. Override if you have
  // been pointed at a different region or a staging endpoint.
  url?: string;
  // Initial evaluation context. Can also be set later via setContext().
  // The cache stays empty (and getValue returns the default) until both
  // datafile and context are present.
  context?: EvalContext;
  // Opt-in anonymous-context generator. When set AND `context` is not
  // provided, the client mints (or reads) a stable per-browser UUID and
  // uses { targetingKey: uuid, user: { key: uuid, anonymous: true } }.
  anonymous?: AnonymousConfig;
  // Server-rendered datafile to seed the SDK with (SSR / RSC hydration).
  // Skips the first network fetch so the first render has real values.
  // Takes precedence over `cache`.
  bootstrap?: Datafile;
  // Opt-in persistence of the last-seen datafile so the next page load
  // can render flag values immediately while the SDK refreshes in the
  // background. Default off so targeting rules aren't cached on shared
  // browsers without an explicit decision by the integrator.
  cache?: DatafileCacheConfig;
  // Background-poll interval in ms. Defaults to 30s. Floored at 5s to
  // protect both the SDK consumer and the feat endpoint from accidental
  // hot loops.
  pollIntervalMs?: number;
  // Cross-tab sync via BroadcastChannel. When a tab fetches a new
  // datafile, sibling tabs adopt it without their own network call.
  // Default on; set false for tests or if you want every tab to fetch
  // independently.
  crossTabSync?: boolean;
  // Usage event reporting. The SDK summarizes the contexts it evaluates
  // (one per end user this browser represents) and flushes them to the
  // platform so they count toward your MAU. Defaults to on; set false to
  // disable entirely (e.g. self-hosted or test runs).
  events?: boolean;
  // How often, in ms, to flush summarized contexts. Defaults to 60s,
  // floored at 5s. Ignored when events is false.
  eventsFlushIntervalMs?: number;
  // Fetch override for tests / non-browser hosts. Defaults to
  // globalThis.fetch.
  fetch?: typeof fetch;
  // Live datafile streaming over Server-Sent Events. The server pushes
  // the full datafile on every change and the SDK adopts it in version order
  // (no HTTP refetch), so `change` events fire near-instantly instead of on
  // the poll interval. Three modes:
  //   undefined (default) - streaming follows subscription: the stream opens
  //     when the first `change` listener is added and closes when the last
  //     one is removed, so a page that never listens pays nothing.
  //   true  - always stream, opening once the client is ready.
  //   false - never stream.
  // Polling stays on as the safety net in every mode.
  streaming?: boolean;
  // EventSource override for tests / non-browser hosts. Defaults to
  // globalThis.EventSource.
  eventSource?: EventSourceConstructor;
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
