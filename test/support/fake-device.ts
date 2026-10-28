// A small stand-in for the app, for the tests that make two devices of one account exchange
// data through the server: it keeps its own copy, remembers what is not sent yet, pulls with the
// rules of `pullAction` (a deletion wins; a clean copy takes whatever comes; a dirty one keeps
// itself only if it is newer by the device's own clock) and pushes what is dirty.

export type Row = Record<string, unknown>;

export interface Rejected {
  table: string;
  id: string | null;
  reason: string;
}

export interface PullBody {
  next: string | null;
  has_more: boolean;
  tasks: Row[];
  logs: Row[];
  moods?: Row[];
  tags?: Row[];
  entries?: Row[];
  cycle_days?: Row[];
}

// How the device talks to the server: the test supplies the two calls (already signed in).
export interface DeviceApi {
  push(body: object): Promise<{ rejected: Rejected[] }>;
  pull(query: string): Promise<PullBody>;
}

// What the client does at the start of a sync: its saved watermark minus 5 seconds.
export const withOverlap = (next: string) =>
  new Date(Date.parse(next) - 5000).toISOString();

const time = (v: unknown) => Date.parse(v as string);
const sorted = (v: unknown) => [...((v as string[] | undefined) ?? [])].sort();

// The tables the diary lives in, by the name the server uses in `deleted`.
type LabelKind = 'tags' | 'moods';
const LABEL_TABLE: Record<LabelKind, string> = {
  tags: 'note_tags',
  moods: 'note_moods',
};
const LINKS: Record<LabelKind, 'tag_ids' | 'mood_ids'> = {
  tags: 'tag_ids',
  moods: 'mood_ids',
};

export class Device {
  tasks = new Map<string, Row>();
  logs = new Map<string, Row>();
  notes = new Map<string, Row>();
  tags = new Map<string, Row>();
  moods = new Map<string, Row>();
  // The cycle calendar, by day. There are no deletions: a taken-back mark is an empty day.
  cycleDays = new Map<string, Row>();
  watermark: string | null = null;
  rejected: Rejected[] = [];
  pulls = 0;

  private dirtyTasks = new Set<string>();
  private dirtyLogs = new Set<string>();
  private dirtyNotes = new Set<string>();
  private dirtyDays = new Set<string>();
  private dirty: Record<LabelKind, Set<string>> = {
    tags: new Set(),
    moods: new Set(),
  };
  // Tombstones to send, as `table|id`.
  private gone = new Set<string>();

  // `diary` and `cycle` are the app's switches: both off, it asks for the tasks only.
  constructor(
    private readonly api: DeviceApi,
    private readonly clock: () => string,
    private readonly options: { diary?: boolean; cycle?: boolean } = {},
  ) {}

  setDiary(on: boolean) {
    this.options.diary = on;
  }

  setCycle(on: boolean) {
    this.options.cycle = on;
  }

  // ---- tasks and marks

  edit(taskId: string, fields: Row) {
    this.tasks.set(taskId, {
      ...this.tasks.get(taskId),
      ...fields,
      id: taskId,
      client_updated_at: this.clock(),
    });
    this.dirtyTasks.add(taskId);
  }

  mark(taskId: string, date: string, fields: Row) {
    const key = `${taskId}|${date}`;
    this.logs.set(key, {
      ...this.logs.get(key),
      ...fields,
      task_id: taskId,
      date,
      client_updated_at: this.clock(),
    });
    this.dirtyLogs.add(key);
  }

  remove(taskId: string) {
    this.dropTask(taskId);
    this.dirtyTasks.delete(taskId);
    this.gone.add(`tasks|${taskId}`);
  }

  private dropTask(taskId: string) {
    this.tasks.delete(taskId);
    for (const key of [...this.logs.keys()]) {
      if (key.startsWith(taskId)) {
        this.logs.delete(key);
        this.dirtyLogs.delete(key);
      }
    }
  }

  // ---- the diary

  // A note always carries its whole set of labels, like the app's.
  note(noteId: string, fields: Row = {}) {
    const old = this.notes.get(noteId);
    this.notes.set(noteId, {
      ...old,
      ...fields,
      id: noteId,
      mood_ids: fields.mood_ids ?? old?.mood_ids ?? [],
      tag_ids: fields.tag_ids ?? old?.tag_ids ?? [],
      client_updated_at: this.clock(),
    });
    this.dirtyNotes.add(noteId);
  }

  tag(tagId: string, fields: Row) {
    this.tags.set(tagId, {
      ...this.tags.get(tagId),
      ...fields,
      id: tagId,
      client_updated_at: this.clock(),
    });
    this.dirty.tags.add(tagId);
  }

