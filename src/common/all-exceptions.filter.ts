import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { isDbUnavailable } from './db-unavailable';
import { errorStack, errorText } from './error-text';

// Default code per status for errors that did not name one themselves.
const STATUS_CODES: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'payload_too_large',
  429: 'too_many_requests',
  503: 'service_unavailable',
};

function isClientError(
  error: unknown,
): error is { status: number; message: string } {
  const e = error as { status?: unknown; expose?: unknown } | null;
  return (
    typeof e?.status === 'number' &&
    e.status >= 400 &&
    e.status < 500 &&
    e.expose === true
  );
}

// A sleeping Neon needs a few seconds to wake; the app waits this long before trying again.
const RETRY_AFTER_SECONDS = '5';

// Every error leaves the server as `{ code, message }` (API contract, section 4 of the plan).
// Throw `new XException({ code: 'bad_code', message: '...' })` to choose the code.
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();

    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'internal_error';
    let message = 'Internal server error';
    let logged = false;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      const detail = (typeof body === 'object' ? body : { message: body }) as {
        code?: unknown;
        message?: unknown;
      };
      // ValidationPipe reports a list of messages.
      const list = Array.isArray(detail.message)
        ? (detail.message as string[])
        : null;
      message = list
        ? list.join('; ')
        : typeof detail.message === 'string'
          ? detail.message
          : exception.message;
      code =
        typeof detail.code === 'string'
          ? detail.code
          : list
            ? 'validation_failed'
            : (STATUS_CODES[status] ??
              (status >= 500 ? 'internal_error' : `http_${status}`));
    }

    // Errors from the body parser (a body over the limit) are plain objects with a status and
    // `expose: true`, not Nest exceptions; without this they would become a 500.
    else if (isClientError(exception)) {
      status = exception.status;
      code = STATUS_CODES[status] ?? `http_${status}`;
      message = exception.message;
    }

    // The database is down, asleep or overloaded: tell the app to come back soon, do not blame
    // our code. A write may or may not have gone through if the link broke at the last moment;
    // the app repeats it, and a repeated push is harmless (rows are keyed by id).
    else if (isDbUnavailable(exception)) {
      status = HttpStatus.SERVICE_UNAVAILABLE;
      code = 'db_unavailable';
      message = 'Database is unavailable';
      res.setHeader('Retry-After', RETRY_AFTER_SECONDS);
      // One line, no stack: during an outage every request fails the same way.
      this.logger.warn(`Database unavailable: ${errorText(exception)}`);
      logged = true;
    }

    // Unknown errors are logged with the stack and never shown to the client.
    if (status >= 500 && !logged) {
      this.logger.error(errorText(exception), errorStack(exception));
    }

    if (res.headersSent) return;
    res.status(status).json({ code, message });
  }
}
