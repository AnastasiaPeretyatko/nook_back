import { MigrationInterface, QueryRunner } from 'typeorm';

// Push notifications, step one (B7): which phones belong to whom. Ported from the Supabase
// script 011.
//
// One row per PHONE, not per account: the key is the FCM token, which names a device. A person
// with two phones has two rows; two people who sign in on one phone in turn have one row that
// moves from one to the other, because the token reaches whoever holds the phone, so the last
// to sign in owns it. The hand-over is an upsert in the route, not something this table checks:
// it only makes sure a token has exactly one owner at a time.
//
// Nothing here is shown to clients: the routes (`PUT`/`DELETE /devices`) take only the caller's
// own token, and nothing ever lists the tokens.
export class CreateDeviceTokens1793276328511 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      create table device_tokens (
        token text not null,
        user_id uuid not null,
        updated_at timestamptz not null default now(),
        constraint device_tokens_pkey primary key (token),
        constraint device_tokens_user_id_fkey
          foreign key (user_id) references users (id) on delete cascade,
        constraint device_tokens_token_length check (length(token) between 20 and 4096)
      )
    `);

    // "All the phones of this person": read for every notification sent.
    await queryRunner.query(
      `create index device_tokens_user_id_idx on device_tokens (user_id)`,
    );
    await queryRunner.query(`
      create trigger device_tokens_updated_at
        before insert or update on device_tokens
        for each row execute function set_updated_at()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('drop table device_tokens');
  }
}
