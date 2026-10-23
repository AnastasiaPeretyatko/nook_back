import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';

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

    // Unknown errors are logged with the stack and never shown to the client.
    if (status >= 500) {
      this.logger.error(
        exception instanceof Error ? exception.message : String(exception),
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    if (res.headersSent) return;
    res.status(status).json({ code, message });
  }
}
