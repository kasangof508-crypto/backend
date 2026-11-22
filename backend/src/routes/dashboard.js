import { Router } from 'express';
import { q } from '../db.js';
import { ROLES } from '../config.js';
import { authorize } from '../middleware/auth.js';
import { wrap } from '../utils/http.js';

const r = Router();
const parse = (b) => (typeof b === 'string' ? JSON.parse(b) : b);

/** One call that feeds the dashboard; sections are filtered by role (RBAC matrix, 'Dashboard and live maps'). */
r.get('/summary', authorize(ROLES.ADMIN, ROLES.VET, ROLES.OPERATOR, ROLES.SYSADMIN), wrap(async (req, res) => {
  const role = req.user.role;
  const all = role === ROLES.ADMIN || role === ROLES.SYSADMIN;
  const out = { role, generated_at: new Date() };

  const alertScope = role === ROLES.VET ? "AND source_module = 'livestock'" : role === ROLES.OPERATOR ? "AND source_module = 'machinery'" : '';
  out.alerts = {
    by_severity: await q(`SELECT severity, COUNT(*) AS n FROM alerts WHERE status <> 'resolved' ${alertScope} GROUP BY severity`),
    recent: await q(`SELECT alert_id, alert_type, severity, source_module, message, status, created_at FROM alerts WHERE status <> 'resolved' ${alertScope}
                     ORDER BY FIELD(severity,'critical','warning','info'), created_at DESC LIMIT 8`),
  };

  if (all) {
    const [wk] = await q(`SELECT (SELECT COUNT(*) FROM attendance WHERE sign_out_at IS NULL) AS on_shift,
                                 (SELECT COUNT(*) FROM users u JOIN roles r ON r.role_id = u.role_id WHERE r.role_name = 'Field Worker' AND u.status = 'active') AS workers`);
    out.workforce = { ...wk, tasks: await q("SELECT status, COUNT(*) AS n FROM tasks WHERE created_at > NOW(3) - INTERVAL 7 DAY GROUP BY status") };
    out.workers = await q(`SELECT u.user_id, u.full_name, l.latitude, l.longitude, l.recorded_at
                             FROM attendance a JOIN users u ON u.user_id = a.user_id
                             JOIN worker_locations l ON l.user_id = a.user_id AND l.recorded_at = (SELECT MAX(recorded_at) FROM worker_locations WHERE user_id = a.user_id)
                            WHERE a.sign_out_at IS NULL`);
    out.zones = (await q('SELECT zone_id, zone_name, zone_type, boundary FROM zones')).map((z) => ({ ...z, boundary: parse(z.boundary) }));
  }
  if (all || role === ROLES.VET) {
    const [l] = await q(`SELECT COUNT(*) AS herd,
        SUM(LOWER(TRIM(a.species)) IN ('sheep','ovine')) AS sheep,
        SUM(LOWER(TRIM(a.species)) IN ('goat','goats','caprine')) AS goats,
        SUM(a.sex = 'M' AND LOWER(TRIM(a.species)) IN ('bull','cattle','cow','cows','dairy','bovine')) AS bull,
        SUM(a.sex = 'F' AND LOWER(TRIM(a.species)) IN ('cattle','cow','cows','dairy','bovine')) AS dairy,
        SUM(EXISTS (SELECT 1 FROM alerts al WHERE al.entity_id = a.animal_id AND al.status <> 'resolved')) AS with_alerts
        FROM livestock a WHERE a.status = 'active'`);
    out.livestock = { herd: l.herd, with_alerts: Number(l.with_alerts ?? 0) };
    if (all) {
      out.livestock.by_type = {
        sheep: Number(l.sheep ?? 0), goats: Number(l.goats ?? 0),
        bull: Number(l.bull ?? 0), dairy: Number(l.dairy ?? 0),
      };
    }
  }
  if (all || role === ROLES.OPERATOR) {
    const [m] = await q(`SELECT COUNT(*) AS machines, SUM(total_engine_hrs - hrs_at_last_service >= service_interval_hrs - 10) AS service_due FROM machinery WHERE status = 'active'`);
    out.machinery = { machines: m.machines, service_due: Number(m.service_due ?? 0) };
    out.machines = await q(`SELECT m.machine_id, m.name, t.latitude, t.longitude, t.ignition_on, t.fuel_level_pct, t.recorded_at
                              FROM machinery m JOIN machinery_telemetry t ON t.machine_id = m.machine_id AND t.recorded_at = (SELECT MAX(recorded_at) FROM machinery_telemetry WHERE machine_id = m.machine_id)
                             WHERE m.status <> 'deleted'`);
  }
  if (all) {
    out.structures = await q(`SELECT s.structure_id, s.structure_name, s.structure_type, s.emergency_stop, c.temperature_c, c.humidity_pct, c.gas_ppm, c.recorded_at
                                FROM structures s LEFT JOIN climate_readings c ON c.structure_id = s.structure_id AND c.recorded_at = (SELECT MAX(recorded_at) FROM climate_readings WHERE structure_id = s.structure_id)`);
    const [dv] = await q("SELECT SUM(status = 'active') AS online, SUM(status = 'offline') AS offline FROM iot_devices");
    out.devices = { online: Number(dv.online ?? 0), offline: Number(dv.offline ?? 0) };
  }
  res.json(out);
}));

export default r;
