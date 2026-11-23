import { Router } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { q, tx } from '../db.js';
import { ROLES } from '../config.js';
import { authorize } from '../middleware/auth.js';
import { auditReq } from '../middleware/audit.js';
import { HttpError, wrap } from '../utils/http.js';
import { evaluateLivestock } from '../services/rules.js';

const r = Router();
const READ = [ROLES.ADMIN, ROLES.VET, ROLES.SYSADMIN];
const PEN_NAMES = ['Bull Pen', 'Dairy Pen', 'Sheep Pen', 'Goat Pen'];
const animalDetails = z.object({
  species: z.string().max(20).default('cattle'), breed: z.string().max(40).optional(),
  sex: z.enum(['M', 'F']), date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), zone_id: z.number().int().nullable().optional(),
  collar_device_id: z.string().uuid().nullable().optional(),
});
const animal = animalDetails.extend({ tag_id: z.string().min(3).max(24) });

async function nextAnimalTag(execute) {
  await execute(
    "INSERT IGNORE INTO livestock_tag_sequence (sequence_id, prefix, next_number, padding, initialized) VALUES (1,'COW-','1',1,FALSE)");
  const [sequence] = await execute(
    'SELECT prefix, next_number, initialized FROM livestock_tag_sequence WHERE sequence_id = 1 FOR UPDATE');
  let prefix = sequence.prefix;
  let nextNumber = BigInt(sequence.next_number);

  if (!sequence.initialized) {
    const [previous] = await execute(
      `SELECT tag_id FROM livestock
        WHERE tag_id REGEXP '[0-9]+$'
        ORDER BY CAST(REGEXP_SUBSTR(tag_id, '[0-9]+$') AS DECIMAL(24,0)) DESC,
                 CHAR_LENGTH(REGEXP_SUBSTR(tag_id, '[0-9]+$')) DESC
        LIMIT 1`);
    const match = previous?.tag_id.match(/^(.*?)([0-9]+)$/);
    if (match) {
      prefix = match[1];
      nextNumber = BigInt(match[2]) + 1n;
    }
  }

  let tagId;
  while (true) {
    tagId = `${prefix}${nextNumber}`;
    if (tagId.length > 24) throw new HttpError(409, 'The RFID tag sequence has reached the maximum tag length');
    const [existing] = await execute('SELECT animal_id FROM livestock WHERE tag_id = ?', [tagId]);
    if (!existing) break;
    nextNumber += 1n;
  }
  await execute(
    'UPDATE livestock_tag_sequence SET prefix = ?, next_number = ?, padding = ?, initialized = TRUE WHERE sequence_id = 1',
    [prefix, (nextNumber + 1n).toString(), 1]);
  return tagId;
}

r.get('/', authorize(...READ), wrap(async (_req, res) => {
  res.json(await q(
    `SELECT a.animal_id, a.tag_id, a.species, a.breed, a.sex, a.date_of_birth, a.status, a.zone_id, z.zone_name,
            a.collar_device_id, d.serial_no AS collar_serial_no,
            t.temperature_c, t.activity_index, COALESCE(t.battery_level, d.battery_level) AS battery_level,
            t.recorded_at AS last_reading_at,
            (SELECT COUNT(*) FROM alerts al WHERE al.entity_id = a.animal_id AND al.status <> 'resolved') AS open_alerts
       FROM livestock a LEFT JOIN zones z ON z.zone_id = a.zone_id
       LEFT JOIN iot_devices d ON d.device_id = a.collar_device_id
       LEFT JOIN livestock_telemetry t ON t.animal_id = a.animal_id AND t.recorded_at = (SELECT MAX(recorded_at) FROM livestock_telemetry WHERE animal_id = a.animal_id)
      WHERE a.status <> 'deleted'
      ORDER BY REGEXP_REPLACE(a.tag_id, '[0-9]+$', '') ASC,
               CAST(REGEXP_SUBSTR(a.tag_id, '[0-9]+$') AS DECIMAL(24,0)) ASC,
               CHAR_LENGTH(REGEXP_SUBSTR(a.tag_id, '[0-9]+$')) ASC,
               a.tag_id ASC`));
}));

r.get('/available-collars', authorize(ROLES.VET), wrap(async (_req, res) => {
  res.json(await q(
    `SELECT d.device_id, d.serial_no, d.firmware_version, d.battery_level, d.last_seen_at
       FROM iot_devices d
      WHERE d.device_type = 'rfid_collar' AND d.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM livestock a WHERE a.collar_device_id = d.device_id)
      ORDER BY d.serial_no`));
}));

