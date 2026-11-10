import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createTestApp, truncateAll } from './support/db';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [T1, T2, T3] = [id(1), id(2), id(3)];
const NOBODY = '00000000-0000-4000-8000-0000000000ff';

interface Session {
  token: string;
  id: string;
}

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  archived_at: string | null;
  total_tasks: number;
  completed_tasks: number;
  progress: number;
}

interface PushResponse {
  rejected: { table: string; id: string | null; reason: string }[];
}

describe('Projects', () => {
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

  const as = (who: Session) => ({ Authorization: `Bearer ${who.token}` });
  const create = (who: Session, body: object = { name: 'Home' }) =>
    api().post('/projects').set(as(who)).send(body);
  const list = (who: Session, query = '') =>
    api().get(`/projects${query}`).set(as(who));
  const details = (who: Session, projectId: string) =>
    api().get(`/projects/${projectId}`).set(as(who));
  const update = (who: Session, projectId: string, body: object) =>
    api().patch(`/projects/${projectId}`).set(as(who)).send(body);
  const archive = (who: Session, projectId: string) =>
    api().patch(`/projects/${projectId}/archive`).set(as(who));
  const restore = (who: Session, projectId: string) =>
    api().patch(`/projects/${projectId}/restore`).set(as(who));
  const projectTasks = (who: Session, projectId: string, query = '') =>
    api().get(`/projects/${projectId}/tasks${query}`).set(as(who));
  const push = async (who: Session, body: object): Promise<PushResponse> => {
    const res = await api()
      .post('/sync/push')
      .set(as(who))
      .send(body)
      .expect(200);
    return res.body as PushResponse;
  };
  const makeProject = async (who: Session, name = 'Home') =>
    (await create(who, { name }).expect(201)).body as ProjectRow;

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

  describe('projects CRUD', () => {
    it('accepts a client identity and safely retries creation', async () => {
      const projectId = id(100);
      const body = { id: projectId, name: 'Offline project' };
      const first = (await create(ann, body).expect(201)).body as ProjectRow;
      const retry = (await create(ann, body).expect(201)).body as ProjectRow;
      expect(first.id).toBe(projectId);
      expect(retry.id).toBe(projectId);
      expect((await list(ann).expect(200)).body).toHaveLength(1);
      await create(bob, body).expect(409);
    });

    it('creates a project for the signed-in user and never trusts a user id from the body', async () => {
      const project = (
        await create(ann, {
          name: '  Home  ',
          description: 'Household tasks',
          color: 'violet',
          user_id: bob.id,
        }).expect(201)
      ).body as ProjectRow;

      expect(project).toMatchObject({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        name: 'Home',
        description: 'Household tasks',
        color: 'violet',
        archived_at: null,
        total_tasks: 0,
        completed_tasks: 0,
        progress: 0,
      });
      expect(
        await ds.query(`select user_id from projects where id = $1`, [
          project.id,
        ]),
      ).toEqual([{ user_id: ann.id }]);
    });

    it('lists only the caller’s active projects, and exposes archived ones through a filter', async () => {
      const home = await makeProject(ann, 'Home');
      const work = await makeProject(ann, 'Work');
      await makeProject(bob, 'Bob’s project');
      await archive(ann, work.id).expect(200);

      const active = (await list(ann).expect(200)).body as ProjectRow[];
      expect(active.map((p) => p.id)).toEqual([home.id]);

      const archived = (await list(ann, '?archived=true').expect(200))
        .body as ProjectRow[];
      expect(archived.map((p) => p.id)).toEqual([work.id]);
    });

    it('gets, updates, archives, and restores a project without changing its tasks', async () => {
      const project = await makeProject(ann);
      await push(ann, { tasks: [{ id: T1, project_id: project.id }] });

      expect((await details(ann, project.id).expect(200)).body).toMatchObject({
        id: project.id,
        name: 'Home',
        total_tasks: 1,
      });
      expect(
        (
          await update(ann, project.id, {
            name: '  Office  ',
            description: null,
            color: 'green',
          }).expect(200)
        ).body,
      ).toMatchObject({
        id: project.id,
        name: 'Office',
        description: null,
        color: 'green',
      });

      await archive(ann, project.id).expect(200);
      expect(
        await ds.query(`select project_id from tasks where id = $1`, [T1]),
      ).toEqual([{ project_id: project.id }]);
      expect(
        (await details(ann, project.id).expect(200)).body.archived_at,
      ).toEqual(expect.any(String));

      await restore(ann, project.id).expect(200);
      expect(
        (await details(ann, project.id).expect(200)).body.archived_at,
      ).toBeNull();
    });

    it('hides another user’s project and validates project input', async () => {
      const project = await makeProject(ann);
      for (const call of [
        () => details(bob, project.id),
        () => update(bob, project.id, { name: 'Taken' }),
        () => archive(bob, project.id),
        () => restore(bob, project.id),
        () => projectTasks(bob, project.id),
        () => details(ann, 'not-a-uuid'),
      ]) {
        expect((await call().expect(404)).body.code).toBe('not_found');
      }
      for (const body of [
        {},
        { name: '' },
        { name: ' '.repeat(3) },
        { name: 'x'.repeat(101) },
        { name: 1 },
        { description: 'x'.repeat(50_001) },
        { color: 'x'.repeat(101) },
      ]) {
        expect((await create(ann, body).expect(400)).body.code).toBe(
          'validation_failed',
        );
      }
      expect(
        (await update(ann, project.id, { name: '' }).expect(400)).body.code,
      ).toBe('validation_failed');
    });
  });

  describe('task project integration through sync', () => {
    it('creates assigned and unassigned tasks, returns project_id on pull, and preserves regular task fields', async () => {
      const project = await makeProject(ann);
      expect(
        await push(ann, {
          tasks: [
            { id: T1, title: 'In project', project_id: project.id },
            {
              id: T2,
              title: 'Untimed habit',
              repeat_type: 'daily',
              scheduled_time_minutes: null,
            },
          ],
        }),
      ).toMatchObject({ rejected: [] });
      const rows = await ds.query(
        `select id, project_id, repeat_type, scheduled_time_minutes
         from tasks where id in ($1, $2) order by id`,
        [T1, T2],
      );
      expect(rows).toEqual([
        {
          id: T1,
          project_id: project.id,
          repeat_type: null,
          scheduled_time_minutes: null,
        },
        {
          id: T2,
          project_id: null,
          repeat_type: 'daily',
          scheduled_time_minutes: null,
        },
      ]);
      const pull = await api().get('/sync/pull').set(as(ann)).expect(200);
      expect(pull.body.tasks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: T1, project_id: project.id }),
          expect.objectContaining({ id: T2, project_id: null }),
        ]),
      );
    });

    it('rejects a missing, another user’s, or archived project without creating a task', async () => {
      const bobs = await makeProject(bob, 'Bob’s');
      const mine = await makeProject(ann, 'Mine');
      await archive(ann, mine.id).expect(200);

      const result = await push(ann, {
        tasks: [
          { id: T1, project_id: NOBODY },
          { id: T2, project_id: bobs.id },
          { id: T3, project_id: mine.id },
        ],
      });
      expect(result.rejected).toEqual(
        expect.arrayContaining([
          { table: 'tasks', id: T1, reason: 'unknown_project' },
          { table: 'tasks', id: T2, reason: 'unknown_project' },
          { table: 'tasks', id: T3, reason: 'archived_project' },
        ]),
      );
      expect(
        await ds.query(`select id from tasks where id in ($1, $2, $3)`, [
          T1,
          T2,
          T3,
        ]),
      ).toEqual([]);
    });

    it('updates, removes, or preserves a project association according to project_id', async () => {
      const first = await makeProject(ann, 'First');
      const second = await makeProject(ann, 'Second');
      await push(ann, { tasks: [{ id: T1, project_id: first.id }] });

      await push(ann, { tasks: [{ id: T1, title: 'No project field' }] });
      expect(
        await ds.query(`select project_id from tasks where id = $1`, [T1]),
      ).toEqual([{ project_id: first.id }]);

      await push(ann, { tasks: [{ id: T1, project_id: second.id }] });
      expect(
        await ds.query(`select project_id from tasks where id = $1`, [T1]),
      ).toEqual([{ project_id: second.id }]);

      await push(ann, { tasks: [{ id: T1, project_id: null }] });
      expect(
        await ds.query(`select project_id from tasks where id = $1`, [T1]),
      ).toEqual([{ project_id: null }]);
    });

    it('rejects attempts to put a shared task or another user’s task in a personal project', async () => {
      const project = await makeProject(ann);
      await push(bob, { tasks: [{ id: T1, title: 'Bob’s' }] });
      const [{ id: group }] = await ds.query(
        `insert into groups (name, owner_id) values ('Shared', $1) returning id`,
        [ann.id],
      );
      await ds.query(
        `insert into group_members (group_id, user_id, role) values ($1, $2, 'owner')`,
        [group, ann.id],
      );

      const result = await push(ann, {
        tasks: [
          { id: T1, project_id: project.id },
          { id: T2, group_id: group, project_id: project.id },
        ],
      });
      expect(result.rejected).toEqual(
        expect.arrayContaining([
          { table: 'tasks', id: T1, reason: 'id_taken' },
          { table: 'tasks', id: T2, reason: 'invalid_row' },
        ]),
      );
      expect(
        await ds.query(`select project_id from tasks where id = $1`, [T1]),
      ).toEqual([{ project_id: null }]);
    });
  });

  describe('project tasks and statistics', () => {
    it('returns project tasks with completed filtering and pagination, including untimed tasks and subtasks', async () => {
      const project = await makeProject(ann);
      await push(ann, {
        tasks: [
          {
            id: T2,
            parent_id: T1,
            title: 'Checklist item',
            project_id: project.id,
          },
          { id: T1, title: 'Top-level', project_id: project.id },
          {
            id: T3,
            title: 'Untimed',
            project_id: project.id,
            scheduled_time_minutes: null,
          },
        ],
        logs: [{ task_id: T1, date: '2026-01-15', completed: true }],
      });

      const completed = (
        await projectTasks(ann, project.id, '?completed=true').expect(200)
      ).body as { tasks: { id: string; completed: boolean }[] };
      expect(completed.tasks).toEqual([
        expect.objectContaining({ id: T1, completed: true }),
      ]);

      const first = (
        await projectTasks(ann, project.id, '?limit=1&offset=0').expect(200)
      ).body as {
        tasks: { id: string }[];
        has_more: boolean;
        next_offset: number | null;
      };
      expect(first.tasks).toHaveLength(1);
      expect(first.has_more).toBe(true);
      expect(first.next_offset).toBe(1);
      const second = (
        await projectTasks(ann, project.id, '?limit=1&offset=1').expect(200)
      ).body as { tasks: { id: string }[] };
      expect(second.tasks).toHaveLength(1);
      expect(second.tasks[0].id).not.toBe(first.tasks[0].id);
    });

    it('calculates statistics from live top-level project tasks only', async () => {
      const empty = await makeProject(ann, 'Empty');
      expect((await details(ann, empty.id).expect(200)).body).toMatchObject({
        total_tasks: 0,
        completed_tasks: 0,
        progress: 0,
      });

      const project = await makeProject(ann, 'Measured');
      await push(ann, {
        tasks: [
          { id: T2, parent_id: T1, project_id: project.id },
          { id: T1, project_id: project.id },
          { id: T3, project_id: project.id, repeat_type: 'daily' },
        ],
        logs: [
          { task_id: T1, date: '2026-01-15', completed: true },
          { task_id: T2, date: '2026-01-15', completed: true },
        ],
      });

      expect((await details(ann, project.id).expect(200)).body).toMatchObject({
        total_tasks: 2,
        completed_tasks: 1,
        progress: 50,
      });
    });
  });
});
