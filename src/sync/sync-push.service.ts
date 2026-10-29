import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PushEvent } from '../push/plan-push';
import { PushService } from '../push/push.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SyncPushDto } from './dto/sync-push.dto';
import { CycleWriter } from './cycle-writer';
import { DeletionWriter } from './deletion-writer';
import { EntryWriter } from './entry-writer';
import { LabelWriter } from './label-writer';
import { LogWriter } from './log-writer';
import {
  parseCycleDay,
  parseDeleted,
  parseEntry,
  parseLog,
  parseMood,
  parseTag,
  parseTask,
  RowResult,
} from './push-rows';
import { Rejection } from './rejection';
import { TaskWriter } from './task-writer';

export interface PushResult {
  rejected: Rejection[];
  // The app server's clock, for information. Not a pull watermark: that is `next` of /sync/pull.
  server_time: string;
}

@Injectable()
export class SyncPushService {
  private readonly logger = new Logger(SyncPushService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly labels: LabelWriter,
    private readonly entries: EntryWriter,
    private readonly tasks: TaskWriter,
    private readonly logs: LogWriter,
    private readonly cycle: CycleWriter,
    private readonly deletions: DeletionWriter,
    private readonly realtime: RealtimeService,
    private readonly pushes: PushService,
  ) {}

  // Checks every row on its own, then writes moods, tags, notes (with their links), tasks,
  // marks, cycle days and deletions in that order in ONE transaction: a database error rolls everything back
  // (the app sends the batch again), while a refused row only lands in `rejected` and the rest
  // is written. The order matters: a note may name a tag created in the same request, a mark a
  // new task, and a deletion comes last so that it wins over anything written before it.
  async push(
    userId: string,
    dto: SyncPushDto,
    deviceId?: string,
  ): Promise<PushResult> {
    const rejected: Rejection[] = [];

    // A row that fails the check is reported by its id (null when it has none usable).
    const parseList = <T>(
      list: unknown[] | undefined,
      table: string,
      parse: (raw: unknown) => RowResult<T>,
    ): T[] => {
      const rows: T[] = [];
      for (const raw of list ?? []) {
        const result = parse(raw);
        if ('row' in result) rows.push(result.row);
        else rejected.push({ table, id: result.id, reason: 'invalid_row' });
      }
      return rows;
    };
    const moodRows = parseList(dto.moods, 'note_moods', parseMood);
    const tagRows = parseList(dto.tags, 'note_tags', parseTag);
    const entryRows = parseList(dto.entries, 'diary_entries', parseEntry);
    const taskRows = parseList(dto.tasks, 'tasks', parseTask);
    const logRows = parseList(dto.logs, 'task_logs', parseLog);
    // A refused day is reported by the day itself (YYYY-MM-DD): the row has no id.
    const cycleRows = parseList(dto.cycle_days, 'cycle_days', parseCycleDay);
    // Without a readable table name there is nothing better to call the table.
    const deletedRows = parseList(dto.deleted, 'deleted', parseDeleted);

    // Nothing to write: do not wake the database for it.
    const lists = [
      moodRows,
      tagRows,
      entryRows,
      taskRows,
      logRows,
      cycleRows,
      deletedRows,
    ];
    // What happened to group tasks, as the writers saw it; told to people's phones after the commit.
    const events: PushEvent[] = [];
    if (lists.some((list) => list.length > 0)) {
      await this.dataSource.transaction(async (manager) => {
        rejected.push(
          ...(await this.labels.writeMoods(manager, userId, moodRows)),
          ...(await this.labels.writeTags(manager, userId, tagRows)),
          ...(await this.entries.write(manager, userId, entryRows)),
          ...(await this.tasks.write(manager, userId, taskRows, events)),
          ...(await this.logs.write(manager, userId, logRows, events)),
        );
        // Refuses nothing: the rows were checked above and a day cannot be someone else's.
        await this.cycle.write(manager, userId, cycleRows);
        rejected.push(
          ...(await this.deletions.write(manager, userId, deletedRows)),
        );
      });
    }

    // Only after the commit (a rollback throws above and rings nobody). A key is what a
    // refusal in `rejected` is called (`table:id`); `taskId` marks rows that may belong to a group.
    await this.ringAboutWrite(userId, deviceId, rejected, [
      ...moodRows.map((r) => ({ key: `note_moods:${r.id}` })),
      ...tagRows.map((r) => ({ key: `note_tags:${r.id}` })),
      ...entryRows.map((r) => ({ key: `diary_entries:${r.id}` })),
      ...cycleRows.map((r) => ({ key: `cycle_days:${r.date}` })),
      ...taskRows.map((r) => ({ key: `tasks:${r.id}`, taskId: r.id })),
      ...logRows.map((r) => ({
        key: `task_logs:${r.taskId}`,
        taskId: r.taskId,
      })),
      ...deletedRows.map((r) => ({
        key: `${r.table}:${r.id}`,
        taskId: r.table === 'tasks' ? r.id : undefined,
      })),
    ]);

    // A task made (or ticked) and deleted by the same push is not news: the deletions come last in
    // the transaction, so the writers did not see them.
    const refused = new Set(
      rejected.filter((r) => r.table === 'tasks').map((r) => r.id),
    );
    const deletedHere = new Set(
      deletedRows
        .filter((r) => r.table === 'tasks' && !refused.has(r.id))
        .map((r) => r.id),
    );
    this.pushes.notify(events.filter((e) => !deletedHere.has(e.task.id)));

    return { rejected, server_time: new Date().toISOString() };
  }

  // Tells the phones that something changed: the writer's other devices, and the members of
  // the groups whose tasks or marks were written who are connected right now. A request that
  // wrote nothing (empty, or every row refused) rings nobody. Never fails the push: it is
  // already saved.
  private async ringAboutWrite(
    userId: string,
    deviceId: string | undefined,
    rejected: Rejection[],
    sent: { key: string; taskId?: string }[],
  ) {
    try {
      // A note with a dropped label is still saved, so that refusal does not count.
      const refused = new Set(
        rejected
          .filter((r) => r.reason !== 'unknown_label')
          .map((r) => `${r.table}:${r.id}`),
      );
      const written = sent.filter(({ key }) => !refused.has(key));
      const taskIds = written.flatMap((w) => (w.taskId ? [w.taskId] : []));
      if (written.length === 0) return;

      // The writer's own phones, minus the one that wrote.
      this.realtime.ring([userId], deviceId);

      const others = this.realtime
        .connectedUserIds()
        .filter((id) => id !== userId);
      if (taskIds.length === 0 || others.length === 0) return;
      // Groups of the written tasks in which the writer is a member right now (a foreign task
      // id gets nobody rung), then their members who are connected. A removed member is not
      // one. The device name is the writer's own and is not applied to other people.
      const members: { user_id: string }[] = await this.dataSource.query(
        `select distinct m.user_id
         from tasks t
         join group_members m on m.group_id = t.group_id and m.deleted_at is null
         where t.id = any($1::uuid[])
           and m.user_id = any($2::uuid[])
           and is_group_member(t.group_id, $3)`,
        [[...new Set(taskIds)], others, userId],
      );
      this.realtime.ring(members.map((m) => m.user_id));
    } catch (error) {
      this.logger.warn(`Ring failed: ${(error as Error).message}`);
    }
  }
}
