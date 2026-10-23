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
  // pg turns TLS on only through ?sslmode= in the URL; without it the link would be plain text.
  if (
    env.NODE_ENV === 'production' &&
    !/[?&]sslmode=(require|verify-ca|verify-full)\b/.test(env.DATABASE_URL)
  ) {
    throw new Error(
      'Invalid environment variables:\n  DATABASE_URL must contain sslmode=require in production',
    );
  }
  return env;
}
