import { INestApplication } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { LabelWriter } from '../src/sync/label-writer';
import {
  MoodRow,
  parseMood,
  parseTag,
  RowResult,
  TagRow,
} from '../src/sync/push-rows';
import { createTestApp, truncateAll } from './support/db';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [L1, L2, L3, L4] = [id(1), id(2), id(3), id(4)];
const JOY = '0f8a4c3e-1d92-4b7a-9c15-6e2f8a01b4d3'; // a starter mood

const ok = <T>(result: RowResult<T>): T => {
  if (!('row' in result)) throw new Error('bad test row');
  return result.row;
};

type Write = (
  writer: LabelWriter,
  manager: EntityManager,
  userId: string,
  rows: never[],
) => Promise<unknown>;

// Moods and tags are written the same way; the same checks run on both.
const KINDS = [
  {
    kind: 'moods',
    table: 'note_moods',
    make: (fields: Record<string, unknown>) =>
      ok(parseMood({ name: 'Joy', emoji: '😊', ...fields })),
    write: (w, m, u, r) => w.writeMoods(m, u, r),
    own: { name: 'Mine', emoji: '🙂' },
    changed: { name: 'Changed', emoji: '🙃' },
    columns: ['name', 'emoji'],
  },
  {
    kind: 'tags',
    table: 'note_tags',
    make: (fields: Record<string, unknown>) =>
      ok(parseTag({ name: 'Work', ...fields })),
    write: (w, m, u, r) => w.writeTags(m, u, r),
    own: { name: 'Mine', color_key: 'green' },
    changed: { name: 'Changed', color_key: 'red' },
    columns: ['name', 'color_key'],
  },
] as {
  kind: string;
  table: 'note_moods' | 'note_tags';
  make: (fields: Record<string, unknown>) => MoodRow | TagRow;
  write: Write;
  own: Record<string, unknown>;
  changed: Record<string, unknown>;
  columns: string[];
}[];

