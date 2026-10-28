import { planEntryWrites } from './plan-entry-writes';
import { KnownLabel } from './plan-label-writes';
import { EntryRow, parseEntry } from './push-rows';

const ME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [N1, N2] = [id(1), id(2)];
const [M1, M2, STARTER] = [id(11), id(12), id(13)];
const [G1, G2] = [id(21), id(22)];

const note = (
  noteId: string,
  extra: Record<string, unknown> = {},
): EntryRow => {
  const result = parseEntry({ id: noteId, ...extra });
  if (!('row' in result)) throw new Error('bad test row');
  return result.row;
};
const known = (
  labelId: string,
  extra: Partial<KnownLabel> = {},
): KnownLabel => ({ id: labelId, userId: ME, deleted: false, ...extra });

const MOODS = [known(M1), known(M2), known(STARTER, { userId: null })];
const TAGS = [known(G1), known(G2)];

const plan = (
  rows: EntryRow[],
  notes: KnownLabel[] = [],
  moods = MOODS,
  tags = TAGS,
) => {
  const p = planEntryWrites(rows, ME, { notes, moods, tags });
  return {
    written: p.write.map((r) => r.id),
    replaceMoodsOf: p.replaceMoodsOf,
    replaceTagsOf: p.replaceTagsOf,
    moodLinks: p.moodLinks.map((l) => `${l.entryId}>${l.labelId}`),
    tagLinks: p.tagLinks.map((l) => `${l.entryId}>${l.labelId}`),
    rejected: p.rejected.map((r) => `${r.table}:${r.id}:${r.reason}`),
  };
};

