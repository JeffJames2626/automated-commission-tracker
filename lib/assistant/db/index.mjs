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

// Migrations run once per warm instance (they are idempotent anyway).
export async function getDb(url) {
  if (shared && shared.url === url) { await shared.ready; return shared.db; }
  const db = neonDb(url);
  shared = { url, db, ready: migrate(db) };
  try { await shared.ready; } catch (e) { shared = null; throw e; }
  return db;
}