r.post('/', authorize(ROLES.VET), wrap(async (req, res) => {
  const b = animalDetails.parse(req.body);
  const id = randomUUID();
  const tagId = await tx(async (execute) => {
    if (b.zone_id != null) {
      const [zone] = await execute("SELECT zone_id FROM zones WHERE zone_id = ? AND zone_type = 'pen' AND zone_name IN (?,?,?,?)",
        [b.zone_id, ...PEN_NAMES]);
      if (!zone) throw new HttpError(400, 'Select one of the designated livestock pens');
    }
    if (b.collar_device_id) {
      const [device] = await execute("SELECT device_id FROM iot_devices WHERE device_id = ? AND device_type = 'rfid_collar' AND status = 'active' FOR UPDATE", [b.collar_device_id]);
      if (!device) throw new HttpError(400, 'Selected collar is unavailable or is not an active RFID collar');
      const [paired] = await execute('SELECT animal_id FROM livestock WHERE collar_device_id = ? LIMIT 1 FOR UPDATE', [b.collar_device_id]);
      if (paired) throw new HttpError(409, 'Selected collar is already paired with an animal');
    }
    const generatedTag = await nextAnimalTag(execute);
    await execute('INSERT INTO livestock (animal_id, tag_id, species, breed, sex, date_of_birth, zone_id, collar_device_id) VALUES (?,?,?,?,?,?,?,?)',
      [id, generatedTag, b.species, b.breed ?? null, b.sex, b.date_of_birth ?? null, b.zone_id ?? null, b.collar_device_id ?? null]);
    return generatedTag;
  });
  await auditReq(req, 'animal_created', 'livestock', { animal_id: id, tag_id: tagId });
  res.status(201).json({ animal_id: id, tag_id: tagId });
}));

r.put('/:id', authorize(ROLES.VET), wrap(async (req, res) => {
  const b = animal.partial().extend({ status: z.enum(['active', 'sold', 'deceased', 'deleted']).optional() }).parse(req.body);
  const entries = Object.entries(b).filter(([, v]) => v !== undefined);
  if (!entries.length) throw new HttpError(400, 'Nothing to update');
  await tx(async (execute) => {
    const [existing] = await execute('SELECT animal_id FROM livestock WHERE animal_id = ? FOR UPDATE', [req.params.id]);
    if (!existing) throw new HttpError(404, 'Animal not found');
    if (b.zone_id != null) {
      const [zone] = await execute("SELECT zone_id FROM zones WHERE zone_id = ? AND zone_type = 'pen' AND zone_name IN (?,?,?,?)",
        [b.zone_id, ...PEN_NAMES]);
      if (!zone) throw new HttpError(400, 'Select one of the designated livestock pens');
    }
    if (b.collar_device_id) {
      const [device] = await execute("SELECT device_id FROM iot_devices WHERE device_id = ? AND device_type = 'rfid_collar' AND status = 'active' FOR UPDATE", [b.collar_device_id]);
      if (!device) throw new HttpError(400, 'Selected collar is unavailable or is not an active RFID collar');
      const [paired] = await execute('SELECT animal_id FROM livestock WHERE collar_device_id = ? AND animal_id <> ? LIMIT 1 FOR UPDATE', [b.collar_device_id, req.params.id]);
      if (paired) throw new HttpError(409, 'Selected collar is already paired with another animal');
    }
    await execute(`UPDATE livestock SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE animal_id = ?`, [...entries.map(([, v]) => v), req.params.id]);
  });
  await auditReq(req, 'animal_updated', 'livestock', { animal_id: req.params.id, ...b });
  res.json({ ok: true });
}));

r.delete('/:id', authorize(ROLES.VET), wrap(async (req, res) => {
  const animalRecord = await tx(async (execute) => {
    const [existing] = await execute(
      'SELECT animal_id, tag_id, status FROM livestock WHERE animal_id = ? FOR UPDATE',
      [req.params.id]);
    if (!existing) throw new HttpError(404, 'Animal not found');
    if (existing.status === 'deleted') throw new HttpError(409, 'Animal is already deleted');
    await execute("UPDATE livestock SET status = 'deleted' WHERE animal_id = ?", [req.params.id]);
    return existing;
  });
  await auditReq(req, 'animal_deleted', 'livestock', {
    animal_id: animalRecord.animal_id, tag_id: animalRecord.tag_id,
  });
  res.json({ ok: true });
}));

