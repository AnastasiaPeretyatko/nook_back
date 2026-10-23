import { MigrationInterface, QueryRunner } from 'typeorm';

// Trigger function shared by every synced table: stamps `updated_at` on the server's clock.
// A client pulls "everything newer than X", so X must come from one clock, never a phone's.
// clock_timestamp(), not now(): now() is the start of the transaction, so a later write
// could get an earlier stamp and a client would miss it.
export class SetUpdatedAtFunction1792758277932 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      create or replace function set_updated_at()
      returns trigger
      language plpgsql
      as $$
      begin
        new.updated_at = clock_timestamp();
        return new;
      end;
      $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('drop function if exists set_updated_at()');
  }
}
