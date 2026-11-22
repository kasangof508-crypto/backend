import { Router } from 'express';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { q } from '../db.js';
import { ROLES } from '../config.js';
import { authorize } from '../middleware/auth.js';
import { auditReq } from '../middleware/audit.js';
import { HttpError, wrap } from '../utils/http.js';
import { buildReport, REPORT_TYPES } from '../services/reportData.js';
import { writePdf, writeXlsx, reportPath } from '../services/reportFiles.js';

const r = Router();

r.get('/', authorize(ROLES.ADMIN, ROLES.VET, ROLES.SYSADMIN), wrap(async (req, res) => {
  const own = req.user.role === ROLES.VET ? 'WHERE r.generated_by = ?' : '';
  res.json(await q(`SELECT r.report_id, r.report_type, r.parameters, r.format, r.generated_at, u.full_name AS generated_by_name
                      FROM reports r JOIN users u ON u.user_id = r.generated_by ${own} ORDER BY r.generated_at DESC LIMIT 100`, own ? [req.user.sub] : []));
}));

/** Generates the report synchronously (well inside the 5-minute requirement for the pilot data volumes). */
r.post('/', authorize(ROLES.ADMIN, ROLES.VET, ROLES.SYSADMIN), wrap(async (req, res) => {
  const b = z.object({
    report_type: z.enum(REPORT_TYPES), format: z.enum(['pdf', 'xlsx']),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }).parse(req.body);
  if (req.user.role === ROLES.VET && b.report_type !== 'livestock') throw new HttpError(403, 'Veterinarians can generate livestock reports only');
  const from = new Date(`${b.from}T00:00:00.000Z`), to = new Date(`${b.to}T23:59:59.999Z`);
  if (to < from) throw new HttpError(400, 'End date is before start date');
  if (to - from > 366 * 864e5) throw new HttpError(400, 'Period cannot exceed one year');

  const started = Date.now();
  const report = await buildReport(b.report_type, from, to, req.user.role);
  const id = randomUUID();
  const file = reportPath(id, b.format);
  const meta = { from: b.from, to: b.to, by: req.user.name };
  if (b.format === 'pdf') await writePdf(report, meta, file); else await writeXlsx(report, meta, file);
  await q('INSERT INTO reports (report_id, report_type, parameters, format, file_path, generated_by) VALUES (?,?,?,?,?,?)',
    [id, b.report_type, JSON.stringify({ from: b.from, to: b.to }), b.format, file, req.user.sub]);
  await auditReq(req, 'report_generated', 'report', { report_id: id, type: b.report_type, ms: Date.now() - started });
  res.status(201).json({ report_id: id, seconds: Number(((Date.now() - started) / 1000).toFixed(2)) });
}));

r.get('/:id/download', authorize(ROLES.ADMIN, ROLES.VET, ROLES.SYSADMIN), wrap(async (req, res) => {
  const [rep] = await q('SELECT * FROM reports WHERE report_id = ?', [req.params.id]);
  if (!rep) throw new HttpError(404, 'Report not found');
  if (req.user.role === ROLES.VET && rep.generated_by !== req.user.sub) throw new HttpError(403, 'Not your report');
  if (!rep.file_path || !fs.existsSync(rep.file_path)) throw new HttpError(410, 'Report file is no longer available');
  await auditReq(req, 'report_exported', 'report', { report_id: rep.report_id });
  res.download(rep.file_path, `SAFM_${rep.report_type}_${rep.generated_at.toISOString().slice(0, 10)}.${rep.format}`);
}));

export default r;
