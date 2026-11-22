import nodemailer from 'nodemailer';
import { config } from '../config.js';

let mailer = null;
const getMailer = () => {
  if (!config.smtp.host) return null;
  mailer ??= nodemailer.createTransport({
    host: config.smtp.host, port: config.smtp.port, secure: config.smtp.port === 465,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
  return mailer;
};

/** SMS via a third-party REST gateway; retries 3 times. Simulated (logged) when SMS_API_URL is not set. */
export async function sendSms(phone, text, retries = 3) {
  if (!config.sms.url) { console.log(`[SMS simulated] ${phone}: ${text}`); return true; }
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(config.sms.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apiKey: config.sms.key },
        body: JSON.stringify({ to: phone, message: text }),
        signal: AbortSignal.timeout(10000),
      });
      if (r.ok) return true;
    } catch { /* retry */ }
  }
  return false;
}

export async function sendEmail(to, subject, text) {
  const m = getMailer();
  if (!m) { console.log(`[Email simulated] ${to}: ${subject}`); return true; }
  try { await m.sendMail({ from: config.smtp.from, to, subject, text }); return true; } catch (e) { console.error('[email]', e.message); return false; }
}

/**
 * In-app push. The web/mobile clients poll /alerts, so "sent" means the alert is available in the feed.
 * Plug Firebase Cloud Messaging in here for native push on the Android app.
 */
export async function sendPush(_userId, text) {
  console.log(`[Push/in-app] ${text}`);
  return true;
}
