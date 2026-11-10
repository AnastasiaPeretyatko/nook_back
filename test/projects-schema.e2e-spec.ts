import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createTestApp, truncateAll } from './support/db';

const TASK = '11111111-1111-4111-8111-111111111111';

describe('Project tables', () => {
  let app: INestApplication;
  let ds: DataSource;

  beforeAll(async () => {
    app = await createTestApp();
    ds = app.get(DataSource);
  });

  beforeEach(() => truncateAll(ds));

  afterAll(() => app.close());

  async function addUser(email: string) {
    const [row] = await ds.query(
      `insert into users (email, password_hash) values ($1, 'hash') returning id`,
      [email],
    );
    return row.id as string;
  }

  const addProject = (userId: string, fields: Record<string, unknown> = {}) => {
    const columns = ['user_id', ...Object.keys(fields)];
    const params = [userId, ...Object.values(fields)];
    return ds.query(
      `insert into projects (${columns.join(', ')})
       values (${params.map((_, i) => `$${i + 1}`).join(', ')})
       returning *`,
      params,
    );
  };

  const addTask = (userId: string, fields: Record<string, unknown> = {}) => {
    const columns = ['id', 'user_id', ...Object.keys(fields)];
    const params = [TASK, userId, ...Object.values(fields)];
    return ds.query(
      `insert into tasks (${columns.join(', ')})
       values (${params.map((_, i) => `$${i + 1}`).join(', ')})`,
      params,
    );
  };

  it('generates a project id and server timestamps with nullable optional fields', async () => {
    const user = await addUser('ann@example.com');
    const [project] = await addProject(user, { name: 'Home' });

    expect(project).toMatchObject({
      user_id: user,
      name: 'Home',
      description: null,
      color: null,
      archived_at: null,
    });
    expect(project.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(project.created_at).toBeInstanceOf(Date);
    expect(project.updated_at).toBeInstanceOf(Date);
  });

  it('requires a non-empty project name up to the existing group-name limit', async () => {
    const user = await addUser('ann@example.com');
    await expect(addProject(user)).rejects.toThrow(
      /null value in column "name"/,
    );
    await expect(addProject(user, { name: '' })).rejects.toThrow(
      /projects_name_check/,
    );
    await expect(addProject(user, { name: 'x'.repeat(101) })).rejects.toThrow(
      /projects_name_check/,
    );
  });

  it('keeps existing unassigned tasks valid and lets a project have many tasks', async () => {
    const user = await addUser('ann@example.com');
    const [project] = await addProject(user, { name: 'Home' });
    await addTask(user);

    const [unassigned] = await ds.query(
      `select project_id from tasks where id = $1`,
      [TASK],
    );
    expect(unassigned.project_id).toBeNull();

    await ds.query(`update tasks set project_id = $1 where id = $2`, [
      project.id,
      TASK,
    ]);
    const [{ count }] = await ds.query(
      `select count(*)::int as count from tasks where project_id = $1`,
      [project.id],
    );
    expect(count).toBe(1);
  });

  it('accepts only the task owner’s personal project', async () => {
    const ann = await addUser('ann@example.com');
    const bob = await addUser('bob@example.com');
    const [project] = await addProject(ann, { name: 'Home' });

    await expect(addTask(bob, { project_id: project.id })).rejects.toThrow(
      /project does not belong to task owner/,
    );
  });

  it('does not allow a shared task in a personal project', async () => {
    const owner = await addUser('ann@example.com');
    const [project] = await addProject(owner, { name: 'Home' });
    const [{ id: group }] = await ds.query(
      `insert into groups (name, owner_id) values ('Family', $1) returning id`,
      [owner],
    );
    await ds.query(
      `insert into group_members (group_id, user_id, role) values ($1, $2, 'owner')`,
      [group, owner],
    );

    await expect(
      addTask(owner, { group_id: group, project_id: project.id }),
    ).rejects.toThrow(/tasks_project_needs_personal_task/);
  });

  it('unassigns tasks when their project is removed', async () => {
    const user = await addUser('ann@example.com');
    const [project] = await addProject(user, { name: 'Home' });
    await addTask(user, { project_id: project.id });

    await ds.query(`delete from projects where id = $1`, [project.id]);
    const [task] = await ds.query(
      `select project_id from tasks where id = $1`,
      [TASK],
    );
    expect(task.project_id).toBeNull();
  });
});
