import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { CurrentUserId } from '../auth/auth.guard';
import { SyncPullQuery } from './dto/sync-pull.query';
import { SyncPushDto } from './dto/sync-push.dto';
import { PullResult, SyncPullService } from './sync-pull.service';
import { PushResult, SyncPushService } from './sync-push.service';

// Closed by default (the global guard); `user_id` of every row comes from the token.
// The optional `X-Device-Id` header is accepted and ignored until the WebSocket call (B6).
@Controller('sync')
export class SyncController {
  constructor(
    private readonly pushService: SyncPushService,
    private readonly pullService: SyncPullService,
  ) {}

  @Post('push')
  @HttpCode(200)
  push(
    @CurrentUserId() userId: string,
    @Body() dto: SyncPushDto,
  ): Promise<PushResult> {
    return this.pushService.push(userId, dto);
  }

  @Get('pull')
  pull(
    @CurrentUserId() userId: string,
    @Query() query: SyncPullQuery,
  ): Promise<PullResult> {
    return this.pullService.pull(userId, query);
  }
}
