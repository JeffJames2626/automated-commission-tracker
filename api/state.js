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
  // ---- health check (no password, no data) — reports config status only ----
  // Lets setup be diagnosed without exposing anything sensitive.
  if (req.method === 'GET' && req.query && req.query.health === '1') {
    const out = {
      app_password_set: !!process.env.APP_PASSWORD,
      database_url_set: !!DB_URL,
      db: 'unknown'
    };
    if (!DB_URL) out.db = 'no DATABASE_URL';
    else {
      try {
        const sql = neon(DB_URL);
        await sql`CREATE TABLE IF NOT EXISTS app_state (id TEXT PRIMARY KEY, data TEXT, updated TIMESTAMPTZ NOT NULL DEFAULT now())`;
        const r = await sql`SELECT length(data) AS len, updated FROM app_state WHERE id='main'`;
        out.db = 'ok';
        out.has_data = r.length > 0;
        if (r.length) { out.data_kb = Math.round((r[0].len || 0) / 1024); out.updated = r[0].updated; }
        try { const a = await sql`SELECT count(*)::int AS n FROM audit_log`; out.audit_rows = a[0].n; }
        catch (e) { out.audit_rows = 0; }
      } catch (e) { out.db = 'fail: ' + (e.message || String(e)).slice(0, 140); }
    }
    return res.status(200).json(out);
  }

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
    // ===== APPEND-ONLY AUDIT VAULT =====
    // Every change to a logged sale is copied here with the server's own clock
    // and the sender's IP. There is deliberately NO update or delete route:
    // nobody holding just the app password can rewrite history. Proof for the
    // reps' commissions and the company's money.
    if (req.query && req.query.audit === '1') {
      await sql`CREATE TABLE IF NOT EXISTS audit_log (
        id BIGSERIAL PRIMARY KEY,
        at TIMESTAMPTZ NOT NULL DEFAULT now(),
        ip TEXT,
        entry TEXT
      )`;
      const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
      if (req.method === 'POST') {
        let body = req.body;
        if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
        const entries = body && Array.isArray(body.entries) ? body.entries.slice(0, 200) : [];
        if (!entries.length) return res.status(400).json({ error: 'no entries' });
        for (const e of entries) {
          const s = JSON.stringify(e).slice(0, 4000);
          await sql`INSERT INTO audit_log (ip, entry) VALUES (${ip}, ${s})`;
        }
        const n = await sql`SELECT count(*)::int AS n FROM audit_log`;
        return res.status(200).json({ ok: true, stored: entries.length, total: n[0].n });
      }
      if (req.method === 'GET') {
        const limit = Math.min(500, Math.max(1, parseInt(req.query.limit || '200', 10) || 200));
        const rows = await sql`SELECT id, at, ip, entry FROM audit_log ORDER BY id DESC LIMIT ${limit}`;
        const n = await sql`SELECT count(*)::int AS n FROM audit_log`;
        return res.status(200).json({ total: n[0].n, rows });
      }
      return res.status(405).json({ error: 'audit log is append-only' });
    }

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

      // --- last-write-wins protection ---
      // Every save must state which cloud version it was built on (x-base-updated,
      // the `updated` stamp it last pulled or pushed). If another device saved in
      // between, the stamps differ and this save is REJECTED (409) instead of
      // silently overwriting the other device's data. A device holding far less
      // data than the cloud (a fresh browser) must also confirm before shrinking
      // the stored state by more than half (x-allow-shrink).
      const cur = await sql`SELECT length(data) AS len, updated FROM app_state WHERE id='main'`;
      if (cur.length) {
        const base = String(req.headers['x-base-updated'] || '');
        const curStamp = new Date(cur[0].updated).toISOString();
        if (base !== curStamp) {
          return res.status(409).json({ conflict: true, updated: cur[0].updated,
            error: 'another device saved since this one last synced' });
        }
        const curLen = cur[0].len || 0;
        if (curLen > 0 && data.length < curLen * 0.5 && req.headers['x-allow-shrink'] !== '1') {
          return res.status(409).json({ shrink: true, updated: cur[0].updated,
            cloudKB: Math.round(curLen / 1024), localKB: Math.round(data.length / 1024),
            error: 'this save holds far less data than the cloud' });
        }
      }

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
