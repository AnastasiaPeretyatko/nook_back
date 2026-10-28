import { json, NextFunction, Request, Response } from 'express';
import { NestExpressApplication } from '@nestjs/platform-express';

// Express reads the client address from X-Forwarded-For only for this many proxy hops,
// counted from the server's side. 0 = trust nothing and use the socket address.
export function configureProxy(app: NestExpressApplication, hops: number) {
  if (hops > 0) app.set('trust proxy', hops);
}

// Nest reads JSON bodies up to 100 KB. A push of 500 tasks needs more, but only that route gets
// the larger limit: it is parsed before the login check, so everywhere else stays small.
export function configureBodyLimit(app: NestExpressApplication) {
  const bigJson = json({ limit: '5mb' });
  // Wrapped on purpose: Nest skips its own JSON parser for the whole app when it finds a
  // middleware named `jsonParser`, which is what express.json() returns.
  app.use('/sync/push', (req: Request, res: Response, next: NextFunction) =>
    bigJson(req, res, next),
  );
}