r.get('/:id/telemetry', authorize(...READ), wrap(async (req, res) => {
  const hours = Math.min(Number(req.query.hours) || 24, 24 * 14);
  res.json(await q(
    `SELECT recorded_at, temperature_c, activity_index FROM livestock_telemetry
      WHERE animal_id = ? AND recorded_at > NOW(3) - INTERVAL ? HOUR ORDER BY recorded_at LIMIT 4100`, [req.params.id, hours]));
}));

r.post('/:id/telemetry', authorize(...READ), wrap(async (req, res) => {
  const reading = z.object({
    temperature_c: z.number().min(30).max(45),
    activity_index: z.number().min(0).max(9999.99),
    battery_level: z.number().int().min(0).max(100).nullable().optional(),
  }).parse(req.body);
  const [animal] = await q("SELECT animal_id, tag_id, breed, sex FROM livestock WHERE animal_id = ? AND status = 'active'", [req.params.id]);
  if (!animal) throw new HttpError(404, 'Active animal not found');

  await q('INSERT INTO livestock_telemetry (animal_id, recorded_at, temperature_c, activity_index, battery_level) VALUES (?, NOW(3), ?, ?, ?)',
    [animal.animal_id, reading.temperature_c, reading.activity_index, reading.battery_level ?? null]);
  await auditReq(req, 'livestock_telemetry_received', 'livestock', { animal_id: animal.animal_id });
  await evaluateLivestock(animal, reading);
  res.status(201).json({ accepted: true });
}));

r.get('/:id/health-records', authorize(...READ), wrap(async (req, res) => {
  res.json(await q(`SELECT h.*, u.full_name AS vet FROM health_records h JOIN users u ON u.user_id = h.vet_id WHERE h.animal_id = ? ORDER BY h.examined_at DESC LIMIT 100`, [req.params.id]));
}));

/** Saving an examination linked to an alert closes the alert (design: condition cleared and record saved -> Resolved). */
r.post('/:id/health-records', authorize(ROLES.VET), wrap(async (req, res) => {
  const b = z.object({
    diagnosis: z.string().max(2000).optional(), treatment: z.string().max(2000).optional(),
    notes: z.string().max(2000).optional(), alert_id: z.string().uuid().optional(),
    treatment_cost_kes: z.number().min(0).max(9999999999.99).nullable().optional(),
  }).parse(req.body);
  if (!b.diagnosis && !b.treatment && !b.notes) throw new HttpError(400, 'Enter at least a diagnosis, treatment or note');
  const id = randomUUID();
  await q('INSERT INTO health_records (record_id, animal_id, alert_id, vet_id, examined_at, diagnosis, treatment, notes, treatment_cost_kes) VALUES (?,?,?,?,NOW(3),?,?,?,?)',
    [id, req.params.id, b.alert_id ?? null, req.user.sub, b.diagnosis ?? null, b.treatment ?? null, b.notes ?? null, b.treatment_cost_kes ?? null]);
  if (b.alert_id) await q("UPDATE alerts SET status = 'resolved', resolved_at = NOW(3), acknowledged_by = COALESCE(acknowledged_by, ?), acknowledged_at = COALESCE(acknowledged_at, NOW(3)) WHERE alert_id = ? AND source_module = 'livestock'", [req.user.sub, b.alert_id]);
  await auditReq(req, 'health_record_created', 'health_record', { record_id: id, animal_id: req.params.id, alert_id: b.alert_id, treatment_cost_kes: b.treatment_cost_kes ?? null });
  res.status(201).json({ record_id: id });
}));

r.get('/:id/breeding-events', authorize(...READ), wrap(async (req, res) => {
  res.json(await q('SELECT * FROM breeding_events WHERE animal_id = ? ORDER BY detected_at DESC LIMIT 100', [req.params.id]));
}));

r.post('/:id/breeding-events', authorize(ROLES.VET), wrap(async (req, res) => {
  const b = z.object({ event_type: z.enum(['estrus', 'insemination', 'pregnancy_check', 'calving']), notes: z.string().max(1000).optional() }).parse(req.body);
  const id = randomUUID();
  await q('INSERT INTO breeding_events (event_id, animal_id, event_type, detected_at, confirmed_by, notes) VALUES (?,?,?,NOW(3),?,?)', [id, req.params.id, b.event_type, req.user.sub, b.notes ?? null]);
  await auditReq(req, 'breeding_event_created', 'breeding_event', { event_id: id, animal_id: req.params.id, type: b.event_type });
  res.status(201).json({ event_id: id });
}));

export default r;
