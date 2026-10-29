import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeModule } from './realtime.module';

// The `/ws` door. Apart from RealtimeModule because it needs AuthModule (to check tokens),
// which itself imports UsersModule, and UsersModule rings through RealtimeModule.
@Module({
  imports: [AuthModule, RealtimeModule],
  providers: [RealtimeGateway],
})
export class RealtimeGatewayModule {}
