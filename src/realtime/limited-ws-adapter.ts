import { IncomingMessage } from 'http';
import { NestExpressApplication } from '@nestjs/platform-express';
import { WsAdapter } from '@nestjs/platform-ws';
import { ConnectionLimiter } from './connection-limiter';

interface Handshake {
  req: IncomingMessage;
}
type Verdict = (
  ok: boolean,
  code?: number,
  message?: string,
  headers?: Record<string, string | number>,
) => void;

// The socket adapter, with a limit on new connections per address that is checked BEFORE the
// handshake: the refusal is a plain HTTP `429`. A close sent by the server after the handshake
// does not get through Render's proxy (the phone would see only a dropped line, see B6.6), but an
// HTTP answer does.
export class LimitedWsAdapter extends WsAdapter {
  private readonly limiter = new ConnectionLimiter();

  constructor(private readonly app: NestExpressApplication) {
    super(app);
  }

  override create(port: number, options: Record<string, unknown>): unknown {
    const server: unknown = super.create(port, {
      ...options,
      // Two parameters on purpose: `ws` tells the asking form from the plain one by the count.
      verifyClient: ({ req }: Handshake, verdict: Verdict) => {
        // Tests switch the limiter off, as the request limiter; production refuses that setting.
        const wait =
          process.env.RATE_LIMIT === 'off'
            ? 0
            : this.limiter.attempt(this.addressOf(req));
        if (wait === 0) return verdict(true);
        const body = JSON.stringify({
          code: 'too_many_requests',
          message: 'Too many connections, try again later',
        });
        verdict(false, 429, body, {
          'Content-Type': 'application/json',
          'Retry-After': wait,
        });
      },
    });
    return server;
  }

  // The client's address by the same rule as every other limit (`TRUST_PROXY_HOPS`): Express
  // works it out for its own requests, and an upgrade does not pass through Express, so ask it
  // through a stand-in request that has the same headers and socket.
  private addressOf(req: IncomingMessage): string {
    const express = this.app.getHttpAdapter().getInstance() as {
      request: object;
    };
    const standIn = Object.create(express.request, {
      headers: { value: req.headers },
      socket: { value: req.socket },
      connection: { value: req.socket },
    }) as { ip?: string };
    return standIn.ip ?? 'unknown';
  }
}
