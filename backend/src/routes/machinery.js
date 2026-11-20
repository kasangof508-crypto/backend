import { Router } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { q } from '../db.js';
import { ROLES } from '../config.js';
import { authorize } from '../middleware/auth.js';
import { auditReq } from '../middleware/audit.js';
import { HttpError, wrap } from '../utils/http.js';
import { fuelSummary } from '../services/analytics.js';
import { evaluateMachinery } from '../services/rules.js';

const r = Router();
const READ = [ROLES.ADMIN, ROLES.OPERATOR, ROLES.SYSADMIN];
const machine = z.object({
  name: z.string().min(2).max(60), machine_type: z.string().max(30).default('tractor'), registration_no: z.string().max(20).optional(),
  make_model: z.string().max(60).optional(), tracker_device_id: z.string().uuid().nullable().optional(),
  service_interval_hrs: z.number().int().min(10).max(5000).default(250), total_engine_hrs: z.number().min(0).optional(), hrs_at_last_service: z.number().min(0).optional(),
});

r.get('/', authorize(...READ), wrap(async (_req, res) => {
  res.json(await q(
    `SELECT m.machine_id, m.name, m.machine_type, m.registration_no, m.make_model, m.service_interval_hrs, m.total_engine_hrs, m.hrs_at_last_service, m.status,
            (m.total_engine_hrs - m.hrs_at_last_service) AS hours_since_service,
            t.latitude, t.longitude, t.speed_kmh, t.ignition_on, t.fuel_level_pct, t.fault_codes, t.recorded_at AS last_reading_at
       FROM machinery m LEFT JOIN machinery_telemetry t ON t.machine_id = m.machine_id AND t.recorded_at = (SELECT MAX(recorded_at) FROM machinery_telemetry WHERE machine_id = m.machine_id)
      WHERE m.status <> 'deleted' ORDER BY m.name`));
}));

r.post('/', authorize(ROLES.ADMIN), wrap(async (req, res) => {
  const b = machine.parse(req.body);
  const id = randomUUID();
  await q('INSERT INTO machinery (machine_id, name, machine_type, registration_no, make_model, tracker_device_id, service_interval_hrs, total_engine_hrs, hrs_at_last_service) VALUES (?,?,?,?,?,?,?,?,?)',
    [id, b.name, b.machine_type, b.registration_no ?? null, b.make_model ?? null, b.tracker_device_id ?? null, b.service_interval_hrs, b.total_engine_hrs ?? 0, b.hrs_at_last_service ?? 0]);
  await auditReq(req, 'machine_created', 'machinery', { machine_id: id, name: b.name });
  res.status(201).json({ machine_id: id });
}));

r.put('/:id', authorize(ROLES.ADMIN), wrap(async (req, res) => {
  const b = machine.partial().extend({
    registration_no: z.string().max(20).nullable().optional(),
    make_model: z.string().max(60).nullable().optional(),
    status: z.enum(['active', 'in_service', 'retired', 'deleted']).optional(),
  }).parse(req.body);
  const entries = Object.entries(b).filter(([, v]) => v !== undefined);
  if (!entries.length) throw new HttpError(400, 'Nothing to update');
  const out = await q(`UPDATE machinery SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE machine_id = ?`, [...entries.map(([, v]) => v), req.params.id]);
  if (!out.affectedRows) throw new HttpError(404, 'Machine not found');
  await auditReq(req, 'machine_updated', 'machinery', { machine_id: req.params.id, ...b });
  res.json({ ok: true });
}));

r.get('/maintenance', authorize(...READ), wrap(async (req, res) => {
  const showCost = req.user.role !== ROLES.OPERATOR;   // cost data is restricted (RBAC matrix)
  const rows = await q(
    `SELECT mr.maintenance_id, mr.machine_id, m.name AS machine, mr.scheduled_for, mr.completed_at, mr.service_type, mr.engine_hrs_at_service, mr.cost_kes, mr.notes, u.full_name AS mechanic
       FROM maintenance_records mr JOIN machinery m ON m.machine_id = mr.machine_id LEFT JOIN users u ON u.user_id = mr.mechanic_id
      ORDER BY mr.completed_at IS NOT NULL, mr.scheduled_for DESC LIMIT 200`);
  res.json(showCost ? rows : rows.map(({ cost_kes, ...rest }) => rest));
}));

r.post('/maintenance', authorize(ROLES.ADMIN), wrap(async (req, res) => {
  const b = z.object({ machine_id: z.string().uuid(), scheduled_for: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), mechanic_id: z.string().uuid().nullable().optional(),
    service_type: z.string().max(30).default('Routine service'), alert_id: z.string().uuid().optional(), notes: z.string().max(1000).optional() }).parse(req.body);
  const id = randomUUID();
  await q('INSERT INTO maintenance_records (maintenance_id, machine_id, alert_id, scheduled_for, mechanic_id, service_type, notes) VALUES (?,?,?,?,?,?,?)',
    [id, b.machine_id, b.alert_id ?? null, b.scheduled_for, b.mechanic_id ?? null, b.service_type, b.notes ?? null]);
  if (b.alert_id) await q("UPDATE alerts SET status = 'acknowledged', acknowledged_by = ?, acknowledged_at = NOW(3) WHERE alert_id = ? AND status IN ('open','escalated')", [req.user.sub, b.alert_id]);
  await auditReq(req, 'maintenance_scheduled', 'maintenance', { maintenance_id: id, machine_id: b.machine_id });
  res.status(201).json({ maintenance_id: id });
}));

