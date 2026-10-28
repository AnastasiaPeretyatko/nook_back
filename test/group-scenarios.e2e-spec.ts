import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createTestApp, truncateAll } from './support/db';
import { Device, PullBody, Rejected, Row } from './support/fake-device';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [T1, T2, T3, T4, T5, T6] = [1, 2, 3, 4, 5, 6].map(id);
const [N1, TAG1] = [id(21), id(22)];
const CODE = '111111';
const DAY = '2026-01-15';

interface Session {
  token: string;
  id: string;
}

describe('Groups (the "done when" list of stage B5)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let ann: Session; // the owner
  let bob: Session; // a member
  let cat: Session; // a member, the third
  let dan: Session; // outside
  let G: string;
  const api = () => request(app.getHttpServer());

  async function signUp(email: string): Promise<Session> {
    const res = await api()
      .post('/auth/register')
      .send({ email, password: 'correct horse' })
      .expect(201);
    const body = res.body as { accessToken: string; user: { id: string } };
    return { token: body.accessToken, id: body.user.id };
  }
  const as = (who: Session) => ({ Authorization: `Bearer ${who.token}` });
  const push = async (who: Session, body: object) => {
    const res = await api()
      .post('/sync/push')
      .set(as(who))
      .send(body)
      .expect(200);
    return res.body as { rejected: Rejected[] };
  };
  const pull = async (who: Session, query = '') => {
    const res = await api().get(`/sync/pull${query}`).set(as(who)).expect(200);
    return res.body as PullBody;
  };
  const join = (who: Session, code = CODE) =>
    api().post('/groups/join').set(as(who)).send({ code });
  const leave = (who: Session) =>
    api().post(`/groups/${G}/leave`).set(as(who)).expect(204);
  const setName = (who: Session, name: string) =>
    api()
      .put('/me/profile')
      .set(as(who))
      .send({ displayName: name, avatarUrl: null })
      .expect(200);

  let tick = 0;
  const clock = () =>
    new Date(Date.UTC(2026, 0, 1, 0, 0, ++tick)).toISOString();
  const deviceOf = (who: Session) =>
    new Device(
      { push: (body) => push(who, body), pull: (query) => pull(who, query) },
      clock,
      { userId: who.id },
    );
  const serverTask = async (taskId: string) =>
    (
      await ds.query(
        `select title, user_id, group_id, assignee_id, deleted_at is not null as deleted from tasks where id = $1`,
        [taskId],
      )
    )[0] as Row | undefined;
  const reasons = (d: Device) =>
    d.rejected.map((r) => `${r.table}:${r.id}:${r.reason}`).sort();

  // Every way a person can ask the server for their data, as one text.
  async function everythingSeenBy(who: Session) {
    let text = '';
    for (const query of [
      '',
      '?include=tasks',
      '?include=diary',
      '?include=cycle',
      '?include=tasks,diary,cycle',
      '?since=',
      '?since=2000-01-01T00:00:00Z&include=diary,cycle',
      '?limit=1&include=diary,cycle',
    ]) {
      text += JSON.stringify(await pull(who, query));
    }
    return text;
  }

  beforeAll(async () => {
    app = await createTestApp();
    app.getHttpServer().setMaxListeners(100);
    ds = app.get(DataSource);
  });

  beforeEach(async () => {
    tick = 0;
    await truncateAll(ds);
    ann = await signUp('ann@example.com');
    bob = await signUp('bob@example.com');
    cat = await signUp('cat@example.com');
    dan = await signUp('dan@example.com');
    const res = await api()
      .post('/groups')
      .set(as(ann))
      .send({ name: 'Home' })
      .expect(201);
    G = res.body.id;
    await ds.query(`update group_invites set code = $2 where group_id = $1`, [
      G,
      CODE,
    ]);
    await join(bob).expect(200);
    await setName(ann, 'Ann');
    await setName(bob, 'Bob');
  });

  afterAll(() => app.close());

  describe('a task of the author reaches the member', () => {
    it('whole, with its author, and with the group and its people', async () => {
      const annPhone = deviceOf(ann);
      const bobPhone = deviceOf(bob);
      annPhone.edit(T1, { title: 'Buy milk', group_id: G });
      await annPhone.sync();
      await bobPhone.sync();
      expect(annPhone.rejected).toEqual([]);
      expect(bobPhone.tasks.get(T1)).toMatchObject({
        title: 'Buy milk',
        user_id: ann.id,
        group_id: G,
        assignee_id: null,
      });
      expect(bobPhone.groupSnapshot()).toEqual({
        groups: [[G, 'Home', ann.id]],
        members: [
          [G, ann.id, 'Ann'],
          [G, bob.id, 'Bob'],
        ].sort(),
      });
    });

    it('and a task of the member reaches the owner', async () => {
      const annPhone = deviceOf(ann);
      const bobPhone = deviceOf(bob);
      bobPhone.edit(T2, { title: 'Wash up', group_id: G });
      await bobPhone.sync();
      await annPhone.sync();
      expect(annPhone.tasks.get(T2)).toMatchObject({
        user_id: bob.id,
        group_id: G,
      });
    });
  });

  describe('whose task may be changed', () => {
    let annPhone: Device;
    let bobPhone: Device;
    beforeEach(async () => {
      annPhone = deviceOf(ann);
      bobPhone = deviceOf(bob);
      annPhone.edit(T1, { title: 'Ann’s task', group_id: G });
      bobPhone.edit(T2, { title: 'Bob’s task', group_id: G });
      await annPhone.sync();
      await bobPhone.sync();
      await annPhone.sync();
    });

    it('a member cannot change the task of another: it is refused and the server keeps its own', async () => {
      bobPhone.edit(T1, { title: 'hijacked', group_id: G });
      await bobPhone.sync();
      expect(reasons(bobPhone)).toEqual([`tasks:${T1}:not_allowed`]);
      expect((await serverTask(T1))?.title).toBe('Ann’s task');
      await annPhone.sync();
      expect(annPhone.tasks.get(T1)?.title).toBe('Ann’s task');
    });

    it('the owner can change the task of a member, and the author stays', async () => {
      annPhone.edit(T2, { title: 'set by the owner', group_id: G });
      await annPhone.sync();
      expect(annPhone.rejected).toEqual([]);
      await bobPhone.sync();
      expect(bobPhone.tasks.get(T2)).toMatchObject({
        title: 'set by the owner',
        user_id: bob.id,
      });
    });

    it('the author changes their own', async () => {
      bobPhone.edit(T2, { title: 'renamed', group_id: G });
      await bobPhone.sync();
      await annPhone.sync();
      expect(annPhone.tasks.get(T2)?.title).toBe('renamed');
      expect(bobPhone.rejected).toEqual([]);
    });

    it('the owner can delete a member’s task and it goes from the member’s phone', async () => {
      annPhone.remove(T2);
      await annPhone.sync();
      expect(annPhone.rejected).toEqual([]);
      await bobPhone.sync();
      expect(bobPhone.tasks.has(T2)).toBe(false);
    });

    it('a member cannot delete the owner’s task', async () => {
      bobPhone.remove(T1);
      await bobPhone.sync();
      expect(reasons(bobPhone)).toEqual([`tasks:${T1}:not_allowed`]);
      expect((await serverTask(T1))?.deleted).toBe(false);
    });
  });

  describe('marks: every member’s are seen by the others', () => {
    it('each of three people marks a task for everyone and each phone shows all three', async () => {
      await join(cat).expect(200);
      const phones = [deviceOf(ann), deviceOf(bob), deviceOf(cat)];
      phones[0].edit(T1, { title: 'Water the plants', group_id: G });
      await phones[0].sync();
      for (const p of phones) await p.sync();
      phones[0].mark(T1, DAY, { completed: true });
      phones[1].mark(T1, DAY, { completed: true });
      phones[2].mark(T1, DAY, { completed: true, value: 5 });
      for (const p of phones) await p.sync();
      for (const p of phones) await p.sync();
      for (const p of phones) {
        expect(p.rejected).toEqual([]);
        const all = [...p.logs.values(), ...p.otherMarks.values()];
        expect(all.map((l) => l.user_id ?? 'me').length).toBe(3);
        expect(p.logs.size + p.otherMarks.size).toBe(3);
      }
      expect(phones[0].otherMarksSnapshot()).toEqual(
        [
          [T1, bob.id, DAY, true, null],
          [T1, cat.id, DAY, true, 5],
        ].sort(),
      );
    });

    it('a task for someone can be marked only by them', async () => {
      await join(cat).expect(200);
      const annPhone = deviceOf(ann);
      const bobPhone = deviceOf(bob);
      const catPhone = deviceOf(cat);
      annPhone.edit(T1, { title: 'For Bob', group_id: G, assignee_id: bob.id });
      await annPhone.sync();
      await bobPhone.sync();
      await catPhone.sync();
      catPhone.mark(T1, DAY, { completed: true });
      await catPhone.sync();
      expect(reasons(catPhone)).toEqual([`task_logs:${T1}:not_allowed`]);
      bobPhone.mark(T1, DAY, { completed: true });
      await bobPhone.sync();
      expect(bobPhone.rejected).toEqual([]);
      await annPhone.sync();
      expect(annPhone.otherMarksSnapshot()).toEqual([
        [T1, bob.id, DAY, true, null],
      ]);
    });

    it('when the assignee leaves, the task goes back to nobody and the owner’s phone sees it', async () => {
      const annPhone = deviceOf(ann);
      annPhone.edit(T1, { title: 'For Bob', group_id: G, assignee_id: bob.id });
      await annPhone.sync();
      await annPhone.sync();
      expect(annPhone.tasks.get(T1)?.assignee_id).toBe(bob.id);
      await leave(bob);
      await annPhone.sync();
      expect(annPhone.tasks.get(T1)?.assignee_id).toBeNull();
    });
  });

  describe('leaving, being removed, the group being deleted: the group goes off the phone', () => {
    let annPhone: Device;
    let bobPhone: Device;
    beforeEach(async () => {
      annPhone = deviceOf(ann);
      bobPhone = deviceOf(bob);
      annPhone.edit(T1, { title: 'Group task', group_id: G });
      bobPhone.edit(T2, { title: 'Bob group task', group_id: G });
      bobPhone.edit(T3, { title: 'Bob personal' });
      await annPhone.sync();
      await bobPhone.sync();
      annPhone.mark(T1, DAY, { completed: true });
      bobPhone.mark(T1, DAY, { completed: true });
      bobPhone.mark(T3, DAY, { completed: true });
      await annPhone.sync();
      await bobPhone.sync();
      await annPhone.sync();
      expect([...bobPhone.tasks.keys()].sort()).toEqual([T1, T2, T3].sort());
      expect(bobPhone.otherMarks.size).toBe(1);
    });

    const expectBobPhoneClean = async () => {
      // What the server sends, not only what the phone keeps: it must not send the group at all.
      const raw = await pull(bob, '?since=');
      expect(raw.tasks.map((t) => t.id)).toEqual([T3]);
      expect(raw.logs.map((l) => l.task_id)).toEqual([T3]);
      await bobPhone.sync();
      expect(bobPhone.groupSnapshot()).toEqual({ groups: [], members: [] });
      expect([...bobPhone.tasks.keys()]).toEqual([T3]);
      expect([...bobPhone.logs.keys()]).toEqual([`${T3}|${DAY}`]);
      expect(bobPhone.otherMarks.size).toBe(0);
    };

    it('when he leaves', async () => {
      await leave(bob);
      await expectBobPhoneClean();
    });

    it('when the owner removes him', async () => {
      await api()
        .delete(`/groups/${G}/members/${bob.id}`)
        .set(as(ann))
        .expect(204);
      await expectBobPhoneClean();
    });

    it('when the owner deletes the group, for the owner’s own phone too', async () => {
      await api().delete(`/groups/${G}`).set(as(ann)).expect(204);
      for (const t of [T1, T2])
        expect((await serverTask(t))?.deleted).toBe(true);
      await expectBobPhoneClean();
      await annPhone.sync();
      expect(annPhone.groupSnapshot()).toEqual({ groups: [], members: [] });
      expect(annPhone.tasks.size).toBe(0);
    });

    it('while the others keep it, without the one who left in the list of people', async () => {
      await leave(bob);
      await annPhone.sync();
      expect(annPhone.groupSnapshot()).toEqual({
        groups: [[G, 'Home', ann.id]],
        members: [[G, ann.id, 'Ann']],
      });
      // What he wrote stays for the group.
      expect(annPhone.tasks.get(T2)).toMatchObject({
        user_id: bob.id,
        group_id: G,
      });
    });

    it('and a phone that sent changes from before it learned of it is turned away and creates nothing', async () => {
      await leave(bob);
      bobPhone.edit(T4, { title: 'queued offline', group_id: G });
      bobPhone.edit(T2, { title: 'edited offline', group_id: G });
      await bobPhone.sync('push-first');
      expect(reasons(bobPhone)).toEqual([
        `tasks:${T2}:id_taken`,
        `tasks:${T4}:unknown_group`,
      ]);
      expect(await serverTask(T4)).toBeUndefined();
      expect((await serverTask(T2))?.title).toBe('Bob group task');
    });

    it('and a phone queued with a mark from before is turned away too', async () => {
      await leave(bob);
      bobPhone.mark(T1, '2026-01-16', { completed: true });
      await bobPhone.sync('push-first');
      expect(reasons(bobPhone)).toEqual([`task_logs:${T1}:unknown_task`]);
    });

    it('he gets the group, its tasks and its marks back by joining again', async () => {
      await leave(bob);
      await bobPhone.sync();
      await join(bob).expect(200);
      await bobPhone.sync();
      expect([...bobPhone.tasks.keys()].sort()).toEqual([T1, T2, T3].sort());
      expect(bobPhone.groupSnapshot().groups).toEqual([[G, 'Home', ann.id]]);
      expect(bobPhone.otherMarks.size).toBe(1);
    });
  });

  describe('joining', () => {
    it('gives a phone that was already up to date the tasks and marks written before', async () => {
      const annPhone = deviceOf(ann);
      annPhone.edit(T1, { title: 'old task', group_id: G });
      annPhone.edit(T2, { title: 'older task', group_id: G });
      await annPhone.sync();
      annPhone.mark(T1, DAY, { completed: true });
      await annPhone.sync();
      // Their time goes far into the past, as if the group had existed for a long while.
      for (const table of ['tasks', 'task_logs']) {
        await ds.query(
          `alter table ${table} disable trigger ${table}_updated_at`,
        );
      }
      try {
        await ds.query(`update tasks set updated_at = '2020-01-01'`);
        await ds.query(`update task_logs set updated_at = '2020-01-01'`);
      } finally {
        for (const table of ['tasks', 'task_logs']) {
          await ds.query(
            `alter table ${table} enable trigger ${table}_updated_at`,
          );
        }
      }
      const catPhone = deviceOf(cat);
      catPhone.edit(T6, { title: 'Cat personal' });
      await catPhone.sync();
      await catPhone.sync(); // now the phone has a watermark: it will not read everything again
      expect(catPhone.watermark).not.toBeNull();
      await join(cat).expect(200);
      await catPhone.sync();
      expect([...catPhone.tasks.keys()].sort()).toEqual([T1, T2, T6].sort());
      expect(catPhone.otherMarksSnapshot()).toEqual([
        [T1, ann.id, DAY, true, null],
      ]);
    });

    it('shows the 11th wrong code of an hour a refusal, and a right one after it too', async () => {
      for (let i = 1; i <= 10; i++) {
        const res = await join(dan, `00000${i}`.slice(-6)).expect(400);
        expect(res.body.code).toBe('bad_code');
      }
      const eleventh = await join(dan, '000011').expect(429);
      expect(eleventh.body.code).toBe('too_many_requests');
      await join(dan, CODE).expect(429);
      const phone = deviceOf(dan);
      await phone.sync();
      expect(phone.groupSnapshot()).toEqual({ groups: [], members: [] });
    });
  });

  describe('someone outside sees and changes nothing', () => {
    it('a third account’s phone gets no group, no task, no mark and no name, by any pull', async () => {
      const annPhone = deviceOf(ann);
      annPhone.edit(T1, { title: 'SECRET-TASK', group_id: G });
      await annPhone.sync();
      annPhone.mark(T1, DAY, { completed: true });
      await annPhone.sync();
      const danPhone = deviceOf(dan);
      await danPhone.sync();
      expect(danPhone.tasks.size).toBe(0);
      expect(danPhone.groupSnapshot()).toEqual({ groups: [], members: [] });
      expect(danPhone.otherMarks.size + danPhone.logs.size).toBe(0);
      const seen = await everythingSeenBy(dan);
      for (const secret of [
        'SECRET-TASK',
        G,
        ann.id,
        bob.id,
        'Ann',
        'Bob',
        'Home',
        CODE,
      ]) {
        expect(seen).not.toContain(secret);
      }
    });

    it('cannot change a task of the group, delete it, mark it, or plant one in the group', async () => {
      const annPhone = deviceOf(ann);
      annPhone.edit(T1, { title: 'Group task', group_id: G });
      await annPhone.sync();
      const danPhone = deviceOf(dan);
      danPhone.edit(T1, { title: 'hijacked', group_id: G });
      danPhone.edit(T4, { title: 'planted', group_id: G });
      danPhone.mark(T1, DAY, { completed: true });
      await danPhone.sync('push-first');
      expect(reasons(danPhone)).toEqual(
        [
          `task_logs:${T1}:unknown_task`,
          `tasks:${T1}:id_taken`,
          `tasks:${T4}:unknown_group`,
        ].sort(),
      );
      danPhone.remove(T1);
      await danPhone.sync('push-first');
      expect((await serverTask(T1))?.title).toBe('Group task');
      expect((await serverTask(T1))?.deleted).toBe(false);
      expect(await serverTask(T4)).toBeUndefined();
    });

    it('cannot learn or change the group through its routes either', async () => {
      await api().get(`/groups/${G}/invite`).set(as(dan)).expect(404);
      await api()
        .patch(`/groups/${G}`)
        .set(as(dan))
        .send({ name: 'x' })
        .expect(404);
      await api().delete(`/groups/${G}`).set(as(dan)).expect(404);
      await api().post(`/groups/${G}/leave`).set(as(dan)).expect(404);
      await api()
        .delete(`/groups/${G}/members/${bob.id}`)
        .set(as(dan))
        .expect(404);
      await api().get(`/groups/${G}/invite`).set(as(bob)).expect(403);
    });
  });

  describe('nothing personal gets into a group', () => {
    beforeEach(async () => {
      await join(cat).expect(200);
      for (const [who, tag] of [
        [ann, 'ANN'],
        [bob, 'BOB'],
      ] as const) {
        await push(who, {
          tasks: [
            {
              id: who === ann ? T5 : T6,
              title: `SECRET-${tag}-TASK`,
              description: `SECRET-${tag}-DESC`,
            },
          ],
          logs: [
            {
              task_id: who === ann ? T5 : T6,
              date: DAY,
              completed: true,
              value: 42,
            },
          ],
          tags: [
            { id: who === ann ? TAG1 : id(23), name: `SECRET-${tag}-TAG` },
          ],
          entries: [
            {
              id: who === ann ? N1 : id(24),
              title: `SECRET-${tag}-NOTE`,
              body: `SECRET-${tag}-BODY`,
            },
          ],
          cycle_days: [{ date: DAY, note: `SECRET-${tag}-CYCLE`, flow: 3 }],
        });
      }
      // A group task to share, so that the group is not empty.
      await push(ann, { tasks: [{ id: T1, group_id: G, title: 'shared' }] });
    });

    it('the members and the owner see only the group’s part of each other, by any pull', async () => {
      const bobSees = await everythingSeenBy(bob);
      const catSees = await everythingSeenBy(cat);
      const annSees = await everythingSeenBy(ann);
      for (const text of [bobSees, catSees]) {
        expect(text).toContain('shared');
        expect(text).not.toMatch(/SECRET-ANN/);
      }
      expect(catSees).not.toMatch(/SECRET-BOB/);
      expect(annSees).not.toMatch(/SECRET-BOB/);
      expect(bobSees).toMatch(/SECRET-BOB-TASK/);
      expect(annSees).toMatch(/SECRET-ANN-TASK/);
    });

    it('a personal task cannot be brought into the group by naming it, and stays private', async () => {
      await push(bob, {
        tasks: [{ id: T6, group_id: G, title: 'SECRET-BOB-TASK' }],
      });
      expect(await serverTask(T6)).toMatchObject({
        group_id: null,
        user_id: bob.id,
      });
      expect(await everythingSeenBy(ann)).not.toMatch(/SECRET-BOB/);
    });

    it('the marks on a personal task are not the group’s: each sees only their own', async () => {
      const taskIds = async (who: Session) =>
        (await pull(who, '?include=diary,cycle')).logs.map((l) => l.task_id);
      expect(await taskIds(ann)).toEqual([T5]);
      expect(await taskIds(bob)).toEqual([T6]);
      expect(await taskIds(cat)).toEqual([]);
    });

    it('the answers of the group routes name nobody’s email, diary or cycle', async () => {
      const bodies = [
        JSON.stringify(
          (
            await api()
              .post('/groups')
              .set(as(ann))
              .send({ name: 'Two' })
              .expect(201)
          ).body,
        ),
        JSON.stringify(
          (await api().get(`/groups/${G}/invite`).set(as(ann)).expect(200))
            .body,
        ),
        JSON.stringify((await pull(bob)).groups),
      ];
      for (const text of bodies) {
        expect(text).not.toMatch(/SECRET|@example\.com/);
      }
    });

    it('nothing of the group is in the diary or the cycle parts of an answer', async () => {
      const res = await pull(bob, '?include=diary,cycle');
      const notGroup = JSON.stringify({
        entries: res.entries,
        tags: res.tags,
        moods: res.moods,
        cycle_days: res.cycle_days,
      });
      expect(notGroup).not.toContain(G);
      expect(notGroup).not.toContain('shared');
    });
  });

  describe('two devices of one member agree', () => {
    it('on tasks, marks, the group and the people, through changes on both sides and a leave', async () => {
      const annPhone = deviceOf(ann);
      const phone = deviceOf(bob);
      const tablet = deviceOf(bob);
      annPhone.edit(T1, { title: 'from Ann', group_id: G });
      await annPhone.sync();
      await phone.sync();
      await tablet.sync();

      phone.edit(T2, { title: 'phone task', group_id: G });
      tablet.edit(T3, { title: 'tablet personal' });
      phone.mark(T1, DAY, { completed: true });
      tablet.mark(T3, DAY, { completed: true });
      await phone.sync();
      await tablet.sync();
      await phone.sync();
      await annPhone.sync();

      const agree = () => {
        expect(tablet.snapshot()).toEqual(phone.snapshot());
        expect(tablet.groupSnapshot()).toEqual(phone.groupSnapshot());
        expect(tablet.otherMarksSnapshot()).toEqual(phone.otherMarksSnapshot());
      };
      agree();
      expect(phone.tasks.size).toBe(3);
      expect(annPhone.otherMarksSnapshot()).toEqual([
        [T1, bob.id, DAY, true, null],
      ]);

      annPhone.mark(T1, DAY, { completed: true });
      await annPhone.sync();
      await phone.sync();
      await tablet.sync();
      agree();
      expect(phone.otherMarksSnapshot()).toEqual([
        [T1, ann.id, DAY, true, null],
      ]);

      await leave(bob);
      await phone.sync();
      await tablet.sync();
      agree();
      expect([...phone.tasks.keys()]).toEqual([T3]);
    });

    it('a repeated sync with nothing new changes nothing', async () => {
      const annPhone = deviceOf(ann);
      const phone = deviceOf(bob);
      annPhone.edit(T1, { title: 'x', group_id: G });
      annPhone.mark(T1, DAY, { completed: true });
      await annPhone.sync();
      await phone.sync();
      const before = JSON.stringify([
        phone.snapshot(),
        phone.groupSnapshot(),
        phone.otherMarksSnapshot(),
      ]);
      await phone.sync();
      await annPhone.sync();
      await phone.sync();
      expect(
        JSON.stringify([
          phone.snapshot(),
          phone.groupSnapshot(),
          phone.otherMarksSnapshot(),
        ]),
      ).toBe(before);
    });
  });
});
