import { Global, Module } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureWebSocket } from '../src/app.setup';
import { DatabaseModule } from '../src/database/database.module';

// Real AppModule (config, filter, health) with only the database connection faked,
// so this checks the wiring that the per-class tests cannot see.
const query = jest.fn();

@Global()
@Module({
  providers: [
    {
      provide: DataSource,
      // Just enough for TypeOrmModule.forFeature (repositories) and the health check.
      useValue: {
        query,
        options: { type: 'postgres' },
        entityMetadatas: [],
        getRepository: () => ({}),
      },
    },
  ],
  exports: [DataSource],
})
class FakeDatabaseModule {}

describe('App (wiring)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL = 'postgresql://u:p@localhost/db';
    delete process.env.SELF_PING_URL;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideModule(DatabaseModule)
      .useModule(FakeDatabaseModule)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureWebSocket(app);
    app.useLogger(false);
    await app.init();
  });

  beforeEach(() => query.mockReset());

  afterAll(() => app.close());

  it('GET /health answers ok and never queries the database', async () => {
    await request(app.getHttpServer()).get('/health').expect(200, { ok: true });
    expect(query).not.toHaveBeenCalled();
  });

  it('GET /health/db answers 503 db_unavailable when the database is down', async () => {
    query.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const res = await request(app.getHttpServer())
      .get('/health/db')
      .expect(503);
    expect(res.body).toEqual({
      code: 'db_unavailable',
      message: 'Database is unavailable',
    });
  });

  it('the global filter is wired: an unknown route gets { code, message }', async () => {
    const res = await request(app.getHttpServer()).get('/nope').expect(404);
    expect(Object.keys(res.body as object).sort()).toEqual(['code', 'message']);
  });
});
