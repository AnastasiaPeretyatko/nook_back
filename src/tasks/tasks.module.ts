import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TaskLog } from './task-log.entity';
import { Task } from './task.entity';

// Only the tables for now; the /sync routes that use them arrive in B2.6 and B2.7.
@Module({
  imports: [TypeOrmModule.forFeature([Task, TaskLog])],
  exports: [TypeOrmModule],
})
export class TasksModule {}
