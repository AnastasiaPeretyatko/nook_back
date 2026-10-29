import { PushMessage } from './push-sender';

// Who is told what, and nothing else: no database, no FCM. The rules are those of the app's toasts
// (`lib/utils/group_events.dart`) and of the Supabase triggers they were ported from
// (`reference/sql/013_push_triggers.sql`). If one changes, change all three.
//
//   * A task made by someone else is news when it is for me or for everyone. The author is never
//     told about their own task. A task made more than an hour ago is the backlog, not news.
//   * A task handed to me later (its assignee changed to me) is news too.
//   * A mark by someone else is news when the task is for everyone, or when I handed it out
//     myself. The one who ticked is never told.
//
// The text has no past-tense verb ("Выполнено: Миша"): a member's gender is unknown.

export const NEW_TASK_MAX_AGE_MS = 60 * 60 * 1000;
export const MAX_PER_RECIPIENT = 10;
export const FALLBACK_NAME = 'Участник';
// A task title may be a thousand characters; a notification shows a few lines.
const TITLE_SHOWN = 200;

// A task of a group, as far as notifications care.
export interface PushTask {
  id: string;
  groupId: string;
  title: string;
  // Who made it (`tasks.user_id`).
  authorId: string;
  // Who it is for; null = for everyone.
  assigneeId: string | null;
  parentId: string | null;
  status: string;
  deleted: boolean;
  // When the device made it (`created_at` of the row), in ms.
  createdAt: number;
}

// What happened, as the writers saw it (B7.6). The planner trusts these facts: "created" is a
// task that did not exist before, "assigned" one whose assignee changed to someone, "done" a mark
// that became completed (a re-sent one that already was is not an event).
export type PushEvent =
  | { kind: 'created'; task: PushTask }
  | { kind: 'assigned'; task: PushTask }
  | { kind: 'done'; task: PushTask; doneBy: string };

export interface PushWorld {
  now: number;
  // A group that is gone is simply not here.
  groups: Map<string, { name: string; members: string[] }>;
  // `profiles.display_name`; anyone missing, or blank, is called FALLBACK_NAME.
  names: Map<string, string | null>;
}

export interface Notification {
  userId: string;
  message: PushMessage;
}

const shown = (text: string, max: number) => {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
};

const nameOf = (world: PushWorld, userId: string) =>
  world.names.get(userId)?.trim() || FALLBACK_NAME;

// The people an event is for, and what to tell them. Nobody for anything that is not news.
function recipientsAndText(
  event: PushEvent,
  world: PushWorld,
): { to: string[]; title: string; body: string } | null {
  const { task } = event;
  const group = world.groups.get(task.groupId);
  if (!group) return null;
  const body = `${shown(task.title, TITLE_SHOWN)} · ${group.name}`;
  const members = [...new Set(group.members)];

  if (event.kind === 'done') {
    // Group tasks are one-off tasks, so there is no habit to rule out; a deleted one is not news.
    if (task.deleted) return null;
    return {
      title: `Выполнено: ${nameOf(world, event.doneBy)}`,
      body,
      // For everyone: all the others. Handed to someone: only whoever handed it out.
      to: members.filter(
        (m) =>
          m !== event.doneBy &&
          (task.assigneeId === null || m === task.authorId),
      ),
    };
  }

  // A subtask, a deleted task, a paused or archived one is not something to be told about.
  if (task.parentId !== null || task.deleted || task.status !== 'active') {
    return null;
  }
  if (event.kind === 'created') {
    // Not a number = no way to tell it is new, so it is not.
    if (!(task.createdAt >= world.now - NEW_TASK_MAX_AGE_MS)) return null;
  } else if (task.assigneeId === null) {
    // Handed back to everyone: nobody new to tell.
    return null;
  }
  return {
    title:
      task.assigneeId === null
        ? `Новая задача для всех от ${nameOf(world, task.authorId)}`
        : `Новая задача от ${nameOf(world, task.authorId)}`,
    body,
    to: members.filter(
      (m) =>
        m !== task.authorId &&
        (task.assigneeId === null || m === task.assigneeId),
    ),
  };
}

// The notifications for a batch of events, in the order of the events. No one gets more than
// MAX_PER_RECIPIENT of them: one push may carry hundreds of tasks, and a phone should not be
// buried; the rest are dropped, not delayed.
export function planPush(
  events: PushEvent[],
  world: PushWorld,
): Notification[] {
  const sent = new Map<string, number>();
  const out: Notification[] = [];
  for (const event of events) {
    const plan = recipientsAndText(event, world);
    if (!plan) continue;
    for (const userId of plan.to) {
      const count = sent.get(userId) ?? 0;
      if (count >= MAX_PER_RECIPIENT) continue;
      sent.set(userId, count + 1);
      out.push({
        userId,
        message: {
          title: plan.title,
          body: plan.body,
          data: { group_id: event.task.groupId, task_id: event.task.id },
        },
      });
    }
  }
  return out;
}
