import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  HttpStatus,
  INestApplication,
  Post,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from './all-exceptions.filter';

@Controller('t')
class ThrowingController {
  @Get('custom')
  custom() {
    throw new HttpException(
      { code: 'bad_code', message: 'Wrong code' },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }

  @Get('forbidden')
  forbidden() {
    throw new ForbiddenException();
  }

  @Get('validation')
  validation() {
    throw new BadRequestException({
      statusCode: 400,
      message: ['email must be an email', 'password is too short'],
      error: 'Bad Request',
    });
  }

  @Get('boom')
  boom() {
    throw new Error('password=hunter2 leaked in a stack');
  }

  @Post('json')
  json(@Body() body: unknown) {
    return body;
  }
}

describe('AllExceptionsFilter', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ThrowingController],
      providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useLogger(false);
    await app.init();
  });

  afterAll(() => app.close());

  it('keeps a code chosen by the thrower, and the status', async () => {
    const res = await request(app.getHttpServer()).get('/t/custom').expect(422);
    expect(res.body).toEqual({ code: 'bad_code', message: 'Wrong code' });
  });

  it('gives a default code for a plain HTTP error', async () => {
    const res = await request(app.getHttpServer())
      .get('/t/forbidden')
      .expect(403);
    expect(res.body).toEqual({ code: 'forbidden', message: 'Forbidden' });
  });

  it('joins validation messages under validation_failed', async () => {
    const res = await request(app.getHttpServer())
      .get('/t/validation')
      .expect(400);
    expect(res.body).toEqual({
      code: 'validation_failed',
      message: 'email must be an email; password is too short',
    });
  });

  it('answers 404 for an unknown route in the same shape', async () => {
    const res = await request(app.getHttpServer()).get('/nope').expect(404);
    expect(Object.keys(res.body).sort()).toEqual(['code', 'message']);
    expect((res.body as { code: string }).code).toBe('not_found');
  });

  it('answers 400 bad_request for malformed JSON', async () => {
    const res = await request(app.getHttpServer())
      .post('/t/json')
      .set('Content-Type', 'application/json')
      .send('{"broken":')
      .expect(400);
    expect((res.body as { code: string }).code).toBe('bad_request');
  });

  it('answers 413 payload_too_large for a body over the size limit', async () => {
    const res = await request(app.getHttpServer())
      .post('/t/json')
      .send({ text: 'x'.repeat(200_000) })
      .expect(413);
    expect((res.body as { code: string }).code).toBe('payload_too_large');
  });

  it('hides the details of an unexpected error', async () => {
    const res = await request(app.getHttpServer()).get('/t/boom').expect(500);
    expect(res.body).toEqual({
      code: 'internal_error',
      message: 'Internal server error',
    });
  });
});
