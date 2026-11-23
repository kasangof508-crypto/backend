import { randomUUID } from 'crypto';
import { q } from '../db.js';
import { raiseAlert } from './alertService.js';
import { audit } from '../middleware/audit.js';

let cache = { at: 0, rows: [] };
export const invalidateThresholds = () => { cache.at = 0; };
async function thresholdRows() {
  if (Date.now() - cache.at > 60_000) cache = { at: Date.now(), rows: await q('SELECT * FROM thresholds WHERE enabled = 1') };
  return cache.rows;
}
/** Specific scope first (breed / machine type / structure type), then the 'default' scope. */
const pick = (rows, module, scope, metric) =>
  rows.find((r) => r.module === module && r.scope === scope && r.metric === metric)
  ?? rows.find((r) => r.module === module && r.scope === 'default' && r.metric === metric);

// ---------------- Livestock (Process 3.0) ----------------
export async function evaluateLivestock(animal, reading) {
  const T = await thresholdRows();
  const scope = animal.breed || 'default';

  const temp = pick(T, 'livestock', scope, 'temperature_c');
  const tempMax = temp?.max_value ?? 39.5;
  if (reading.temperature_c > tempMax) {
    await raiseAlert({
      type: 'high_temperature', module: 'livestock', entityType: 'animal', entityId: animal.animal_id,
      severity: reading.temperature_c >= tempMax + 1 ? 'critical' : (temp?.severity ?? 'warning'),
      message: `Animal ${animal.tag_id}: body temperature ${reading.temperature_c.toFixed(1)} °C exceeds ${tempMax} °C`,
    });
  }

  const act = pick(T, 'livestock', scope, 'activity_index');
  const actMax = act?.max_value ?? 2.0;
  const minutes = act?.duration_minutes || 120;
  const [w] = await q(
    `SELECT COUNT(*) AS n, MAX(activity_index) AS mx FROM livestock_telemetry
      WHERE animal_id = ? AND recorded_at > NOW(3) - INTERVAL ? MINUTE`, [animal.animal_id, minutes]);
  if (w.n >= Math.floor((minutes / 5) * 0.8) && Number(w.mx) < actMax) {
    await raiseAlert({
      type: 'low_activity', module: 'livestock', entityType: 'animal', entityId: animal.animal_id, severity: act?.severity ?? 'warning',
      message: `Animal ${animal.tag_id}: activity below ${actMax} for ${Math.round(minutes / 60 * 10) / 10} h (possible illness or injury)`,
    });
  }

  // Estrus heuristic: mean activity of the last 3 h vs the preceding 24 h baseline (females only).
  // Needs calibration with the veterinarian before the 95% detection target can be claimed.
  if (animal.sex === 'F') {
    const est = pick(T, 'livestock', scope, 'estrus_ratio');
    const ratioMin = est?.max_value ?? 2.0;
    const [r] = await q(
      `SELECT AVG(CASE WHEN recorded_at > NOW(3) - INTERVAL 3 HOUR THEN activity_index END) AS recent,
              AVG(CASE WHEN recorded_at <= NOW(3) - INTERVAL 3 HOUR AND recorded_at > NOW(3) - INTERVAL 27 HOUR THEN activity_index END) AS base,
              SUM(recorded_at > NOW(3) - INTERVAL 3 HOUR) AS n_recent,
              SUM(recorded_at <= NOW(3) - INTERVAL 3 HOUR AND recorded_at > NOW(3) - INTERVAL 27 HOUR) AS n_base
         FROM livestock_telemetry WHERE animal_id = ? AND recorded_at > NOW(3) - INTERVAL 27 HOUR`, [animal.animal_id]);
    if (r.n_recent >= 24 && r.n_base >= 100 && r.base > 0 && r.recent / r.base >= ratioMin) {
      const id = await raiseAlert({
        type: 'estrus', module: 'livestock', entityType: 'animal', entityId: animal.animal_id, severity: est?.severity ?? 'info',
        dedupeHours: 24, message: `Animal ${animal.tag_id}: activity ${(r.recent / r.base).toFixed(1)}x baseline - possible estrus`,
      });
      if (id) await q('INSERT INTO breeding_events (event_id, animal_id, event_type, detected_at) VALUES (?,?, "estrus", NOW(3))', [randomUUID(), animal.animal_id]);
    }
  }
}

