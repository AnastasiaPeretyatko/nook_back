import { MarkableTask, planLogWrites } from './plan-log-writes';
import { LogRow, parseLog } from './push-rows';

const ME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [T1, T2] = [id(1), id(2)];

const log = (taskId: string, date = '2026-01-15', extra = {}): LogRow => {
  const result = parseLog({ task_id: taskId, date, ...extra });
  if (!('row' in result)) throw new Error('bad test row');
  return result.row;
};
const task = (
  taskId: string,
  extra: Partial<MarkableTask> = {},
): MarkableTask => ({ id: taskId, userId: ME, deleted: false, ...extra });

describe('planLogWrites', () => {
  it('writes marks of the caller’s live tasks', () => {
    const { write, rejected } = planLogWrites(
      [log(T1), log(T1, '2026-01-16'), log(T2)],
      ME,
      [task(T1), task(T2)],
    );
    expect(write.map((r) => `${r.taskId}|${r.date}`)).toEqual([
      `${T1}|2026-01-15`,
      `${T1}|2026-01-16`,
      `${T2}|2026-01-15`,
    ]);
    expect(rejected).toEqual([]);
  });

  it('refuses a mark of a task that does not exist, naming the task', () => {
    expect(planLogWrites([log(T1)], ME, [])).toEqual({
      write: [],
      rejected: [{ table: 'task_logs', id: T1, reason: 'unknown_task' }],
    });
  });

  it('refuses a mark of someone else’s task the same way', () => {
    expect(planLogWrites([log(T1)], ME, [task(T1, { userId: OTHER })])).toEqual(
      {
        write: [],
        rejected: [{ table: 'task_logs', id: T1, reason: 'unknown_task' }],
      },
    );
  });

  it('refuses someone else’s task even when it is deleted there', () => {
    const { rejected } = planLogWrites([log(T1)], ME, [
      task(T1, { userId: OTHER, deleted: true }),
    ]);
    expect(rejected.map((r) => r.reason)).toEqual(['unknown_task']);
  });

  it('drops a mark of a deleted task without an error', () => {
    expect(planLogWrites([log(T1)], ME, [task(T1, { deleted: true })])).toEqual(
      { write: [], rejected: [] },
    );
  });

  it('keeps the good marks next to the bad ones', () => {
    const { write, rejected } = planLogWrites(
      [log(T1), log(T2), log(id(3))],
      ME,
      [task(T1), task(T2, { userId: OTHER })],
    );
    expect(write.map((r) => r.taskId)).toEqual([T1]);
    expect(rejected.map((r) => r.id)).toEqual([T2, id(3)]);
  });

  it('keeps the last of two marks for the same task and day', () => {
    const { write } = planLogWrites(
      [
        log(T1, '2026-01-15', { value: 1 }),
        log(T1, '2026-01-15', { value: 2 }),
      ],
      ME,
      [task(T1)],
    );
    expect(write.map((r) => r.value)).toEqual([2]);
  });

  it('treats the same task on another day as another mark', () => {
    const { write } = planLogWrites(
      [log(T1, '2026-01-15'), log(T1, '2026-01-16')],
      ME,
      [task(T1)],
    );
    expect(write).toHaveLength(2);
  });
});
