// Live cloud state for the Automated Commission Tracker.
// Stores the whole app state as one JSON document in a private Postgres (Neon)
// database, gated by a shared password. The browser app auto-loads on open and
// auto-saves on change, so data is the same on every device — no manual restore.
//
// Env vars needed (set in Vercel → Settings → Environment Variables):
//   DATABASE_URL (or POSTGRES_URL) — added automatically when you create a
//                                    Vercel Postgres/Neon store and link the project
//   APP_PASSWORD                   — the password that unlocks the tracker
//
// The app degrades to local-only if this API is unreachable, so it never breaks.

import { neon } from '@neondatabase/serverless';

const DB_URL =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.POSTGRES_PRISMA_URL ||
  process.env.DATABASE_URL_UNPOOLED ||
  '';

export const config = { api: { bodyParser: { sizeLimit: '8mb' } } };

function unauthorized(res) {
  return res.status(401).json({ error: 'unauthorized' });
}

export default async function handler(req, res) {
  // ---- password gate ----
  const want = process.env.APP_PASSWORD || '';
  const got = req.headers['x-app-password'] || '';
  if (!want) return res.status(500).json({ error: 'APP_PASSWORD is not set on the server' });
  if (got !== want) return unauthorized(res);

  if (!DB_URL) return res.status(500).json({ error: 'No database is connected yet (DATABASE_URL missing)' });

  let sql;
  try {
    sql = neon(DB_URL);
    await sql`CREATE TABLE IF NOT EXISTS app_state (
      id TEXT PRIMARY KEY,
      data TEXT,
      updated TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  } catch (e) {
    return res.status(500).json({ error: 'DB connect failed: ' + (e.message || String(e)) });
  }

  try {
    if (req.method === 'GET') {
      const rows = await sql`SELECT data, updated FROM app_state WHERE id = 'main'`;
      if (!rows.length) return res.status(200).json({ empty: true });
      return res.status(200).json({ data: rows[0].data, updated: rows[0].updated });
    }

    if (req.method === 'POST') {
      // Body is the state JSON as a plain string (may arrive parsed or raw).
      let data = req.body;
      if (data && typeof data === 'object') data = data.data != null ? data.data : JSON.stringify(data);
      if (typeof data !== 'string') data = String(data == null ? '' : data);
      if (!data || data.length < 2) return res.status(400).json({ error: 'empty body' });
      const r = await sql`
        INSERT INTO app_state (id, data, updated) VALUES ('main', ${data}, now())
        ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated = now()
        RETURNING updated`;
      return res.status(200).json({ ok: true, updated: r[0].updated });
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: 'DB op failed: ' + (e.message || String(e)) });
  }
}
