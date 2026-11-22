/**
 * Demo / pilot seed data:  npm run seed
 * Creates users for every role, zones, paired IoT devices (4 collars, 2 trackers, 2 climate kits = pilot scale),
 * animals, machines, structures with actuators, default thresholds with recipients, sample tasks and 24 h of telemetry.
 * Zone coordinates are placeholders - replace them with the real farm boundaries from the Workforce page / zones API.
 */
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { config } from './config.js';
import { q, pool } from './db.js';

if (!config.seedPassword) {
  throw new Error('SEED_PASSWORD is required to seed demo accounts. Set a unique password in backend/.env.');
}

const [{ n }] = await q('SELECT COUNT(*) AS n FROM users');
if (n > 0) { console.log('Database already has users - seed skipped.'); await pool.end(); process.exit(0); }

const roleId = Object.fromEntries((await q('SELECT role_id, role_name FROM roles')).map((r) => [r.role_name, r.role_id]));
const hash = await bcrypt.hash(config.seedPassword, 12);
const U = {};
const users = [
  ['admin', 'Farm Administrator', 'Farm Administrator', '+254700000001'],
  ['sysadmin', 'System Administrator', 'System Administrator', '+254700000002'],
  ['vet', 'Dr. Vet Demo', 'Veterinarian', '+254700000003'],
  ['operator', 'Machinery Operator', 'Machinery Operator', '+254700000004'],
  ['worker1', 'Field Worker One', 'Field Worker', '+254700000005'],
  ['worker2', 'Field Worker Two', 'Field Worker', '+254700000006'],
];
for (const [key, name, role, phone] of users) {
  U[key] = randomUUID();
  await q('INSERT INTO users (user_id, full_name, email, phone, password_hash, role_id, consent_at) VALUES (?,?,?,?,?,?,NOW(3))',
    [U[key], name, `${key}@safm.local`, phone, hash, roleId[role]]);
}

// ---- zones (placeholder rectangles around a base point) ----
const BASE = [-1.2000, 36.8000];
const rect = (dLat, dLng, h = 0.0015, w = 0.002) => [[BASE[0] + dLat, BASE[1] + dLng], [BASE[0] + dLat, BASE[1] + dLng + w], [BASE[0] + dLat + h, BASE[1] + dLng + w], [BASE[0] + dLat + h, BASE[1] + dLng]];
const zoneDefs = [
  ['North Field', 'field', rect(0.004, 0)],
  ['South Field', 'field', rect(-0.004, 0)],
  ['Dairy Pen', 'pen', [[-1.2, 36.803], [-1.2, 36.804], [-1.19925, 36.804], [-1.19925, 36.803]]],
  ['Bull Pen', 'pen', [[-1.2, 36.804], [-1.2, 36.805], [-1.19925, 36.805], [-1.19925, 36.804]]],
  ['Goat Pen', 'pen', [[-1.19925, 36.803], [-1.19925, 36.804], [-1.1985, 36.804], [-1.1985, 36.803]]],
  ['Sheep Pen', 'pen', [[-1.19925, 36.804], [-1.19925, 36.805], [-1.1985, 36.805], [-1.1985, 36.804]]],
  ['Greenhouse 1 Area', 'greenhouse', rect(0.0035, 0.003, 0.0008, 0.001)],
  ['Storage Yard', 'storage', rect(-0.0015, 0.003, 0.0008, 0.001)],
];
const Z = {};
for (const [name, type, poly] of zoneDefs) Z[name] = (await q('INSERT INTO zones (zone_name, zone_type, boundary, created_by) VALUES (?,?,?,?)', [name, type, JSON.stringify(poly), U.admin])).insertId;

// ---- devices ----
const dev = {};
const devices = [['rfid_collar', 'COLLAR-001'], ['rfid_collar', 'COLLAR-002'], ['rfid_collar', 'COLLAR-003'], ['rfid_collar', 'COLLAR-004'], ['gps_tracker', 'TRK-001'], ['gps_tracker', 'TRK-002'], ['climate_kit', 'CLM-001'], ['climate_kit', 'CLM-002']];
for (const [type, serial] of devices) { dev[serial] = randomUUID(); await q("INSERT INTO iot_devices (device_id, device_type, serial_no, firmware_version, battery_level, last_seen_at) VALUES (?,?,?,?,90,NOW(3))", [dev[serial], type, serial, '1.0.0']); }

