import { timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { AppError } from '@opsbridge/common';
import { ROLES } from './models.js';

export const hashPassword = (plain, cost) => bcrypt.hash(plain, cost);
export const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash);

export function signToken(user, config) {
  return jwt.sign({ roles: user.roles, email: user.email }, config.jwtSecret, {
    algorithm: 'HS256',
    subject: String(user.id),
    expiresIn: config.jwtTtlSeconds,
    issuer: 'opsbridge-api',
  });
}

const safeEqual = (a, b) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Resolves req.user from either a bearer JWT (local) or gateway-asserted headers (gateway). */
export function authenticate(config) {
  return (req, _res, next) => {
    if (config.authMode === 'gateway') {
      const key = req.headers['x-internal-key'];
      if (typeof key !== 'string' || !safeEqual(key, config.internalKey)) {
        return next(new AppError(401, 'UNAUTHENTICATED', 'Requests must arrive through the gateway'));
      }
      const id = req.headers['x-user-id'];
      if (!id) return next(new AppError(401, 'UNAUTHENTICATED', 'Missing identity'));
      req.user = { id: String(id), email: req.headers['x-user-email'], roles: String(req.headers['x-user-roles'] ?? '').split(',').filter(Boolean) };
      return next();
    }

    const header = req.headers.authorization ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) return next(new AppError(401, 'UNAUTHENTICATED', 'Missing bearer token'));
    try {
      const claims = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'], issuer: 'opsbridge-api' });
      req.user = { id: claims.sub, email: claims.email, roles: claims.roles ?? [] };
      next();
    } catch (err) {
      next(new AppError(401, 'UNAUTHENTICATED', err.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token'));
    }
  };
}

// viewer < engineer < admin: a higher role satisfies a lower requirement.
const rank = (roles) => Math.max(-1, ...roles.map((r) => ROLES.indexOf(r)));

export const requireRole = (minimum) => (req, _res, next) => {
  if (rank(req.user?.roles ?? []) >= ROLES.indexOf(minimum)) return next();
  next(new AppError(403, 'FORBIDDEN', `Requires role "${minimum}"`));
};
