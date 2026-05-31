import type { EvalContext } from "@feathq/feat-eval";

const STORAGE_KEY = "feat:anonymousKey";

export type AnonymousStorage = "localStorage" | "memory";

export interface AnonymousConfig {
  storage: AnonymousStorage;
}

// Build a stable anonymous EvalContext: a uuidv4 minted on first call,
// persisted per the storage option so the same browser hits the same
// targeting bucket across reloads.
//
// Returns null when called in a non-DOM environment with storage=memory
// and crypto.randomUUID is absent. Falls back from localStorage to
// in-process on QuotaExceeded / disabled-storage browsers.
export function buildAnonymousContext(config: AnonymousConfig): EvalContext | null {
  const key = resolveOrMintAnonymousKey(config.storage);
  if (!key) return null;
  return {
    targetingKey: key,
    user: { key, anonymous: true },
  };
}

let memoryKey: string | null = null;

function resolveOrMintAnonymousKey(storage: AnonymousStorage): string | null {
  if (storage === "localStorage" && hasLocalStorage()) {
    try {
      const existing = window.localStorage.getItem(STORAGE_KEY);
      if (existing) return existing;
      const fresh = randomKey();
      if (!fresh) return null;
      window.localStorage.setItem(STORAGE_KEY, fresh);
      return fresh;
    } catch {
      // Private mode / quota / disabled cookies: fall through to memory.
    }
  }
  if (memoryKey) return memoryKey;
  const fresh = randomKey();
  if (!fresh) return null;
  memoryKey = fresh;
  return memoryKey;
}

function hasLocalStorage(): boolean {
  try {
    return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
  } catch {
    return false;
  }
}

function randomKey(): string | null {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return null;
}

// Test-only escape hatch: reset the in-process memory cache so suites
// can simulate a fresh page load without restarting the runtime.
export function _resetAnonymousMemoryForTests(): void {
  memoryKey = null;
}
