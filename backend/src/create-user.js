import bcrypt from 'bcryptjs';
import crypto, { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { pool, tx, q } from './db.js';

const prompt = createInterface({ input, output });
const answers = prompt[Symbol.asyncIterator]();
const ask = async (label) => {
  output.write(label);
  const { value, done } = await answers.next();
  if (done) throw new Error('Input ended before account details were complete.');
  return value;
};

try {
  const fullName = (await ask('Full name: ')).trim();
  const email = (await ask('Email: ')).trim().toLowerCase();
  const phone = (await ask('Phone (international format, e.g. +254700000000): ')).trim();

  if (fullName.length < 2 || fullName.length > 100) throw new Error('Name must be between 2 and 100 characters.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120) throw new Error('Enter a valid email address.');
  if (!/^\+?\d{9,15}$/.test(phone)) throw new Error('Enter a phone number in international format.');

  const roles = await q('SELECT role_id, role_name FROM roles ORDER BY role_id');
  if (roles.length === 0) throw new Error('No roles found. Initialize the database schema first.');
  console.log('\nAvailable roles:');
  for (const role of roles) console.log(`- ${role.role_name}`);
  const roleName = (await ask('Role name: ')).trim().toLowerCase();
  const role = roles.find((item) => item.role_name.toLowerCase() === roleName);
  if (!role) throw new Error('Choose one of the listed role names.');

  const password = `Aa9!${crypto.randomBytes(18).toString('base64url')}`;
  const passwordHash = await bcrypt.hash(password, 12);
  const userId = randomUUID();
  await tx(async (execute) => {
    await execute(
      'INSERT INTO users (user_id, full_name, email, phone, password_hash, role_id, consent_at) VALUES (?,?,?,?,?,?,NOW(3))',
      [userId, fullName, email, phone, passwordHash, role.role_id],
    );
    await execute('INSERT INTO audit_log (user_id, action, entity, details) VALUES (?,?,?,?)', [
      userId, 'user_created', 'user', JSON.stringify({ email, role: role.role_name, source: 'account_setup' }),
    ]);
  });

  console.log('\nAccount created. Save this password now; it will not be shown again.');
  console.log(`Email: ${email}`);
  console.log(`Role: ${role.role_name}`);
  console.log(`Password: ${password}`);
} catch (error) {
  console.error(`Account creation failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  prompt.close();
  await pool.end();
}
