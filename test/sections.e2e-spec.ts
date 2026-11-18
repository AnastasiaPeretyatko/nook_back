import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createTestApp, truncateAll } from './support/db';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [T1, T2, T3, T4, S1, S2, S3, S4] = [1, 2, 3, 4, 11, 12, 13, 14].map(id);
const TIME = '2026-01-15T10:00:00Z';

interface Session {
  token: string;
  id: string;
}

interface Rejection {
  table: string;
  id: string | null;
  reason: string;
}

describe('Sections through sync', () => {
  let app: INestApplication;
  let ds: DataSource;
  let ann: Session;
  let bob: Session;
  const api = () => request(app.getHttpServer());
  const as = (who: Session) => ({ Authorization: `Bearer ${who.token}` });

  async function signUp(email: string): Promise<Session> {
    const res = await api()
      .post('/auth/register')
      .send({ email, password: 'correct horse' })
      .expect(201);
    const body = res.body as { accessToken: string; user: { id: string } };
    return { token: body.accessToken, id: body.user.id };
  }

  const createProject = async (who: Session, name: string) =>
    (await api().post('/projects').set(as(who)).send({ name }).expect(201))
      .body as { id: string };
  const push = async (who: Session, body: object) =>
    (await api().post('/sync/push').set(as(who)).send(body).expect(200))
      .body as { rejected: Rejection[] };
  const pull = async (who: Session) =>
    (await api().get('/sync/pull').set(as(who)).expect(200)).body as {
      sections: Record<string, unknown>[];
      tasks: Record<string, unknown>[];
    };
  const section = (
    sectionId: string,
    name: string,
    fields: Record<string, unknown> = {},
  ) => ({
    id: sectionId,
    name,
    position: 0,
    created_at: TIME,
    client_updated_at: TIME,
    ...fields,
  });

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

  it('has no Sections REST resource; devices create, list, rename, and reorder sections through sync', async () => {
    await api()
      .post('/sections')
      .set(as(ann))
      .send({ name: 'Inbox' })
      .expect(404);
    const project = await createProject(ann, 'Home');

    expect(
      (
        await push(ann, {
          sections: [
            section(S1, 'Inbox', { position: 1 }),
            section(S2, 'Kitchen', { project_id: project.id }),
          ],
        })
      ).rejected,
    ).toEqual([]);
    const firstPull = await pull(ann);
    expect(firstPull.sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: S1,
          name: 'Inbox',
          position: 1,
          project_id: null,
          deleted_at: null,
        }),
        expect.objectContaining({
          id: S2,
          name: 'Kitchen',
          position: 0,
          project_id: project.id,
          deleted_at: null,
        }),
      ]),
    );

    expect(
      (
        await push(ann, {
          sections: [
            section(S1, 'Today', {
              position: -2,
              client_updated_at: '2026-01-15T10:01:00Z',
            }),
          ],
        })
      ).rejected,
    ).toEqual([]);
    expect(
      (await pull(ann)).sections.find((row) => row.id === S1),
    ).toMatchObject({ id: S1, name: 'Today', position: -2, project_id: null });
  });

  it('validates section rows and prevents cross-user or cross-project scope writes', async () => {
    const annProject = await createProject(ann, 'Ann');
    const bobProject = await createProject(bob, 'Bob');
    await push(ann, { sections: [section(S1, 'Mine')] });

    const result = await push(ann, {
      sections: [
        section(S2, '', { project_id: annProject.id }),
        section(S3, 'Bad project', { project_id: bobProject.id }),
      ],
    });
    expect(result.rejected).toEqual(
      expect.arrayContaining([
        { table: 'sections', id: S2, reason: 'invalid_row' },
        { table: 'sections', id: S3, reason: 'unknown_project' },
      ]),
    );
    expect(
      (await push(bob, { sections: [section(S1, 'Taken')] })).rejected,
    ).toEqual([{ table: 'sections', id: S1, reason: 'id_taken' }]);
  });

  it('assigns only compatible synced sections and preserves task state on association-only updates', async () => {
    const first = await createProject(ann, 'First');
    const second = await createProject(ann, 'Second');
    await push(ann, {
      sections: [
        section(S1, 'Inbox'),
        section(S2, 'Today', { project_id: first.id }),
        section(S3, 'Later', { project_id: second.id }),
      ],
    });
    await push(bob, { sections: [section(S4, 'Bob')] });

    expect(
      (
        await push(ann, {
          tasks: [
            { id: T1, section_id: S1 },
            {
              id: T2,
              project_id: first.id,
              section_id: S2,
              scheduled_time_minutes: 600,
            },
          ],
        })
      ).rejected,
    ).toEqual([]);
    await push(ann, {
      logs: [{ task_id: T2, date: '2026-01-15', completed: true }],
    });

    const invalid = await push(ann, {
      tasks: [
        { id: T3, project_id: first.id, section_id: S1 },
        { id: T4, section_id: S2 },
        { id: T1, section_id: S4 },
        { id: T2, project_id: second.id },
      ],
    });
    expect(invalid.rejected).toEqual(
      expect.arrayContaining([
        { table: 'tasks', id: T1, reason: 'unknown_section' },
        { table: 'tasks', id: T2, reason: 'invalid_section' },
        { table: 'tasks', id: T3, reason: 'invalid_section' },
        { table: 'tasks', id: T4, reason: 'invalid_section' },
      ]),
    );

    await push(ann, { tasks: [{ id: T2, section_id: S2 }] });
    expect(
      await ds.query(
        `select section_id, scheduled_time_minutes from tasks where id = $1`,
        [T2],
      ),
    ).toEqual([{ section_id: S2, scheduled_time_minutes: 600 }]);
    expect(
      await ds.query(
        `select completed from task_logs where task_id = $1 and date = '2026-01-15'`,
        [T2],
      ),
    ).toEqual([{ completed: true }]);

    await push(ann, {
      tasks: [{ id: T2, project_id: second.id, section_id: S3 }],
    });
    await push(ann, { tasks: [{ id: T2, project_id: null }] });
    expect(
      await ds.query(`select project_id, section_id from tasks where id = $1`, [
        T2,
      ]),
    ).toEqual([{ project_id: null, section_id: null }]);
  });

  it('tombstones a deleted section, clears its tasks, and returns the tombstone to other devices', async () => {
    await push(ann, { sections: [section(S1, 'Inbox')] });
    await push(ann, { tasks: [{ id: T1, section_id: S1 }] });

    expect(
      (await push(ann, { deleted: [{ table: 'sections', id: S1 }] })).rejected,
    ).toEqual([]);
    expect(
      await ds.query(`select section_id from tasks where id = $1`, [T1]),
    ).toEqual([{ section_id: null }]);
    expect(
      (await pull(ann)).sections.find((row) => row.id === S1),
    ).toMatchObject({
      id: S1,
      name: '',
      project_id: null,
      deleted_at: expect.stringMatching(/^\d{4}-.*Z$/),
    });
  });

  it('erases sections with the account', async () => {
    await push(ann, { sections: [section(S1, 'Inbox')] });
    await api()
      .delete('/me')
      .set(as(ann))
      .send({ password: 'correct horse' })
      .expect(204);
    expect(
      await ds.query(`select id from sections where user_id = $1`, [ann.id]),
    ).toEqual([]);
  });
});