describe('LabelWriter', () => {
  let app: INestApplication;
  let ds: DataSource;
  let writer: LabelWriter;
  let ann: string;
  let bob: string;

  beforeAll(async () => {
    app = await createTestApp();
    ds = app.get(DataSource);
    writer = app.get(LabelWriter);
  });

  beforeEach(async () => {
    await truncateAll(ds);
    ann = await addUser('ann@example.com');
    bob = await addUser('bob@example.com');
  });

  afterAll(() => app.close());

  async function addUser(email: string) {
    const [row] = await ds.query(
      `insert into users (email, password_hash) values ($1, 'hash') returning id`,
      [email],
    );
    return row.id as string;
  }

  describe.each(KINDS)('$kind', (k) => {
    const rowsOf = (...fields: Record<string, unknown>[]) =>
      fields.map((f) => k.make(f)) as never[];
    const write = (userId: string, ...fields: Record<string, unknown>[]) =>
      ds.transaction((m) => k.write(writer, m, userId, rowsOf(...fields)));
    const get = async (rowId: string): Promise<Record<string, unknown>> => {
      const rows: Record<string, unknown>[] = await ds.query(
        `select * from ${k.table} where id = $1`,
        [rowId],
      );
      return rows[0];
    };
    const count = async (where = 'user_id is not null') =>
      (
        await ds.query(`select count(*)::int n from ${k.table} where ${where}`)
      )[0].n as number;
    const rejection = (rowId: string, reason: string) => ({
      table: k.table,
      id: rowId,
      reason,
    });

    it('writes new rows under the caller, with every field', async () => {
      const rejected = await write(ann, {
        id: L1,
        ...k.own,
        created_at: '2026-01-15T10:00:00.123456Z',
        client_updated_at: '2026-01-15T10:00:01.654321Z',
      });
      expect(rejected).toEqual([]);
      const r = await get(L1);
      expect(r).toMatchObject({ user_id: ann, deleted_at: null });
      for (const c of k.columns) expect(r[c]).toBe(k.own[c]);
      const [{ created, client }] = await ds.query(
        `select created_at::text created, client_updated_at::text client from ${k.table} where id = $1`,
        [L1],
      );
      expect(created).toBe('2026-01-15 10:00:00.123456+00');
      expect(client).toBe('2026-01-15 10:00:01.654321+00');
    });

    it('stamps updated_at on the server, whatever the client says', async () => {
      await write(ann, { id: L1, client_updated_at: '2000-01-01T00:00:00Z' });
      const [{ fresh }] = await ds.query(
        `select updated_at > '2020-01-01' fresh from ${k.table} where id = $1`,
        [L1],
      );
      expect(fresh).toBe(true);
    });

    it('does nothing for an empty list', async () => {
      expect(await write(ann)).toEqual([]);
      expect(await count()).toBe(0);
    });

    describe('updating', () => {
      it('overwrites the content of its own row but keeps created_at', async () => {
        await write(ann, {
          id: L1,
          ...k.own,
          created_at: '2026-01-01T00:00:00Z',
        });
        await write(ann, {
          id: L1,
          ...k.changed,
          created_at: '2026-02-02T00:00:00Z',
        });
        const [{ created }] = await ds.query(
          `select created_at::text created from ${k.table} where id = $1`,
          [L1],
        );
        const r = await get(L1);
        for (const c of k.columns) expect(r[c]).toBe(k.changed[c]);
        expect(created).toBe('2026-01-01 00:00:00+00');
        expect(await count()).toBe(1);
      });

      it('moves updated_at forward', async () => {
        await write(ann, { id: L1 });
        const [{ before }] = await ds.query(
          `select updated_at::text before from ${k.table} where id = $1`,
          [L1],
        );
        await write(ann, { id: L1, ...k.changed });
        const [{ moved }] = await ds.query(
          `select updated_at > $2::timestamptz moved from ${k.table} where id = $1`,
          [L1, before],
        );
        expect(moved).toBe(true);
      });

      it('is idempotent: the same batch twice leaves the same rows and refuses nothing', async () => {
        const batch = [
          {
            id: L1,
            ...k.own,
            created_at: '2026-01-01T00:00:00Z',
            client_updated_at: '2026-01-02T00:00:00Z',
          },
          {
            id: L2,
            ...k.changed,
            created_at: '2026-01-01T00:00:00Z',
            client_updated_at: '2026-01-02T00:00:00Z',
          },
        ];
        expect(await write(ann, ...batch)).toEqual([]);
        const first = await ds.query(
          `select id, user_id, ${k.columns.join(', ')}, created_at::text c from ${k.table} where user_id is not null order by id`,
        );
        expect(await write(ann, ...batch)).toEqual([]);
        expect(
          await ds.query(
            `select id, user_id, ${k.columns.join(', ')}, created_at::text c from ${k.table} where user_id is not null order by id`,
          ),
        ).toEqual(first);
      });
    });

    describe("another user's rows", () => {
      it('are not touched, and the id is reported as taken', async () => {
        await write(bob, { id: L1, name: "Bob's" });
        const rejected = await write(ann, { id: L1, name: 'Hijacked' });
        expect(rejected).toEqual([rejection(L1, 'id_taken')]);
        expect(await get(L1)).toMatchObject({ user_id: bob, name: "Bob's" });
      });

      it('are not touched even when Bob has deleted them', async () => {
        await write(bob, { id: L1, name: "Bob's" });
        await ds.query(
          `update ${k.table} set deleted_at = now() where id = $1`,
          [L1],
        );
        expect(await write(ann, { id: L1, name: 'Mine' })).toEqual([
          rejection(L1, 'id_taken'),
        ]);
        expect(await get(L1)).toMatchObject({ user_id: bob, name: '' });
      });

      it('stay out of reach if the check misses them (a race between check and write)', async () => {
        await write(bob, { id: L1, name: "Bob's" });
        await ds.transaction(async (manager) => {
          // The look-up claims L1 does not exist, as if Bob's row appeared a moment later.
          const blind = Object.create(manager) as EntityManager;
          blind.query = ((sql: string, params?: unknown[]) =>
            sql.includes('where id = any')
              ? Promise.resolve([])
              : manager.query(sql, params)) as EntityManager['query'];
          await k.write(
            writer,
            blind,
            ann,
            rowsOf({ id: L1, name: 'Hijacked' }),
          );
        });
        expect(await get(L1)).toMatchObject({ user_id: bob, name: "Bob's" });
      });

      it('leave each user their own rows in one table', async () => {
        await write(ann, { id: L1 });
        await write(bob, { id: L2 });
        const rows = await ds.query(
          `select id, user_id from ${k.table} where user_id is not null order by id`,
        );
        expect(rows).toEqual([
          { id: L1, user_id: ann },
          { id: L2, user_id: bob },
        ]);
      });
    });

    describe('deleted rows', () => {
      it('stay deleted and empty when a device that missed the deletion sends them again', async () => {
        await write(ann, { id: L1, ...k.own });
        await ds.query(
          `update ${k.table} set deleted_at = now() where id = $1`,
          [L1],
        );
        expect(await write(ann, { id: L1, ...k.changed })).toEqual([]);
        const r = await get(L1);
        expect(r.name).toBe('');
        expect(r.deleted_at).not.toBeNull();
      });

      it('are left untouched, updated_at included', async () => {
        await write(ann, { id: L1 });
        await ds.query(
          `update ${k.table} set deleted_at = now() where id = $1`,
          [L1],
        );
        const [{ before }] = await ds.query(
          `select updated_at::text before from ${k.table} where id = $1`,
          [L1],
        );
        await write(ann, { id: L1, ...k.changed });
        const [{ same }] = await ds.query(
          `select updated_at = $2::timestamptz same from ${k.table} where id = $1`,
          [L1, before],
        );
        expect(same).toBe(true);
      });
    });

    it('writes the good rows next to the refused ones', async () => {
      await write(bob, { id: L2 });
      const rejected = await write(ann, { id: L1 }, { id: L2 }, { id: L3 });
      expect(rejected).toEqual([rejection(L2, 'id_taken')]);
      const rows = await ds.query(
        `select id from ${k.table} where user_id = $1 order by id`,
        [ann],
      );
      expect(rows.map((r: { id: string }) => r.id)).toEqual([L1, L3]);
    });

    it('keeps the last version of an id sent twice in one batch', async () => {
      await write(ann, { id: L1, name: 'first' }, { id: L1, name: 'second' });
      expect((await get(L1)).name).toBe('second');
    });

    it('stores half an emoji as U+FFFD and keeps quotes, backslashes and newlines exactly', async () => {
      await write(
        ann,
        { id: L1, name: 'a\ud83d' },
        { id: L2, name: 'He said "hi" \\ \n 😀' },
      );
      expect((await get(L1)).name).toBe('a�');
      expect((await get(L2)).name).toBe('He said "hi" \\ \n 😀');
    });

    it('writes 500 rows in one go', async () => {
      const batch = Array.from({ length: 500 }, (_, i) => ({
        id: id(1000 + i),
      }));
      expect(await write(ann, ...batch)).toEqual([]);
      expect(await count()).toBe(500);
    });

    it('rolls back with the push transaction', async () => {
      await expect(
        ds.transaction(async (m) => {
          await k.write(writer, m, ann, rowsOf({ id: L1 }));
          throw new Error('later step failed');
        }),
      ).rejects.toThrow('later step failed');
      expect(await count()).toBe(0);
    });
  });

  describe('the starter moods', () => {
    const joy = () => ({ id: JOY, name: 'Hijacked', emoji: '💀' });
    const moods = (...f: Record<string, unknown>[]) =>
      f.map((x) => ok(parseMood(x)));
    const write = (userId: string, ...f: Record<string, unknown>[]) =>
      ds.transaction((m) => writer.writeMoods(m, userId, moods(...f)));
    const starter = async (): Promise<Record<string, unknown>> => {
      const rows: Record<string, unknown>[] = await ds.query(
        `select name, emoji, user_id from note_moods where id = $1`,
        [JOY],
      );
      return rows[0];
    };

    it('cannot be written by anybody: the id is reported as taken, the mood stays', async () => {
      const rejected = await write(ann, joy());
      expect(rejected).toEqual([
        { table: 'note_moods', id: JOY, reason: 'id_taken' },
      ]);
      expect(await starter()).toEqual({
        name: 'Радость',
        emoji: '😊',
        user_id: null,
      });
    });

    it('are refused for every user alike', async () => {
      await write(ann, joy());
      expect(await write(bob, joy())).toEqual([
        { table: 'note_moods', id: JOY, reason: 'id_taken' },
      ]);
    });

    it('stay unchanged without an error even if the check misses them (the database has the last word)', async () => {
      await ds.transaction(async (manager) => {
        const blind = Object.create(manager) as EntityManager;
        blind.query = ((sql: string, params?: unknown[]) =>
          sql.includes('where id = any')
            ? Promise.resolve([])
            : manager.query(sql, params)) as EntityManager['query'];
        await writer.writeMoods(blind, ann, moods(joy()));
      });
      expect(await starter()).toEqual({
        name: 'Радость',
        emoji: '😊',
        user_id: null,
      });
    });

    it('do not stop the other moods of the same batch', async () => {
      const rejected = await write(ann, joy(), {
        id: L1,
        name: 'Mine',
        emoji: '🙂',
      });
      expect(rejected.map((r) => (r as { id: string }).id)).toEqual([JOY]);
      const [{ n }] = await ds.query(
        `select count(*)::int n from note_moods where user_id = $1`,
        [ann],
      );
      expect(n).toBe(1);
    });

    it('are not wiped by a tag with the same id', async () => {
      // A tag and a mood have separate tables; a starter id sent as a tag is just a new tag.
      const rejected = await ds.transaction((m) =>
        writer.writeTags(m, ann, [ok(parseTag({ id: JOY, name: 'Odd' }))]),
      );
      expect(rejected).toEqual([]);
      expect(await starter()).toEqual({
        name: 'Радость',
        emoji: '😊',
        user_id: null,
      });
    });
  });

  it('keeps a mood and a tag with the same id apart (separate tables)', async () => {
    await ds.transaction(async (m) => {
      await writer.writeMoods(m, ann, [
        ok(parseMood({ id: L4, name: 'm', emoji: 'e' })),
      ]);
      await writer.writeTags(m, bob, [ok(parseTag({ id: L4, name: 't' }))]);
    });
    expect(
      (await ds.query(`select user_id from note_moods where id = $1`, [L4]))[0]
        .user_id,
    ).toBe(ann);
    expect(
      (await ds.query(`select user_id from note_tags where id = $1`, [L4]))[0]
        .user_id,
    ).toBe(bob);
  });
});
