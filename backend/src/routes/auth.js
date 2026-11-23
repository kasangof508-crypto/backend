import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto, { randomUUID } from 'crypto';
import { z } from 'zod';
import { q } from '../db.js';
import { config } from '../config.js';
import { HttpError, wrap } from '../utils/http.js';
import { authenticate } from '../middleware/auth.js';
import { audit, auditReq } from '../middleware/audit.js';

const r = Router();
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const publicUser = (u) => ({ user_id: u.user_id, full_name: u.full_name, email: u.email, role: u.role_name, preferred_language: u.preferred_language });
const MAX_ATTEMPTS = 5;

async function issueTokens(u) {
  const accessToken = jwt.sign({ sub: u.user_id, role: u.role_name, name: u.full_name }, config.jwtSecret, { expiresIn: config.accessTtl });
  const refreshToken = crypto.randomBytes(48).toString('hex');
  await q('INSERT INTO refresh_tokens (token_id, user_id, token_hash, issued_at, expires_at) VALUES (?,?,?,NOW(3), NOW(3) + INTERVAL ? DAY)',
    [randomUUID(), u.user_id, sha(refreshToken), config.refreshDays]);
  return { accessToken, refreshToken, user: publicUser(u) };
}
const loadUser = (where, v) => q(`SELECT u.*, r.role_name FROM users u JOIN roles r ON r.role_id = u.role_id WHERE ${where}`, [v]).then((x) => x[0]);

r.post('/login', wrap(async (req, res) => {
  const { email, password, selectedRole } = z.object({
    email: z.string().email(), password: z.string().min(1),
    selectedRole: z.enum(['Farm Administrator', 'Field Worker', 'Veterinarian', 'Machinery Operator', 'System Administrator']),
  }).parse(req.body);
  const u = await loadUser('u.email = ?', email.toLowerCase());
  const fail = async (why) => { await audit({ userId: u?.user_id ?? null, ip: req.ip, action: 'login_failed', entity: 'user', details: { email, why } }); };
  if (!u || u.status === 'deleted') { await fail('unknown'); throw new HttpError(401, 'Invalid email or password'); }
  if (u.status !== 'active') { await fail('suspended'); throw new HttpError(403, 'Account is suspended'); }
  if (u.locked_until && new Date(u.locked_until) > new Date()) { await fail('locked'); throw new HttpError(423, 'Account temporarily locked. Try again later.'); }
  if (!(await bcrypt.compare(password, u.password_hash))) {
    const attempts = u.failed_attempts + 1;
    if (attempts >= MAX_ATTEMPTS) await q('UPDATE users SET failed_attempts = 0, locked_until = NOW(3) + INTERVAL 15 MINUTE WHERE user_id = ?', [u.user_id]);
    else await q('UPDATE users SET failed_attempts = ? WHERE user_id = ?', [attempts, u.user_id]);
    await fail('bad_password');
    throw new HttpError(401, 'Invalid email or password');
  }
  if (u.role_name !== selectedRole) {
    await fail('role_mismatch');
    throw new HttpError(403, 'This account does not use the selected role. Return to role selection and choose the correct role.');
  }
  const [tokens] = await Promise.all([
    issueTokens(u),
    q('UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = NOW(3) WHERE user_id = ?', [u.user_id]),
    audit({ userId: u.user_id, ip: req.ip, action: 'login', entity: 'user' }),
  ]);
  res.json(tokens);
}));

/** Refresh-token rotation; re-use of a rotated token revokes the whole family. */
r.post('/refresh', wrap(async (req, res) => {
  const { refreshToken } = z.object({ refreshToken: z.string().min(20) }).parse(req.body);
  const [t] = await q('SELECT * FROM refresh_tokens WHERE token_hash = ?', [sha(refreshToken)]);
  if (!t) throw new HttpError(401, 'Invalid refresh token');
  if (t.revoked) {
    await q('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?', [t.user_id]);
    await audit({ userId: t.user_id, ip: req.ip, action: 'refresh_reuse_detected', entity: 'user' });
    throw new HttpError(401, 'Refresh token re-use detected; please sign in again');
  }
  if (new Date(t.expires_at) < new Date()) throw new HttpError(401, 'Refresh token expired');
  await q('UPDATE refresh_tokens SET revoked = 1 WHERE token_id = ?', [t.token_id]);
  const u = await loadUser('u.user_id = ?', t.user_id);
  if (!u || u.status !== 'active') throw new HttpError(401, 'Account not active');
  res.json(await issueTokens(u));
}));

r.post('/logout', wrap(async (req, res) => {
  const { refreshToken } = req.body ?? {};
  if (refreshToken) await q('UPDATE refresh_tokens SET revoked = 1 WHERE token_hash = ?', [sha(refreshToken)]);
  res.json({ ok: true });
}));

r.get('/me', authenticate, wrap(async (req, res) => {
  const u = await loadUser('u.user_id = ?', req.user.sub);
  if (!u) throw new HttpError(401, 'User not found');
  res.json(publicUser(u));
}));

// ---- Device-bound (biometric) sign-in: the phone signs a one-time challenge with a key unlocked by fingerprint/face ----
const challenges = new Map(); // challengeId -> { email, nonce, exp }

r.post('/devices/register', authenticate, wrap(async (req, res) => {
  const b = z.object({ device_name: z.string().max(80), public_key: z.string().min(50), fcm_token: z.string().optional() }).parse(req.body);
  const id = randomUUID();
  await q('INSERT INTO user_devices (device_id, user_id, device_name, public_key, fcm_token) VALUES (?,?,?,?,?)', [id, req.user.sub, b.device_name, b.public_key, b.fcm_token ?? null]);
  await auditReq(req, 'device_registered', 'user_device', { device_id: id });
  res.status(201).json({ device_id: id });
}));

r.post('/device/challenge', wrap(async (req, res) => {
  const { email } = z.object({ email: z.string().email() }).parse(req.body);
  const challengeId = randomUUID();
  const nonce = crypto.randomBytes(32).toString('base64');
  challenges.set(challengeId, { email: email.toLowerCase(), nonce, exp: Date.now() + 120_000 });
  res.json({ challengeId, nonce });
}));

r.post('/device/login', wrap(async (req, res) => {
  const b = z.object({ challengeId: z.string(), signature: z.string(), auth_method: z.enum(['fingerprint', 'face']).default('fingerprint') }).parse(req.body);
  const c = challenges.get(b.challengeId);
  challenges.delete(b.challengeId);
  if (!c || c.exp < Date.now()) throw new HttpError(401, 'Challenge expired');
  const u = await loadUser('u.email = ?', c.email);
  if (!u || u.status !== 'active') throw new HttpError(401, 'Invalid credentials');
  const keys = await q('SELECT public_key FROM user_devices WHERE user_id = ? AND is_active = 1', [u.user_id]);
  const ok = keys.some((k) => { try { return crypto.verify('sha256', Buffer.from(c.nonce), k.public_key, Buffer.from(b.signature, 'base64')); } catch { return false; } });
  if (!ok) { await audit({ userId: u.user_id, ip: req.ip, action: 'login_failed', entity: 'user', details: { why: 'bad_signature' } }); throw new HttpError(401, 'Invalid credentials'); }
  await q('UPDATE users SET last_login_at = NOW(3) WHERE user_id = ?', [u.user_id]);
  await audit({ userId: u.user_id, ip: req.ip, action: 'login', entity: 'user', details: { method: b.auth_method } });
  res.json(await issueTokens(u));
}));

export default r;
