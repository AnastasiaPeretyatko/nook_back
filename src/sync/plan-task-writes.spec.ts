import { GroupAccess, KnownTask, planTaskWrites } from './plan-task-writes';
import { parseTask, TaskRow } from './push-rows';

const ME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [A, B, C, D] = [id(1), id(2), id(3), id(4)];
const G = id(50); // a group
const H = id(51); // another group

const task = (
  taskId: string,
  parentId: string | null = null,
  extra = {},
): TaskRow => {
  const result = parseTask({ id: taskId, parent_id: parentId, ...extra });
  if (!('row' in result)) throw new Error('bad test row');
  return result.row;
};
const stored = (
  taskId: string,
  parentId: string | null = null,
  extra: Partial<KnownTask> = {},
): KnownTask => ({
  id: taskId,
  userId: ME,
  parentId,
  groupId: null,
  deleted: false,
  ...extra,
});
// A task of a group, stored under the author `by` (the caller by default).
const inGroup = (
  taskId: string,
  group = G,
  extra: Partial<KnownTask> = {},
): KnownTask => stored(taskId, null, { groupId: group, ...extra });

const member: GroupAccess = { id: G, member: true, owner: false };
const owner: GroupAccess = { id: G, member: true, owner: true };

const plan = (
  rows: TaskRow[],
  known: KnownTask[] = [],
  groups: GroupAccess[] = [],
) => {
  const { write, rejected } = planTaskWrites(rows, ME, known, groups);
  return {
    written: write.map((r) => r.id).sort(),
    rejected: rejected.map((r) => `${r.id}:${r.reason}`).sort(),
  };
};
// The rows that would be written, as the writer gets them.
const rowsOf = (
  rows: TaskRow[],
  known: KnownTask[] = [],
  groups: GroupAccess[] = [],
) => planTaskWrites(rows, ME, known, groups).write;

