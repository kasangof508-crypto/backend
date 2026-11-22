import 'dotenv/config';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const jwtSecret = process.env.JWT_SECRET;

if (!jwtSecret) {
  throw new Error('JWT_SECRET is not set. Copy .env.example to .env and set it.');
}

export const config = {
  port: Number(env('PORT', 4000)),
  isProd: env('NODE_ENV', 'development') === 'production',
  corsOrigin: env('CORS_ORIGIN', 'http://localhost:5173'),
  db: {
    host: env('DB_HOST', '127.0.0.1'),
    port: Number(env('DB_PORT', 3306)),
    user: env('DB_USER', 'root'),
    password: env('DB_PASSWORD', ''),
    database: env('DB_NAME', 'safm_sys'),
  },
  jwtSecret,
  accessTtl: env('ACCESS_TOKEN_TTL', '15m'),
  refreshDays: Number(env('REFRESH_TOKEN_DAYS', 7)),
  sms: { url: env('SMS_API_URL', ''), key: env('SMS_API_KEY', '') },
  smtp: {
    host: env('SMTP_HOST', ''), port: Number(env('SMTP_PORT', 587)),
    user: env('SMTP_USER', ''), pass: env('SMTP_PASS', ''), from: env('SMTP_FROM', 'alerts@safm.local'),
  },
  mpesa: {
    environment: env('MPESA_ENV', 'sandbox'),
    consumerKey: env('MPESA_CONSUMER_KEY', ''),
    consumerSecret: env('MPESA_CONSUMER_SECRET', ''),
    shortcode: env('MPESA_SHORTCODE', ''),
    passkey: env('MPESA_PASSKEY', ''),
    transactionType: env('MPESA_TRANSACTION_TYPE', 'CustomerPayBillOnline'),
    callbackUrl: env('MPESA_CALLBACK_URL', ''),
    callbackToken: createHmac('sha256', jwtSecret).update('safm-sys:mpesa-callback').digest('hex'),
  },
  seedPassword: env('SEED_PASSWORD', ''),
  reportDir: fileURLToPath(new URL('../storage/reports/', import.meta.url)),
};

export const ROLES = {
  ADMIN: 'Farm Administrator',
  WORKER: 'Field Worker',
  VET: 'Veterinarian',
  OPERATOR: 'Machinery Operator',
  SYSADMIN: 'System Administrator',
};
