import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EnvironmentVariables } from '../config/env.validation';
import { buildDataSourceOptions } from './data-source-options';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>) => ({
        ...buildDataSourceOptions(config.get('DATABASE_URL', { infer: true })),
        autoLoadEntities: true,
        // Total attempts at startup (the first plus one retry), 3 s apart.
        retryAttempts: 2,
        retryDelay: 3000,
      }),
    }),
  ],
})
export class DatabaseModule {}