/** Completing a service resets the runtime counter and closes related service_due alerts. */
r.post('/maintenance/:id/complete', authorize(ROLES.ADMIN), wrap(async (req, res) => {
  const b = z.object({ engine_hrs_at_service: z.number().min(0), cost_kes: z.number().min(0).optional(), notes: z.string().max(1000).optional() }).parse(req.body);
  const [m] = await q('SELECT machine_id, completed_at FROM maintenance_records WHERE maintenance_id = ?', [req.params.id]);
  if (!m) throw new HttpError(404, 'Maintenance record not found');
  if (m.completed_at) throw new HttpError(409, 'Already completed');
  await q('UPDATE maintenance_records SET completed_at = NOW(3), engine_hrs_at_service = ?, cost_kes = ?, notes = COALESCE(?, notes) WHERE maintenance_id = ?', [b.engine_hrs_at_service, b.cost_kes ?? null, b.notes ?? null, req.params.id]);
  await q("UPDATE machinery SET hrs_at_last_service = ?, total_engine_hrs = GREATEST(total_engine_hrs, ?), status = 'active' WHERE machine_id = ?", [b.engine_hrs_at_service, b.engine_hrs_at_service, m.machine_id]);
  await q("UPDATE alerts SET status = 'resolved', resolved_at = NOW(3) WHERE entity_id = ? AND alert_type = 'service_due' AND status <> 'resolved'", [m.machine_id]);
  await auditReq(req, 'maintenance_completed', 'maintenance', { maintenance_id: req.params.id, ...b });
  res.json({ ok: true });
}));

r.get('/:id/telemetry', authorize(...READ), wrap(async (req, res) => {
  const hours = Math.min(Number(req.query.hours) || 24, 24 * 14);
  res.json(await q(
    `SELECT recorded_at, latitude, longitude, speed_kmh, ignition_on, engine_hours, fuel_level_pct FROM machinery_telemetry
      WHERE machine_id = ? AND recorded_at > NOW(3) - INTERVAL ? HOUR ORDER BY recorded_at LIMIT 4100`, [req.params.id, hours]));
}));

r.post('/:id/telemetry', authorize(...READ), wrap(async (req, res) => {
  const reading = z.object({
    latitude: z.number().min(-90).max(90).nullable().optional(),
    longitude: z.number().min(-180).max(180).nullable().optional(),
    speed_kmh: z.number().min(0).max(1000).nullable().optional(),
    ignition_on: z.boolean().nullable().optional(),
    engine_hours: z.number().min(0).max(9999999.9).nullable().optional(),
    fuel_level_pct: z.number().min(0).max(100).nullable().optional(),
    fault_codes: z.string().max(2000).nullable().optional(),
  }).refine((body) => Object.values(body).some((value) => value !== undefined && value !== null), {
    message: 'Provide at least one telemetry value',
  }).parse(req.body);
  const [machineRow] = await q("SELECT machine_id FROM machinery WHERE machine_id = ? AND status <> 'deleted'", [req.params.id]);
  if (!machineRow) throw new HttpError(404, 'Machine not found');

  await q(`INSERT INTO machinery_telemetry
    (machine_id, recorded_at, latitude, longitude, speed_kmh, ignition_on, engine_hours, fuel_level_pct, fault_codes)
    VALUES (?, NOW(3), ?, ?, ?, ?, ?, ?, ?)`,
  [machineRow.machine_id, reading.latitude ?? null, reading.longitude ?? null, reading.speed_kmh ?? null,
    reading.ignition_on ?? null, reading.engine_hours ?? null, reading.fuel_level_pct ?? null, reading.fault_codes ?? null]);
  if (reading.engine_hours != null) {
    await q('UPDATE machinery SET total_engine_hrs = GREATEST(total_engine_hrs, ?) WHERE machine_id = ?', [reading.engine_hours, machineRow.machine_id]);
  }
  await auditReq(req, 'machinery_telemetry_received', 'machinery', { machine_id: machineRow.machine_id });
  await evaluateMachinery(machineRow.machine_id, {
    fuel_pct: reading.fuel_level_pct,
    fault_codes: reading.fault_codes,
  });
  res.status(201).json({ accepted: true });
}));

r.get('/:id/fuel-efficiency', authorize(...READ), wrap(async (req, res) => {
  const days = Math.min(Number(req.query.days) || 7, 90);
  res.json(await fuelSummary(req.params.id, new Date(Date.now() - days * 864e5), new Date()));
}));

r.get('/:id/fuel-logs', authorize(...READ), wrap(async (req, res) => {
  res.json(await q('SELECT f.*, u.full_name AS logged_by_name FROM fuel_logs f JOIN users u ON u.user_id = f.logged_by WHERE f.machine_id = ? ORDER BY f.logged_at DESC LIMIT 50', [req.params.id]));
}));

r.post('/:id/fuel-logs', authorize(ROLES.OPERATOR, ROLES.ADMIN), wrap(async (req, res) => {
  const b = z.object({ litres: z.number().positive().max(2000), engine_hours: z.number().min(0).optional(), notes: z.string().max(200).optional() }).parse(req.body);
  await q('INSERT INTO fuel_logs (machine_id, logged_by, litres, engine_hours, notes) VALUES (?,?,?,?,?)', [req.params.id, req.user.sub, b.litres, b.engine_hours ?? null, b.notes ?? null]);
  await auditReq(req, 'fuel_logged', 'machinery', { machine_id: req.params.id, litres: b.litres });
  res.status(201).json({ ok: true });
}));

export default r;
