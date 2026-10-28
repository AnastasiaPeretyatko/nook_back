import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
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
  constructor(
    private readonly dataSource: DataSource,
    private readonly labels: LabelWriter,
    private readonly entries: EntryWriter,
    private readonly tasks: TaskWriter,
    private readonly logs: LogWriter,
    private readonly cycle: CycleWriter,
    private readonly deletions: DeletionWriter,
  ) {}

  // Checks every row on its own, then writes moods, tags, notes (with their links), tasks,
  // marks, cycle days and deletions in that order in ONE transaction: a database error rolls everything back
  // (the app sends the batch again), while a refused row only lands in `rejected` and the rest
  // is written. The order matters: a note may name a tag created in the same request, a mark a
  // new task, and a deletion comes last so that it wins over anything written before it.
  async push(userId: string, dto: SyncPushDto): Promise<PushResult> {
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
    if (lists.some((list) => list.length > 0)) {
      await this.dataSource.transaction(async (manager) => {
        rejected.push(
          ...(await this.labels.writeMoods(manager, userId, moodRows)),
          ...(await this.labels.writeTags(manager, userId, tagRows)),
          ...(await this.entries.write(manager, userId, entryRows)),
          ...(await this.tasks.write(manager, userId, taskRows)),
          ...(await this.logs.write(manager, userId, logRows)),
        );
        // Refuses nothing: the rows were checked above and a day cannot be someone else's.
        await this.cycle.write(manager, userId, cycleRows);
        rejected.push(
          ...(await this.deletions.write(manager, userId, deletedRows)),
        );
      });
    }

    return { rejected, server_time: new Date().toISOString() };
  }
}
