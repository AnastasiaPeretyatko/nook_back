import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createTestApp, truncateAll } from './support/db';

const NOBODY = '00000000-0000-4000-8000-000000000000';
const tokenOf = (n: number, length = 40) => `phone-${n}-`.padEnd(length, 'x');

describe('Table device_tokens', () => {
  let app: INestApplication;
  let ds: DataSource;

  beforeAll(async () => {
    app = await createTestApp();
    ds = app.get(DataSource);
  });

  beforeEach(() => truncateAll(ds));

  afterAll(() => app.close());

  async function addUser(email = 'a@example.com') {
    const [row] = await ds.query(
      `insert into users (email, password_hash) values ($1, 'hash') returning id`,
      [email],
    );
    return row.id as string;
  }
  const addToken = (userId: string | null, token: string | null) =>
    ds.query(`insert into device_tokens (token, user_id) values ($1, $2)`, [
      token,
      userId,
    ]);
  const rows = (): Promise<{ token: string; user_id: string }[]> =>
    ds.query(`select token, user_id from device_tokens order by token`);

  it('stores a token with the account it belongs to', async () => {
    const ann = await addUser();
    await addToken(ann, tokenOf(1));
    expect(await rows()).toEqual([{ token: tokenOf(1), user_id: ann }]);
  });

  it('lets one account hold several phones', async () => {
    const ann = await addUser();
    await addToken(ann, tokenOf(1));
    await addToken(ann, tokenOf(2));
    expect((await rows()).map((r) => r.user_id)).toEqual([ann, ann]);
  });

  describe('a token has exactly one owner', () => {
    it('refuses the same token twice', async () => {
      const ann = await addUser('ann@example.com');
      const bob = await addUser('bob@example.com');
      await addToken(ann, tokenOf(1));
      await expect(addToken(bob, tokenOf(1))).rejects.toThrow(
        /device_tokens_pkey/,
      );
      await expect(addToken(ann, tokenOf(1))).rejects.toThrow(
        /device_tokens_pkey/,
      );
      expect(await rows()).toEqual([{ token: tokenOf(1), user_id: ann }]);
    });

    it('moves to the one who signed in last, as the upsert of PUT /devices does', async () => {
      const ann = await addUser('ann@example.com');
      const bob = await addUser('bob@example.com');
      await addToken(ann, tokenOf(1));
      await ds.query(
        `insert into device_tokens (token, user_id) values ($1, $2)
         on conflict (token) do update set user_id = excluded.user_id`,
        [tokenOf(1), bob],
      );
      expect(await rows()).toEqual([{ token: tokenOf(1), user_id: bob }]);
    });
  });

  describe('the owner', () => {
    it('must be an existing account', async () => {
      await expect(addToken(NOBODY, tokenOf(1))).rejects.toThrow(
        /device_tokens_user_id_fkey/,
      );
      expect(await rows()).toEqual([]);
    });

    it('is required, and so is the token', async () => {
      const ann = await addUser();
      await expect(addToken(null, tokenOf(1))).rejects.toThrow(/user_id/);
      await expect(addToken(ann, null)).rejects.toThrow(/token/);
    });

    it('takes the phones with it when the account is deleted, and only its own', async () => {
      const ann = await addUser('ann@example.com');
      const bob = await addUser('bob@example.com');
      await addToken(ann, tokenOf(1));
      await addToken(ann, tokenOf(2));
      await addToken(bob, tokenOf(3));
      await ds.query(`delete from users where id = $1`, [ann]);
      expect(await rows()).toEqual([{ token: tokenOf(3), user_id: bob }]);
    });
  });

  describe('the length of a token', () => {
    it.each([20, 21, 4095, 4096])('allows %i characters', async (length) => {
      const ann = await addUser();
      await addToken(ann, tokenOf(1, length));
      expect((await rows())[0].token).toHaveLength(length);
    });

    it.each([0, 1, 19, 4097, 10000])(
      'refuses %i characters',
      async (length) => {
        const ann = await addUser();
        await expect(addToken(ann, tokenOf(1, length))).rejects.toThrow(
          /device_tokens_token_length/,
        );
        expect(await rows()).toEqual([]);
      },
    );
  });

  describe('updated_at', () => {
    it('is stamped by the server and ignores what is sent', async () => {
      const ann = await addUser();
      await ds.query(
        `insert into device_tokens (token, user_id, updated_at) values ($1, $2, '2000-01-01')`,
        [tokenOf(1), ann],
      );
      const [{ fresh }] = await ds.query(
        `select updated_at > '2020-01-01' fresh from device_tokens`,
      );
      expect(fresh).toBe(true);
    });

    it('moves when the token changes hands, and again whatever the update says', async () => {
      const ann = await addUser('ann@example.com');
      const bob = await addUser('bob@example.com');
      await addToken(ann, tokenOf(1));
      const [{ before }] = await ds.query(
        `select updated_at::text before from device_tokens`,
      );
      await ds.query(
        `update device_tokens set user_id = $1, updated_at = '2000-01-01'`,
        [bob],
      );
      const [{ moved }] = await ds.query(
        `select updated_at > $1::timestamptz moved from device_tokens`,
        [before],
      );
      expect(moved).toBe(true);
    });
  });

  it('has an index for "all the phones of this account"', async () => {
    const [index] = await ds.query(
      `select indexdef from pg_indexes
       where tablename = 'device_tokens' and indexname = 'device_tokens_user_id_idx'`,
    );
    expect(index.indexdef).toMatch(/\(user_id\)/);
  });

  it('is emptied by the test cleaner like every other table', async () => {
    const ann = await addUser();
    await addToken(ann, tokenOf(1));
    await truncateAll(ds);
    expect(await rows()).toEqual([]);
  });
});