// ---------------- Machinery (Process 4.0) ----------------
export async function evaluateMachinery(machineId, reading) {
  const T = await thresholdRows();
  const [m] = await q('SELECT * FROM machinery WHERE machine_id = ?', [machineId]);
  if (!m) return;
  const lead = pick(T, 'machinery', m.machine_type, 'service_lead_hrs')?.max_value ?? 10;
  const since = Number(m.total_engine_hrs) - Number(m.hrs_at_last_service);
  if (since >= m.service_interval_hrs - lead) {
    const overdue = since >= m.service_interval_hrs;
    await raiseAlert({
      type: 'service_due', module: 'machinery', entityType: 'machine', entityId: machineId, severity: overdue ? 'critical' : 'warning',
      message: `${m.name}: ${since.toFixed(1)} engine hours since last service (interval ${m.service_interval_hrs} h)${overdue ? ' - OVERDUE' : ''}`,
    });
  }
  const fuelMin = pick(T, 'machinery', m.machine_type, 'fuel_level_pct')?.min_value ?? 15;
  if (reading.fuel_pct != null && reading.fuel_pct < fuelMin) {
    await raiseAlert({ type: 'low_fuel', module: 'machinery', entityType: 'machine', entityId: machineId, severity: 'info', message: `${m.name}: fuel level ${reading.fuel_pct}%` });
  }
  if (reading.fault_codes) {
    await raiseAlert({ type: 'fault_code', module: 'machinery', entityType: 'machine', entityId: machineId, severity: 'warning', message: `${m.name}: diagnostic code(s) ${reading.fault_codes}` });
  }
}

// ---------------- Structures (Process 5.0) ----------------
async function setActuators(structure, commands) {
  if (structure.emergency_stop && !commands.every(([t]) => t === 'alarm')) return;
  for (const [type, state] of commands) {
    if (type !== 'alarm' && structure.manual_override) continue;
    const res = await q(
      `UPDATE actuators SET state = ?, last_changed_at = NOW(3), last_changed_by = NULL
        WHERE structure_id = ? AND actuator_type = ? AND state <> ? AND (mode = 'auto' OR actuator_type = 'alarm')`,
      [state, structure.structure_id, type, state]);
    if (res.affectedRows) {
      await audit({ action: 'actuator_auto', entity: `structure:${structure.structure_id}`, details: { type, state } });
    }
  }
}

export async function evaluateStructure(structure, r) {
  const T = await thresholdRows();
  const scope = structure.structure_type;
  const t = pick(T, 'structure', scope, 'temperature_c');
  const h = pick(T, 'structure', scope, 'humidity_pct');
  const g = pick(T, 'structure', scope, 'gas_ppm');
  const id = structure.structure_id;
  const name = structure.structure_name;

  if (g?.max_value != null && r.gas_ppm != null && r.gas_ppm > g.max_value) {
    await raiseAlert({ type: 'gas_leak', module: 'structure', entityType: 'structure', entityId: id, severity: 'critical',
      message: `${name}: ${r.gas_type || 'gas'} ${r.gas_ppm} ppm exceeds safe limit ${g.max_value} ppm` });
    await setActuators(structure, [['alarm', 'on']]);
  }
  const tMax = t?.max_value;
  if (tMax != null && r.temperature_c > tMax) {
    await raiseAlert({ type: 'high_temperature', module: 'structure', entityType: 'structure', entityId: id, severity: 'critical',
      message: `${name}: temperature ${r.temperature_c} °C exceeds ${tMax} °C` });
    await setActuators(structure, [['fan', 'on'], ['cooler', 'on'], ['vent', 'open']]);
  } else if (tMax != null && r.temperature_c <= tMax - 2) {
    await setActuators(structure, [['fan', 'off'], ['cooler', 'off'], ['vent', 'closed']]); // hysteresis
  }
  if (t?.min_value != null && r.temperature_c < t.min_value) {
    await raiseAlert({ type: 'low_temperature', module: 'structure', entityType: 'structure', entityId: id, severity: 'warning',
      message: `${name}: temperature ${r.temperature_c} °C below ${t.min_value} °C` });
  }
  if (h && ((h.min_value != null && r.humidity_pct < h.min_value) || (h.max_value != null && r.humidity_pct > h.max_value))) {
    await raiseAlert({ type: 'humidity', module: 'structure', entityType: 'structure', entityId: id, severity: 'warning',
      message: `${name}: humidity ${r.humidity_pct}% outside ${h.min_value ?? 0}-${h.max_value ?? 100}%` });
  }
}
