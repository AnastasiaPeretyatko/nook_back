import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { SectionRow } from './push-rows';
import { Rejection } from './rejection';

const FIND_SECTIONS = `
  select id, user_id, project_id, deleted_at is not null as deleted
  from sections where id = any($1::uuid[])
`;

const FIND_PROJECTS = `
  select id from projects where id = any($1::uuid[]) and user_id = $2
`;

// `project_id` never changes on conflict. Moving a section would turn every task assigned to it
// into a scope mismatch, so a section's scope is set when the device creates it and then fixed.
const UPSERT = `
  insert into sections (
    id, user_id, project_id, name, position, created_at, client_updated_at
  )
  select
    r.id, $2::uuid, r."projectId", r.name, r.position, r."createdAt", r."clientUpdatedAt"
  from jsonb_to_recordset($1::jsonb) as r(
    id uuid, "projectId" uuid, name text, position integer,
    "createdAt" timestamptz, "clientUpdatedAt" timestamptz
  )
  where r."projectId" is null or exists (
    select 1 from projects p where p.id = r."projectId" and p.user_id = $2::uuid
  )
  on conflict (id) do update set
    name = excluded.name,
    position = excluded.position,
    client_updated_at = excluded.client_updated_at
  where sections.user_id = excluded.user_id and sections.deleted_at is null
`;

interface KnownSection {
  id: string;
  userId: string;
  projectId: string | null;
  deleted: boolean;
}

@Injectable()
export class SectionWriter {
  // Runs before TaskWriter in the push transaction, so one device batch can create a section and
  // assign a task to it. A deleted section is never resurrected: its tombstone wins like tags.
  async write(
    manager: EntityManager,
    userId: string,
    rows: SectionRow[],
  ): Promise<Rejection[]> {
    if (rows.length === 0) return [];
    const found: {
      id: string;
      user_id: string;
      project_id: string | null;
      deleted: boolean;
    }[] = await manager.query(FIND_SECTIONS, [
      [...new Set(rows.map((row) => row.id))],
    ]);
    const known = new Map<string, KnownSection>(
      found.map((row) => [
        row.id,
        {
          id: row.id,
          userId: row.user_id,
          projectId: row.project_id,
          deleted: row.deleted,
        },
      ]),
    );
    const rejected: Rejection[] = [];
    const write: SectionRow[] = [];
    for (const row of new Map(rows.map((row) => [row.id, row])).values()) {
      const old = known.get(row.id);
      if (old && old.userId !== userId) {
        rejected.push({ table: 'sections', id: row.id, reason: 'id_taken' });
      } else if (old?.deleted) {
        // Deletion always wins; the returning device will learn the tombstone on pull.
      } else if (
        old &&
        row.projectIdSpecified &&
        row.projectId !== old.projectId
      ) {
        rejected.push({ table: 'sections', id: row.id, reason: 'invalid_row' });
      } else {
        write.push({ ...row, projectId: old?.projectId ?? row.projectId });
      }
    }

    const projectIds = new Set(
      write
        .map((row) => row.projectId)
        .filter((projectId): projectId is string => projectId !== null),
    );
    const projects: { id: string }[] =
      projectIds.size > 0
        ? await manager.query(FIND_PROJECTS, [[...projectIds], userId])
        : [];
    const accessible = new Set(projects.map((project) => project.id));
    const accepted = write.filter((row) => {
      if (row.projectId === null || accessible.has(row.projectId)) return true;
      rejected.push({
        table: 'sections',
        id: row.id,
        reason: 'unknown_project',
      });
      return false;
    });
    if (accepted.length > 0) {
      await manager.query(UPSERT, [JSON.stringify(accepted), userId]);
    }
    return rejected;
  }
}
