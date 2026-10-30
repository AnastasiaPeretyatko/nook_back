import {
  ConnectionLimiter,
  MAX_NEW_CONNECTIONS_PER_MINUTE as MAX,
} from './connection-limiter';

describe('ConnectionLimiter', () => {
  it('allows exactly the limit, then says how long to wait', () => {
    const limiter = new ConnectionLimiter();
    for (let i = 0; i < MAX; i++) expect(limiter.attempt('a', 1000)).toBe(0);
    expect(limiter.attempt('a', 1000)).toBe(60);
    expect(limiter.attempt('a', 31_000)).toBe(30);
  });

  it('starts a new minute after 60 seconds', () => {
    const limiter = new ConnectionLimiter();
    for (let i = 0; i < MAX; i++) limiter.attempt('a', 0);
    expect(limiter.attempt('a', 59_999)).toBeGreaterThan(0);
    expect(limiter.attempt('a', 60_000)).toBe(0);
  });

  it('counts each address on its own', () => {
    const limiter = new ConnectionLimiter();
    for (let i = 0; i < MAX; i++) limiter.attempt('a', 0);
    expect(limiter.attempt('a', 0)).toBeGreaterThan(0);
    expect(limiter.attempt('b', 0)).toBe(0);
  });

  it('forgets expired addresses when there are very many (no timer)', () => {
    const limiter = new ConnectionLimiter();
    for (let i = 0; i < 10_001; i++) limiter.attempt(`ip-${i}`, 0);
    limiter.attempt('late', 120_000);
    expect(
      (limiter as unknown as { windows: Map<string, unknown> }).windows.size,
    ).toBe(1);
  });
});
