import { KnownLabel, planLabelWrites } from './plan-label-writes';

const ME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [A, B, C] = [id(1), id(2), id(3)];

const row = (rowId: string, name = 'x') => ({ id: rowId, name });
const stored = (
  rowId: string,
  extra: Partial<KnownLabel> = {},
): KnownLabel => ({ id: rowId, userId: ME, deleted: false, ...extra });

const plan = (rows: { id: string }[], known: KnownLabel[] = []) => {
  const { write, rejected } = planLabelWrites('note_tags', rows, ME, known);
  return {
    written: write.map((r) => r.id),
    rejected: rejected.map((r) => `${r.table}:${r.id}:${r.reason}`),
  };
};

describe('planLabelWrites', () => {
  it('writes new rows and refuses nothing', () => {
    expect(plan([row(A), row(B)])).toEqual({ written: [A, B], rejected: [] });
  });

  it('writes over a row of the same user', () => {
    expect(plan([row(A)], [stored(A)])).toEqual({ written: [A], rejected: [] });
  });

  it('names the table in a refusal', () => {
    const { rejected } = planLabelWrites('note_moods', [row(A)], ME, [
      stored(A, { userId: OTHER }),
    ]);
    expect(rejected).toEqual([
      { table: 'note_moods', id: A, reason: 'id_taken' },
    ]);
  });

  it("refuses another user's id as id_taken", () => {
    expect(plan([row(A)], [stored(A, { userId: OTHER })])).toEqual({
      written: [],
      rejected: [`note_tags:${A}:id_taken`],
    });
  });

  it("refuses another user's id even when it is deleted there", () => {
    expect(
      plan([row(A)], [stored(A, { userId: OTHER, deleted: true })]).rejected,
    ).toEqual([`note_tags:${A}:id_taken`]);
  });

  it('refuses the id of a starter mood (it belongs to nobody)', () => {
    expect(plan([row(A)], [stored(A, { userId: null })])).toEqual({
      written: [],
      rejected: [`note_tags:${A}:id_taken`],
    });
  });

  it('skips a row of its own that is already deleted, without refusing it', () => {
    expect(plan([row(A)], [stored(A, { deleted: true })])).toEqual({
      written: [],
      rejected: [],
    });
  });

  it('keeps the good rows next to the bad ones', () => {
    expect(
      plan([row(A), row(B), row(C)], [stored(B, { userId: OTHER })]),
    ).toEqual({ written: [A, C], rejected: [`note_tags:${B}:id_taken`] });
  });

  it('keeps the last of two rows with the same id', () => {
    const { write } = planLabelWrites(
      'note_tags',
      [row(A, 'first'), row(A, 'second')],
      ME,
      [],
    );
    expect(write.map((r) => r.name)).toEqual(['second']);
  });
});
