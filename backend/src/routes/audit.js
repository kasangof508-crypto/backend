import { Router } from 'express';
import { q } from '../db.js';
import { ROLES } from '../config.js';
import { authorize } from '../middleware/auth.js';
import { auditReq } from '../middleware/audit.js';
import { wrap } from '../utils/http.js';

const r = Router();

/** System Administrator sees full entries; Farm Administrator gets the summary view (no IP / detail payloads). */
r.get('/', authorize(ROLES.SYSADMIN, ROLES.ADMIN), wrap(async (req, res) => {
  const full = req.user.role === ROLES.SYSADMIN;
  const where = [], vals = [];
  if (req.query.action) { where.push('a.action = ?'); vals.push(String(req.query.action)); }
  if (req.query.user_id) { where.push('a.user_id = ?'); vals.push(String(req.query.user_id)); }
  if (req.query.from) { where.push('a.created_at >= ?'); vals.push(new Date(String(req.query.from))); }
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const rows = await q(`SELECT a.audit_id, a.created_at, a.action, a.entity, u.full_name AS user_name ${full ? ', a.ip_address, a.details' : ''}
                          FROM audit_log a LEFT JOIN users u ON u.user_id = a.user_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                         ORDER BY a.audit_id DESC LIMIT ?`, [...vals, limit]);
  if (full) await auditReq(req, 'audit_log_viewed', 'audit_log');
  res.json(rows);
}));

r.get('/actions', authorize(ROLES.SYSADMIN, ROLES.ADMIN), wrap(async (_req, res) => {
  res.json((await q('SELECT DISTINCT action FROM audit_log ORDER BY action')).map((x) => x.action));
}));

export default r;
