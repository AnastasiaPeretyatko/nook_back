import { KnownTask, planTaskWrites } from './plan-task-writes';
import { parseTask, TaskRow } from './push-rows';

const ME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [A, B, C, D] = [id(1), id(2), id(3), id(4)];

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
  deleted: false,
  ...extra,
});

const plan = (rows: TaskRow[], known: KnownTask[] = []) => {
  const { write, rejected } = planTaskWrites(rows, ME, known);
  return {
    written: write.map((r) => r.id).sort(),
    rejected: rejected.map((r) => `${r.id}:${r.reason}`).sort(),
  };
};

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
    it('refuses a group task, and keeps the others', () => {
      const group = task(A, null, { group_id: OTHER });
      expect(plan([group, task(B)])).toEqual({
        written: [B],
        rejected: [`${A}:groups_not_supported`],
      });
    });

    it('does not mind an assignee without a group', () => {
      expect(plan([task(A, null, { assignee_id: OTHER })]).written).toEqual([
        A,
      ]);
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
      const group = task(A, null, { group_id: OTHER });
      expect(plan([group, task(B, A), task(C)])).toEqual({
        written: [C],
        rejected: [`${A}:groups_not_supported`, `${B}:unknown_parent`],
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