// ---- livestock ----
const animals = [['E200-01A1', 'Friesian', 'F'], ['E200-01A2', 'Friesian', 'F'], ['E200-01A3', 'Ayrshire', 'F'], ['E200-01A4', 'Jersey', 'M']];
const A = [];
for (const [i, [tag, breed, sex]] of animals.entries()) {
  const id = randomUUID(); A.push({ id, tag });
  await q('INSERT INTO livestock (animal_id, tag_id, species, breed, sex, date_of_birth, collar_device_id, zone_id) VALUES (?,?,?,?,?,?,?,?)', [id, tag, 'cattle', breed, sex, `2022-0${i + 1}-15`, dev[`COLLAR-00${i + 1}`], Z['Dairy Pen']]);
}

// ---- machinery ----
const M = [];
for (const [i, [name, type, reg, model, hrs]] of [['Tractor T1', 'tractor', 'KDA 101A', 'John Deere 5075E', 236.0], ['Tractor T2', 'tractor', 'KDB 202B', 'Massey Ferguson 275', 120.0]].entries()) {
  const id = randomUUID(); M.push({ id, hrs });
  await q('INSERT INTO machinery (machine_id, name, machine_type, registration_no, make_model, tracker_device_id, service_interval_hrs, total_engine_hrs, hrs_at_last_service) VALUES (?,?,?,?,?,?,250,?,0)', [id, name, type, reg, model, dev[`TRK-00${i + 1}`], hrs]);
}

// ---- structures + actuators ----
const S = [];
const structs = [['Greenhouse 1', 'greenhouse', 'Greenhouse 1 Area', 'CLM-001'], ['Grain Silo 1', 'grain_silo', 'Storage Yard', 'CLM-002'], ['Silage Pit 1', 'silage_pit', 'Storage Yard', null]];
for (const [name, type, zone, serial] of structs) {
  const sid = (await q('INSERT INTO structures (structure_name, structure_type, zone_id, sensor_device_id) VALUES (?,?,?,?)', [name, type, Z[zone], serial ? dev[serial] : null])).insertId;
  S.push({ sid, serial, type });
  for (const a of ['fan', 'cooler', 'vent', 'alarm']) await q("INSERT INTO actuators (structure_id, actuator_type, state) VALUES (?,?,?)", [sid, a, a === 'vent' ? 'closed' : 'off']);
}

// ---- thresholds (initial values from the SRS examples; confirm the climate/gas limits with the farm's interview answers) ----
const T = {};
const ths = [
  ['livestock', 'default', 'temperature_c', null, 39.5, 0, 'warning'],
  ['livestock', 'default', 'activity_index', null, 2.0, 120, 'warning'],
  ['livestock', 'default', 'estrus_ratio', null, 2.0, 0, 'info'],
  ['machinery', 'default', 'service_lead_hrs', null, 10, 0, 'info'],
  ['machinery', 'default', 'fuel_level_pct', 15, null, 0, 'info'],
  ['structure', 'greenhouse', 'temperature_c', 10, 30, 0, 'critical'],
  ['structure', 'greenhouse', 'humidity_pct', 60, 80, 0, 'warning'],
  ['structure', 'greenhouse', 'gas_ppm', null, 1500, 0, 'critical'],
  ['structure', 'grain_silo', 'temperature_c', null, 30, 0, 'critical'],
  ['structure', 'grain_silo', 'humidity_pct', 40, 70, 0, 'warning'],
  ['structure', 'grain_silo', 'gas_ppm', null, 1000, 0, 'critical'],
  ['structure', 'silage_pit', 'gas_ppm', null, 5000, 0, 'critical'],
];
for (const [module, scope, metric, min, max, dur, sev] of ths) T[`${module}:${scope}:${metric}`] = (await q('INSERT INTO thresholds (module, scope, metric, min_value, max_value, duration_minutes, severity, updated_by) VALUES (?,?,?,?,?,?,?,?)', [module, scope, metric, min, max, dur, sev, U.admin])).insertId;
const rec = (key, user, level, ch) => q('INSERT INTO alert_recipients (threshold_id, user_id, level, channels) VALUES (?,?,?,?)', [T[key], user, level, ch]);
await rec('livestock:default:temperature_c', U.vet, 1, 'sms,push'); await rec('livestock:default:temperature_c', U.admin, 1, 'sms,push,email'); await rec('livestock:default:temperature_c', U.sysadmin, 2, 'sms');
await rec('machinery:default:service_lead_hrs', U.admin, 1, 'push,sms'); await rec('machinery:default:service_lead_hrs', U.operator, 1, 'push'); await rec('machinery:default:service_lead_hrs', U.sysadmin, 2, 'sms');
await rec('structure:greenhouse:temperature_c', U.admin, 1, 'sms,push'); await rec('structure:greenhouse:temperature_c', U.sysadmin, 2, 'sms');

