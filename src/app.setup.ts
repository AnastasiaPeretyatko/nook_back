import { json, NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { NestExpressApplication } from '@nestjs/platform-express';
import { LimitedWsAdapter } from './realtime/limited-ws-adapter';

// Protective headers on every answer (not sniffing the type of a file, no framing, no referrer, ...)
// and no `X-Powered-By: Express`. Must come first: the later steps (body parser, filters) answer
// too, and those answers need the headers as well. There is no CORS on purpose: the only client is
// the phone app, which is not a browser page, so no other website has any business calling this.
export function configureSecurity(app: NestExpressApplication) {
  app.use(helmet());
}

// Express reads the client address from X-Forwarded-For only for this many proxy hops,
// counted from the server's side. 0 = trust nothing and use the socket address.
export function configureProxy(app: NestExpressApplication, hops: number) {
  if (hops > 0) app.set('trust proxy', hops);
}

// Real bodies are at most ~6 levels deep. Nest's ValidationPipe walks the body recursively and
// dies with a stack overflow (a 500) on JSON nested thousands of levels, so refuse it up front.
export const MAX_JSON_DEPTH = 32;

// Counts the brackets of the raw JSON text, skipping what is inside strings. Runs before
// parsing, so a hostile body costs one pass over the bytes and never reaches the recursion.
export function assertShallowJson(buf: Buffer) {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (inString) {
      if (c === 0x5c)
        i++; // backslash: skip the escaped character
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) inString = true;
    else if (c === 0x5b || c === 0x7b) {
      if (++depth > MAX_JSON_DEPTH) {
        throw Object.assign(new Error('JSON is nested too deeply'), {
          status: 400,
        });
      }
    } else if (c === 0x5d || c === 0x7d) depth--;
  }
}

// Nest reads JSON bodies up to 100 KB. A push of 500 tasks needs more, but only that route gets
// the larger limit: it is parsed before the login check, so everywhere else stays small.
// Our own parsers go first and mark the request as read, so Nest's default one (which has no
// depth check) skips it.
export function configureBodyLimit(app: NestExpressApplication) {
  const verify = (_req: Request, _res: Response, buf: Buffer) =>
    assertShallowJson(buf);
  const bigJson = json({ limit: '5mb', verify });
  const smallJson = json({ limit: '100kb', verify });
  // Wrapped on purpose: Nest skips its own JSON parser for the whole app when it finds a
  // middleware named `jsonParser`, which is what express.json() returns.
  app.use('/sync/push', (req: Request, res: Response, next: NextFunction) =>
    bigJson(req, res, next),
  );
  app.use((req: Request, res: Response, next: NextFunction) =>
    smallJson(req, res, next),
  );
}

// Plain `ws` sockets (no Socket.IO) on the same port as the HTTP routes, with a limit on new
// connections per address.
export function configureWebSocket(app: NestExpressApplication) {
  app.useWebSocketAdapter(new LimitedWsAdapter(app));
}
