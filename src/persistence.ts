import type { Datafile } from "@feathq/datafile-schema";

const STORAGE_KEY = "feat:datafile";

export type DatafileCacheStorage = "localStorage";

export interface DatafileCacheConfig {
  storage: DatafileCacheStorage;
}

interface CachedDatafilePayload {
  datafile: Datafile;
  etag: string | null;
}

// Read a previously-persisted datafile from localStorage. Defensive about
// shape (the apiKey or env may have changed since the last write); a
// failed parse just returns null and the SDK falls back to a fresh fetch.
export function loadCachedDatafile(config: DatafileCacheConfig): CachedDatafilePayload | null {
  if (config.storage !== "localStorage" || !hasLocalStorage()) return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedDatafilePayload>;
    if (!parsed.datafile || typeof parsed.datafile !== "object") return null;
    const df = parsed.datafile as Datafile;
    if (typeof df.envId !== "string" || typeof df.version !== "number") return null;
    return { datafile: df, etag: parsed.etag ?? null };
  } catch {
    return null;
  }
}

export function saveCachedDatafile(
  config: DatafileCacheConfig,
  payload: CachedDatafilePayload,
): void {
  if (config.storage !== "localStorage" || !hasLocalStorage()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // QuotaExceeded / private mode: silently skip; the SDK still works
    // from memory.
  }
}

function hasLocalStorage(): boolean {
  try {
    return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
  } catch {
    return false;
  }
}
