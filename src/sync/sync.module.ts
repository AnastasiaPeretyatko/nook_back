import { Module } from '@nestjs/common';
import { PushModule } from '../push/push.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { CycleWriter } from './cycle-writer';
import { CycleConfirmedStartWriter } from './cycle-confirmed-start-writer';
import { DeletionWriter } from './deletion-writer';
import { EntryWriter } from './entry-writer';
import { LabelWriter } from './label-writer';
import { LogWriter } from './log-writer';
import { SectionWriter } from './section-writer';
import { SyncController } from './sync.controller';
import { SyncPullService } from './sync-pull.service';
import { SyncPushService } from './sync-push.service';
import { TaskWriter } from './task-writer';

@Module({
  imports: [RealtimeModule, PushModule],
  controllers: [SyncController],
  providers: [
    TaskWriter,
    LogWriter,
    CycleWriter,
    CycleConfirmedStartWriter,
    DeletionWriter,
    LabelWriter,
    EntryWriter,
    SectionWriter,
    SyncPushService,
    SyncPullService,
  ],
})
export class SyncModule {}
