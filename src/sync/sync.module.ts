import { Module } from '@nestjs/common';
import { DeletionWriter } from './deletion-writer';
import { LogWriter } from './log-writer';
import { SyncController } from './sync.controller';
import { SyncPullService } from './sync-pull.service';
import { SyncPushService } from './sync-push.service';
import { TaskWriter } from './task-writer';

@Module({
  controllers: [SyncController],
  providers: [
    TaskWriter,
    LogWriter,
    DeletionWriter,
    SyncPushService,
    SyncPullService,
  ],
})
export class SyncModule {}
