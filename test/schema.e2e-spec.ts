import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createTestApp, truncateAll } from './support/db';

describe('Auth tables', () => {
  let app: INestApplication;
  let ds: DataSource;

  beforeAll(async () => {
    app = await createTestApp();
    ds = app.get(DataSource);
  });

  beforeEach(() => truncateAll(ds));

  afterAll(() => app.close());

  async function addUser(email: string, passwordHash: string | null = 'hash') {
    const [row] = await ds.query(
      `insert into users (email, password_hash) values ($1, $2) returning id`,
      [email, passwordHash],
    );
    return row.id as string;
  }

  it('matches the entities: nothing left for TypeORM to change', async () => {
    const { upQueries } = await ds.driver.createSchemaBuilder().log();
    expect(upQueries.map((q) => q.query)).toEqual([]);
  });

  describe('users', () => {
    it('generates the id itself', async () => {
      const id = await addUser('a@example.com');
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('refuses an upper-case email', async () => {
      await expect(addUser('A@Example.com')).rejects.toThrow(
        /users_email_lowercase/,
      );
    });

    it('refuses a duplicate email', async () => {
      await addUser('a@example.com');
      await expect(addUser('a@example.com')).rejects.toThrow(/users_email_key/);
    });

    it('refuses an account with neither password nor Google', async () => {
      await expect(addUser('a@example.com', null)).rejects.toThrow(
        /users_has_credential/,
      );
    });

    it('accepts a Google-only account, and refuses a second one with the same sub', async () => {
      const insert = (email: string) =>
        ds.query(
          `insert into users (email, google_sub) values ($1, 'sub-1') returning id`,
          [email],
        );
      await insert('g@example.com');
      await expect(insert('h@example.com')).rejects.toThrow(
        /users_google_sub_key/,
      );
    });

    it('allows many accounts without a Google sub', async () => {
      await addUser('a@example.com');
      await addUser('b@example.com');
    });
  });

  describe('refresh_tokens', () => {
    const insertToken = (hash: string, userId: string) =>
      ds.query(
        `insert into refresh_tokens (token_hash, user_id, expires_at)
         values ($1, $2, now() + interval '90 days')`,
        [hash, userId],
      );

    it('refuses a token of a user that does not exist', async () => {
      await expect(
        insertToken('h1', '00000000-0000-4000-8000-000000000000'),
      ).rejects.toThrow(/refresh_tokens_user_id_fkey/);
    });

    it('refuses the same hash twice', async () => {
      const id = await addUser('a@example.com');
      await insertToken('h1', id);
      await expect(insertToken('h1', id)).rejects.toThrow(
        /refresh_tokens_pkey/,
      );
    });

    it('is removed together with its user', async () => {
      const id = await addUser('a@example.com');
      await insertToken('h1', id);
      await ds.query(`delete from users where id = $1`, [id]);
      const [{ n }] = await ds.query(
        `select count(*)::int n from refresh_tokens`,
      );
      expect(n).toBe(0);
    });
  });

  describe('profiles', () => {
    it('stamps updated_at on the server clock, ignoring the value given', async () => {
      const id = await addUser('a@example.com');
      await ds.query(
        `insert into profiles (user_id, display_name, updated_at) values ($1, 'Ann', '2000-01-01')`,
        [id],
      );
      const [row] = await ds.query(
        `select updated_at > '2020-01-01' as fresh from profiles`,
      );
      expect(row.fresh).toBe(true);
    });

    it('moves updated_at forward on every update', async () => {
      const id = await addUser('a@example.com');
      await ds.query(`insert into profiles (user_id) values ($1)`, [id]);
      // Kept as text and compared inside Postgres: a JS Date only has milliseconds,
      // and two writes can land in the same one.
      const [{ before }] = await ds.query(
        `select updated_at::text as before from profiles`,
      );
      await ds.query(`update profiles set display_name = 'Ann'`);
      const [{ moved }] = await ds.query(
        `select updated_at > $1::timestamptz as moved from profiles`,
        [before],
      );
      expect(moved).toBe(true);
    });

    it('limits the name to 100 and the avatar address to 2048 characters', async () => {
      const id = await addUser('a@example.com');
      await expect(
        ds.query(
          `insert into profiles (user_id, display_name) values ($1, $2)`,
          [id, 'x'.repeat(101)],
        ),
      ).rejects.toThrow(/profiles_display_name_length/);
      await expect(
        ds.query(`insert into profiles (user_id, avatar_url) values ($1, $2)`, [
          id,
          'x'.repeat(2049),
        ]),
      ).rejects.toThrow(/profiles_avatar_url_length/);
      await ds.query(
        `insert into profiles (user_id, display_name, avatar_url) values ($1, $2, $3)`,
        [id, 'x'.repeat(100), 'x'.repeat(2048)],
      );
    });

    it('is removed together with its user', async () => {
      const id = await addUser('a@example.com');
      await ds.query(`insert into profiles (user_id) values ($1)`, [id]);
      await ds.query(`delete from users where id = $1`, [id]);
      const [{ n }] = await ds.query(`select count(*)::int n from profiles`);
      expect(n).toBe(0);
    });
  });
});
