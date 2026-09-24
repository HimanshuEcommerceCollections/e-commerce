import type { User } from '@prisma/client';
import type { RequestHandler } from 'express';
import type { UserRole } from '../common/enums';
import { AccessDeniedError, AuthenticationRequiredError } from '../common/errors';
import type { Db } from '../db';
import type { JwtService } from './jwt';

declare module 'express-serve-static-core' {
  interface Request {
    /** The authenticated user, set by `authenticate` when a valid bearer token is sent. */
    user?: User;
  }
}

/**
 * Reads the Bearer token on every request and, when valid, attaches the user.
 * Never rejects: a missing or bad token leaves the request anonymous, and the
 * route guards below decide. The user (and so the role) is re-read from the
 * database each time, as the Java filter did.
 */
export function authenticate(jwt: JwtService, db: Db): RequestHandler {
  return async (req, _res, next) => {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      const email = jwt.verify(header.slice('Bearer '.length));
      if (email) {
        const user = await db.user.findUnique({ where: { email } });
        if (user) req.user = user;
      }
    }
    next();
  };
}

/**
 * 401 for anonymous callers. Used on routers outside the public paths — the
 * Java security chain rejected those before any role check ran.
 */
export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.user) throw new AuthenticationRequiredError();
  next();
};

/**
 * 403 unless the caller has one of the roles (`@PreAuthorize("hasRole(...)")`).
 * On public paths (/api/products, /api/categories) an anonymous caller also
 * gets 403, exactly as Spring's method security answered there.
 */
export function requireRole(...roles: UserRole[]): RequestHandler {
  return (req, _res, next) => {
    assertRole(req, ...roles);
    next();
  };
}

/**
 * The same check, for use inside a handler after the body is parsed: Spring
 * validated @Valid bodies before @PreAuthorize ran, so an invalid body is a 400
 * even for a caller without the role.
 */
export function assertRole(req: { user?: User }, ...roles: UserRole[]): User {
  if (!req.user || !roles.includes(req.user.role as UserRole)) throw new AccessDeniedError();
  return req.user;
}

/** The authenticated user; only call behind requireAuth/requireRole. */
export function currentUser(req: { user?: User }): User {
  if (!req.user) throw new AuthenticationRequiredError();
  return req.user;
}
