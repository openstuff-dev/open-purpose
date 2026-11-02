/** Called with the fresh answer when a stored one was returned first and the server's differs. */
export type OnFresh<T> = (fresh: T) => void;

/**
 * Shares GETs in flight and keeps answers for a second visit. `get` with `store` returns the
 * stored answer at once (a copy) and loads it again behind the scenes; `onFresh` gets the new one
 * if it changed. `forget` drops everything, and an answer to a request sent before it is never
 * stored. Plain TypeScript, so it can be tested without Angular.
 */
export class GetCache {
  private inFlight = new Map<string, Promise<unknown>>();
  private stored = new Map<string, string>();
  private generation = 0;

  forget(): void {
    this.generation++;
    this.inFlight.clear();
    this.stored.clear();
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

  get<T>(
    key: string,
    request: () => Promise<T>,
    store?: { onFresh?: OnFresh<T> },
  ): Promise<T> {
    const fresh = this.load(key, request);
    if (!store) return fresh;
    const generation = this.generation;
    const before = this.stored.get(key);
    const saved = fresh.then(
      (v) => {
        if (generation !== this.generation) return;
        const now = JSON.stringify(v);
        this.stored.set(key, now);
        if (before !== undefined && now !== before) store.onFresh?.(v);
      },
      () => {
        if (generation === this.generation) this.stored.delete(key);
      },
    );
    if (before === undefined) return saved.then(() => fresh);
    // A copy, so a page that changes what it got can't change what the next visit gets.
    return Promise.resolve(JSON.parse(before) as T);
  }
}