  mood(moodId: string, fields: Row) {
    this.moods.set(moodId, {
      ...this.moods.get(moodId),
      ...fields,
      id: moodId,
      client_updated_at: this.clock(),
    });
    this.dirty.moods.add(moodId);
  }

  removeNote(noteId: string) {
    this.notes.delete(noteId);
    this.dirtyNotes.delete(noteId);
    this.gone.add(`diary_entries|${noteId}`);
  }

  // The app takes a deleted label off its notes by itself; it does not mark them as changed.
  removeTag(tagId: string) {
    this.dropLabel('tags', tagId);
    this.gone.add(`${LABEL_TABLE.tags}|${tagId}`);
  }

  removeMood(moodId: string) {
    this.dropLabel('moods', moodId);
    this.gone.add(`${LABEL_TABLE.moods}|${moodId}`);
  }

  private dropLabel(kind: LabelKind, labelId: string) {
    this[kind].delete(labelId);
    this.dirty[kind].delete(labelId);
    for (const note of this.notes.values()) {
      note[LINKS[kind]] = ((note[LINKS[kind]] as string[]) ?? []).filter(
        (l) => l !== labelId,
      );
    }
  }

  // ---- the cycle

  // The app saves a whole day: what is not given is empty, so `day(date)` alone is a day with
  // nothing marked (how a mark is taken back).
  day(date: string, fields: Row = {}) {
    this.cycleDays.set(date, {
      date,
      flow: 0,
      mood: null,
      symptoms: [],
      discharge: null,
      sex: null,
      pill: false,
      note: null,
      ...fields,
      client_updated_at: this.clock(),
    });
    this.dirtyDays.add(date);
  }

  // ---- talking to the server

  async sync(order: 'pull-first' | 'push-first' = 'pull-first', limit = 500) {
    if (order === 'pull-first') {
      await this.pullAll(limit);
      await this.pushAll();
    } else {
      await this.pushAll();
      await this.pullAll(limit);
    }
  }

  // Forgets how far it has read, as the app does when the diary is switched on.
  forgetWatermark() {
    this.watermark = null;
  }

  private async pushAll() {
    const chunks = <T>(list: T[]) =>
      Array.from({ length: Math.ceil(list.length / 500) }, (_, i) =>
        list.slice(i * 500, i * 500 + 500),
      );
    const lists = {
      moods: chunks([...this.dirty.moods].map((i) => this.moods.get(i)!)),
      tags: chunks([...this.dirty.tags].map((i) => this.tags.get(i)!)),
      entries: chunks([...this.dirtyNotes].map((i) => this.notes.get(i)!)),
      tasks: chunks([...this.dirtyTasks].map((i) => this.tasks.get(i)!)),
      cycle_days: chunks(
        [...this.dirtyDays].map((d) => this.cycleDays.get(d)!),
      ),
      logs: chunks([...this.dirtyLogs].map((k) => this.logs.get(k)!)),
      deleted: chunks(
        [...this.gone].map((g) => {
          const [table, id] = g.split('|');
          return { table, id };
        }),
      ),
    };
    const parts = Math.max(...Object.values(lists).map((l) => l.length));
    for (let i = 0; i < parts; i++) {
      const res = await this.api.push(
        Object.fromEntries(
          Object.entries(lists).map(([key, chunked]) => [
            key,
            chunked[i] ?? [],
          ]),
        ),
      );
      this.rejected.push(...res.rejected);
    }
    this.dirtyTasks.clear();
    this.dirtyLogs.clear();
    this.dirtyNotes.clear();
    this.dirtyDays.clear();
    this.dirty.tags.clear();
    this.dirty.moods.clear();
    this.gone.clear();
  }

  private async pullAll(limit: number) {
    const parts = [
      ...(this.options.diary ? ['diary'] : []),
      ...(this.options.cycle ? ['cycle'] : []),
    ];
    const include = parts.length > 0 ? `&include=${parts.join(',')}` : '';
    // Overlap once, at the start; follow `next` as it is.
    let since = this.watermark ? withOverlap(this.watermark) : null;
    for (;;) {
      this.pulls += 1;
      const res = await this.api.pull(
        `?limit=${limit}${include}${since ? `&since=${since}` : ''}`,
      );
      res.tasks.forEach((t) => this.mergeTask(t));
      res.logs.forEach((l) => this.mergeLog(l));
      res.moods?.forEach((m) => this.mergeLabel('moods', m));
      res.tags?.forEach((t) => this.mergeLabel('tags', t));
      res.entries?.forEach((e) => this.mergeNote(e));
      res.cycle_days?.forEach((d) => this.mergeDay(d));
      if (res.next) this.watermark = res.next;
      if (!res.has_more) break;
      since = res.next;
    }
    this.settleLinks();
  }

