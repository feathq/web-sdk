import type { EvalContext } from "@feathq/feat-eval";

const STORAGE_KEY = "feat:anonymousKey";

export type AnonymousStorage = "localStorage" | "memory";

export interface AnonymousConfig {
  storage: AnonymousStorage;
}

// Build a stable anonymous EvalContext: a UUID minted on first call,
// persisted per the storage option so the same browser hits the same
// targeting bucket across reloads. Falls back from localStorage to
// in-process on QuotaExceeded / private mode / disabled-storage browsers.
export function buildAnonymousContext(config: AnonymousConfig): EvalContext {
  const key = resolveOrMintAnonymousKey(config.storage);
  return {
    targetingKey: key,
    user: { key, anonymous: true },
  };
}

let memoryKey: string | null = null;

function resolveOrMintAnonymousKey(storage: AnonymousStorage): string {
  if (storage === "localStorage" && hasLocalStorage()) {
    try {
      const existing = window.localStorage.getItem(STORAGE_KEY);
      if (existing) return existing;
      const fresh = randomKey();
      window.localStorage.setItem(STORAGE_KEY, fresh);
      return fresh;
    } catch {
      // Private mode / quota / disabled cookies: fall through to memory.
    }
  }
  if (memoryKey) return memoryKey;
  memoryKey = randomKey();
  return memoryKey;
}

function hasLocalStorage(): boolean {
  try {
    return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
  } catch {
    return false;
  }
}

function randomKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Older browsers without crypto.randomUUID. Uses crypto.getRandomValues
  // when available, otherwise Math.random as a last resort. The fallback
  // bytes aren't a strict RFC 4122 UUIDv4 but are unique-enough for
  // anonymous bucketing.
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    buf[6] = ((buf[6] ?? 0) & 0x0f) | 0x40;
    buf[8] = ((buf[8] ?? 0) & 0x3f) | 0x80;
    return formatUuid(buf);
  }
  let s = "";
  for (let i = 0; i < 32; i++) {
    s += Math.floor(Math.random() * 16).toString(16);
  }
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

function formatUuid(bytes: Uint8Array): string {
  const hex: string[] = [];
  for (let i = 0; i < 16; i++) {
    hex.push(((bytes[i] ?? 0) & 0xff).toString(16).padStart(2, "0"));
  }
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

// Test-only escape hatch: reset the in-process memory cache so suites
// can simulate a fresh page load without restarting the runtime.
export function _resetAnonymousMemoryForTests(): void {
  memoryKey = null;
}
