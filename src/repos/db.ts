// src/repos/db.ts
import path from 'path';
import dotenv from 'dotenv';
import { Pool } from 'pg';

// Load .env from repo root: /home/ubuntu/loopdup-mvp/.env
const ROOT_ENV = path.resolve(__dirname, '../../../../.env');
dotenv.config({ path: ROOT_ENV });
console.log('[env.load]', { loadedFrom: ROOT_ENV });

const connectionString = process.env.DATABASE_URL || '';
if (!connectionString) {
  throw new Error('[db] Missing DATABASE_URL env (check .env at repo root)');
}

export const db = new Pool({
  connectionString,
  max: 10,
  idleTimeoutMillis: 30000,
});

db.on('error', (err) => {
  console.error('[db] unexpected error on idle client', err);
});
