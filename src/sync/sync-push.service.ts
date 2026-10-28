import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SyncPushDto } from './dto/sync-push.dto';
import { DeletionWriter } from './deletion-writer';
import { LogWriter } from './log-writer';
import {
  idOf,
  parseDeleted,
  parseLog,
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

// Lists of tables that do not exist yet, with the table name they are reported under.
const UNSUPPORTED_LISTS = [
  ['moods', 'moods'],
  ['tags', 'tags'],
  ['entries', 'diary_entries'],
  ['cycle_days', 'cycle_days'],
] as const;

@Injectable()
export class SyncPushService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly tasks: TaskWriter,
    private readonly logs: LogWriter,
    private readonly deletions: DeletionWriter,
  ) {}

  // Checks every row on its own, then writes tasks, marks and deletions in that order in ONE
  // transaction: a database error rolls everything back (the app sends the batch again), while
  // a refused row only lands in `rejected` and the rest is written.
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
    const taskRows = parseList(dto.tasks, 'tasks', parseTask);
    const logRows = parseList(dto.logs, 'task_logs', parseLog);
    // Without a readable table name there is nothing better to call the table.
    const deletedRows = parseList(dto.deleted, 'deleted', parseDeleted);

    for (const [key, table] of UNSUPPORTED_LISTS) {
      for (const raw of dto[key] ?? []) {
        rejected.push({
          table,
          id: idOf(raw, 'id'),
          reason: 'unsupported_table',
        });
      }
    }

    // Nothing to write: do not wake the database for it.
    if (taskRows.length + logRows.length + deletedRows.length > 0) {
      await this.dataSource.transaction(async (manager) => {
        rejected.push(...(await this.tasks.write(manager, userId, taskRows)));
        rejected.push(...(await this.logs.write(manager, userId, logRows)));
        rejected.push(
          ...(await this.deletions.write(manager, userId, deletedRows)),
        );
      });
    }

    return { rejected, server_time: new Date().toISOString() };
  }
}
