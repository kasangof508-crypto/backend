import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { q } from '../db.js';
import { ROLES } from '../config.js';
import { authorize } from '../middleware/auth.js';
import { auditReq } from '../middleware/audit.js';
import { HttpError, wrap } from '../utils/http.js';

const r = Router();
const password = z.string().min(8).regex(/[A-Z]/, 'needs an uppercase letter').regex(/[a-z]/, 'needs a lowercase letter').regex(/\d/, 'needs a number');
const phone = z.string().regex(/^\+?\d{9,15}$/, 'use international format e.g. +2547XXXXXXXX');
const SAFE = 'u.user_id, u.full_name, u.email, u.phone, u.role_id, r.role_name, u.preferred_language, u.status, u.mfa_enabled, u.created_at, u.last_login_at';

r.get('/roles', authorize(ROLES.SYSADMIN, ROLES.ADMIN), wrap(async (_req, res) => res.json(await q('SELECT role_id, role_name, description FROM roles'))));

r.get('/', authorize(ROLES.SYSADMIN, ROLES.ADMIN), wrap(async (req, res) => {
  const rows = await q(`SELECT ${SAFE} FROM users u JOIN roles r ON r.role_id = u.role_id WHERE u.status <> 'deleted' ORDER BY u.full_name`);
  res.json(rows);
}));

r.post('/', authorize(ROLES.SYSADMIN), wrap(async (req, res) => {
  const b = z.object({ full_name: z.string().min(2).max(100), email: z.string().email().max(120), phone, password,
    role_id: z.number().int().positive(), preferred_language: z.enum(['en', 'sw']).default('en') }).parse(req.body);
  const id = randomUUID();
  await q('INSERT INTO users (user_id, full_name, email, phone, password_hash, role_id, preferred_language, consent_at) VALUES (?,?,?,?,?,?,?,NOW(3))',
    [id, b.full_name, b.email.toLowerCase(), b.phone, await bcrypt.hash(b.password, 12), b.role_id, b.preferred_language]);
  await auditReq(req, 'user_created', 'user', { user_id: id, email: b.email, role_id: b.role_id });
  res.status(201).json({ user_id: id });
}));

r.put('/:id', authorize(ROLES.SYSADMIN), wrap(async (req, res) => {
  const b = z.object({ full_name: z.string().min(2).max(100), phone, role_id: z.number().int().positive(),
    preferred_language: z.enum(['en', 'sw']), status: z.enum(['active', 'suspended']), password: password.optional() }).partial().parse(req.body);
  const [before] = await q("SELECT full_name, phone, role_id, status FROM users WHERE user_id = ? AND status <> 'deleted'", [req.params.id]);
  if (!before) throw new HttpError(404, 'User not found');
  if (req.params.id === req.user.sub && b.status === 'suspended') throw new HttpError(400, 'You cannot suspend your own account');
  const sets = [], vals = [];
  for (const [k, v] of Object.entries(b)) {
    if (k === 'password') { sets.push('password_hash = ?'); vals.push(await bcrypt.hash(v, 12)); } else { sets.push(`${k} = ?`); vals.push(v); }
  }
  if (!sets.length) throw new HttpError(400, 'Nothing to update');
  await q(`UPDATE users SET ${sets.join(', ')}, failed_attempts = 0, locked_until = NULL WHERE user_id = ?`, [...vals, req.params.id]);
  const { password: _pw, ...after } = b;
  await auditReq(req, 'user_updated', 'user', { user_id: req.params.id, before, after, password_changed: !!b.password });
  res.json({ ok: true });
}));

/** Soft delete: personal fields are anonymised, operational records (tasks, health records, ...) are preserved. */
r.delete('/:id', authorize(ROLES.SYSADMIN), wrap(async (req, res) => {
  if (req.params.id === req.user.sub) throw new HttpError(400, 'You cannot delete your own account');
  const res1 = await q(`UPDATE users SET status = 'deleted', email = CONCAT('deleted+', user_id, '@removed.local'), phone = '', full_name = 'Deleted user'
                         WHERE user_id = ? AND status <> 'deleted'`, [req.params.id]);
  if (!res1.affectedRows) throw new HttpError(404, 'User not found');
  await q('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?', [req.params.id]);
  await auditReq(req, 'user_deleted', 'user', { user_id: req.params.id });
  res.json({ ok: true });
}));

export default r;
