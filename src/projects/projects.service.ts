import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  CreateProjectDto,
  defaultProjectTasksLimit,
  ProjectTasksQuery,
  UpdateProjectDto,
} from './dto/project.dto';

export const projectNotFound = () =>
  new NotFoundException({ code: 'not_found', message: 'Project not found' });

export interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
  total_tasks: number;
  completed_tasks: number;
  progress: number;
}

// Statistics deliberately join only live top-level tasks. Checklist items inherit their
// project's association for retrieval, but are not independent work in its progress.
const PROJECT_COLUMNS = `
  p.id, p.name, p.description, p.color, p.created_at, p.updated_at, p.archived_at,
  count(t.id)::int as total_tasks,
  count(t.id) filter (where exists (
    select 1 from task_logs l where l.task_id = t.id and l.completed = true
  ))::int as completed_tasks,
  case when count(t.id) = 0 then 0 else round(
    count(t.id) filter (where exists (
      select 1 from task_logs l where l.task_id = t.id and l.completed = true
    )) * 100.0 / count(t.id)
  )::int end as progress`;

const PROJECT_FROM = `
  from projects p
  left join tasks t on t.project_id = p.id
    and t.user_id = p.user_id
    and t.group_id is null
    and t.deleted_at is null
    and t.parent_id is null`;

const PROJECT_GROUP = `
  group by p.id, p.name, p.description, p.color, p.created_at, p.updated_at, p.archived_at`;

@Injectable()
export class ProjectsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async create(userId: string, dto: CreateProjectDto): Promise<ProjectRow> {
    if (dto.id) {
      await this.dataSource.query(
        `insert into projects (id, user_id, name, description, color)
         values ($1, $2, $3, $4, $5) on conflict (id) do nothing`,
        [dto.id, userId, dto.name, dto.description ?? null, dto.color ?? null],
      );
      const [owner] = await this.dataSource.query<{ user_id: string }[]>(
        `select user_id from projects where id = $1`,
        [dto.id],
      );
      if (!owner || owner.user_id !== userId) {
        throw new ConflictException({
          code: 'id_taken',
          message: 'Project id unavailable',
        });
      }
      return this.detail(userId, dto.id);
    }
    const [created] = await this.dataSource.query<{ id: string }[]>(
      `insert into projects (user_id, name, description, color)
       values ($1, $2, $3, $4) returning id`,
      [userId, dto.name, dto.description ?? null, dto.color ?? null],
    );
    return this.detail(userId, created.id);
  }

  async list(userId: string, archived: boolean): Promise<ProjectRow[]> {
    return this.dataSource.query<ProjectRow[]>(
      `select ${PROJECT_COLUMNS} ${PROJECT_FROM}
       where p.user_id = $1 and p.archived_at is ${archived ? 'not ' : ''}null
       ${PROJECT_GROUP}
       order by p.created_at, p.id`,
      [userId],
    );
  }

  async detail(userId: string, id: string): Promise<ProjectRow> {
    const [project] = await this.dataSource.query<ProjectRow[]>(
      `select ${PROJECT_COLUMNS} ${PROJECT_FROM}
       where p.id = $1 and p.user_id = $2
       ${PROJECT_GROUP}`,
      [id, userId],
    );
    if (!project) throw projectNotFound();
    return project;
  }

  async update(userId: string, id: string, dto: UpdateProjectDto) {
    const assignments: string[] = [];
    const values: unknown[] = [id, userId];
    const set = (column: string, value: unknown) => {
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    };
    if (dto.name !== undefined) set('name', dto.name);
    if (dto.description !== undefined) set('description', dto.description);
    if (dto.color !== undefined) set('color', dto.color);
    if (assignments.length > 0) {
      const changed = await this.dataSource.query<{ id: string }[]>(
        `update projects set ${assignments.join(', ')}
         where id = $1 and user_id = $2 returning id`,
        values,
      );
      if (changed.length === 0) throw projectNotFound();
    }
    return this.detail(userId, id);
  }

  async archive(userId: string, id: string) {
    const changed = await this.dataSource.query<{ id: string }[]>(
      `update projects set archived_at = coalesce(archived_at, now())
       where id = $1 and user_id = $2 returning id`,
      [id, userId],
    );
    if (changed.length === 0) throw projectNotFound();
    return this.detail(userId, id);
  }

  async restore(userId: string, id: string) {
    const changed = await this.dataSource.query<{ id: string }[]>(
      `update projects set archived_at = null
       where id = $1 and user_id = $2 returning id`,
      [id, userId],
    );
    if (changed.length === 0) throw projectNotFound();
    return this.detail(userId, id);
  }

  async tasks(userId: string, id: string, query: ProjectTasksQuery) {
    // Ensures a foreign project is indistinguishable from a missing one before touching tasks.
    await this.detail(userId, id);
    const limit = query.limit ?? defaultProjectTasksLimit;
    const offset = query.offset ?? 0;
    const rows = await this.dataSource.query<
      (Record<string, unknown> & { completed: boolean })[]
    >(
      `select t.*, exists(
         select 1 from task_logs l where l.task_id = t.id and l.completed = true
       ) as completed
       from tasks t
       where t.project_id = $1 and t.user_id = $2 and t.group_id is null
         and t.deleted_at is null
         and ($3::boolean is null or exists(
           select 1 from task_logs l where l.task_id = t.id and l.completed = $3
         ))
       order by t.created_at, t.id
       limit $4 offset $5`,
      [id, userId, query.completed ?? null, limit + 1, offset],
    );
    const hasMore = rows.length > limit;
    return {
      tasks: hasMore ? rows.slice(0, limit) : rows,
      has_more: hasMore,
      next_offset: hasMore ? offset + limit : null,
    };
  }
}
