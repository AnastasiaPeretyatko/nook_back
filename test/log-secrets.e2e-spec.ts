import {
  ConsoleLogger,
  Controller,
  Get,
  INestApplication,
  Query,
} from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createTestApp, truncateAll } from './support/db';
import { listenForSockets, quiet, Sockets } from './support/ws-client';

// Decoys stand in for secrets. If one shows up in the log, a real secret would have too.
const PASSWORD = 'DECOY-password-7Qx2mZ';
const GOOGLE = 'DECOY.google-id-token.Zk81aQ';
const FCM = 'DECOY-fcm-token-0123456789-abcdefghij';
const REFRESH = 'DECOY-refresh-token-0123456789-abcdefghijklmnop';
const BEARER = 'DECOY.bearer.Mm44xP';
const CODE = 'DECOY1';
const DECOYS = [PASSWORD, GOOGLE, FCM, REFRESH, BEARER, CODE];

// Routes that fail the way unknown bugs do, with a client value inside the failing query.
@Controller('leak')
class LeakController {
  constructor(private readonly ds: DataSource) {}

  @Get('plain')
  plain(): never {
    throw new Error('plain failure');
  }

  @Get('uuid')
  uuid(@Query('v') v: string) {
    return this.ds.query('select $1::uuid', [v]);
  }

  @Get('date')
  date(@Query('v') v: string) {
    return this.ds.query('select $1::date', [v]);
  }

  @Get('number')
  number(@Query('v') v: string) {
    return this.ds.query('select $1::int', [v]);
  }

  @Get('duplicate')
  async duplicate(@Query('v') v: string) {
    const insert = () =>
      this.ds.query(
        `insert into users (id, email) values (gen_random_uuid(), $1)`,
        [v],
      );
    await insert();
    await insert();
  }

  @Get('time')
  time(@Query('v') v: string) {
    return this.ds.query('select $1::timestamptz', [v]);
  }
}

describe('No secrets in the log (B8.3)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let sockets: Sockets;
  let written: string[];
  let access: string;
  let refresh: string;
  const api = () => request(app.getHttpServer());
  const logText = () => written.join('');

  beforeAll(async () => {
    app = await createTestApp([LeakController]);
    // The test app is silent; turn the real console logger back on and listen at the lowest
    // level, where anything the process prints must pass (Nest's logger, console, Node itself).
    app.useLogger(new ConsoleLogger());
    ds = app.get(DataSource);
    sockets = await listenForSockets(app);
  });

  beforeEach(async () => {
    await truncateAll(ds);
    const res = await api()
      .post('/auth/register')
      .send({ email: 'ann@example.com', password: PASSWORD })
      .expect(201);
    ({ accessToken: access, refreshToken: refresh } = res.body as {
      accessToken: string;
      refreshToken: string;
    });
    written = [];
    for (const stream of [process.stdout, process.stderr]) {
      jest.spyOn(stream, 'write').mockImplementation((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      });
    }
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await sockets.closeAll();
  });

  afterAll(() => app.close());

  const expectClean = () => {
    const text = logText();
    for (const secret of [...DECOYS, access, refresh]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toContain(process.env.JWT_SECRET!);
  };

  it('database errors that echo a client value (the log has the kind and code only)', async () => {
    const auth = { Authorization: `Bearer ${access}` };
    await api().get('/leak/plain').set(auth).expect(500);
    for (const path of ['uuid', 'date', 'number', 'time']) {
      await api()
        .get(`/leak/${path}`)
        .set(auth)
        .query({ v: PASSWORD })
        .expect(500);
    }
    await api().get('/leak/duplicate').set(auth).query({ v: CODE }).expect(500);

    expectClean();
    // The plain error is the control: proves the capture works and normal messages stay useful.
    expect(logText()).toContain('plain failure');
    expect(logText()).toContain('database error 22P02');
  });

  it('wrong, reused and made-up credentials', async () => {
    await api()
      .post('/auth/register')
      .send({ email: 'ann@example.com', password: PASSWORD })
      .expect(409);
    await api()
      .post('/auth/register')
      .send({ email: 'bob@example.com', password: PASSWORD.slice(0, 3) })
      .expect(400);
    await api()
      .post('/auth/login')
      .send({ email: 'ann@example.com', password: PASSWORD + 'x' })
      .expect(401);
    await api()
      .post('/auth/login')
      .send({ email: 'nobody@example.com', password: PASSWORD })
      .expect(401);
    await api()
      .post('/auth/refresh')
      .send({ refreshToken: REFRESH })
      .expect(401);
    await api()
      .post('/auth/refresh')
      .send({ refreshToken: refresh })
      .expect(200);
    await api()
      .post('/auth/refresh')
      .send({ refreshToken: refresh })
      .expect(401); // reuse
    await api().post('/auth/logout').send({ refreshToken: REFRESH });
    const google = await api().post('/auth/google').send({ idToken: GOOGLE });
    expect(google.status).toBeGreaterThanOrEqual(400);
    for (const bad of [BEARER, 'Bearer', `Bearer ${BEARER}.${BEARER}`]) {
      await api()
        .get('/me')
        .set('Authorization', bad.startsWith('Bearer') ? bad : `Bearer ${bad}`)
        .expect(401);
    }
    expectClean();
  });

  it('broken requests carrying secrets', async () => {
    const auth = { Authorization: `Bearer ${access}` };
    await api().put('/devices').set(auth).send({ token: FCM }).expect(204);
    await api()
      .put('/devices')
      .set(auth)
      .send({ token: 5, extra: FCM })
      .expect(400);
    await api().delete('/devices').set(auth).send({ token: FCM });
    await api().post('/groups/join').set(auth).send({ code: CODE }).expect(400);
    await api().post(`/groups/${PASSWORD}/leave`).set(auth).expect(404);
    await api()
      .post('/sync/push')
      .set(auth)
      .set('Content-Type', 'application/json')
      .send(
        `{"tasks":[{"id":"${PASSWORD}","title":"${FCM}","created_at":"${CODE}"}],"logs":[{"task_id":"${GOOGLE}","day":"${REFRESH}"}]}`,
      )
      .expect(200);
    await api()
      .post('/sync/push')
      .set(auth)
      .set('Content-Type', 'application/json')
      .send(`{"tasks":[ "${PASSWORD}`)
      .expect(400);
    await api()
      .get('/sync/pull')
      .set(auth)
      .query({ since: PASSWORD, limit: CODE })
      .expect(400);
    await api()
      .post('/groups')
      .set(auth)
      .send('x'.repeat(200_000) + PASSWORD)
      .expect(413);
    expectClean();
  });

  it('sockets with a bad, odd or good token in the address', async () => {
    const tries: [string, string][] = [
      [`?token=${BEARER}`, '/ws'],
      [`?token=${access}`, '/ws2'],
      ['?token=%E0%A4%A', '/ws'],
      [`?token=${access}&device=${PASSWORD}`, '/ws'],
      [`?token=${access}`, '/ws'],
    ];
    for (const [query, path] of tries) {
      const client = sockets.connect(query, path);
      client.socket.on('error', () => undefined);
      await Promise.race([client.closed, quiet(300)]);
    }
    expectClean();
  });
});
