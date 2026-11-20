import { Router } from 'express';
import { z } from 'zod';
import { q } from '../db.js';
import { ROLES } from '../config.js';
import { authorize } from '../middleware/auth.js';
import { auditReq } from '../middleware/audit.js';
import { HttpError, wrap } from '../utils/http.js';

export const attendanceRouter = Router();
export const locationsRouter = Router();

attendanceRouter.post('/sign-in', authorize(ROLES.WORKER), wrap(async (req, res) => {
  const b = z.object({ lat: z.number().min(-90).max(90).optional(), lng: z.number().min(-180).max(180).optional(), auth_method: z.enum(['fingerprint', 'face', 'password']).default('password') }).parse(req.body);
  const [open] = await q('SELECT attendance_id FROM attendance WHERE user_id = ? AND sign_out_at IS NULL', [req.user.sub]);
  if (open) throw new HttpError(409, 'You are already signed in');
  await q('INSERT INTO attendance (user_id, sign_in_at, sign_in_lat, sign_in_lng, auth_method) VALUES (?, NOW(3), ?, ?, ?)', [req.user.sub, b.lat ?? null, b.lng ?? null, b.auth_method]);
  await auditReq(req, 'sign_in', 'attendance', { method: b.auth_method });
  res.status(201).json({ ok: true });
}));

attendanceRouter.post('/sign-out', authorize(ROLES.WORKER), wrap(async (req, res) => {
  const out = await q('UPDATE attendance SET sign_out_at = NOW(3) WHERE user_id = ? AND sign_out_at IS NULL', [req.user.sub]);
  if (!out.affectedRows) throw new HttpError(409, 'You are not signed in');
  await auditReq(req, 'sign_out', 'attendance');
  res.json({ ok: true });
}));

attendanceRouter.get('/me', authorize(ROLES.WORKER), wrap(async (req, res) => {
  const [open] = await q('SELECT attendance_id, sign_in_at FROM attendance WHERE user_id = ? AND sign_out_at IS NULL', [req.user.sub]);
  res.json({ signed_in: !!open, since: open?.sign_in_at ?? null });
}));

attendanceRouter.get('/', authorize(ROLES.ADMIN, ROLES.SYSADMIN), wrap(async (req, res) => {
  const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 7 * 864e5);
  const rows = await q(
    `SELECT a.attendance_id, u.full_name, a.sign_in_at, a.sign_out_at, a.auth_method FROM attendance a JOIN users u ON u.user_id = a.user_id
      WHERE a.sign_in_at >= ? ORDER BY a.sign_in_at DESC LIMIT 500`, [from]);
  res.json(rows);
}));

/** Batched GPS fixes from the worker app (also used by the offline queue when connectivity returns). */
locationsRouter.post('/', authorize(ROLES.WORKER), wrap(async (req, res) => {
  const fixes = z.array(z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracy: z.number().optional(), recorded_at: z.string().optional() })).min(1).max(100).parse(req.body.fixes ?? req.body);
  const vals = fixes.map((f) => [req.user.sub, f.recorded_at ? new Date(f.recorded_at) : new Date(), f.lat, f.lng, f.accuracy ?? null]);
  await q('INSERT IGNORE INTO worker_locations (user_id, recorded_at, latitude, longitude, accuracy_m) VALUES ?', [vals]);
  res.status(201).json({ stored: vals.length });
}));

locationsRouter.get('/latest', authorize(ROLES.ADMIN, ROLES.SYSADMIN), wrap(async (_req, res) => {
  res.json(await q(
    `SELECT u.user_id, u.full_name, l.latitude, l.longitude, l.recorded_at
       FROM attendance a JOIN users u ON u.user_id = a.user_id
       JOIN worker_locations l ON l.user_id = a.user_id AND l.recorded_at = (SELECT MAX(recorded_at) FROM worker_locations WHERE user_id = a.user_id)
      WHERE a.sign_out_at IS NULL`));
}));
