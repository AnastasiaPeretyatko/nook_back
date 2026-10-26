import { NestExpressApplication } from '@nestjs/platform-express';

// Express reads the client address from X-Forwarded-For only for this many proxy hops,
// counted from the server's side. 0 = trust nothing and use the socket address.
export function configureProxy(app: NestExpressApplication, hops: number) {
  if (hops > 0) app.set('trust proxy', hops);
}
