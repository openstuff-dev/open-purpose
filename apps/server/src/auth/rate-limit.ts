import { isIPv6 } from 'node:net';

/**
 * A small in-memory limiter: at most `limit` hits per key in each window. Per server process,
 * which is enough to stop the magic-link sender from being used to spam people.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  private nextSweep = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    /** The most keys kept; past it the oldest go first, so memory stays bounded. */
    private readonly maxKeys = 50_000,
    private readonly sweepEveryMs = 60_000,
  ) {}

  /** Count a hit. false = over the limit, don't go on. */
  take(key: string, now = Date.now()): boolean {
    if (now >= this.nextSweep) {
      this.nextSweep = now + this.sweepEveryMs;
      for (const [k, hit] of this.hits) if (hit.resetAt <= now) this.hits.delete(k);
    }
    const hit = this.hits.get(key);
    if (!hit || hit.resetAt <= now) {
      // Re-insert so the key moves to the end: a Map keeps insertion order, oldest first.
      this.hits.delete(key);
      for (const oldest of this.hits.keys()) {
        if (this.hits.size < this.maxKeys) break;
        this.hits.delete(oldest);
      }
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    hit.count++;
    return hit.count <= this.limit;
  }

  /** How many keys are kept now (for tests). */
  get size(): number {
    return this.hits.size;
  }
}

/**
 * The key to rate-limit a client address by. One IPv6 address is cheap to change inside the /64
 * a network gets, so IPv6 counts per /64. IPv4, also written as `::ffff:a.b.c.d`, stays as it is.
 */
export function clientKey(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1];
  if (!isIPv6(ip)) return ip;
  const addr = ip.split('%')[0].toLowerCase();
  const [head, tail = ''] = addr.split('::');
  const left = head ? head.split(':') : [];
  const right = addr.includes('::') && tail ? tail.split(':') : [];
  // An embedded IPv4 address at the end (`::1.2.3.4`) fills two groups.
  const width = (gs: string[]) => gs.length + (gs.at(-1)?.includes('.') ? 1 : 0);
  const groups = addr.includes('::')
    ? [...left, ...Array<string>(8 - width(left) - width(right)).fill('0'), ...right]
    : left;
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}
