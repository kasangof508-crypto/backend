import { Router } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { q } from '../db.js';
import { ROLES } from '../config.js';
import { authorize } from '../middleware/auth.js';
import { auditReq } from '../middleware/audit.js';
import { HttpError, wrap } from '../utils/http.js';
import { pointInPolygon } from '../utils/geo.js';

const r = Router();
const dt = z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}/)).transform((s) => new Date(s));
const taskBody = z.object({
  title: z.string().min(2).max(120), description: z.string().max(2000).optional(), zone_id: z.number().int().nullable().optional(),
  assigned_to: z.string().uuid().nullable().optional(), priority: z.enum(['low', 'medium', 'high']).default('medium'), due_at: dt.nullable().optional(),
});

r.get('/', authorize(ROLES.ADMIN, ROLES.SYSADMIN, ROLES.WORKER), wrap(async (req, res) => {
  const where = [], vals = [];
  if (req.user.role === ROLES.WORKER) { where.push('t.assigned_to = ?'); vals.push(req.user.sub); }
  if (req.query.status) { where.push('t.status = ?'); vals.push(String(req.query.status)); }
  const rows = await q(
    `SELECT t.*, z.zone_name, u.full_name AS assignee FROM tasks t
       LEFT JOIN zones z ON z.zone_id = t.zone_id LEFT JOIN users u ON u.user_id = t.assigned_to
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY FIELD(t.status,'in_progress','assigned','completed','cancelled'), t.due_at IS NULL, t.due_at LIMIT 500`, vals);
  res.json(rows);
}));

r.post('/', authorize(ROLES.ADMIN), wrap(async (req, res) => {
  const b = taskBody.parse(req.body);
  const id = randomUUID();
  await q('INSERT INTO tasks (task_id, title, description, zone_id, assigned_to, assigned_by, priority, due_at) VALUES (?,?,?,?,?,?,?,?)',
    [id, b.title, b.description ?? null, b.zone_id ?? null, b.assigned_to ?? null, req.user.sub, b.priority, b.due_at ?? null]);
  await auditReq(req, 'task_created', 'task', { task_id: id, assigned_to: b.assigned_to });
  res.status(201).json({ task_id: id });
}));

/** Active tasks can be edited / reassigned until they are completed or cancelled. */
r.put('/:id', authorize(ROLES.ADMIN), wrap(async (req, res) => {
  const b = taskBody.partial().parse(req.body);
  const [t] = await q('SELECT status, assigned_to FROM tasks WHERE task_id = ?', [req.params.id]);
  if (!t) throw new HttpError(404, 'Task not found');
  if (!['assigned', 'in_progress'].includes(t.status)) throw new HttpError(409, `A task that is ${t.status} cannot be edited`);
  const entries = Object.entries(b).filter(([, v]) => v !== undefined);
  if (!entries.length) throw new HttpError(400, 'Nothing to update');
  await q(`UPDATE tasks SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE task_id = ?`, [...entries.map(([, v]) => v), req.params.id]);
  await auditReq(req, b.assigned_to && b.assigned_to !== t.assigned_to ? 'task_reassigned' : 'task_updated', 'task', { task_id: req.params.id, from: t.assigned_to, ...b });
  res.json({ ok: true });
}));

const TRANSITIONS = { assigned: ['in_progress', 'cancelled'], in_progress: ['completed', 'cancelled'] };

r.post('/:id/status', authorize(ROLES.WORKER, ROLES.ADMIN), wrap(async (req, res) => {
  const b = z.object({ status: z.enum(['in_progress', 'completed', 'cancelled']), lat: z.number().min(-90).max(90).optional(), lng: z.number().min(-180).max(180).optional() }).parse(req.body);
  const [t] = await q('SELECT t.*, z.boundary FROM tasks t LEFT JOIN zones z ON z.zone_id = t.zone_id WHERE t.task_id = ?', [req.params.id]);
  if (!t) throw new HttpError(404, 'Task not found');
  const isWorker = req.user.role === ROLES.WORKER;
  if (isWorker && t.assigned_to !== req.user.sub) throw new HttpError(403, 'This task is not assigned to you');
  if (isWorker && b.status === 'cancelled') throw new HttpError(403, 'Only an administrator can cancel a task');
  if (!(TRANSITIONS[t.status] ?? []).includes(b.status)) throw new HttpError(409, `Cannot change a ${t.status} task to ${b.status}`);

  // Geofence: a worker may only start a task from inside its zone
  if (isWorker && b.status === 'in_progress' && t.boundary) {
    const poly = typeof t.boundary === 'string' ? JSON.parse(t.boundary) : t.boundary;
    if (b.lat == null || b.lng == null) throw new HttpError(400, 'Location is required to start this task');
    if (!pointInPolygon(b.lat, b.lng, poly)) throw new HttpError(403, 'You are outside the task zone. Move into the zone to start.');
  }
  const col = b.status === 'in_progress' ? 'started_at' : b.status === 'completed' ? 'completed_at' : null;
  await q(`UPDATE tasks SET status = ?${col ? `, ${col} = NOW(3)` : ''} WHERE task_id = ?`, [b.status, req.params.id]);
  await auditReq(req, `task_${b.status}`, 'task', { task_id: req.params.id });
  res.json({ ok: true });
}));

export default r;
