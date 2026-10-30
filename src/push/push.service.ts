import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Notification, planPush, PushEvent, PushWorld } from './plan-push';
import { PushSender } from './push-sender';
import { errorText } from '../common/error-text';

// How many phones are sent to at the same moment.
const AT_ONCE = 10;

interface WorldRows {
  groups: { id: string; name: string; members: string[] }[];
  names: { id: string; name: string | null }[];
  tokens: { userId: string; token: string }[];
}

// Everything the notifications of one `push` need, in ONE query (the database can be an ocean
// away): the groups (alive ones only) with their members now, the names of the people the texts
// mention, and the phones of everyone in those groups.
const WORLD = `
  select
    (select coalesce(json_agg(json_build_object(
        'id', g.id, 'name', g.name,
        'members', (select coalesce(json_agg(m.user_id), '[]'::json)
                    from group_members m
                    where m.group_id = g.id and m.deleted_at is null))), '[]'::json)
       from groups g where g.id = any($1::uuid[]) and g.deleted_at is null) as groups,
    (select coalesce(json_agg(json_build_object('id', p.user_id, 'name', p.display_name)),
                     '[]'::json)
       from profiles p where p.user_id = any($2::uuid[])) as names,
    (select coalesce(json_agg(json_build_object('userId', d.user_id, 'token', d.token)),
                     '[]'::json)
       from device_tokens d
       where d.user_id in (select m.user_id from group_members m
                           where m.group_id = any($1::uuid[]) and m.deleted_at is null)) as tokens
`;

// Tells people's phones about what happened in a push, after it was saved. It starts the work and
// does not wait for it: the answer to the phone that wrote must not wait for Google. Whatever goes
// wrong is a line in the log (never a token), never a failed write.
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly pending = new Set<Promise<void>>();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly sender: PushSender,
  ) {}

  // Call after the commit. Nothing to do (no key, no events) costs nothing, not even a query.
  notify(events: PushEvent[]): void {
    if (!this.sender.enabled || events.length === 0) return;
    const job: Promise<void> = this.run(events)
      .catch((error: unknown) =>
        this.logger.warn(`Push notifications failed: ${errorText(error)}`),
      )
      .finally(() => this.pending.delete(job));
    this.pending.add(job);
  }

  // Resolves when what was started has finished; for tests, and for a clean stop.
  async idle() {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  private async run(events: PushEvent[]) {
    const groupIds = [...new Set(events.map((e) => e.task.groupId))];
    const people = new Set<string>();
    for (const e of events) {
      people.add(e.task.authorId);
      if (e.kind === 'done') people.add(e.doneBy);
    }
    const [row]: WorldRows[] = await this.dataSource.query(WORLD, [
      groupIds,
      [...people],
    ]);

    const world: PushWorld = {
      now: Date.now(),
      groups: new Map(row.groups.map((g) => [g.id, g])),
      names: new Map(row.names.map((n) => [n.id, n.name])),
    };
    const tokensOf = new Map<string, string[]>();
    for (const { userId, token } of row.tokens) {
      tokensOf.set(userId, [...(tokensOf.get(userId) ?? []), token]);
    }

    // Each notification to each phone of its person.
    const sends = planPush(events, world).flatMap((n: Notification) =>
      (tokensOf.get(n.userId) ?? []).map((token) => ({ token, n })),
    );
    const dead = new Set<string>();
    for (let i = 0; i < sends.length; i += AT_ONCE) {
      await Promise.all(
        sends.slice(i, i + AT_ONCE).map(async ({ token, n }) => {
          if ((await this.sender.send(token, n.message)) === 'unregistered') {
            dead.add(token);
          }
        }),
      );
    }
    // Only a token FCM says is gone for good is removed; any other trouble leaves it alone.
    if (dead.size > 0) {
      await this.dataSource.query(
        `delete from device_tokens where token = any($1::text[])`,
        [[...dead]],
      );
    }
  }
}
