import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { config } from './config.js';

const schemaPath = fileURLToPath(new URL('../../database/schema.sql', import.meta.url));
let connection;

try {
  const schema = await readFile(schemaPath, 'utf8');
  const expectedTables = [...schema.matchAll(/CREATE TABLE\s+`?([a-z0-9_]+)`?/gi)].map(([, name]) => name);
  connection = await mysql.createConnection({
    ...config.db,
    multipleStatements: true,
    timezone: 'Z',
  });

  const [tables] = await connection.query(
    'SELECT TABLE_NAME FROM information_schema.tables WHERE table_schema = DATABASE()',
  );
  if (tables.length > 0) {
    const names = tables.map(({ TABLE_NAME }) => TABLE_NAME).join(', ');
    throw new Error(
      `Refusing to apply the initial schema because ${config.db.database} already contains tables: ${names}.`,
    );
  }

  await connection.query(schema);

  const [createdTables] = await connection.query(
    'SELECT TABLE_NAME FROM information_schema.tables WHERE table_schema = DATABASE()',
  );
  const created = new Set(createdTables.map(({ TABLE_NAME }) => TABLE_NAME));
  const missing = expectedTables.filter((name) => !created.has(name));
  if (missing.length > 0) {
    throw new Error(`Schema execution did not create all expected tables. Missing: ${missing.join(', ')}.`);
  }

  console.log(`Database schema created successfully in "${config.db.database}".`);
} catch (error) {
  console.error(`Database setup failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (connection) await connection.end();
}
