import { q } from '../db.js';

/** Append an entry to the immutable audit log. Never throws into the request path. */
export async function audit({ userId = null, ip = null, action, entity = null, details = null }) {
  try {
    await q('INSERT INTO audit_log (user_id, ip_address, action, entity, details) VALUES (?,?,?,?,?)', [
      userId, ip, action, entity, details ? JSON.stringify(details) : null,
    ]);
  } catch (e) {
    console.error('[audit] failed to write entry', e.message);
  }
}

export const auditReq = (req, action, entity, details) =>
  audit({ userId: req.user?.sub ?? null, ip: req.ip, action, entity, details });
