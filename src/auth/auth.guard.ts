import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { IS_PUBLIC_KEY } from './public.decorator';
import { TokenService } from './token.service';

export type AuthedRequest = Request & { userId?: string };

// "Bearer <token>", the scheme in any letter case, exactly one token.
const BEARER = /^Bearer (\S+)$/i;

// Closed by default: a route is open only when it (or its controller) says @Public().
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(
      IS_PUBLIC_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const token = BEARER.exec(request.headers.authorization ?? '')?.[1];
    // One answer for missing, malformed, forged and expired: the app reacts the same way
    // to all of them (refresh the token, or ask to sign in).
    const userId = token ? await this.tokens.verifyAccessToken(token) : null;
    if (!userId) {
      throw new UnauthorizedException({
        code: 'unauthorized',
        message: 'Missing or invalid access token',
      });
    }
    request.userId = userId;
    return true;
  }
}

// The signed-in user's id. It comes only from the verified token, never from the request body.
export const CurrentUserId = createParamDecorator(
  (_data: unknown, context: ExecutionContext) =>
    context.switchToHttp().getRequest<AuthedRequest>().userId,
);