describe('planTaskWrites', () => {
  it('writes plain tasks and refuses nothing', () => {
    expect(plan([task(A), task(B)])).toEqual({ written: [A, B], rejected: [] });
  });

  it('names the table in a refusal', () => {
    const { rejected } = planTaskWrites([task(A, A)], ME, []);
    expect(rejected).toEqual([
      { table: 'tasks', id: A, reason: 'parent_cycle' },
    ]);
  });

  describe('ownership', () => {
    it('writes over a task of the same user', () => {
      expect(plan([task(A)], [stored(A)]).written).toEqual([A]);
    });

    it("refuses another user's id as id_taken", () => {
      expect(plan([task(A)], [stored(A, null, { userId: OTHER })])).toEqual({
        written: [],
        rejected: [`${A}:id_taken`],
      });
    });

    it("refuses another user's id even if the row is deleted there", () => {
      expect(
        plan([task(A)], [stored(A, null, { userId: OTHER, deleted: true })])
          .rejected,
      ).toEqual([`${A}:id_taken`]);
    });
  });

  describe('deleted tasks', () => {
    it('skips a task that is already deleted, without refusing it', () => {
      expect(
        plan(
          [task(A, null, { title: 'back' })],
          [stored(A, null, { deleted: true })],
        ),
      ).toEqual({
        written: [],
        rejected: [],
      });
    });

    it('still takes a subtask whose parent is deleted', () => {
      expect(
        plan([task(B, A)], [stored(A, null, { deleted: true })]).written,
      ).toEqual([B]);
    });
  });

  describe('groups', () => {
    const inG = (taskId: string, extra = {}) =>
      task(taskId, null, { group_id: G, ...extra });

    describe('a new task', () => {
      it('is written when the caller is in the group', () => {
        expect(plan([inG(A)], [], [member])).toEqual({
          written: [A],
          rejected: [],
        });
      });

      it('is refused as unknown_group when the caller is not in the group', () => {
        const out = plan([inG(A), task(B)], [], [{ ...member, member: false }]);
        expect(out).toEqual({
          written: [B],
          rejected: [`${A}:unknown_group`],
        });
      });

      it('is refused the same way when the group is not there at all', () => {
        expect(plan([inG(A)], [], [])).toEqual({
          written: [],
          rejected: [`${A}:unknown_group`],
        });
      });

      it('is refused when the caller names a group they are not in, whoever else is', () => {
        expect(plan([inG(A)], [], [{ ...member, id: H }])).toEqual({
          written: [],
          rejected: [`${A}:unknown_group`],
        });
      });

      it('does not mind an assignee without a group', () => {
        expect(plan([task(A, null, { assignee_id: OTHER })]).written).toEqual([
          A,
        ]);
      });

      it('keeps the assignee for the database to check', () => {
        const out = rowsOf([inG(A, { assignee_id: OTHER })], [], [member]);
        expect(out[0].assigneeId).toBe(OTHER);
      });
    });

    describe('a task that exists in a group', () => {
      it('is changed by its author who is in the group', () => {
        const out = plan([inG(A, { title: 'x' })], [inGroup(A)], [member]);
        expect(out).toEqual({ written: [A], rejected: [] });
      });

      it('is changed by the owner of the group, though they are not the author', () => {
        const out = plan([inG(A)], [inGroup(A, G, { userId: OTHER })], [owner]);
        expect(out).toEqual({ written: [A], rejected: [] });
      });

      it('is not changed by another member: not_allowed', () => {
        const out = plan(
          [inG(A)],
          [inGroup(A, G, { userId: OTHER })],
          [member],
        );
        expect(out).toEqual({
          written: [],
          rejected: [`${A}:not_allowed`],
        });
      });

      it('is none of the business of someone outside the group, even its author: id_taken', () => {
        const out = plan(
          [inG(A)],
          [inGroup(A)],
          [{ ...member, member: false, owner: true }],
        );
        expect(out).toEqual({
          written: [],
          rejected: [`${A}:id_taken`],
        });
        expect(plan([inG(A)], [inGroup(A, G, { userId: OTHER })], [])).toEqual({
          written: [],
          rejected: [`${A}:id_taken`],
        });
      });

      it('keeps its stored group, whatever group the row names', () => {
        const out = rowsOf([inG(A, { group_id: H })], [inGroup(A)], [member]);
        expect(out[0].groupId).toBe(G);
      });

      it('keeps its stored group when the row names none', () => {
        const out = rowsOf(
          [task(A, null, { assignee_id: OTHER })],
          [inGroup(A)],
          [member],
        );
        expect(out[0]).toMatchObject({ groupId: G, assigneeId: OTHER });
      });

      it('is judged by the stored group, not by the one the row names', () => {
        // The row names a group the caller owns; the task is in another where they are a plain member.
        const out = plan(
          [inG(A, { group_id: H })],
          [inGroup(A, G, { userId: OTHER })],
          [member, { id: H, member: true, owner: true }],
        );
        expect(out).toEqual({
          written: [],
          rejected: [`${A}:not_allowed`],
        });
      });

      it('must stay a one-off task, whatever the row says of its group', () => {
        for (const extra of [
          { repeat_type: 'daily' },
          { tracking_mode: 'value' },
          { parent_id: B },
        ]) {
          const out = plan([task(A, null, extra)], [inGroup(A)], [member]);
          expect(out).toEqual({
            written: [],
            rejected: [`${A}:invalid_row`],
          });
        }
      });

      it('stays deleted: nothing is written for the author, for the owner', () => {
        for (const access of [member, owner]) {
          const known = inGroup(A, G, {
            deleted: true,
            userId: access.owner ? OTHER : ME,
          });
          expect(plan([inG(A)], [known], [access])).toEqual({
            written: [],
            rejected: [],
          });
        }
      });

      it('is still refused for a stranger when it is deleted', () => {
        const known = inGroup(A, G, { deleted: true });
        expect(plan([inG(A)], [known], [])).toEqual({
          written: [],
          rejected: [`${A}:id_taken`],
        });
      });
    });

    describe('a personal task', () => {
      it('stays personal when the row names a group', () => {
        const out = rowsOf(
          [inG(A, { assignee_id: OTHER })],
          [stored(A)],
          [member],
        );
        expect(out[0]).toMatchObject({ groupId: null, assigneeId: null });
      });

      it('is refused when it is another user’s, whatever the row names', () => {
        const out = plan(
          [inG(A)],
          [stored(A, null, { userId: OTHER })],
          [member],
        );
        expect(out).toEqual({
          written: [],
          rejected: [`${A}:id_taken`],
        });
      });
    });

    describe('subtasks', () => {
      it('cannot hang under a task of a group', () => {
        expect(plan([task(B, A)], [inGroup(A)], [member])).toEqual({
          written: [],
          rejected: [`${B}:unknown_parent`],
        });
      });

      it('cannot hang under a group task written in the same batch', () => {
        const out = plan([inG(A), task(B, A)], [], [member]);
        expect(out).toEqual({
          written: [A],
          rejected: [`${B}:unknown_parent`],
        });
      });
    });
  });

  describe('parents', () => {
    it('takes a subtask that comes before its parent in the batch', () => {
      expect(plan([task(B, A), task(A)])).toEqual({
        written: [A, B],
        rejected: [],
      });
    });

    it('takes a subtask of a task the user already has', () => {
      expect(plan([task(B, A)], [stored(A)])).toEqual({
        written: [B],
        rejected: [],
      });
    });

    it('refuses a subtask whose parent is nowhere', () => {
      expect(plan([task(B, A), task(C)])).toEqual({
        written: [C],
        rejected: [`${B}:unknown_parent`],
      });
    });

    it("refuses a subtask whose parent is another user's, as if it did not exist", () => {
      expect(plan([task(B, A)], [stored(A, null, { userId: OTHER })])).toEqual({
        written: [],
        rejected: [`${B}:unknown_parent`],
      });
    });

    it('refuses the whole chain below a missing parent', () => {
      expect(plan([task(D, C), task(C, B), task(B, A)])).toEqual({
        written: [],
        rejected: [
          `${B}:unknown_parent`,
          `${C}:unknown_parent`,
          `${D}:unknown_parent`,
        ],
      });
    });

    it('refuses children of a refused parent, but not its siblings', () => {
      const refused = task(A, null, { group_id: OTHER });
      expect(plan([refused, task(B, A), task(C)])).toEqual({
        written: [C],
        rejected: [`${A}:unknown_group`, `${B}:unknown_parent`],
      });
    });

    it('refuses a child of a task that is taken by another user', () => {
      expect(
        plan([task(A), task(B, A)], [stored(A, null, { userId: OTHER })]),
      ).toEqual({
        written: [],
        rejected: [`${A}:id_taken`, `${B}:unknown_parent`],
      });
    });

    it('lets a child fall back on the stored parent when the new one is refused', () => {
      // A is refused as a cycle in the batch, but the user already has an A to attach to.
      const rows = [task(A, B), task(B, A), task(C, A)];
      expect(plan(rows, [stored(A)])).toEqual({
        written: [C],
        rejected: [`${A}:parent_cycle`, `${B}:parent_cycle`],
      });
    });
  });

  describe('cycles', () => {
    it('refuses a task that is its own parent', () => {
      expect(plan([task(A, A)])).toEqual({
        written: [],
        rejected: [`${A}:parent_cycle`],
      });
    });

    it('refuses both tasks of a two-task loop', () => {
      expect(plan([task(A, B), task(B, A)])).toEqual({
        written: [],
        rejected: [`${A}:parent_cycle`, `${B}:parent_cycle`],
      });
    });

    it('refuses a three-task loop, and what hangs below it', () => {
      expect(plan([task(A, C), task(B, A), task(C, B), task(D, A)])).toEqual({
        written: [],
        rejected: [
          `${A}:parent_cycle`,
          `${B}:parent_cycle`,
          `${C}:parent_cycle`,
          `${D}:unknown_parent`,
        ],
      });
    });

    it('refuses a loop that closes through the database', () => {
      // Stored: B is under A. The batch moves A under B.
      expect(plan([task(A, B)], [stored(B, A), stored(A)])).toEqual({
        written: [],
        rejected: [`${A}:parent_cycle`],
      });
    });

    it('refuses a loop through a long stored chain', () => {
      // Stored: D under C under B under A. The batch moves A under D.
      const known = [stored(A), stored(B, A), stored(C, B), stored(D, C)];
      expect(plan([task(A, D)], known).rejected).toEqual([`${A}:parent_cycle`]);
    });

    it('allows moving a task to another parent', () => {
      expect(plan([task(C, A)], [stored(A), stored(B), stored(C, B)])).toEqual({
        written: [C],
        rejected: [],
      });
    });

    it('allows a task to move out from under its parent (parent_id null)', () => {
      expect(plan([task(B, null)], [stored(A), stored(B, A)]).written).toEqual([
        B,
      ]);
    });

    it('is not fooled by a loop that is already stored and does not include the row', () => {
      // Cannot happen in a healthy database; the walk must still end.
      const known = [stored(A, B), stored(B, A)];
      expect(plan([task(C, A)], known).written).toEqual([C]);
    });
  });

  describe('duplicates', () => {
    it('keeps the last of two rows with the same id', () => {
      const { write } = planTaskWrites(
        [task(A, null, { title: 'first' }), task(A, null, { title: 'second' })],
        ME,
        [],
      );
      expect(write.map((r) => r.title)).toEqual(['second']);
    });

    it('judges the last row, not the first', () => {
      // The first A is a loop, the last is fine.
      expect(plan([task(A, A), task(A, null)])).toEqual({
        written: [A],
        rejected: [],
      });
    });
  });
});
