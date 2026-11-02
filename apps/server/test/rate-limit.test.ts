import { describe, expect, it } from 'vitest';
import { clientKey, RateLimiter } from '../src/auth/rate-limit.js';

describe('RateLimiter', () => {
  it('refuses hits over the limit until the window has passed', () => {
    const limiter = new RateLimiter(20, 1000);
    for (let i = 0; i < 20; i++) expect(limiter.take('ip:1.2.3.4', 0)).toBe(true);
    expect(limiter.take('ip:1.2.3.4', 10)).toBe(false);
    expect(limiter.take('ip:5.6.7.8', 10)).toBe(true);
    expect(limiter.take('ip:1.2.3.4', 1000)).toBe(true);
  });

  it('never keeps more keys than its cap, dropping the oldest first', () => {
    const limiter = new RateLimiter(1, 60_000, 100);
    for (let i = 0; i < 1000; i++) limiter.take(`ip:${i}`, i);
    expect(limiter.size).toBe(100);
    // The newest keys are still counted, so they stay limited.
    expect(limiter.take('ip:999', 1000)).toBe(false);
  });

  it('drops expired keys on its next sweep', () => {
    const limiter = new RateLimiter(1, 1000, 50_000, 60_000);
    for (let i = 0; i < 10; i++) limiter.take(`ip:${i}`, 0);
    limiter.take('ip:new', 60_000);
    expect(limiter.size).toBe(1);
  });
});

describe('clientKey', () => {
  it('counts IPv6 addresses per /64', () => {
    expect(clientKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(clientKey('2001:db8:0:0:ffff::2')).toBe(clientKey('2001:db8::1'));
    expect(clientKey('2001:0db8:0000:0000:1:2:3:4')).toBe(clientKey('2001:db8::1'));
    expect(clientKey('2001:db8:0:1::1')).not.toBe(clientKey('2001:db8::1'));
    expect(clientKey('::1')).toBe('0:0:0:0::/64');
    expect(clientKey('2001::1:2:3:4:1.2.3.4')).toBe('2001:0:1:2::/64');
    expect(clientKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  });

  it('keeps IPv4 addresses as they are, also when written as IPv6', () => {
    expect(clientKey('1.2.3.4')).toBe('1.2.3.4');
    expect(clientKey('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(clientKey('::FFFF:10.0.0.1')).toBe('10.0.0.1');
  });
});
