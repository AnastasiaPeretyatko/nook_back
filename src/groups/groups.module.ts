import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RealtimeModule } from '../realtime/realtime.module';
import { GroupInvite } from './group-invite.entity';
import { GroupJoinFailure } from './group-join-failure.entity';
import { GroupMember } from './group-member.entity';
import { Group } from './group.entity';
import { GroupsController } from './groups.controller';
import { GroupsService } from './groups.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Group,
      GroupMember,
      GroupInvite,
      GroupJoinFailure,
    ]),
    RealtimeModule,
  ],
  controllers: [GroupsController],
  providers: [GroupsService],
  exports: [TypeOrmModule, GroupsService],
})
export class GroupsModule {}
