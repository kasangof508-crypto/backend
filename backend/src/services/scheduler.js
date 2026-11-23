import cron from 'node-cron';
import { q } from '../db.js';
import { escalateDueAlerts } from './alertService.js';

export function startScheduler() {
  // every minute: escalate unacknowledged critical alerts (15 min rule) and flag silent devices as offline
  cron.schedule('* * * * *', async () => {
    try {
      await escalateDueAlerts();
      await q("UPDATE iot_devices SET status = 'offline' WHERE status = 'active' AND last_seen_at IS NOT NULL AND last_seen_at < NOW(3) - INTERVAL 30 MINUTE");
    } catch (e) { console.error('[scheduler]', e.message); }
  });
  // daily 03:00 UTC: purge expired refresh tokens
  cron.schedule('0 3 * * *', () => q('DELETE FROM refresh_tokens WHERE expires_at < NOW(3) OR revoked = 1').catch(() => {}));
}