  // A note can come before the label it names (the pages are cut table by table) and an old copy
  // of a note can still name a label this device has deleted. So the links are checked once the
  // whole pull is in: a link to a label this device does not have is dropped, and the note is
  // not marked as changed for it.
  private settleLinks() {
    for (const note of this.notes.values()) {
      for (const kind of ['tags', 'moods'] as const) {
        note[LINKS[kind]] = ((note[LINKS[kind]] as string[]) ?? []).filter(
          (labelId) => this[kind].has(labelId),
        );
      }
    }
  }

  // Takes the remote copy unless this device has a newer edit of its own that is not sent yet.
  private takes(local: Row | undefined, dirty: boolean, remote: Row) {
    return (
      !local ||
      !dirty ||
      time(remote.client_updated_at) > time(local.client_updated_at)
    );
  }

  // A row whose deletion waits to be sent must not come back from a pull that crossed it.
  private waitingToBeDeleted(table: string, remote: Row) {
    return this.gone.has(`${table}|${remote.id as string}`);
  }

  private mergeTask(remote: Row) {
    if (this.waitingToBeDeleted('tasks', remote)) return;
    const taskId = remote.id as string;
    const local = this.tasks.get(taskId);
    if (remote.deleted_at) {
      if (local) this.dropTask(taskId);
      this.dirtyTasks.delete(taskId);
    } else if (this.takes(local, this.dirtyTasks.has(taskId), remote)) {
      this.tasks.set(taskId, remote);
      this.dirtyTasks.delete(taskId);
    }
  }

  private mergeLog(remote: Row) {
    // Nor do the marks of a task whose deletion waits to be sent.
    if (this.gone.has(`tasks|${remote.task_id as string}`)) return;
    const key = `${remote.task_id as string}|${remote.date as string}`;
    if (this.takes(this.logs.get(key), this.dirtyLogs.has(key), remote)) {
      this.logs.set(key, remote);
      this.dirtyLogs.delete(key);
    }
  }

  private mergeNote(remote: Row) {
    if (this.waitingToBeDeleted('diary_entries', remote)) return;
    const noteId = remote.id as string;
    if (remote.deleted_at) {
      this.notes.delete(noteId);
      this.dirtyNotes.delete(noteId);
    } else if (
      this.takes(this.notes.get(noteId), this.dirtyNotes.has(noteId), remote)
    ) {
      this.notes.set(noteId, remote);
      this.dirtyNotes.delete(noteId);
    }
  }

  private mergeDay(remote: Row) {
    const date = remote.date as string;
    if (
      this.takes(this.cycleDays.get(date), this.dirtyDays.has(date), remote)
    ) {
      this.cycleDays.set(date, remote);
      this.dirtyDays.delete(date);
    }
  }

  private mergeLabel(kind: LabelKind, remote: Row) {
    if (this.waitingToBeDeleted(LABEL_TABLE[kind], remote)) return;
    const labelId = remote.id as string;
    if (remote.deleted_at) {
      this.dropLabel(kind, labelId);
    } else if (
      this.takes(this[kind].get(labelId), this.dirty[kind].has(labelId), remote)
    ) {
      this[kind].set(labelId, remote);
      this.dirty[kind].delete(labelId);
    }
  }

  // ---- what the device holds, in a form two devices can be compared in

  snapshot() {
    return {
      tasks: [...this.tasks.values()]
        .map((t) => [
          t.id,
          t.parent_id ?? null,
          t.title ?? '',
          t.status ?? 'active',
        ])
        .sort(),
      logs: [...this.logs.values()]
        .map((l) => [l.task_id, l.date, l.completed ?? false, l.value ?? null])
        .sort(),
    };
  }

  cycleSnapshot() {
    return [...this.cycleDays.values()]
      .map((d) => [
        d.date,
        d.flow,
        d.mood ?? null,
        [...((d.symptoms as number[] | undefined) ?? [])].sort(),
        d.discharge ?? null,
        d.sex ?? null,
        d.pill,
        d.note ?? null,
      ])
      .sort();
  }

  diarySnapshot() {
    return {
      notes: [...this.notes.values()]
        .map((n) => [
          n.id,
          n.title ?? '',
          n.body ?? '',
          n.status ?? 'normal',
          n.is_favorite ?? false,
          sorted(n.mood_ids),
          sorted(n.tag_ids),
        ])
        .sort(),
      tags: [...this.tags.values()]
        .map((t) => [t.id, t.name, t.color_key ?? 'violet'])
        .sort(),
      moods: [...this.moods.values()]
        .map((m) => [m.id, m.name, m.emoji])
        .sort(),
    };
  }
}
