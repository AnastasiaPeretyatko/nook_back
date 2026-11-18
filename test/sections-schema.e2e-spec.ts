import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createTestApp, truncateAll } from './support/db';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('Section tables', () => {
  let app: INestApplication;
  let ds: DataSource;

  beforeAll(async () => {
    app = await createTestApp();
    ds = app.get(DataSource);
  });

  beforeEach(() => truncateAll(ds));
  afterAll(() => app.close());

  const addUser = async (email: string) => {
    const [user] = await ds.query(
      `insert into users (email, password_hash) values ($1, 'hash') returning id`,
      [email],
    );
    return user.id as string;
  };
  const addProject = async (userId: string) => {
    const [project] = await ds.query(
      `insert into projects (user_id, name) values ($1, 'Home') returning id`,
      [userId],
    );
    return project.id as string;
  };
  const addSection = (
    sectionId: string,
    userId: string,
    fields: Record<string, unknown> = {},
  ) => {
    const columns = ['id', 'user_id', ...Object.keys(fields)];
    const values = [sectionId, userId, ...Object.values(fields)];
    return ds.query(
      `insert into sections (${columns.join(', ')})
       values (${values.map((_, i) => `$${i + 1}`).join(', ')}) returning *`,
      values,
    );
  };
  const addTask = (
    taskId: string,
    userId: string,
    fields: Record<string, unknown> = {},
  ) => {
    const columns = ['id', 'user_id', ...Object.keys(fields)];
    const values = [taskId, userId, ...Object.values(fields)];
    return ds.query(
      `insert into tasks (${columns.join(', ')})
       values (${values.map((_, i) => `$${i + 1}`).join(', ')})`,
      values,
    );
  };

  it('uses device-generated IDs and keeps the timestamps needed for sync', async () => {
    const user = await addUser('ann@example.com');
    const [section] = await addSection(id(1), user, { name: 'Inbox' });

    expect(section).toMatchObject({
      id: id(1),
      user_id: user,
      project_id: null,
      name: 'Inbox',
      position: 0,
      deleted_at: null,
    });
    expect(section.created_at).toBeInstanceOf(Date);
    expect(section.client_updated_at).toBeInstanceOf(Date);
    expect(section.updated_at).toBeInstanceOf(Date);
  });

  it('does not allow another user’s project, section, or project scope on a task', async () => {
    const ann = await addUser('ann@example.com');
    const bob = await addUser('bob@example.com');
    const project = await addProject(ann);
    const [regular] = await addSection(id(1), ann, { name: 'Inbox' });
    const [projectSection] = await addSection(id(2), ann, {
      project_id: project,
      name: 'Kitchen',
    });

    await expect(
      addSection(id(3), bob, { project_id: project, name: 'No access' }),
    ).rejects.toThrow(/project does not belong to section owner/);
    await addTask(id(4), ann, { section_id: regular.id });
    await addTask(id(5), ann, {
      project_id: project,
      section_id: projectSection.id,
    });
    await expect(
      addTask(id(6), bob, { section_id: regular.id }),
    ).rejects.toThrow(/section does not belong to task owner/);
    await expect(
      addTask(id(7), ann, { project_id: project, section_id: regular.id }),
    ).rejects.toThrow(/section does not match task project/);
  });

  it('turns a deleted section into a tombstone, unassigns its tasks, and tombstones project sections on project removal', async () => {
    const user = await addUser('ann@example.com');
    const project = await addProject(user);
    const [regular] = await addSection(id(1), user, { name: 'Inbox' });
    const [projectSection] = await addSection(id(2), user, {
      project_id: project,
      name: 'Kitchen',
    });
    await addTask(id(3), user, { section_id: regular.id });
    await addTask(id(4), user, {
      project_id: project,
      section_id: projectSection.id,
    });

    await ds.query(`update sections set deleted_at = now() where id = $1`, [
      regular.id,
    ]);
    expect(
      await ds.query(`select section_id from tasks where id = $1`, [id(3)]),
    ).toEqual([{ section_id: null }]);
    await ds.query(`delete from projects where id = $1`, [project]);
    expect(
      await ds.query(`select project_id, section_id from tasks where id = $1`, [
        id(4),
      ]),
    ).toEqual([{ project_id: null, section_id: null }]);
    expect(
      await ds.query(
        `select project_id, deleted_at from sections where id = $1`,
        [projectSection.id],
      ),
    ).toEqual([{ project_id: null, deleted_at: expect.any(Date) }]);
  });
});
