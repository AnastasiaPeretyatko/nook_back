import { Module } from '@nestjs/common';
import { Ringer } from './ringer.service';
import { RealtimeService } from './realtime.service';

// Who is connected and how to ring them. Depends on nothing, so any module may import it.
@Module({
  providers: [RealtimeService, Ringer],
  exports: [RealtimeService, Ringer],
})
export class RealtimeModule {}
