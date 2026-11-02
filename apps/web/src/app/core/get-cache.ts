/** Called with the fresh answer when a stored one was returned first and the server's differs. */
export type OnFresh<T> = (fresh: T) => void;

/** How long a stored answer is used without asking the server again, unless told otherwise. */
export const MAX_AGE_MS = 60_000;

export interface StoreOptions<T> {
  onFresh?: OnFresh<T>;
  /** How long the answer counts as fresh; `Infinity` for answers that change only on a deploy. */
  maxAge?: number;
}

interface Stored {
  json: string;
  at: number;
}

/**
 * Shares GETs in flight and keeps answers for a second visit. With `store`, `get` returns:
 * - a copy of the stored answer, and no request, while it is younger than `maxAge`;
 * - once older, with `onFresh`: the stored copy at once, while it is loaded again behind the
 *   scenes; `onFresh` gets the new one if it changed;
 * - once older, without `onFresh`: the answer from the server, so a caller that can't take a
 *   late update never shows old data.
 *
 * `expire` makes every stored answer old but keeps it; `forget` drops everything, and an answer to
 * a request sent before it is never stored. Plain TypeScript, so it can be tested without Angular.
 */
export class GetCache {
  private inFlight = new Map<string, Promise<unknown>>();
  private stored = new Map<string, Stored>();
  private generation = 0;

  private now: () => number;

  /** `now` is the clock, replaceable in tests. */
  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  forget(): void {
    this.generation++;
    this.inFlight.clear();
    this.stored.clear();
  }

  /** Every stored answer is loaded again on its next use, but can still be shown meanwhile. */
  expire(): void {
    for (const s of this.stored.values()) s.at = -Infinity;
  }

  /** One request per key at a time; whoever joins one gets their own copy of the answer. */
  private load<T>(key: string, request: () => Promise<T>): Promise<T> {
    const shared = this.inFlight.get(key) as Promise<T> | undefined;
    if (shared) return shared.then((v) => structuredClone(v));
    const generation = this.generation;
    const req = request().finally(() => {
      if (generation === this.generation) this.inFlight.delete(key);
    });
    this.inFlight.set(key, req);
    return req;
  }

  get<T>(key: string, request: () => Promise<T>, store?: StoreOptions<T>): Promise<T> {
    if (!store) return this.load(key, request);
    const before = this.stored.get(key);
    // A copy, so a page that changes what it got can't change what the next visit gets.
    const copy = (s: Stored) => Promise.resolve(JSON.parse(s.json) as T);
    if (before && this.now() - before.at < (store.maxAge ?? MAX_AGE_MS)) return copy(before);
    const generation = this.generation;
    const fresh = this.load(key, request);
    const saved = fresh.then(
      (v) => {
        if (generation !== this.generation) return;
        const json = JSON.stringify(v);
        this.stored.set(key, { json, at: this.now() });
        if (before && json !== before.json) store.onFresh?.(v);
      },
      () => {
        if (generation === this.generation) this.stored.delete(key);
      },
    );
    if (!before || !store.onFresh) return saved.then(() => fresh);
    return copy(before);
  }
}
