import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { DeletionWriter } from '../src/sync/deletion-writer';
import { createTestApp, truncateAll } from './support/db';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [N1, N2] = [id(1), id(2)];
const [M1, M2] = [id(11), id(12)];
const [G1, G2] = [id(21), id(22)];
const T1 = id(31);
const JOY = '0f8a4c3e-1d92-4b7a-9c15-6e2f8a01b4d3'; // a starter mood

interface PushResponse {
  rejected: { table: string; id: string | null; reason: string }[];
  server_time: string;
}
interface Session {
  token: string;
  id: string;
}

describe('POST /sync/push with the diary', () => {
  let app: INestApplication;
  let ds: DataSource;
  let throwInDeletions = false;
  let ann: Session;
  let bob: Session;
  const api = () => request(app.getHttpServer());

  async function signUp(email: string): Promise<Session> {
    const res = await api()
      .post('/auth/register')
      .send({ email, password: 'correct horse' })
      .expect(201);
    const body = res.body as { accessToken: string; user: { id: string } };
    return { token: body.accessToken, id: body.user.id };
  }

  const push = async (who: Session, body: object, status = 200) => {
    const res = await api()
      .post('/sync/push')
      .set('Authorization', `Bearer ${who.token}`)
      .send(body)
      .expect(status);
    return res.body as PushResponse;
  };
  const reasons = (r: PushResponse) =>
    r.rejected.map((x) => `${x.table}:${x.id}:${x.reason}`).sort();

  beforeAll(async () => {
    app = await createTestApp([], 0, (builder) =>
      builder.overrideProvider(DeletionWriter).useFactory({
        factory: () => ({
          write: (...args: Parameters<DeletionWriter['write']>) => {
            if (throwInDeletions) throw new Error('database went away');
            return new DeletionWriter().write(...args);
          },
        }),
      }),
    );
    ds = app.get(DataSource);
  });

  beforeEach(async () => {
    throwInDeletions = false;
    await truncateAll(ds);
    ann = await signUp('ann@example.com');
    bob = await signUp('bob@example.com');
  });

  afterAll(() => app.close());

  const all = async (sql: string, ...params: unknown[]) => {
    const rows: Record<string, unknown>[] = await ds.query(sql, params);
    return rows;
  };
  const notesOf = (userId: string) =>
    all(
      `select id, title, deleted_at is not null as deleted from diary_entries where user_id = $1 order by id`,
      userId,
    );
  const tagLinks = (userId: string) =>
    all(
      `select entry_id, tag_id from diary_entry_tags where user_id = $1 order by entry_id, tag_id`,
      userId,
    );
  const moodLinks = (userId: string) =>
    all(
      `select entry_id, mood_id from diary_entry_moods where user_id = $1 order by entry_id, mood_id`,
      userId,
    );

  it('writes moods, tags and a note that names them, from one request', async () => {
    const res = await push(ann, {
      moods: [{ id: M1, name: 'Mine', emoji: '🙂' }],
      tags: [{ id: G1, name: 'Work', color_key: 'red' }],
      entries: [
        {
          id: N1,
          title: 'A day',
          body: 'text',
          mood_ids: [M1, JOY],
          tag_ids: [G1],
        },
      ],
    });
    expect(res.rejected).toEqual([]);
    expect(await notesOf(ann.id)).toEqual([
      { id: N1, title: 'A day', deleted: false },
    ]);
    expect(await tagLinks(ann.id)).toEqual([{ entry_id: N1, tag_id: G1 }]);
    expect(await moodLinks(ann.id)).toEqual(
      [
        { entry_id: N1, mood_id: M1 },
        { entry_id: N1, mood_id: JOY },
      ].sort((a, b) => a.mood_id.localeCompare(b.mood_id)),
    );
  });

  it('writes the diary together with tasks, marks and deletions', async () => {
    const res = await push(ann, {
      tags: [{ id: G1, name: 'Work' }],
      entries: [{ id: N1, tag_ids: [G1] }],
      tasks: [{ id: T1, title: 'Read' }],
      logs: [{ task_id: T1, date: '2026-01-15', completed: true }],
      deleted: [{ table: 'diary_entries', id: N2 }],
    });
    expect(res.rejected).toEqual([]);
    expect((await notesOf(ann.id)).map((n) => [n.id, n.deleted])).toEqual([
      [N1, false],
      [N2, true],
    ]);
    expect(await all(`select count(*)::int n from tasks`)).toEqual([{ n: 1 }]);
    expect(await all(`select count(*)::int n from task_logs`)).toEqual([
      { n: 1 },
    ]);
  });

  it('applies the deletions last: a tag deleted in the same request takes its links with it', async () => {
    const res = await push(ann, {
      tags: [{ id: G1, name: 'Work' }],
      entries: [{ id: N1, tag_ids: [G1] }],
      deleted: [{ table: 'note_tags', id: G1 }],
    });
    expect(res.rejected).toEqual([]);
    expect(await tagLinks(ann.id)).toEqual([]);
    expect((await notesOf(ann.id))[0].deleted).toBe(false);
  });

  it('takes the same push twice and leaves the same data', async () => {
    const body = {
      moods: [
        {
          id: M1,
          name: 'Mine',
          emoji: '🙂',
          created_at: '2026-01-01T00:00:00Z',
          client_updated_at: '2026-01-02T00:00:00Z',
        },
      ],
      tags: [
        {
          id: G1,
          name: 'Work',
          created_at: '2026-01-01T00:00:00Z',
          client_updated_at: '2026-01-02T00:00:00Z',
        },
      ],
      entries: [
        {
          id: N1,
          title: 'A day',
          mood_ids: [M1, JOY],
          tag_ids: [G1],
          created_at: '2026-01-01T00:00:00Z',
          client_updated_at: '2026-01-02T00:00:00Z',
        },
      ],
      deleted: [{ table: 'note_tags', id: G2 }],
    };
    expect((await push(ann, body)).rejected).toEqual([]);
    const snapshot = async () => [
      await notesOf(ann.id),
      await tagLinks(ann.id),
      await moodLinks(ann.id),
      await all(
        `select id, name, emoji from note_moods where user_id = $1`,
        ann.id,
      ),
      await all(
        `select id, name, color_key from note_tags where user_id = $1 order by id`,
        ann.id,
      ),
    ];
    const first = await snapshot();
    expect((await push(ann, body)).rejected).toEqual([]);
    expect(await snapshot()).toEqual(first);
  });

  it('replaces the links of a note by the next push, and leaves them if the note does not name them', async () => {
    await push(ann, {
      tags: [
        { id: G1, name: 'a' },
        { id: G2, name: 'b' },
      ],
      entries: [{ id: N1, tag_ids: [G1, G2] }],
    });
    await push(ann, { entries: [{ id: N1, title: 'edited' }] });
    expect(await tagLinks(ann.id)).toHaveLength(2);
    await push(ann, { entries: [{ id: N1, tag_ids: [G2] }] });
    expect(await tagLinks(ann.id)).toEqual([{ entry_id: N1, tag_id: G2 }]);
    await push(ann, { entries: [{ id: N1, tag_ids: [] }] });
    expect(await tagLinks(ann.id)).toEqual([]);
  });

  describe('a bad row does not stop the rest', () => {
    it('reports each refusal under its table and writes the good rows', async () => {
      const res = await push(ann, {
        moods: [
          { id: M1, name: 'Fine', emoji: '🙂' },
          { id: M2, name: 'No emoji' },
        ],
        tags: [{ id: G1, name: 'Fine' }, { id: G2 }, 'text'],
        entries: [
          { id: N1, status: 'done' },
          { id: N2, title: 'Fine', tag_ids: [G1, id(99)] },
          null,
        ],
        deleted: [{ table: 'note_tags', id: 'abc' }],
      });
      expect(reasons(res)).toEqual(
        [
          `note_moods:${M2}:invalid_row`,
          `note_tags:${G2}:invalid_row`,
          `note_tags:null:invalid_row`,
          `diary_entries:${N1}:invalid_row`,
          `diary_entries:null:invalid_row`,
          `diary_entries:${N2}:unknown_label`,
          `deleted:null:invalid_row`,
        ].sort(),
      );
      expect((await notesOf(ann.id)).map((n) => n.id)).toEqual([N2]);
      expect(await tagLinks(ann.id)).toEqual([{ entry_id: N2, tag_id: G1 }]);
      expect(
        await all(`select id from note_moods where user_id = $1`, ann.id),
      ).toEqual([{ id: M1 }]);
    });
  });

  describe('who the rows belong to', () => {
    it('writes every row under the token, whatever user_id the body names', async () => {
      await push(ann, {
        moods: [{ id: M1, name: 'm', emoji: 'e', user_id: bob.id }],
        tags: [{ id: G1, name: 't', user_id: bob.id }],
        entries: [{ id: N1, user_id: bob.id, tag_ids: [G1] }],
      });
      expect(await notesOf(bob.id)).toEqual([]);
      expect(await tagLinks(bob.id)).toEqual([]);
      expect(
        await all(`select id from note_tags where user_id = $1`, bob.id),
      ).toEqual([]);
      expect(
        await all(`select id from note_moods where user_id = $1`, bob.id),
      ).toEqual([]);
      expect(await notesOf(ann.id)).toHaveLength(1);
    });

    it("leaves Bob's diary alone when Ann names his ids", async () => {
      await push(bob, {
        moods: [{ id: M1, name: "Bob's mood", emoji: '🙂' }],
        tags: [{ id: G1, name: "Bob's tag" }],
        entries: [
          {
            id: N1,
            title: "Bob's",
            body: 'secret',
            mood_ids: [M1, JOY],
            tag_ids: [G1],
          },
        ],
      });
      const bobsBefore = [
        await notesOf(bob.id),
        await tagLinks(bob.id),
        await moodLinks(bob.id),
        await all(`select name, emoji from note_moods where id = $1`, M1),
        await all(`select name from note_tags where id = $1`, G1),
      ];

      const res = await push(ann, {
        moods: [
          { id: M1, name: 'Hijacked', emoji: '💀' },
          { id: JOY, name: 'Hijacked', emoji: '💀' },
        ],
        tags: [{ id: G1, name: 'Hijacked' }],
        entries: [
          { id: N1, title: 'Hijacked', body: 'x', mood_ids: [], tag_ids: [] },
          { id: N2, tag_ids: [G1], mood_ids: [M1] },
        ],
        deleted: [
          { table: 'note_tags', id: G1 },
          { table: 'note_moods', id: M1 },
          { table: 'diary_entries', id: N1 },
          { table: 'note_moods', id: JOY },
        ],
      });

      expect(reasons(res)).toEqual(
        [
          `note_moods:${M1}:id_taken`,
          `note_moods:${JOY}:id_taken`,
          `note_tags:${G1}:id_taken`,
          `diary_entries:${N1}:id_taken`,
          `diary_entries:${N2}:unknown_label`,
          // the deletions of the same four rows
          `note_tags:${G1}:id_taken`,
          `note_moods:${M1}:id_taken`,
          `diary_entries:${N1}:id_taken`,
          `note_moods:${JOY}:id_taken`,
        ].sort(),
      );
      expect([
        await notesOf(bob.id),
        await tagLinks(bob.id),
        await moodLinks(bob.id),
        await all(`select name, emoji from note_moods where id = $1`, M1),
        await all(`select name from note_tags where id = $1`, G1),
      ]).toEqual(bobsBefore);
      // Ann has only the note she made, without the links she could not have.
      expect((await notesOf(ann.id)).map((n) => n.id)).toEqual([N2]);
      expect(await tagLinks(ann.id)).toEqual([]);
      expect(await moodLinks(ann.id)).toEqual([]);
      expect(
        await all(`select name from note_moods where id = $1`, JOY),
      ).toEqual([{ name: 'Радость' }]);
    });
  });

  describe('a failure inside the transaction', () => {
    it('writes nothing at all of the diary or the rest, and answers 500', async () => {
      throwInDeletions = true;
      const res = await api()
        .post('/sync/push')
        .set('Authorization', `Bearer ${ann.token}`)
        .send({
          moods: [{ id: M1, name: 'm', emoji: 'e' }],
          tags: [{ id: G1, name: 't' }],
          entries: [{ id: N1, tag_ids: [G1] }],
          tasks: [{ id: T1 }],
          deleted: [{ table: 'diary_entries', id: N2 }],
        })
        .expect(500);
      expect(res.body).toEqual({
        code: 'internal_error',
        message: 'Internal server error',
      });
      expect(await notesOf(ann.id)).toEqual([]);
      expect(await tagLinks(ann.id)).toEqual([]);
      expect(await all(`select id from note_tags`)).toEqual([]);
      expect(
        await all(`select id from note_moods where user_id is not null`),
      ).toEqual([]);
      expect(await all(`select id from tasks`)).toEqual([]);
    });
  });

  describe('an empty push', () => {
    it('does not open a transaction, also when the only diary rows are bad ones', async () => {
      const spy = jest.spyOn(ds, 'transaction');
      try {
        await push(ann, {});
        await push(ann, { moods: [], tags: [], entries: [] });
        await push(ann, { moods: [{ bad: 1 }], tags: [null], entries: ['x'] });
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  });

  it('takes the full 500 notes with two links each, and 500 moods and tags, in one request', async () => {
    const moods = Array.from({ length: 500 }, (_, i) => ({
      id: id(1000 + i),
      name: `m${i}`,
      emoji: '🙂',
    }));
    const tags = Array.from({ length: 500 }, (_, i) => ({
      id: id(2000 + i),
      name: `t${i}`,
    }));
    const entries = Array.from({ length: 500 }, (_, i) => ({
      id: id(3000 + i),
      title: `n${i}`,
      body: 'x'.repeat(500),
      mood_ids: [id(1000 + i), JOY],
      tag_ids: [id(2000 + i)],
    }));
    const started = Date.now();
    const res = await push(ann, { moods, tags, entries });
    expect(res.rejected).toEqual([]);
    expect(await notesOf(ann.id)).toHaveLength(500);
    expect(await tagLinks(ann.id)).toHaveLength(500);
    expect(await moodLinks(ann.id)).toHaveLength(1000);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it.each(['moods', 'tags', 'entries'])(
    'refuses 501 rows in %s with batch_too_large',
    async (list) => {
      const res = await api()
        .post('/sync/push')
        .set('Authorization', `Bearer ${ann.token}`)
        .send({ [list]: Array.from({ length: 501 }, () => ({})) })
        .expect(400);
      expect((res.body as { code: string }).code).toBe('batch_too_large');
    },
  );
});
