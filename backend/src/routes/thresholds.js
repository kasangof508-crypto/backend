import { Router } from 'express';
import { z } from 'zod';
import { q } from '../db.js';
import { ROLES } from '../config.js';
import { authorize, reauth } from '../middleware/auth.js';
import { auditReq } from '../middleware/audit.js';
import { HttpError, wrap } from '../utils/http.js';
import { invalidateThresholds } from '../services/rules.js';

const r = Router();
const body = z.object({
  module: z.enum(['livestock', 'machinery', 'structure']), scope: z.string().min(1).max(40).default('default'), metric: z.string().min(2).max(30),
  min_value: z.number().nullable().optional(), max_value: z.number().nullable().optional(), duration_minutes: z.number().int().min(0).default(0),
  severity: z.enum(['info', 'warning', 'critical']).default('warning'), enabled: z.boolean().default(true),
});

r.get('/', authorize(ROLES.ADMIN, ROLES.SYSADMIN), wrap(async (_req, res) => {
  const th = await q('SELECT * FROM thresholds ORDER BY module, scope, metric');
  const rec = await q('SELECT r.*, u.full_name FROM alert_recipients r JOIN users u ON u.user_id = r.user_id ORDER BY r.level');
  res.json(th.map((t) => ({ ...t, recipients: rec.filter((x) => x.threshold_id === t.threshold_id) })));
}));

r.post('/', authorize(ROLES.ADMIN), reauth, wrap(async (req, res) => {
  const b = body.parse(req.body);
  const out = await q('INSERT INTO thresholds (module, scope, metric, min_value, max_value, duration_minutes, severity, enabled, updated_by) VALUES (?,?,?,?,?,?,?,?,?)',
    [b.module, b.scope, b.metric, b.min_value ?? null, b.max_value ?? null, b.duration_minutes, b.severity, b.enabled, req.user.sub]);
  invalidateThresholds();
  await auditReq(req, 'threshold_created', 'threshold', { threshold_id: out.insertId, ...b });
  res.status(201).json({ threshold_id: out.insertId });
}));

r.put('/:id', authorize(ROLES.ADMIN), reauth, wrap(async (req, res) => {
  const b = body.pick({ min_value: true, max_value: true, duration_minutes: true, severity: true, enabled: true }).partial().parse(req.body);
  const [before] = await q('SELECT min_value, max_value, duration_minutes, severity, enabled FROM thresholds WHERE threshold_id = ?', [req.params.id]);
  if (!before) throw new HttpError(404, 'Threshold not found');
  const entries = Object.entries(b).filter(([, v]) => v !== undefined);
  if (!entries.length) throw new HttpError(400, 'Nothing to update');
  await q(`UPDATE thresholds SET ${entries.map(([k]) => `${k} = ?`).join(', ')}, updated_by = ? WHERE threshold_id = ?`, [...entries.map(([, v]) => v), req.user.sub, req.params.id]);
  invalidateThresholds();
  await auditReq(req, 'threshold_updated', 'threshold', { threshold_id: Number(req.params.id), before, after: b });
  res.json({ ok: true });
}));

r.post('/:id/recipients', authorize(ROLES.ADMIN), wrap(async (req, res) => {
  const b = z.object({ user_id: z.string().uuid(), level: z.number().int().min(1).max(2).default(1),
    channels: z.array(z.enum(['sms', 'push', 'email'])).min(1) }).parse(req.body);
  await q('INSERT INTO alert_recipients (threshold_id, user_id, level, channels) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE channels = VALUES(channels)', [req.params.id, b.user_id, b.level, b.channels.join(',')]);
  await auditReq(req, 'recipient_set', 'threshold', { threshold_id: Number(req.params.id), ...b });
  res.status(201).json({ ok: true });
}));

r.delete('/recipients/:ruleId', authorize(ROLES.ADMIN), wrap(async (req, res) => {
  await q('DELETE FROM alert_recipients WHERE rule_id = ?', [req.params.ruleId]);
  await auditReq(req, 'recipient_removed', 'threshold', { rule_id: Number(req.params.ruleId) });
  res.json({ ok: true });
}));

export default r;
