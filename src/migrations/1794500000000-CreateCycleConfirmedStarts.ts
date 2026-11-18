import { MigrationInterface, QueryRunner } from 'typeorm';

// Confirmed cycle boundaries are separate from calendar-day marks. Existing cycle_days remain
// untouched; clients perform their one-time local derivation and then sync the explicit starts.
export class CreateCycleConfirmedStarts1794500000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      create table cycle_confirmed_starts (
        user_id uuid not null,
        date date not null,
        updated_at timestamptz not null default now(),
        deleted_at timestamptz,
        constraint cycle_confirmed_starts_pkey primary key (user_id, date),
        constraint cycle_confirmed_starts_user_id_fkey
          foreign key (user_id) references users (id) on delete cascade
      )
    `);
    await queryRunner.query(
      `create index cycle_confirmed_starts_user_updated_idx
       on cycle_confirmed_starts (user_id, updated_at)`,
    );
    await queryRunner.query(`
      create trigger cycle_confirmed_starts_updated_at
        before insert or update on cycle_confirmed_starts
        for each row execute function set_updated_at()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('drop table cycle_confirmed_starts');
  }
}
