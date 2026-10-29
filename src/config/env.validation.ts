import { plainToInstance, Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';
import { parseServiceAccount } from './firebase-account';

export class EnvironmentVariables {
  @IsIn(['development', 'production', 'test'])
  NODE_ENV: string = 'development';

  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 3000;

  @Matches(/^postgres(ql)?:\/\/.+/, {
    message:
      'DATABASE_URL must be a postgres:// or postgresql:// connection string',
  })
  DATABASE_URL: string;

  // Public URL of this service; when set, the server pings its own /health (keeps Render awake).
  @IsOptional()
  @IsUrl({ require_tld: false, require_protocol: true })
  SELF_PING_URL?: string;

  // Signs access tokens. Anyone who knows it can mint a token for any user.
  // Generate: node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
  @MinLength(32, { message: 'JWT_SECRET must be at least 32 characters' })
  JWT_SECRET: string;

  // OAuth client IDs whose Google ID tokens we accept (the token's `aud`), comma separated.
  // Not set = Google sign-in rejects every token.
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean)
      : value,
  )
  @IsString({ each: true })
  GOOGLE_CLIENT_IDS?: string[];

  // The Firebase service account key file (JSON), encoded as base64 (`base64 -w0 key.json`). It lets
  // the server send push notifications. Not set = push is off and the rest works. A secret: only in
  // .env and the host's variables, never in the repository.
  @IsOptional()
  @IsString()
  FIREBASE_SERVICE_ACCOUNT?: string;

  // How many reverse proxies stand between the internet and this server (Render: set after
  // checking, see MEMORY). Request limits are counted per client address, and the address
  // is only read from X-Forwarded-For when this is above 0. Too high lets a client forge it.
  @IsInt()
  @Min(0)
  @Max(5)
  TRUST_PROXY_HOPS: number = 0;

  // Tests turn the limiter off; it can never be off in production.
  @IsIn(['on', 'off'])
  RATE_LIMIT: string = 'on';
}

export function validateEnv(config: Record<string, unknown>) {
  const env = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(env, { skipMissingProperties: false });
  if (errors.length > 0) {
    const details = errors
      .map((e) => Object.values(e.constraints ?? {}).join('; '))
      .join('\n  ');
    throw new Error(`Invalid environment variables:\n  ${details}`);
  }
  // Set but broken must stop the start: otherwise push would silently never work.
  if (env.FIREBASE_SERVICE_ACCOUNT?.trim()) {
    try {
      parseServiceAccount(env.FIREBASE_SERVICE_ACCOUNT);
    } catch (error) {
      throw new Error(
        `Invalid environment variables:\n  FIREBASE_SERVICE_ACCOUNT ${(error as Error).message}`,
      );
    }
  } else {
    env.FIREBASE_SERVICE_ACCOUNT = undefined; // blank counts as not set
  }
  // pg turns TLS on only through ?sslmode= in the URL; without it the link would be plain text.
  if (
    env.NODE_ENV === 'production' &&
    !/[?&]sslmode=(require|verify-ca|verify-full)\b/.test(env.DATABASE_URL)
  ) {
    throw new Error(
      'Invalid environment variables:\n  DATABASE_URL must contain sslmode=require in production',
    );
  }
  if (env.NODE_ENV === 'production' && env.RATE_LIMIT === 'off') {
    throw new Error(
      'Invalid environment variables:\n  RATE_LIMIT=off is not allowed in production',
    );
  }
  return env;
}