// ---- sample tasks ----
await q('INSERT INTO tasks (task_id, title, description, zone_id, assigned_to, assigned_by, priority, due_at) VALUES (?,?,?,?,?,?,?, NOW(3) + INTERVAL 6 HOUR)', [randomUUID(), 'Weed North Field rows 1-10', 'Manual weeding', Z['North Field'], U.worker1, U.admin, 'medium']);
await q('INSERT INTO tasks (task_id, title, description, zone_id, assigned_to, assigned_by, priority, due_at) VALUES (?,?,?,?,?,?,?, NOW(3) + INTERVAL 8 HOUR)', [randomUUID(), 'Clean dairy pen', 'Daily cleaning', Z['Dairy Pen'], U.worker2, U.admin, 'high']);
await q('INSERT INTO tasks (task_id, title, zone_id, assigned_by, priority) VALUES (?,?,?,?,?)', [randomUUID(), 'Irrigation check South Field', Z['South Field'], U.admin, 'low']);

// ---- 24 h of telemetry so charts are populated ----
const rnd = (a, b) => a + Math.random() * (b - a);
const now = Date.now();
const bulk = async (sql, rows) => { for (let i = 0; i < rows.length; i += 400) await q(sql, [rows.slice(i, i + 400)]); };
const lt = [], mt = [], cr = [];
for (let step = 288; step >= 1; step--) {
  const ts = new Date(now - step * 5 * 60_000);
  const hour = ts.getUTCHours();
  for (const a of A) {
    const p = { animal_tag: a.tag, temperature_c: Number(rnd(38.2, 39.0).toFixed(1)), activity_index: Number((rnd(8, 20) * (hour >= 3 && hour <= 15 ? 1 : 0.5)).toFixed(2)), battery: 90, ts: ts.toISOString() };
    lt.push([a.id, ts, p.temperature_c, p.activity_index, 90]);
  }
  if (step % 2 === 0) for (const [i, m] of M.entries()) {   // 10-minute machinery readings
    const p = { lat: BASE[0] + 0.004 + i * 0.001 + rnd(0, 0.0005), lng: BASE[1] + 0.001 + rnd(0, 0.0005), speed_kmh: i === 0 ? Number(rnd(0, 9).toFixed(1)) : 0, ignition: i === 0, engine_hours: Number((m.hrs - step / 12 * 0.1).toFixed(1)), fuel_pct: Number((80 - (288 - step) * 0.08).toFixed(1)), fault_codes: '', ts: ts.toISOString() };
    mt.push([m.id, ts, p.lat, p.lng, p.speed_kmh, p.ignition ? 1 : 0, p.engine_hours, p.fuel_pct, null]);
  }
  if (step % 3 === 0) for (const s of S.filter((x) => x.serial)) {     // ~15-minute climate points (3-minute in production)
    const ghTemp = s.type === 'greenhouse' ? rnd(21, 26) : rnd(18, 24);
    const p = { temperature_c: Number(ghTemp.toFixed(1)), humidity_pct: Number((s.type === 'greenhouse' ? rnd(62, 76) : rnd(48, 62)).toFixed(1)), gas_type: 'CO2', gas_ppm: Number(rnd(500, 750).toFixed(1)), ts: ts.toISOString() };
    cr.push([s.sid, ts, p.temperature_c, p.humidity_pct, 'CO2', p.gas_ppm]);
  }
}
await bulk('INSERT INTO livestock_telemetry (animal_id, recorded_at, temperature_c, activity_index, battery_level) VALUES ?', lt);
await bulk('INSERT INTO machinery_telemetry (machine_id, recorded_at, latitude, longitude, speed_kmh, ignition_on, engine_hours, fuel_level_pct, fault_codes) VALUES ?', mt);
await bulk('INSERT INTO climate_readings (structure_id, recorded_at, temperature_c, humidity_pct, gas_type, gas_ppm) VALUES ?', cr);

console.log('Seed complete. Sign in with these accounts (password from SEED_PASSWORD):');
users.forEach(([k, , role]) => console.log(`  ${k}@safm.local  (${role})`));
console.log(`Password: ${config.seedPassword}  <- change it after first login`);
await pool.end();
