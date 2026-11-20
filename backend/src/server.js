import { config } from './config.js';
import { createApp } from './app.js';
import { startScheduler } from './services/scheduler.js';
import { pool } from './db.js';

const app = createApp();
const server = app.listen(config.port, () => console.log(`SAFM-SYS API listening on :${config.port}`));
Promise.all(Array.from({ length: 3 }, () => pool.query('SELECT 1')))
  .then(() => console.log('[database] Login connections warmed'))
  .catch((error) => console.error('[database] Connection warm-up failed:', error.message));
startScheduler();

const shutdown = async () => { server.close(); await pool.end().catch(() => {}); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'OK',
        message: 'API is running successfully',
        timestamp: new Date().toISOString()
    });
});
