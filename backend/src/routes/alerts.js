import { Router } from 'express';
import { z } from 'zod';
import { q } from '../db.js';
import { ROLES } from '../config.js';
import { authorize } from '../middleware/auth.js';
import { auditReq } from '../middleware/audit.js';
import { HttpError, wrap } from '../utils/http.js';
import { raiseAlert } from '../services/alertService.js';

const r = Router();
const READ = [ROLES.ADMIN, ROLES.VET, ROLES.OPERATOR, ROLES.SYSADMIN];
const CREATE = [ROLES.ADMIN, ROLES.VET, ROLES.OPERATOR];
const moduleFor = (role) => (role === ROLES.VET ? 'livestock' : role === ROLES.OPERATOR ? 'machinery' : null);

r.get('/', authorize(...READ), wrap(async (req, res) => {
  const where = [], vals = [];
  const mod = moduleFor(req.user.role);
  if (mod) { where.push('source_module = ?'); vals.push(mod); }
  for (const f of ['status', 'severity']) if (req.query[f]) { where.push(`a.${f} = ?`); vals.push(String(req.query[f])); }
  if (req.query.active === '1') where.push("a.status <> 'resolved'");
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  res.json(await q(`SELECT a.*, u.full_name AS acknowledged_by_name FROM alerts a LEFT JOIN users u ON u.user_id = a.acknowledged_by
                     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY FIELD(a.status,'escalated','open','acknowledged','resolved'), a.created_at DESC LIMIT ?`, [...vals, limit]));
}));

r.post('/', authorize(...CREATE), wrap(async (req, res) => {
  const b = z.object({
    module: z.enum(['livestock', 'machinery', 'structure']),
    entity_id: z.string().min(1).max(36),
    severity: z.enum(['info', 'warning', 'critical']),
    message: z.string().trim().min(1).max(2000),
  }).parse(req.body);
  const allowedModule = moduleFor(req.user.role);
  if (allowedModule && b.module !== allowedModule) throw new HttpError(403, 'This module is outside your area');

  const entities = {
    livestock: { table: 'livestock', id: 'animal_id', type: 'animal', active: " AND status <> 'deleted'" },
    machinery: { table: 'machinery', id: 'machine_id', type: 'machine', active: " AND status <> 'deleted'" },
    structure: { table: 'structures', id: 'structure_id', type: 'structure', active: '' },
  };
  const entity = entities[b.module];
  const [found] = await q(`SELECT ${entity.id} FROM ${entity.table} WHERE ${entity.id} = ?${entity.active}`, [b.entity_id]);
  if (!found) throw new HttpError(404, 'Entity not found');

  const alertId = await raiseAlert({
    type: 'manual', severity: b.severity, module: b.module, entityType: entity.type,
    entityId: b.entity_id, message: b.message, dedupe: false,
  });
  await auditReq(req, 'alert_created_manually', 'alert', { alert_id: alertId, module: b.module, entity_id: b.entity_id, severity: b.severity });
  res.status(201).json({ alert_id: alertId });
}));

async function load(req) {
  const [a] = await q('SELECT * FROM alerts WHERE alert_id = ?', [req.params.id]);
  if (!a) throw new HttpError(404, 'Alert not found');
  const mod = moduleFor(req.user.role);
  if (mod && a.source_module !== mod) throw new HttpError(403, 'This alert is outside your area');
  return a;
}

r.post('/:id/ack', authorize(ROLES.ADMIN, ROLES.VET, ROLES.OPERATOR), wrap(async (req, res) => {
  const a = await load(req);
  if (a.status === 'resolved') throw new HttpError(409, 'Alert is already resolved');
  await q("UPDATE alerts SET status = 'acknowledged', acknowledged_by = ?, acknowledged_at = NOW(3) WHERE alert_id = ? AND status IN ('open','escalated')", [req.user.sub, a.alert_id]);
  await auditReq(req, 'alert_acknowledged', 'alert', { alert_id: a.alert_id, type: a.alert_type });
  res.json({ ok: true });
}));

r.post('/:id/resolve', authorize(ROLES.ADMIN, ROLES.VET), wrap(async (req, res) => {
  const a = await load(req);
  await q("UPDATE alerts SET status = 'resolved', resolved_at = NOW(3), acknowledged_by = COALESCE(acknowledged_by, ?), acknowledged_at = COALESCE(acknowledged_at, NOW(3)) WHERE alert_id = ?", [req.user.sub, a.alert_id]);
  await auditReq(req, 'alert_resolved', 'alert', { alert_id: a.alert_id, type: a.alert_type });
  res.json({ ok: true });
}));

export default r;
