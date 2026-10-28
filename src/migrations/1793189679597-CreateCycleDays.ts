import { MigrationInterface, QueryRunner } from 'typeorm';

// The cycle calendar (B4): one row per account per day. Ported from the Supabase script 008.
//
// The key is the pair (user_id, date), the same bargain as `task_logs`: two phones that marked
// the same day converge on one row with nothing to merge, and there is no `id`. Nothing is ever
// deleted either: taking a mark back saves the day empty, so there is no `deleted_at` and no
// tombstone; an empty day is a row like any other and other devices learn from it.
//
// Health data: only the account that wrote it may see it, and no group rule is ever to name
// this table.
//
// The options are small integers, indexes into the lists in the app (lib/utils/cycle_marks.dart).
// The checks bound the *current* lists; a new option is an `alter` of the check, made before
// the app that uses it is released.
export class CreateCycleDays1793189679597 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      create table cycle_days (
        user_id uuid not null,
        date date not null,
        flow smallint not null default 0,
        mood smallint,
        symptoms smallint[] not null default '{}',
        discharge smallint,
        sex smallint,
        pill boolean not null default false,
        note text,
        client_updated_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        constraint cycle_days_pkey primary key (user_id, date),
        constraint cycle_days_user_id_fkey
          foreign key (user_id) references users (id) on delete cascade,
        constraint cycle_days_flow_check check (flow between 0 and 4),
        constraint cycle_days_mood_check check (mood between 0 and 5),
        constraint cycle_days_symptoms_check
          check (symptoms <@ array[0, 1, 2, 3, 4, 5, 6, 7, 8]::smallint[]),
        constraint cycle_days_discharge_check check (discharge between 0 and 6),
        constraint cycle_days_sex_check check (sex between 0 and 2)
      )
    `);

    // The one read: "everything of mine changed since X".
    await queryRunner.query(
      `create index cycle_days_user_updated_idx on cycle_days (user_id, updated_at)`,
    );
    await queryRunner.query(`
      create trigger cycle_days_updated_at
        before insert or update on cycle_days
        for each row execute function set_updated_at()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('drop table cycle_days');
  }
}
