import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { q } from '../db.js';
import { HttpError, wrap } from '../utils/http.js';

/** Verifies the Bearer token and attaches req.user = { sub, role, name }. */
export function authenticate(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(new HttpError(401, 'Authentication required'));
  try {
    req.user = jwt.verify(token, config.jwtSecret);
    next();
  } catch {
    next(new HttpError(401, 'Invalid or expired token'));
  }
}

/** RBAC: only the listed roles may call the endpoint. */
export const authorize = (...roles) => (req, _res, next) => {
  if (!req.user || !roles.includes(req.user.role)) return next(new HttpError(403, 'You do not have permission for this action'));
  next();
};

/** Critical changes require the user's password again (design spec section 7). */
export const reauth = wrap(async (req, _res, next) => {
  const pw = req.body?.password;
  if (!pw) throw new HttpError(401, 'Password re-entry required');
  const [u] = await q("SELECT password_hash FROM users WHERE user_id = ? AND status = 'active'", [req.user.sub]);
  if (!u || !(await bcrypt.compare(pw, u.password_hash))) throw new HttpError(403, 'Incorrect password');
  delete req.body.password;
  next();
});
