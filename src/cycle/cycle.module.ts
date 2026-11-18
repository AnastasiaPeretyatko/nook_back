import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CycleConfirmedStart } from './cycle-confirmed-start.entity';
import { CycleDay } from './cycle-day.entity';

// Only the table for now; the cycle joins /sync/push and /sync/pull in B4.4 and B4.5.
@Module({
  imports: [TypeOrmModule.forFeature([CycleDay, CycleConfirmedStart])],
  exports: [TypeOrmModule],
})
export class CycleModule {}
