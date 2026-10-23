import { plainToInstance } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsUrl,
  Matches,
  Max,
  Min,
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
