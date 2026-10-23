import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { ValidationError, ValidationOptions } from 'class-validator';

// Gives a validation rule its API error code:
//   @IsEmail({}, withCode('invalid_email', 'Invalid email'))
// Rules without a code report `validation_failed`.
export function withCode(code: string, message: string): ValidationOptions {
  return { message, context: { code } };
}

function messagesOf(error: ValidationError): string[] {
  return [
    ...Object.values(error.constraints ?? {}),
    ...(error.children ?? []).flatMap(messagesOf),
  ];
}

function codeOf(error: ValidationError): string | undefined {
  for (const context of Object.values(error.contexts ?? {})) {
    const code = (context as { code?: unknown } | undefined)?.code;
    if (typeof code === 'string') return code;
  }
  for (const child of error.children ?? []) {
    const code = codeOf(child);
    if (code) return code;
  }
  return undefined;
}

export function createValidationPipe() {
  return new ValidationPipe({
    transform: true, // bodies become DTO instances, query numbers become numbers
    whitelist: true, // properties without a rule are dropped, not rejected
    stopAtFirstError: true, // one message per property
    exceptionFactory: (errors) =>
      new BadRequestException({
        // The first failing property decides the code (properties are checked in DTO order).
        code: errors.map(codeOf).find(Boolean) ?? 'validation_failed',
        message: errors.flatMap(messagesOf).join('; '),
      }),
  });
}
