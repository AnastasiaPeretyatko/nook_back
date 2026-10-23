import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvironmentVariables } from '../config/env.validation';

// Render free sleeps after 15 minutes without incoming requests; this keeps it awake.
// Well under 15 minutes, so one lost ping does not let it sleep.
const PING_EVERY_MS = 5 * 60 * 1000;
const PING_TIMEOUT_MS = 30 * 1000;

// Calls our own public /health. That route never touches the database,
// so Neon is free to sleep.
@Injectable()
export class SelfPingService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(SelfPingService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly config: ConfigService<EnvironmentVariables, true>,
  ) {}

  onApplicationBootstrap() {
    const base = this.config.get('SELF_PING_URL', { infer: true });
    if (!base) return;
    const url = new URL('/health', base).href;
    this.timer = setInterval(() => void this.ping(url), PING_EVERY_MS);
    this.timer.unref(); // never keeps the process alive on its own
    this.logger.log(`Self-ping every ${PING_EVERY_MS / 60000} min: ${url}`);
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  private async ping(url: string) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(PING_TIMEOUT_MS),
      });
      if (!res.ok) this.logger.warn(`Self-ping got HTTP ${res.status}`);
    } catch (error) {
      this.logger.warn(`Self-ping failed: ${(error as Error).message}`);
    }
  }
}
