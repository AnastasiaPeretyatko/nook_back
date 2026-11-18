import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { CycleConfirmedStartRow } from './push-rows';

// The date is the key. A live duplicate is a no-op, while an explicit later push of a deleted
// date restores it. This keeps retries quiet and lets a user re-confirm a start they removed.
const UPSERT = `
  insert into cycle_confirmed_starts (user_id, date)
  select $2::uuid, r.date
  from jsonb_to_recordset($1::jsonb) as r(date date)
  on conflict (user_id, date) do update set deleted_at = null
  where cycle_confirmed_starts.deleted_at is not null
`;

@Injectable()
export class CycleConfirmedStartWriter {
  async write(
    manager: EntityManager,
    userId: string,
    rows: CycleConfirmedStartRow[],
  ): Promise<void> {
    if (rows.length === 0) return;
    const dates = [...new Map(rows.map((row) => [row.date, row])).values()];
    await manager.query(UPSERT, [JSON.stringify(dates), userId]);
  }
}
