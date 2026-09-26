import { neon } from '@neondatabase/serverless';
import { migrate } from './schema.mjs';

// One tiny interface for the whole assistant: db.query(text, params) → rows.
// Production uses Neon's HTTP driver (same as the tracker); tests hand in a
// PGlite instance so every query runs against real Postgres.

let shared = null;

export function neonDb(url) {
  const sql = neon(url);
  return { query: (text, params = []) => sql.query(text, params), kind: 'neon' };
}

export function pgliteDb(pg) {
  return { query: async (text, params = []) => (await pg.query(text, params)).rows, kind: 'pglite' };
}

// Migrations run once per warm instance (they are idempotent anyway). Two
// instances starting at once can trip over each other's CREATE, so one retry.
export async function getDb(url) {
  // Tests run against PGlite only. A test that reaches here would be talking
  // to a real database, so it is refused outright.
  if (process.env.ASSISTANT_TEST === '1') throw new Error('Tests must not connect to a real database.');
  if (shared && shared.url === url) { await shared.ready; return shared.db; }
  const db = neonDb(url);
  shared = { url, db, ready: migrate(db).catch(() => new Promise(r => setTimeout(r, 400)).then(() => migrate(db))) };
  try { await shared.ready; } catch (e) { shared = null; throw e; }
  return db;
}
