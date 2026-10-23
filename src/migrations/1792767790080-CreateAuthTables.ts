import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAuthTables1792767790080 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // An account is either email + password, or Google (identified by its stable `sub`).
    // Google is never merged into an existing password account by email alone: we do
    // not verify emails at sign-up, so that would let anyone take over an address.
    await queryRunner.query(`
      create table users (
        id uuid not null default gen_random_uuid(),
        email text not null,
        password_hash text,
        google_sub text,
        created_at timestamptz not null default now(),
        constraint users_pkey primary key (id),
        constraint users_email_key unique (email),
        constraint users_google_sub_key unique (google_sub),
        constraint users_email_lowercase check (email = lower(email)),
        constraint users_has_credential
          check (password_hash is not null or google_sub is not null)
      )
    `);

    // Single-use: refreshing deletes the row and inserts the next one. Only the hash is kept.
    // Cascade: deleting an account (B8) removes its sessions.
    await queryRunner.query(`
      create table refresh_tokens (
        token_hash text not null,
        user_id uuid not null,
        expires_at timestamptz not null,
        created_at timestamptz not null default now(),
        constraint refresh_tokens_pkey primary key (token_hash),
        constraint refresh_tokens_user_id_fkey
          foreign key (user_id) references users (id) on delete cascade
      )
    `);
    await queryRunner.query(
      `create index refresh_tokens_user_id_idx on refresh_tokens (user_id)`,
    );

    // What other people see: name and picture. Groups (B5) read member names from here.
    await queryRunner.query(`
      create table profiles (
        user_id uuid not null,
        display_name text,
        avatar_url text,
        updated_at timestamptz not null default now(),
        constraint profiles_pkey primary key (user_id),
        constraint profiles_user_id_fkey
          foreign key (user_id) references users (id) on delete cascade,
        constraint profiles_display_name_length check (length(display_name) <= 100),
        constraint profiles_avatar_url_length check (length(avatar_url) <= 2048)
      )
    `);
    await queryRunner.query(`
      create trigger profiles_updated_at
        before insert or update on profiles
        for each row execute function set_updated_at()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('drop table profiles');
    await queryRunner.query('drop table refresh_tokens');
    await queryRunner.query('drop table users');
  }
}
