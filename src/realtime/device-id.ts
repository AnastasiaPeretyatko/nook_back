import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import { Request } from 'express';

// The phone names itself so the server does not "ring" the device that just wrote.
// Anything that does not fit counts as "no name": the phone then gets a harmless extra ring.
const DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const parseDeviceId = (value: unknown) =>
  typeof value === 'string' && DEVICE_ID.test(value) ? value : undefined;

// The `X-Device-Id` request header, or undefined.
export const DeviceId = createParamDecorator(
  (_data: unknown, context: ExecutionContext) =>
    parseDeviceId(
      context.switchToHttp().getRequest<Request>().headers['x-device-id'],
    ),
);
