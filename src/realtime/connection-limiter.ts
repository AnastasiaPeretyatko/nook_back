export const MAX_NEW_CONNECTIONS_PER_MINUTE = 60;
const WINDOW_MS = 60_000;
// Above this many addresses the expired ones are swept out, so the map cannot grow without end.
const SWEEP_ABOVE = 10_000;

// How many new socket connections each address may open in a minute. Checking a token is cheap
// (a signature, no database), so this is not about load: it only stops one address from
// opening connections without end. In memory, like the rest of the sockets (one server);
// a swept-on-demand map, no timer.
export class ConnectionLimiter {
  private readonly windows = new Map<
    string,
    { start: number; count: number }
  >();

  // Counts one attempt. Returns 0 when it is allowed, otherwise the seconds until it may be.
  attempt(address: string, now = Date.now()): number {
    if (this.windows.size > SWEEP_ABOVE) this.sweep(now);
    let window = this.windows.get(address);
    if (!window || now - window.start >= WINDOW_MS) {
      window = { start: now, count: 0 };
      this.windows.set(address, window);
    }
    if (window.count >= MAX_NEW_CONNECTIONS_PER_MINUTE) {
      return Math.max(1, Math.ceil((window.start + WINDOW_MS - now) / 1000));
    }
    window.count += 1;
    return 0;
  }

  private sweep(now: number) {
    for (const [address, { start }] of this.windows) {
      if (now - start >= WINDOW_MS) this.windows.delete(address);
    }
  }
}
