import { Router } from 'express';
import { z } from 'zod';
import { q } from '../db.js';
import { ROLES } from '../config.js';
import { authorize, reauth } from '../middleware/auth.js';
import { auditReq } from '../middleware/audit.js';
import { HttpError, wrap } from '../utils/http.js';
import { evaluateStructure } from '../services/rules.js';

const r = Router();
const ALLOWED = [ROLES.ADMIN, ROLES.SYSADMIN];
const VALID = { fan: ['on', 'off'], cooler: ['on', 'off'], alarm: ['on', 'off'], vent: ['open', 'closed'] };

r.get('/', authorize(...ALLOWED), wrap(async (_req, res) => {
  const structures = await q(
    `SELECT s.structure_id, s.structure_name, s.structure_type, s.manual_override, s.emergency_stop, d.serial_no, d.last_seen_at, d.status AS device_status,
            c.temperature_c, c.humidity_pct, c.gas_type, c.gas_ppm, c.recorded_at AS last_reading_at,
            (SELECT COUNT(*) FROM alerts a
              WHERE a.entity_id = CAST(s.structure_id AS CHAR) COLLATE utf8mb4_0900_ai_ci
                AND a.source_module = 'structure' AND a.status <> 'resolved') AS open_alerts
       FROM structures s LEFT JOIN iot_devices d ON d.device_id = s.sensor_device_id
       LEFT JOIN climate_readings c ON c.structure_id = s.structure_id AND c.recorded_at = (SELECT MAX(recorded_at) FROM climate_readings WHERE structure_id = s.structure_id)
      ORDER BY s.structure_name`);
  const actuators = await q('SELECT actuator_id, structure_id, actuator_type, state, mode, last_changed_at FROM actuators ORDER BY actuator_type');
  res.json(structures.map((s) => ({ ...s, actuators: actuators.filter((a) => a.structure_id === s.structure_id) })));
}));

r.get('/:id/readings', authorize(...ALLOWED), wrap(async (req, res) => {
  const hours = Math.min(Number(req.query.hours) || 24, 24 * 30);
  res.json(await q(
    `SELECT recorded_at, temperature_c, humidity_pct, gas_ppm FROM climate_readings
      WHERE structure_id = ? AND recorded_at > NOW(3) - INTERVAL ? HOUR ORDER BY recorded_at LIMIT 10100`, [req.params.id, hours]));
}));

r.post('/:id/readings', authorize(...ALLOWED), wrap(async (req, res) => {
  const reading = z.object({
    temperature_c: z.number().min(-50).max(100),
    humidity_pct: z.number().min(0).max(100),
    gas_type: z.string().max(10).nullable().optional(),
    gas_ppm: z.number().min(0).max(9999999.9).nullable().optional(),
  }).parse(req.body);
  const [structure] = await q('SELECT structure_id, structure_name, structure_type, manual_override, emergency_stop FROM structures WHERE structure_id = ?', [req.params.id]);
  if (!structure) throw new HttpError(404, 'Structure not found');

  await q(`INSERT INTO climate_readings (structure_id, recorded_at, temperature_c, humidity_pct, gas_type, gas_ppm)
    VALUES (?, NOW(3), ?, ?, ?, ?)`,
  [structure.structure_id, reading.temperature_c, reading.humidity_pct, reading.gas_type ?? null, reading.gas_ppm ?? null]);
  await auditReq(req, 'structure_reading_received', `structure:${structure.structure_id}`);
  await evaluateStructure(structure, reading);
  res.status(201).json({ accepted: true });
}));

/** Manual actuator command (fan, cooler, vent, alarm). Requires password re-entry; the actuator switches to manual mode. */
r.post('/actuators/:id/command', authorize(...ALLOWED), reauth, wrap(async (req, res) => {
  const b = z.object({ state: z.enum(['on', 'off', 'open', 'closed']) }).parse(req.body);
  const [a] = await q('SELECT a.*, s.emergency_stop FROM actuators a JOIN structures s ON s.structure_id = a.structure_id WHERE a.actuator_id = ?', [req.params.id]);
  if (!a) throw new HttpError(404, 'Actuator not found');
  if (!VALID[a.actuator_type].includes(b.state)) throw new HttpError(400, `${a.actuator_type} accepts: ${VALID[a.actuator_type].join(', ')}`);
  if (a.emergency_stop && a.actuator_type !== 'alarm' && ['on', 'open'].includes(b.state)) throw new HttpError(409, 'Emergency stop is engaged. Release it first.');
  await q("UPDATE actuators SET state = ?, mode = 'manual', last_changed_at = NOW(3), last_changed_by = ? WHERE actuator_id = ?", [b.state, req.user.sub, a.actuator_id]);
  await auditReq(req, 'actuator_manual', `structure:${a.structure_id}`, { actuator: a.actuator_type, from: a.state, to: b.state, control_mode: 'database_only' });
  res.json({ ok: true, control_mode: 'database_only', message: 'Actuator state updated in the system; no hardware command is sent.' });
}));

/** Hand actuators back to automation. */
r.post('/actuators/:id/auto', authorize(...ALLOWED), reauth, wrap(async (req, res) => {
  const out = await q("UPDATE actuators SET mode = 'auto' WHERE actuator_id = ?", [req.params.id]);
  if (!out.affectedRows) throw new HttpError(404, 'Actuator not found');
  await auditReq(req, 'actuator_auto_restored', 'actuator', { actuator_id: Number(req.params.id) });
  res.json({ ok: true });
}));

r.post('/:id/override', authorize(...ALLOWED), reauth, wrap(async (req, res) => {
  const { manual_override } = z.object({ manual_override: z.boolean() }).parse(req.body);
  const out = await q('UPDATE structures SET manual_override = ? WHERE structure_id = ?', [manual_override, req.params.id]);
  if (!out.affectedRows) throw new HttpError(404, 'Structure not found');
  await auditReq(req, 'structure_override', `structure:${req.params.id}`, { manual_override });
  res.json({ ok: true });
}));

/** Emergency stop: engaging it switches fans, coolers and vents off/closed and blocks automation until released. */
r.post('/:id/estop', authorize(...ALLOWED), reauth, wrap(async (req, res) => {
  const { engaged } = z.object({ engaged: z.boolean() }).parse(req.body);
  const out = await q('UPDATE structures SET emergency_stop = ? WHERE structure_id = ?', [engaged, req.params.id]);
  if (!out.affectedRows) throw new HttpError(404, 'Structure not found');
  if (engaged) {
    await q(`UPDATE actuators SET state = IF(actuator_type = 'vent', 'closed', 'off'), mode = 'manual', last_changed_at = NOW(3), last_changed_by = ?
              WHERE structure_id = ? AND actuator_type IN ('fan','cooler','vent')`, [req.user.sub, req.params.id]);
  }
  await auditReq(req, engaged ? 'emergency_stop_engaged' : 'emergency_stop_released', `structure:${req.params.id}`);
  res.json({ ok: true });
}));

export default r;
