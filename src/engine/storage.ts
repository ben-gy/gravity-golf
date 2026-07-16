/**
 * storage.ts — namespaced, typed, quota-safe localStorage (copied from
 * patterns/). Local-only by design; games are offline-capable.
 */

export function createStore(namespace: string) {
  const key = (k: string) => `game:${namespace}:${k}`;

  function get<T>(k: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(key(k));
      if (raw == null) return fallback;
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  function set<T>(k: string, value: T): void {
    try {
      localStorage.setItem(key(k), JSON.stringify(value));
    } catch {
      // quota exceeded / disabled — persistence is best-effort
    }
  }

  function remove(k: string): void {
    try {
      localStorage.removeItem(key(k));
    } catch {
      /* ignore */
    }
  }

  return { get, set, remove };
}