describe('planEntryWrites', () => {
  it('writes a note that names no labels and touches no links', () => {
    expect(plan([note(N1)])).toEqual({
      written: [N1],
      replaceMoodsOf: [],
      replaceTagsOf: [],
      moodLinks: [],
      tagLinks: [],
      rejected: [],
    });
  });

  it('keeps the labels it can and replaces the links of that note', () => {
    expect(
      plan([note(N1, { mood_ids: [M1, STARTER], tag_ids: [G1, G2] })]),
    ).toEqual({
      written: [N1],
      replaceMoodsOf: [N1],
      replaceTagsOf: [N1],
      moodLinks: [`${N1}>${M1}`, `${N1}>${STARTER}`],
      tagLinks: [`${N1}>${G1}`, `${N1}>${G2}`],
      rejected: [],
    });
  });

  it('treats an empty list as "erase the links", and a missing one as "leave them"', () => {
    const p = plan([note(N1, { mood_ids: [] })]);
    expect(p.replaceMoodsOf).toEqual([N1]);
    expect(p.moodLinks).toEqual([]);
    expect(p.replaceTagsOf).toEqual([]);
  });

  describe('moods', () => {
    it('lets a note have a starter mood and one of its own', () => {
      expect(plan([note(N1, { mood_ids: [STARTER, M1] })]).moodLinks).toEqual([
        `${N1}>${STARTER}`,
        `${N1}>${M1}`,
      ]);
    });

    it("drops another user's mood, and says so once", () => {
      const p = plan(
        [note(N1, { mood_ids: [M1, M2] })],
        [],
        [known(M1), known(M2, { userId: OTHER })],
      );
      expect(p.moodLinks).toEqual([`${N1}>${M1}`]);
      expect(p.written).toEqual([N1]);
      expect(p.rejected).toEqual([`diary_entries:${N1}:unknown_label`]);
    });

    it('drops a mood the server has never seen', () => {
      const p = plan([note(N1, { mood_ids: [id(99)] })]);
      expect(p.moodLinks).toEqual([]);
      expect(p.rejected).toEqual([`diary_entries:${N1}:unknown_label`]);
    });

    it('drops a deleted mood', () => {
      const p = plan(
        [note(N1, { mood_ids: [M1] })],
        [],
        [known(M1, { deleted: true })],
      );
      expect(p.moodLinks).toEqual([]);
      expect(p.rejected).toEqual([`diary_entries:${N1}:unknown_label`]);
    });
  });

  describe('tags', () => {
    it("drops another user's tag, a deleted one and an unknown one", () => {
      const p = plan(
        [note(N1, { tag_ids: [G1, G2, id(98), id(99)] })],
        [],
        MOODS,
        [
          known(G1),
          known(G2, { userId: OTHER }),
          known(id(98), { deleted: true }),
        ],
      );
      expect(p.tagLinks).toEqual([`${N1}>${G1}`]);
      expect(p.rejected).toEqual([`diary_entries:${N1}:unknown_label`]);
    });

    it('does not take a starter mood id for a tag', () => {
      // A mood and a tag are looked up in their own tables: an id found only among moods is no tag.
      expect(plan([note(N1, { tag_ids: [STARTER] })]).tagLinks).toEqual([]);
    });

    it('is not taken as a tag when the tag has no owner', () => {
      const p = plan([note(N1, { tag_ids: [G1] })], [], MOODS, [
        known(G1, { userId: null }),
      ]);
      expect(p.tagLinks).toEqual([]);
    });
  });

  it('says "unknown label" once for a note, however many labels it lost', () => {
    const p = plan([
      note(N1, { mood_ids: [id(97)], tag_ids: [id(98), id(99)] }),
    ]);
    expect(p.rejected).toEqual([`diary_entries:${N1}:unknown_label`]);
  });

  it('judges each note by its own labels', () => {
    const p = plan([
      note(N1, { tag_ids: [id(99)] }),
      note(N2, { tag_ids: [G1] }),
    ]);
    expect(p.written).toEqual([N1, N2]);
    expect(p.tagLinks).toEqual([`${N2}>${G1}`]);
    expect(p.rejected).toEqual([`diary_entries:${N1}:unknown_label`]);
  });

  describe('ownership of the note', () => {
    it("refuses another user's note as id_taken, with no links", () => {
      expect(
        plan(
          [note(N1, { mood_ids: [M1], tag_ids: [G1] })],
          [known(N1, { userId: OTHER })],
        ),
      ).toEqual({
        written: [],
        replaceMoodsOf: [],
        replaceTagsOf: [],
        moodLinks: [],
        tagLinks: [],
        rejected: [`diary_entries:${N1}:id_taken`],
      });
    });

    it("refuses another user's note even when it is deleted there", () => {
      const p = plan([note(N1)], [known(N1, { userId: OTHER, deleted: true })]);
      expect(p.rejected).toEqual([`diary_entries:${N1}:id_taken`]);
    });

    it('writes over a note of its own', () => {
      expect(plan([note(N1, { tag_ids: [G1] })], [known(N1)]).written).toEqual([
        N1,
      ]);
    });

    it('skips a deleted note of its own: nothing is written, no links are added or erased', () => {
      expect(
        plan(
          [note(N1, { mood_ids: [M1], tag_ids: [G1] })],
          [known(N1, { deleted: true })],
        ),
      ).toEqual({
        written: [],
        replaceMoodsOf: [],
        replaceTagsOf: [],
        moodLinks: [],
        tagLinks: [],
        rejected: [],
      });
    });
  });

  it('keeps the good notes next to the refused ones', () => {
    const p = plan([note(N1), note(N2)], [known(N1, { userId: OTHER })]);
    expect(p.written).toEqual([N2]);
    expect(p.rejected).toEqual([`diary_entries:${N1}:id_taken`]);
  });

  it('judges the last of two rows with the same id, links included', () => {
    const p = plan([
      note(N1, { tag_ids: [G1], title: 'first' }),
      note(N1, { tag_ids: [G2], title: 'second' }),
    ]);
    expect(p.written).toEqual([N1]);
    expect(p.tagLinks).toEqual([`${N1}>${G2}`]);
  });
});
