import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createTestApp, truncateAll } from './support/db';

type Row = Record<string, unknown>;
interface Session {
  token: string;
  id: string;
}
interface PullResponse {
  next: string | null;
  cycle_confirmed_starts?: Row[];
}

describe('confirmed menstrual cycle starts in sync', () => {
  let app: INestApplication;
  let ds: DataSource;
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

  const push = async (who: Session, body: object) =>
    (
      await api()
        .post('/sync/push')
        .set('Authorization', `Bearer ${who.token}`)
        .send(body)
        .expect(200)
    ).body as {
      rejected: { table: string; id: string | null; reason: string }[];
    };

  const pull = async (who: Session, since?: string) =>
    (
      await api()
        .get(`/sync/pull?include=cycle${since ? `&since=${since}` : ''}`)
        .set('Authorization', `Bearer ${who.token}`)
        .expect(200)
    ).body as PullResponse;

  beforeAll(async () => {
    app = await createTestApp();
    ds = app.get(DataSource);
  });

  beforeEach(async () => {
    await truncateAll(ds);
    ann = await signUp('ann@example.com');
    bob = await signUp('bob@example.com');
  });

  afterAll(() => app.close());

  it('creates multiple starts and another device pulls their historical dates unchanged', async () => {
    await push(ann, {
      cycle_confirmed_starts: [
        { date: '2025-11-03' },
        { date: '2025-12-01' },
        { date: '2026-01-04' },
      ],
    });

    const onOtherDevice = await pull(ann);
    expect(onOtherDevice.cycle_confirmed_starts).toEqual([
      expect.objectContaining({ date: '2025-11-03', deleted_at: null }),
      expect.objectContaining({ date: '2025-12-01', deleted_at: null }),
      expect.objectContaining({ date: '2026-01-04', deleted_at: null }),
    ]);
    expect(
      onOtherDevice.cycle_confirmed_starts!.every(
        (r) => typeof r.date === 'string',
      ),
    ).toBe(true);
  });

  it('syncs a retroactive start incrementally', async () => {
    await push(ann, { cycle_confirmed_starts: [{ date: '2026-02-01' }] });
    const first = await pull(ann);
    await push(ann, { cycle_confirmed_starts: [{ date: '2025-08-19' }] });

    expect((await pull(ann, first.next!)).cycle_confirmed_starts).toEqual([
      expect.objectContaining({ date: '2025-08-19', deleted_at: null }),
    ]);
  });

  it('propagates deletion tombstones, does not duplicate repeated pushes, and permits an explicit restore', async () => {
    const date = '2026-01-15';
    await push(ann, { cycle_confirmed_starts: [{ date }] });
    await push(ann, { cycle_confirmed_starts: [{ date }] });
    expect(
      await ds.query(
        `select date::text as date, deleted_at from cycle_confirmed_starts where user_id = $1`,
        [ann.id],
      ),
    ).toEqual([{ date, deleted_at: null }]);

    const beforeDeletion = await pull(ann);
    expect(
      (
        await push(ann, {
          deleted: [{ table: 'cycle_confirmed_starts', id: date }],
        })
      ).rejected,
    ).toEqual([]);
    const deleted = await pull(ann, beforeDeletion.next!);
    expect(deleted.cycle_confirmed_starts).toEqual([
      expect.objectContaining({
        date,
        deleted_at: expect.stringMatching(/Z$/),
      }),
    ]);
    expect((await pull(ann, deleted.next!)).cycle_confirmed_starts).toEqual([]);

    await push(ann, {
      deleted: [{ table: 'cycle_confirmed_starts', id: date }],
    });
    expect((await pull(ann, deleted.next!)).cycle_confirmed_starts).toEqual([]);

    await push(ann, { cycle_confirmed_starts: [{ date }] });
    expect((await pull(ann, deleted.next!)).cycle_confirmed_starts).toEqual([
      expect.objectContaining({ date, deleted_at: null }),
    ]);
  });

  it('scopes starts and tombstones to the authenticated user', async () => {
    const date = '2026-03-08';
    await push(ann, { cycle_confirmed_starts: [{ date }] });
    expect(
      (
        await push(bob, {
          deleted: [{ table: 'cycle_confirmed_starts', id: date }],
        })
      ).rejected,
    ).toEqual([
      { table: 'cycle_confirmed_starts', id: date, reason: 'id_taken' },
    ]);
    expect((await pull(bob)).cycle_confirmed_starts).toEqual([]);
    expect((await pull(ann)).cycle_confirmed_starts).toEqual([
      expect.objectContaining({ date, deleted_at: null }),
    ]);
  });

  it('keeps starts when an older client omits them, and leaves cycle_days unchanged', async () => {
    await push(ann, { cycle_confirmed_starts: [{ date: '2026-01-15' }] });
    await push(ann, { cycle_days: [{ date: '2026-01-15', flow: 3 }] });

    expect((await pull(ann)).cycle_confirmed_starts).toEqual([
      expect.objectContaining({ date: '2026-01-15', deleted_at: null }),
    ]);
    expect(
      await ds.query(
        `select date::text as date, flow from cycle_days where user_id = $1`,
        [ann.id],
      ),
    ).toEqual([{ date: '2026-01-15', flow: 3 }]);
  });
});
