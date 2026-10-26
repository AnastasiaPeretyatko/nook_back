import {
  Controller,
  Get,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Public } from '../auth/public.decorator';

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
