import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RealtimeService } from './realtime.service';
import { errorText } from '../common/error-text';

interface Audience {
  // Everyone now in these groups.
  groups?: string[];
  // These people, named outright (someone who has just left still hears of it).
  users?: string[];
  // Everyone who shares a group with the sender now.
  inSendersGroups?: boolean;
}

// Rings after a request that changed groups or the profile: the sender's other phones, and the
// chosen people who are connected right now. The device name belongs to the sender only.
// Never fails the request: it is already saved.
@Injectable()
export class Ringer {
  private readonly logger = new Logger(Ringer.name);

  constructor(
    private readonly realtime: RealtimeService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async ringFrom(
    senderId: string,
    deviceId: string | undefined,
    { groups = [], users = [], inSendersGroups = false }: Audience = {},
  ) {
    try {
      this.realtime.ring([senderId], deviceId);
      const heard = new Set(users);
      const connected = this.realtime
        .connectedUserIds()
        .filter((id) => id !== senderId && !heard.has(id));
      // Only people who are connected are looked up: no one to ring, no query.
      if ((groups.length > 0 || inSendersGroups) && connected.length > 0) {
        const members = await this.dataSource.query<{ user_id: string }[]>(
          `select distinct m.user_id from group_members m
           where m.deleted_at is null and m.user_id = any($2::uuid[])
             and (m.group_id = any($1::uuid[])
                  or ($4 and m.group_id in (
                    select group_id from group_members
                    where user_id = $3 and deleted_at is null)))`,
          [groups, connected, senderId, inSendersGroups],
        );
        for (const { user_id } of members) heard.add(user_id);
      }
      heard.delete(senderId);
      this.realtime.ring(heard);
    } catch (error) {
      this.logger.warn(`Ring failed: ${errorText(error)}`);
    }
  }
}
