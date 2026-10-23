import {
  Body,
  Controller,
  Get,
  INestApplication,
  Post,
  Query,
} from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Type } from 'class-transformer';
import {
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  MinLength,
  ValidateNested,
} from 'class-validator';
import request from 'supertest';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { createValidationPipe, withCode } from './validation.pipe';

class AddressDto {
  @IsString(withCode('bad_city', 'City must be a string'))
  city: string;
}

class SignUpDto {
  @IsEmail({}, withCode('invalid_email', 'Invalid email'))
  email: string;

  @MinLength(8, withCode('weak_password', 'Password is too short'))
  password: string;

  @IsOptional()
  @IsString()
  nickname?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => AddressDto)
  address?: AddressDto;
}

class PageDto {
  @Type(() => Number)
  @IsInt()
  limit: number;
}

@Controller('t')
class TestController {
  @Post('sign-up')
  signUp(@Body() body: SignUpDto) {
    return body;
  }

  @Get('page')
  page(@Query() query: PageDto) {
    return { limit: query.limit, type: typeof query.limit };
  }
}

const bodyOf = (res: request.Response) =>
  res.body as { code: string; message: string };

describe('validation pipe', () => {
  let app: INestApplication;
  const post = (body: object) =>
    request(app.getHttpServer()).post('/t/sign-up').send(body);
  const ok = { email: 'a@example.com', password: '12345678' };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [TestController],
      providers: [
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        { provide: APP_PIPE, useValue: createValidationPipe() },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useLogger(false);
    await app.init();
  });

  afterAll(() => app.close());

  it('accepts a valid body', async () => {
    await post(ok).expect(201, ok);
  });

  it('reports the code of the failed rule', async () => {
    const res = await post({ ...ok, email: 'nope' }).expect(400);
    expect(bodyOf(res)).toEqual({
      code: 'invalid_email',
      message: 'Invalid email',
    });
    const res2 = await post({ ...ok, password: 'short' }).expect(400);
    expect(bodyOf(res2)).toEqual({
      code: 'weak_password',
      message: 'Password is too short',
    });
  });

  it('treats a missing field like an invalid one', async () => {
    const res = await post({ password: '12345678' }).expect(400);
    expect(bodyOf(res).code).toBe('invalid_email');
  });

  it('uses the first property in DTO order when several fail', async () => {
    const res = await post({ email: 'nope', password: 'x' }).expect(400);
    expect(bodyOf(res).code).toBe('invalid_email');
    expect(bodyOf(res).message).toBe('Invalid email; Password is too short');
  });

  it('answers validation_failed when the broken rule has no code', async () => {
    const res = await post({ ...ok, nickname: 42 }).expect(400);
    expect(bodyOf(res).code).toBe('validation_failed');
    expect(bodyOf(res).message).toBe('nickname must be a string');
  });

  it('finds the code of a rule inside a nested object', async () => {
    const res = await post({ ...ok, address: { city: 5 } }).expect(400);
    expect(bodyOf(res).code).toBe('bad_city');
  });

  it('drops properties that have no rule instead of rejecting them', async () => {
    const res = await post({ ...ok, isAdmin: true }).expect(201);
    expect(bodyOf(res)).toEqual(ok);
  });

  it('turns query numbers into numbers', async () => {
    const res = await request(app.getHttpServer())
      .get('/t/page?limit=5')
      .expect(200);
    expect(bodyOf(res)).toEqual({ limit: 5, type: 'number' });
    await request(app.getHttpServer()).get('/t/page?limit=abc').expect(400);
  });

  it('survives a missing body', async () => {
    const res = await request(app.getHttpServer())
      .post('/t/sign-up')
      .expect(400);
    expect(bodyOf(res).code).toBe('invalid_email');
  });
});
