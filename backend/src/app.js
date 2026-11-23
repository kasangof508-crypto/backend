import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { config, ROLES } from './config.js';
import { pool } from './db.js';
import { authenticate } from './middleware/auth.js';
import { errorHandler, wrap } from './utils/http.js';

import auth from './routes/auth.js';
import users from './routes/users.js';
import devices from './routes/devices.js';
import zones from './routes/zones.js';
import tasks from './routes/tasks.js';
import { attendanceRouter, locationsRouter } from './routes/workforce.js';
import livestock from './routes/livestock.js';
import production from './routes/production.js';
import payroll from './routes/payroll.js';
import payments from './routes/payments.js';
import machinery from './routes/machinery.js';
import structures from './routes/structures.js';
import alerts from './routes/alerts.js';
import thresholds from './routes/thresholds.js';
import reports from './routes/reports.js';
import dashboard from './routes/dashboard.js';
import audit from './routes/audit.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);                       // behind Nginx
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigin.split(','), credentials: false }));
  app.use(express.json({ limit: '100kb' }));
  if (!config.isProd) app.use(morgan('dev', { skip: (req) => req.path.startsWith('/api/v1/payments/mpesa/callback/') }));

  app.get('/health', wrap(async (_req, res) => { await pool.query('SELECT 1'); res.json({ status: 'ok', time: new Date() }); }));

  // 20 login attempts / 15 min / IP on top of the per-account lockout
  app.use('/api/v1/auth/login', rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many login attempts' } }));
  app.use('/api/v1/auth', auth);
  app.use('/api/v1/payments', payments);

  // Everything below needs a valid JWT and is limited to 100 requests/minute per user (SRS 5.3)
  const api = express.Router();
  api.use(authenticate);
  api.use(rateLimit({ windowMs: 60_000, limit: 100, keyGenerator: (req) => req.user.sub, standardHeaders: true, legacyHeaders: false, message: { error: 'Rate limit exceeded (100 requests/minute)' } }));
  api.use('/users', users);
  api.use('/devices', devices);
  api.use('/zones', zones);
  api.use('/tasks', tasks);
  api.use('/attendance', attendanceRouter);
  api.use('/locations', locationsRouter);
  api.use('/livestock', livestock);
  api.use('/production', production);
  api.use('/payroll', payroll);
  api.use('/machinery', machinery);
  api.use('/structures', structures);
  api.use('/alerts', alerts);
  api.use('/thresholds', thresholds);
  api.use('/reports', reports);
  api.use('/dashboard', dashboard);
  api.use('/audit-log', audit);
  app.use('/api/v1', api);

  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(errorHandler);
  return app;
}
export { ROLES };
