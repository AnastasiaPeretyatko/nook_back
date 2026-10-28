import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { CycleDayRow } from './push-rows';

// One statement for the whole batch, rows as one JSON value (see TaskWriter). The user comes
// from the token ($2) and is part of the key, so another account's day cannot be reached at all.
// A day is replaced whole, an empty one included: an empty day is how a taken-back mark reaches
// the other devices, so it is stored like any other.
const UPSERT = `
  insert into cycle_days (
    user_id, date, flow, mood, symptoms, discharge, sex, pill, note, client_updated_at
  )
  select
    $2::uuid, r.date, r.flow, r.mood, r.symptoms, r.discharge, r.sex, r.pill, r.note,
    r."clientUpdatedAt"
  from jsonb_to_recordset($1::jsonb) as r(
    date date, flow smallint, mood smallint, symptoms smallint[], discharge smallint,
    sex smallint, pill boolean, note text, "clientUpdatedAt" timestamptz
  )
  on conflict (user_id, date) do update set
    flow = excluded.flow, mood = excluded.mood, symptoms = excluded.symptoms,
    discharge = excluded.discharge, sex = excluded.sex, pill = excluded.pill,
    note = excluded.note, client_updated_at = excluded.client_updated_at
`;

@Injectable()
export class CycleWriter {
  // Runs inside the push transaction. Nothing can be refused here (the rows were checked by
  // parseCycleDay and there is no one else's row to collide with), so nothing is returned.
  async write(
    manager: EntityManager,
    userId: string,
    rows: CycleDayRow[],
  ): Promise<void> {
    if (rows.length === 0) return;
    // The same day twice in one batch: the later row wins. (An insert can't touch a row twice.)
    const latest = [...new Map(rows.map((r) => [r.date, r])).values()];
    await manager.query(UPSERT, [JSON.stringify(latest), userId]);
  }
}
