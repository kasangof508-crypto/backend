import mysql from 'mysql2/promise';
import { config } from './config.js';

export const pool = mysql.createPool({
  ...config.db,
  waitForConnections: true,
  connectionLimit: 10,
  maxIdle: 3,
  idleTimeout: 5 * 60_000,
  timezone: 'Z',          // JS Dates are exchanged as UTC
  decimalNumbers: true,   // DECIMAL columns come back as numbers
  dateStrings: false,
});

// Keep MySQL's NOW() in UTC too
pool.pool.on('connection', (conn) => conn.query("SET time_zone = '+00:00'"));

/** Run a parameterised query and return rows (or the result header for writes). */
export async function q(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

export async function tx(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn((sql, params = []) => conn.query(sql, params).then(([r]) => r));
    await conn.commit();
    return result;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}
