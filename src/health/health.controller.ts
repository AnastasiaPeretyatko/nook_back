import {
  Controller,
  Get,
  Req,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { DataSource } from 'typeorm';
import { Public } from '../auth/public.decorator';

// Render's health checks and our own ping come from one address, often.
@SkipThrottle({ burst: true, sustained: true }) // by name: a bare @SkipThrottle() only skips "default"
@Public()
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(private readonly dataSource: DataSource) {}

  // Must never touch the database: the self-ping calls it, and a query would keep Neon awake.
  @Get()
  alive() {
    return { ok: true };
  }

  // TEMPORARY (B1.12): shows what this server sees of the caller, to pick TRUST_PROXY_HOPS.
  // Remove after the value is chosen. Returns only the caller's own connection details.
  @Get('client')
  client(@Req() req: Request) {
    return {
      ip: req.ip,
      ips: req.ips,
      socket: req.socket.remoteAddress,
      forwardedFor: req.headers['x-forwarded-for'] ?? null,
      cfConnectingIp: req.headers['cf-connecting-ip'] ?? null,
      trustProxy: req.app.get('trust proxy') as unknown,
    };
  }

  // Wakes Neon up. For manual checks only, never for pings.
  @Get('db')
  async db() {
    try {
      await this.dataSource.query('select 1');
    } catch (error) {
      this.logger.error('Database check failed', (error as Error).stack);
      throw new ServiceUnavailableException({
        code: 'db_unavailable',
        message: 'Database is unavailable',
      });
    }
    return { ok: true };
  }
}
