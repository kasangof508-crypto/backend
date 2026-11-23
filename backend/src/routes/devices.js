import { Router } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { q, tx } from '../db.js';
import { ROLES } from '../config.js';
import { authorize } from '../middleware/auth.js';
import { auditReq } from '../middleware/audit.js';
import { HttpError, wrap } from '../utils/http.js';

const r = Router();
const TYPES = ['rfid_collar', 'gps_tracker', 'canbus', 'climate_kit', 'gateway'];

r.get('/', authorize(ROLES.SYSADMIN, ROLES.ADMIN), wrap(async (_req, res) => {
  res.json(await q('SELECT device_id, device_type, serial_no, firmware_version, battery_level, last_seen_at, status FROM iot_devices ORDER BY device_type, serial_no'));
}));

r.post('/', authorize(ROLES.SYSADMIN), wrap(async (req, res) => {
  const b = z.object({
    device_type: z.enum(TYPES), serial_no: z.string().min(3).max(40),
    firmware_version: z.string().max(20).optional(), battery_level: z.number().int().min(0).max(100),
  }).parse(req.body);
  const id = randomUUID();
  await q('INSERT INTO iot_devices (device_id, device_type, serial_no, firmware_version, battery_level) VALUES (?,?,?,?,?)',
    [id, b.device_type, b.serial_no, b.firmware_version ?? null, b.battery_level]);
  await auditReq(req, 'device_paired', 'iot_device', { device_id: id, ...b });
  res.status(201).json({ device_id: id });
}));

r.put('/:id', authorize(ROLES.SYSADMIN), wrap(async (req, res) => {
  const b = z.object({
    device_type: z.enum(TYPES), serial_no: z.string().min(3).max(40),
    firmware_version: z.string().max(20).nullable(), battery_level: z.number().int().min(0).max(100).nullable(),
    status: z.enum(['active', 'offline', 'retired']),
  }).partial().parse(req.body);
  const keys = Object.keys(b);
  if (!keys.length) throw new HttpError(400, 'Nothing to update');
  if (b.device_type) {
    const [linked] = await q(
      `SELECT
         EXISTS (SELECT 1 FROM livestock WHERE collar_device_id = ?) AS livestock_linked,
         EXISTS (SELECT 1 FROM machinery WHERE tracker_device_id = ?) AS machinery_linked,
         EXISTS (SELECT 1 FROM structures WHERE sensor_device_id = ?) AS structure_linked`,
      [req.params.id, req.params.id, req.params.id]);
    if (linked.livestock_linked && b.device_type !== 'rfid_collar') {
      throw new HttpError(409, 'A device paired with livestock must remain an RFID collar');
    }
    if (linked.machinery_linked && !['gps_tracker', 'canbus'].includes(b.device_type)) {
      throw new HttpError(409, 'A device assigned to machinery must remain a GPS tracker or CAN bus device');
    }
    if (linked.structure_linked && b.device_type !== 'climate_kit') {
      throw new HttpError(409, 'A device assigned to a structure must remain a climate kit');
    }
  }
  const res1 = await q(`UPDATE iot_devices SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE device_id = ?`, [...Object.values(b), req.params.id]);
  if (!res1.affectedRows) throw new HttpError(404, 'Device not found');
  await auditReq(req, 'device_updated', 'iot_device', { device_id: req.params.id, ...b });
  res.json({ ok: true });
}));

r.delete('/:id', authorize(ROLES.SYSADMIN), wrap(async (req, res) => {
  const device = await tx(async (execute) => {
    const [row] = await execute('SELECT device_id, device_type, serial_no FROM iot_devices WHERE device_id = ? FOR UPDATE', [req.params.id]);
    if (!row) throw new HttpError(404, 'Device not found');
    await execute('UPDATE livestock SET collar_device_id = NULL WHERE collar_device_id = ?', [req.params.id]);
    await execute('UPDATE machinery SET tracker_device_id = NULL WHERE tracker_device_id = ?', [req.params.id]);
    await execute('UPDATE structures SET sensor_device_id = NULL WHERE sensor_device_id = ?', [req.params.id]);
    await execute('DELETE FROM iot_devices WHERE device_id = ?', [req.params.id]);
    return row;
  });
  await auditReq(req, 'device_deleted', 'iot_device', {
    device_id: device.device_id, device_type: device.device_type, serial_no: device.serial_no,
  });
  res.json({ ok: true });
}));

export default r;
