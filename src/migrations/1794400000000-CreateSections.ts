import { MigrationInterface, QueryRunner } from 'typeorm';

// Sections are device-owned synced rows. A null project_id is the regular-task scope; a deleted
// row stays as a tombstone so another device can remove it from its local store.
export class CreateSections1794400000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      create table sections (
        id uuid not null,
        user_id uuid not null,
        project_id uuid,
        name text not null,
        position integer not null default 0,
        created_at timestamptz not null default now(),
        client_updated_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        deleted_at timestamptz,
        constraint sections_pkey primary key (id),
        constraint sections_user_id_fkey
          foreign key (user_id) references users (id) on delete cascade,
        constraint sections_project_id_fkey
          foreign key (project_id) references projects (id) on delete set null,
        constraint sections_name_check
          check (deleted_at is not null or length(name) between 1 and 100)
      )
    `);
    await queryRunner.query(
      `create index sections_user_updated_idx on sections (user_id, updated_at)`,
    );
    await queryRunner.query(
      `create index sections_user_project_position_idx
       on sections (user_id, project_id, position)`,
    );
    await queryRunner.query(`
      create trigger sections_updated_at
        before insert or update on sections
        for each row execute function set_updated_at()
    `);

    // A section may only name a project owned by its user. The database is the final barrier,
    // since sync writers intentionally use compact batched SQL rather than entity saves.
    await queryRunner.query(`
      create function guard_section_project()
      returns trigger
      language plpgsql
      as $$
      begin
        if new.project_id is null then
          return new;
        end if;
        if not exists (
          select 1 from projects p
          where p.id = new.project_id and p.user_id = new.user_id
        ) then
          raise exception 'project does not belong to section owner'
            using errcode = '23514', constraint = 'sections_project_owner_check';
        end if;
        return new;
      end;
      $$
    `);
    await queryRunner.query(`
      create trigger sections_guard_project
        before insert or update on sections
        for each row execute function guard_section_project()
    `);

    // A tombstone cannot retain task membership. The trigger also supplies the required name for
    // a deletion that arrives before the section's original creation row.
    await queryRunner.query(`
      create function blank_deleted_section()
      returns trigger
      language plpgsql
      as $$
      begin
        new.project_id := null;
        new.name := '';
        new.position := 0;
        if tg_op = 'UPDATE' then
          update tasks set section_id = null where section_id = new.id;
        end if;
        return new;
      end;
      $$
    `);
    await queryRunner.query(`
      create trigger sections_blank_when_deleted
        before insert or update on sections
        for each row
        when (new.deleted_at is not null)
        execute function blank_deleted_section()
    `);

    // Existing tasks keep their null value. Deleting a section must not delete a task.
    await queryRunner.query(`
      alter table tasks
        add column section_id uuid,
        add constraint tasks_section_id_fkey
          foreign key (section_id) references sections (id) on delete set null,
        add constraint tasks_section_needs_personal_task
          check (section_id is null or group_id is null)
    `);
    await queryRunner.query(
      `create index tasks_section_id_idx on tasks (section_id)`,
    );

    // The section's owner and project scope must exactly match the task's. A deleted section is
    // not assignable even though its tombstone still exists for synchronization.
    await queryRunner.query(`
      create function guard_task_section()
      returns trigger
      language plpgsql
      as $$
      declare section_project_id uuid;
      begin
        if new.section_id is null then
          return new;
        end if;
        select s.project_id into section_project_id
        from sections s where s.id = new.section_id and s.deleted_at is null;
        if not found then
          raise exception 'section is deleted or does not exist'
            using errcode = '23514', constraint = 'tasks_section_live_check';
        end if;
        if not exists (
          select 1 from sections s
          where s.id = new.section_id and s.user_id = new.user_id and s.deleted_at is null
        ) then
          raise exception 'section does not belong to task owner'
            using errcode = '23514', constraint = 'tasks_section_owner_check';
        end if;
        if section_project_id is distinct from new.project_id then
          raise exception 'section does not match task project'
            using errcode = '23514', constraint = 'tasks_section_scope_check';
        end if;
        return new;
      end;
      $$
    `);
    await queryRunner.query(`
      create trigger tasks_guard_section
        before insert or update on tasks
        for each row execute function guard_task_section()
    `);

    // Projects are physically removed only by existing lifecycle flows. Keep project sections as
    // tombstones before that removal, so devices learn they are gone instead of keeping orphans.
    await queryRunner.query(`
      create function clear_project_task_sections()
      returns trigger
      language plpgsql
      as $$
      begin
        update sections
        set project_id = null, deleted_at = clock_timestamp()
        where project_id = old.id and deleted_at is null;
        update tasks set section_id = null
        where project_id = old.id and section_id is not null;
        return old;
      end;
      $$
    `);
    await queryRunner.query(`
      create trigger projects_clear_task_sections
        before delete on projects
        for each row execute function clear_project_task_sections()
    `);

    // Deleted task tombstones have no project or section association, just as they have no task
    // content. This replaces the project-era version of the shared trigger function.
    await queryRunner.query(`
      create or replace function blank_deleted_task()
      returns trigger
      language plpgsql
      as $$
      begin
        new.parent_id := null;
        new.project_id := null;
        new.section_id := null;
        new.title := '';
        new.description := null;
        new.status := 'active';
        new.repeat_type := null;
        new.repeat_interval := null;
        new.repeat_days_mask := null;
        new.tracking_mode := 'checkbox';
        new.target_duration_minutes := null;
        new.target_value := null;
        new.icon_key := null;
        new.color_key := null;
        new.scheduled_time_minutes := null;
        new.end_time_minutes := null;
        new.start_date := null;
        new.assignee_id := null;
        if tg_op = 'UPDATE' then
          delete from task_logs where task_id = new.id;
        end if;
        return new;
      end;
      $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `drop trigger projects_clear_task_sections on projects`,
    );
    await queryRunner.query(`drop function clear_project_task_sections()`);
    await queryRunner.query(`drop trigger tasks_guard_section on tasks`);
    await queryRunner.query(`drop function guard_task_section()`);
    await queryRunner.query(`drop index tasks_section_id_idx`);
    await queryRunner.query(`
      alter table tasks
        drop constraint tasks_section_needs_personal_task,
        drop column section_id
    `);
    await queryRunner.query(
      `drop trigger sections_blank_when_deleted on sections`,
    );
    await queryRunner.query(`drop function blank_deleted_section()`);
    await queryRunner.query(`drop trigger sections_guard_project on sections`);
    await queryRunner.query(`drop function guard_section_project()`);
    await queryRunner.query(`drop trigger sections_updated_at on sections`);
    await queryRunner.query(`drop index sections_user_project_position_idx`);
    await queryRunner.query(`drop index sections_user_updated_idx`);
    await queryRunner.query(`drop table sections`);

    // Restore the project-era task tombstone shape before returning to the prior migration.
    await queryRunner.query(`
      create or replace function blank_deleted_task()
      returns trigger
      language plpgsql
      as $$
      begin
        new.parent_id := null;
        new.project_id := null;
        new.title := '';
        new.description := null;
        new.status := 'active';
        new.repeat_type := null;
        new.repeat_interval := null;
        new.repeat_days_mask := null;
        new.tracking_mode := 'checkbox';
        new.target_duration_minutes := null;
        new.target_value := null;
        new.icon_key := null;
        new.color_key := null;
        new.scheduled_time_minutes := null;
        new.end_time_minutes := null;
        new.start_date := null;
        new.assignee_id := null;
        if tg_op = 'UPDATE' then
          delete from task_logs where task_id = new.id;
        end if;
        return new;
      end;
      $$
    `);
  }
}
