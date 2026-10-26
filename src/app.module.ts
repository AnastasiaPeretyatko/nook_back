import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { createValidationPipe } from './common/validation.pipe';
import { AuthGuard } from './auth/auth.guard';
import { AuthModule } from './auth/auth.module';
import { validateEnv } from './config/env.validation';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    // In memory: counters reset when the server restarts and are not shared between
    // servers. Fine for one small instance; limits that must survive (group join codes)
    // are kept in the database instead.
    ThrottlerModule.forRoot({
      throttlers: [
        { name: 'burst', ttl: 60_000, limit: 120 },
        { name: 'sustained', ttl: 3_600_000, limit: 3000 },
      ],
      errorMessage: 'Too many requests, try again later',
      // Read on every request so tests can switch it; production refuses RATE_LIMIT=off.
      skipIf: () => process.env.RATE_LIMIT === 'off',
    }),
    DatabaseModule,
    HealthModule,
    UsersModule,
    AuthModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_PIPE, useValue: createValidationPipe() },
    // Order matters: count the request before checking who it is, so guessing is limited too.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
