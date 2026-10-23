import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  let app: INestApplication;
  const query = jest.fn();

  beforeEach(async () => {
    query.mockReset();
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: DataSource, useValue: { query } }],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useLogger(false);
    await app.init();
  });

  afterEach(() => app.close());

  it('GET /health answers without touching the database', async () => {
    await request(app.getHttpServer()).get('/health').expect(200, { ok: true });
    expect(query).not.toHaveBeenCalled();
  });

  it('GET /health/db runs a query and answers ok', async () => {
    query.mockResolvedValue([{ '?column?': 1 }]);
    await request(app.getHttpServer())
      .get('/health/db')
      .expect(200, { ok: true });
    expect(query).toHaveBeenCalledWith('select 1');
  });

  it('GET /health/db answers 503 db_unavailable when the query fails', async () => {
    query.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const res = await request(app.getHttpServer())
      .get('/health/db')
      .expect(503);
    expect(res.body).toMatchObject({ code: 'db_unavailable' });
    expect(JSON.stringify(res.body)).not.toContain('ECONNREFUSED');
  });
});
