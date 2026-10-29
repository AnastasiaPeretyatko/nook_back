import { Module } from '@nestjs/common';
import { PushSender } from './push-sender';
import { PushService } from './push.service';

// The sender (FCM), the rules (plan-push.ts, a plain function) and the service that joins them
// after a `push`.
@Module({
  providers: [PushSender, PushService],
  exports: [PushSender, PushService],
})
export class PushModule {}
