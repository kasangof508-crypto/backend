import { Router } from 'express';
import { z } from 'zod';
import { q } from '../db.js';
import { ROLES } from '../config.js';
import { authorize } from '../middleware/auth.js';
import { auditReq } from '../middleware/audit.js';
import { HttpError, wrap } from '../utils/http.js';

const r = Router();
const boundary = z.array(z.tuple([z.number().min(-90).max(90), z.number().min(-180).max(180)])).min(3);
const body = z.object({ zone_name: z.string().min(2).max(60), zone_type: z.enum(['field', 'greenhouse', 'pen', 'yard', 'storage']), boundary });

r.get('/', wrap(async (_req, res) => {
  const rows = await q('SELECT zone_id, zone_name, zone_type, boundary FROM zones ORDER BY zone_name');
  res.json(rows.map((z) => ({ ...z, boundary: typeof z.boundary === 'string' ? JSON.parse(z.boundary) : z.boundary })));
}));

r.post('/', authorize(ROLES.ADMIN), wrap(async (req, res) => {
  const b = body.parse(req.body);
  const out = await q('INSERT INTO zones (zone_name, zone_type, boundary, created_by) VALUES (?,?,?,?)', [b.zone_name, b.zone_type, JSON.stringify(b.boundary), req.user.sub]);
  await auditReq(req, 'zone_created', 'zone', { zone_id: out.insertId, zone_name: b.zone_name });
  res.status(201).json({ zone_id: out.insertId });
}));

r.put('/:id', authorize(ROLES.ADMIN), wrap(async (req, res) => {
  const b = body.parse(req.body);
  const out = await q('UPDATE zones SET zone_name = ?, zone_type = ?, boundary = ? WHERE zone_id = ?', [b.zone_name, b.zone_type, JSON.stringify(b.boundary), req.params.id]);
  if (!out.affectedRows) throw new HttpError(404, 'Zone not found');
  await auditReq(req, 'zone_updated', 'zone', { zone_id: Number(req.params.id) });
  res.json({ ok: true });
}));

export default r;
