/**
 * A small in-memory limiter: at most `limit` hits per key in each window. Per server process,
 * which is enough to stop the magic-link sender from being used to spam people.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Count a hit. false = over the limit, don't go on. */
  take(key: string, now = Date.now()): boolean {
    if (this.hits.size > 10_000) this.sweep(now);
    const hit = this.hits.get(key);
    if (!hit || hit.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    hit.count++;
    return hit.count <= this.limit;
  }

  private sweep(now: number): void {
    for (const [key, hit] of this.hits) if (hit.resetAt <= now) this.hits.delete(key);
  }
}
