import { randomUUID } from 'crypto';
import { q } from '../db.js';
import { sendSms, sendEmail, sendPush } from './notify.js';

/** True while an unresolved alert of this type exists for the entity (prevents alert storms). */
export async function activeAlertExists(type, entityId, withinHours = 0) {
  const rows = await q(
    `SELECT 1 FROM alerts WHERE alert_type = ? AND entity_id = ?
       AND (status <> 'resolved' OR created_at > NOW(3) - INTERVAL ? HOUR) LIMIT 1`,
    [type, String(entityId), withinHours],
  );
  return rows.length > 0;
}

async function recipientsFor(module, level) {
  const rows = await q(
    `SELECT u.user_id, u.phone, u.email, r.channels
       FROM alert_recipients r
       JOIN thresholds t ON t.threshold_id = r.threshold_id
       JOIN users u ON u.user_id = r.user_id
      WHERE t.module = ? AND r.level = ? AND u.status = 'active'`,
    [module, level],
  );
  const merged = new Map();
  for (const r of rows) {
    const m = merged.get(r.user_id) ?? { ...r, channels: new Set() };
    r.channels.split(',').map((c) => c.trim()).filter(Boolean).forEach((c) => m.channels.add(c));
    if (level === 1 && r.email) m.channels.add('email');
    merged.set(r.user_id, m);
  }
  return [...merged.values()];
}

async function dispatch(alertId, module, level, text, subject) {
  const recipients = await recipientsFor(module, level);
  await Promise.allSettled(
    recipients.flatMap((r) => [...r.channels].map(async (channel) => {
      const res = await q('INSERT INTO notifications (alert_id, recipient_id, channel, status) VALUES (?,?,?,"queued")', [alertId, r.user_id, channel]);
      const id = res.insertId;
      const ok = channel === 'sms' ? await sendSms(r.phone, text)
        : channel === 'email' ? await sendEmail(r.email, subject, text)
        : await sendPush(r.user_id, text);
      await q('UPDATE notifications SET status = ?, attempts = attempts + 1, sent_at = NOW(3) WHERE notification_id = ?', [ok ? 'sent' : 'failed', id]);
    })),
  );
}

/** Create an alert and notify level-1 recipients (SMS / push / email). Notification delivery is not awaited. */
export async function raiseAlert({ type, severity, module, entityType, entityId, message, dedupeHours = 0, dedupe = true }) {
  if (dedupe && await activeAlertExists(type, entityId, dedupeHours)) return null;
  const alertId = randomUUID();
  await q(
    `INSERT INTO alerts (alert_id, alert_type, severity, source_module, entity_type, entity_id, message, status)
     VALUES (?,?,?,?,?,?,?, 'open')`,
    [alertId, type, severity, module, entityType, String(entityId), message],
  );
  dispatch(alertId, module, 1, `[SAFM ${severity.toUpperCase()}] ${message}`, `SAFM ${severity} alert: ${type}`)
    .catch((e) => console.error('[alerts] dispatch failed', e.message));
  return alertId;
}

/** Critical alerts unacknowledged for 15 minutes are escalated to level-2 recipients. */
export async function escalateDueAlerts() {
  const due = await q(`SELECT alert_id, source_module, message FROM alerts
                        WHERE severity = 'critical' AND status = 'open' AND created_at < NOW(3) - INTERVAL 15 MINUTE`);
  for (const a of due) {
    const res = await q("UPDATE alerts SET status = 'escalated', escalated_at = NOW(3) WHERE alert_id = ? AND status = 'open'", [a.alert_id]);
    if (res.affectedRows) {
      await dispatch(a.alert_id, a.source_module, 2, `[SAFM ESCALATION] Critical alert not acknowledged: ${a.message}`, 'SAFM escalation');
    }
  }
  return due.length;
}
