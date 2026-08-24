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
import crypto from 'node:crypto';

// ===== GOOGLE SIGN-IN + SESSIONS =====
// "Log in with Google": the browser gets an ID token from Google, we verify it
// against Google's tokeninfo endpoint, check the email against the users table,
// and hand back a signed 30-day session token. Requests may authenticate with
// either that session token (x-session) or the legacy shared password
// (x-app-password) — so nothing breaks while people migrate to real logins.
const ROOT_ADMIN = 'jeff@automatedlawnandpest.com';   // seeded as admin when the users table is empty
// Only company Google accounts may ever sign in or be added to the team list.
// Checked against the VERIFIED email Google returns (never a typed one), after
// lowercasing and trimming, on an exact domain match — so gmail.com, a
// look-alike like automatedlawnandpest.co, or a sub-domain all fail.
const ALLOWED_DOMAIN = (process.env.ALLOWED_DOMAIN || 'automatedlawnandpest.com').toLowerCase();
function normEmail(e) { return String(e || '').trim().toLowerCase(); }
function companyEmail(e) {
  e = normEmail(e);
  const at = e.lastIndexOf('@');
  return at > 0 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && e.slice(at + 1) === ALLOWED_DOMAIN;
}
// The Google OAuth Client ID is PUBLIC by design (it ships in page JS on every
// site using Google sign-in), so it lives here in code. An env var, if ever
// set, still takes precedence.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ||
  '96381167271-fg32gstb7df6k19fe0fe0dm0v64k0khr.apps.googleusercontent.com';
// Set SESSION_SECRET in Vercel so session signing does not share a key with the
// tracker password (until then it falls back to APP_PASSWORD so nothing breaks).
function sessSecret() { return process.env.SESSION_SECRET || process.env.APP_PASSWORD || ''; }
function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', sessSecret()).update(body).digest('base64url');
  return body + '.' + sig;
}
function verifySession(token) {
  try {
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig) return null;
    const want = crypto.createHmac('sha256', sessSecret()).update(body).digest('base64url');
    if (!safeEqual(sig, want)) return null;
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!p.e || !p.x || Date.now() > p.x) return null;
    return p;   // {e: email, n: name, r: role, x: expiry}
  } catch (e) { return null; }
}
async function ensureUsers(sql) {
  await sql`CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY, name TEXT, role TEXT NOT NULL DEFAULT 'rep',
    added_by TEXT, added_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login TIMESTAMPTZ`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub TEXT`;
  const n = await sql`SELECT count(*)::int AS n FROM users`;
  if (!n[0].n) await sql`INSERT INTO users (email, name, role, added_by) VALUES (${ROOT_ADMIN}, 'Jeff James', 'admin', 'bootstrap')`;
}

// ===== ROLE PROJECTION =====
// The browser can hide a number; only the server can decline to send it. A
// non-admin session gets a state document with other people's compensation,
// other people's sales, ledger, hours and the company's billing removed — so
// "hidden" is not the only thing standing between a rep and the payroll of the
// whole company.
// The mirror rule applies on the way back in: a client may not change what it
// was never sent, so every withheld record is restored from the stored document
// before a non-admin's save is written.
// Scope comes from the STORED roster (which only an admin can edit) plus the
// session role. A person cannot widen their own scope by editing their own
// record, because their record is one of the things they may not write.
const COMP_FIELDS = ['rate','hrsIn','hrsOff','offMonths','commNew','commUp','commRenew','commOv',
  'std','win','val','hit','goal','floor','salesPct','acv','pin','caps','hours','note','payFrom','scored'];
// Never writable from a non-admin session, for ANYONE — including themselves.
// A rep raising their own commission rate, or handing themselves a capability
// or the admin flag, is the obvious attack and it must not depend on the UI.
const WRITE_PROTECTED = COMP_FIELDS.concat(['admin']);
// Mirror of the client's bundles. Kept deliberately in step with ROLE_CAPS in
// the app; the two are compared by the projection tests.
const ROLE_CAPS = {
  manager:  ['view_own_sales','view_team_sales','view_own_commission','view_team_commission',
             'view_clients','edit_clients','view_properties','edit_sales','view_data_hawk','view_revenue'],
  sales:    ['view_own_sales','view_own_commission','view_clients','view_properties','edit_sales','edit_clients'],
  estimator:['view_own_sales','view_own_commission','view_clients','view_properties','edit_sales','edit_clients'],
  csr:      ['view_clients','edit_clients','view_properties','view_data_hawk'],
  office:   ['view_clients','edit_clients','view_properties','view_data_hawk'],
  billing:  ['view_clients','view_properties','view_client_financials','view_revenue','view_data_hawk','export_data'],
  tech:     ['view_properties'],
  field:    ['view_properties']
};
// 'owner' is deliberately absent: company scope comes from the users table,
// never from a job title on the roster.
function roleKeysOf(p) {
  const out = [];
  if (!p) return out;
  (Array.isArray(p.roles) ? p.roles : []).forEach(r => { if (ROLE_CAPS[r]) out.push(r); });
  if (/billing|account/i.test(p.title || '')) out.push('billing');
  if (/csr|customer/i.test(p.title || '')) out.push('csr');
  return out.filter((v, i, a) => a.indexOf(v) === i);
}
function meIdOf(doc, email) {
  const e = String(email || '').toLowerCase();
  if (!e || !doc || !Array.isArray(doc.people)) return '';
  const hit = doc.people.find(p =>
    String(p.email || '').toLowerCase() === e ||
    String((p.google && p.google.email) || '').toLowerCase() === e ||
    (Array.isArray(p.altEmails) && p.altEmails.some(a => String(a || '').toLowerCase() === e)));
  return hit ? hit.id : '';
}
// Everything the projection needs about the person asking, worked out from the
// stored document. Fails closed: an email nobody on the roster owns gets nothing.
function whoCtx(doc, email) {
  const people = Array.isArray(doc && doc.people) ? doc.people : [];
  const me = meIdOf(doc, email);
  const mine = me ? people.find(p => p && p.id === me) : null;
  const caps = {};
  roleKeysOf(mine).forEach(r => (ROLE_CAPS[r] || []).forEach(c => { caps[c] = 1; }));
  (mine && Array.isArray(mine.caps) ? mine.caps : []).forEach(c => { caps[c] = 1; });
  const team = me ? people.filter(p => p && p.mgr === me).map(p => p.id).concat([me]) : [];
  const sales = caps.view_company_sales ? 'all' : caps.view_team_sales ? 'team' : caps.view_own_sales ? 'own' : 'none';
  const money = caps.view_all_commissions ? 'all' : caps.view_team_commission ? 'team' : caps.view_own_commission ? 'own' : 'none';
  const idsFor = sc => sc === 'team' ? team : sc === 'own' ? (me ? [me] : []) : [];
  return {
    me: me, caps: caps, sales: sales, money: money,
    salesIds: idsFor(sales), moneyIds: idsFor(money),
    financial: !!(caps.view_client_financials || caps.view_revenue)
  };
}
function sharesOf(r) {
  if (r && Array.isArray(r.split) && r.split.length) {
    const t = r.split.reduce((a, s) => a + (+s.pct || 0), 0);
    if (t > 0) return r.split.filter(s => (+s.pct || 0) > 0).map(s => s.rep);
  }
  return [r && r.rep];
}
function rowVisible(ctx, r) {
  if (ctx.sales === 'all') return true;
  if (ctx.sales === 'none' || !r) return false;
  return sharesOf(r).some(id => ctx.salesIds.indexOf(id) > -1);
}
function ownedVisible(ctx, x, field) {
  if (ctx.money === 'all') return true;
  if (ctx.money === 'none' || !x) return false;
  return ctx.moneyIds.indexOf(x[field]) > -1;
}
function keepVisible(list, ok) { return (Array.isArray(list) ? list : []).filter(ok); }

function projectState(raw, email) {
  let doc;
  try { doc = JSON.parse(raw); } catch (e) { return raw; }   // unparseable: send as-is rather than break the app
  if (!doc || typeof doc !== 'object') return raw;
  const ctx = whoCtx(doc, email);
  const seesMoneyOf = id => ctx.money === 'all' || (id && ctx.moneyIds.indexOf(id) > -1);
  if (Array.isArray(doc.people)) {
    doc.people = doc.people.map(p => {
      if (!p || p.id === ctx.me || seesMoneyOf(p.id)) return p;
      const c = Object.assign({}, p);
      COMP_FIELDS.forEach(f => { delete c[f]; });
      c.compHidden = true;              // the client knows the figure is withheld, not zero
      return c;
    });
  }
  // Sales, ledger, disputes and hours: only what this person's job covers.
  if (ctx.sales !== 'all') doc.rows = keepVisible(doc.rows, r => rowVisible(ctx, r));
  if (ctx.money !== 'all') {
    doc.payouts  = keepVisible(doc.payouts,  x => ownedVisible(ctx, x, 'emp'));
    doc.disputes = keepVisible(doc.disputes, x => ownedVisible(ctx, x, 'rep'));
    doc.hours    = keepVisible(doc.hours,    x => ownedVisible(ctx, x, 'rep'));
  }
  // Client billing: invoices, payments and open balances are money owed to the
  // company, not to a rep. Only billing, managers and the owner get them.
  if (!ctx.financial) {
    ['invoices','payments','openinv','paidinv','invsyncs','paysyncs','balsyncs','pdisyncs','invlinks','invclimap','invassign'].forEach(k => {
      if (Array.isArray(doc[k])) doc[k] = [];
    });
  }
  return JSON.stringify(doc);
}
// Keep what the caller was allowed to see (their version wins), and put back
// verbatim every record that was withheld from them.
//   visible   — the caller was sent this record, so their edit stands
//   deletable — the caller may drop it entirely (defaults to visible)
//   allowNew  — the caller may add a record of this kind at all
function mergeById(incList, storedList, opts) {
  const inc = Array.isArray(incList) ? incList : [];
  const stored = Array.isArray(storedList) ? storedList : [];
  const visible = opts.visible || (() => false);
  const allowNew = opts.allowNew || (() => false);
  const deletable = opts.deletable || visible;
  const incBy = new Map();
  inc.forEach(x => { if (x && x.id != null && !incBy.has(x.id)) incBy.set(x.id, x); });
  const out = [], used = new Set();
  stored.forEach(x => {
    if (!x || x.id == null) { out.push(x); return; }
    used.add(x.id);
    if (!visible(x)) { out.push(x); return; }        // withheld: the stored record always wins
    const v = incBy.get(x.id);
    if (v !== undefined) { out.push(v); return; }    // shown to them and returned: their edit stands
    if (!deletable(x)) out.push(x);                  // shown to them, dropped, but not theirs to remove
  });
  inc.forEach(x => { if (x && (x.id == null || !used.has(x.id)) && allowNew(x)) out.push(x); });
  return out;
}
// A person record is an admin's document. On a non-admin save only these fields
// of THEIR OWN record are taken from the browser; everything else — pay, caps,
// the admin flag, roles, who they report to, their email — comes from what is
// stored, because the org chart is the thing scope is calculated from.
const SELF_EDITABLE = ['photo', 'log', 'phone', 'cell'];
const NEVER_ON_A_NEW_PERSON = WRITE_PROTECTED.concat(['roles', 'mgr', 'email', 'altEmails', 'google']);
function mergePeople(incP, storedP, ctx) {
  const inc = Array.isArray(incP) ? incP : [];
  const stored = Array.isArray(storedP) ? storedP : [];
  const incBy = new Map();
  inc.forEach(p => { if (p && p.id != null && !incBy.has(p.id)) incBy.set(p.id, p); });
  const out = [], used = new Set();
  stored.forEach(orig => {
    if (!orig || orig.id == null) { out.push(orig); return; }
    used.add(orig.id);
    const v = incBy.get(orig.id);
    if (v === undefined || orig.id !== ctx.me) { out.push(orig); return; }   // never deletable, never editable
    const c = Object.assign({}, orig);
    SELF_EDITABLE.forEach(f => { if (v[f] !== undefined) c[f] = v[f]; });
    out.push(c);
  });
  inc.forEach(p => {
    if (!p || (p.id != null && used.has(p.id))) return;
    const c = Object.assign({}, p);
    delete c.compHidden;
    NEVER_ON_A_NEW_PERSON.forEach(f => { delete c[f]; });   // a record they invented starts with nothing
    out.push(c);
  });
  return out;
}
// Put back everything a non-admin was not allowed to see, taking the stored values.
function mergeProtected(incomingRaw, storedRaw, email) {
  let inc, stored;
  try { inc = JSON.parse(incomingRaw); stored = JSON.parse(storedRaw); } catch (e) { return null; }
  if (!inc || !stored || typeof inc !== 'object' || typeof stored !== 'object') return null;
  const ctx = whoCtx(stored, email);
  inc.people = mergePeople(inc.people, stored.people, ctx);
  // Sales: anything they can see, they can correct. Deleting is different — a
  // shared sale carries somebody else's commission, so it takes everyone's scope.
  inc.rows = mergeById(inc.rows, stored.rows, {
    visible: r => rowVisible(ctx, r),
    deletable: r => ctx.sales === 'all' ||
      (ctx.sales !== 'none' && sharesOf(r).every(id => ctx.salesIds.indexOf(id) > -1)),
    allowNew: () => ctx.sales !== 'none'
  });
  // The payout ledger is payroll's record of money that moved. It is written
  // where payroll is run, never from a non-admin session — not even their own row.
  inc.payouts = Array.isArray(stored.payouts) ? stored.payouts : [];
  // A dispute is the one money record a person is meant to raise for themselves.
  inc.disputes = mergeById(inc.disputes, stored.disputes, {
    visible: x => ownedVisible(ctx, x, 'rep'),
    allowNew: x => ownedVisible(ctx, x, 'rep')
  });
  inc.hours = mergeById(inc.hours, stored.hours, {
    visible: x => ownedVisible(ctx, x, 'rep'),
    allowNew: x => ownedVisible(ctx, x, 'rep')
  });
  // The invoice audit, the payments feed, the open balances and the three sync logs
  // carry NO id — an invoice line is identified by its content, not a key. Pairing them
  // with mergeById therefore matched nothing and appended the incoming copy alongside
  // the stored one, so every save by a manager or billing user DOUBLED the whole audit:
  // $1,300 -> $2,600 -> $5,200. They are whole-collection documents, replaced wholesale
  // by their importers, so they are taken wholesale here too: from the caller if they
  // were sent them, from storage if they were not.
  ['invoices', 'payments', 'openinv', 'paidinv', 'invsyncs', 'paysyncs', 'balsyncs', 'pdisyncs'].forEach(k => {
    inc[k] = ctx.financial ? (Array.isArray(inc[k]) ? inc[k] : (stored[k] || []))
                           : (stored[k] || []);
  });
  // Invoice-sale links and client mappings are admin DECISIONS, not feed
  // documents: they are taken only from a caller whose job includes making
  // them — financial WITH sales scope (the owner, managers). Billing reads
  // them but can never rewrite or wipe them.
  ['invlinks', 'invclimap', 'invassign'].forEach(k => {
    inc[k] = (ctx.financial && ctx.sales !== 'none')
      ? (Array.isArray(inc[k]) ? inc[k] : (stored[k] || []))
      : (stored[k] || []);
  });
  return JSON.stringify(inc);
}

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
  // ---- public config: tells the page whether Google login is set up ----
  if (req.method === 'GET' && req.query && req.query.config === '1') {
    return res.status(200).json({ googleClientId: GOOGLE_CLIENT_ID });
  }

  // ---- Google sign-in: swap a Google ID token for a 30-day session ----
  if (req.query && req.query.auth === 'google' && req.method === 'POST') {
    if (!GOOGLE_CLIENT_ID) return res.status(500).json({ error: 'GOOGLE_CLIENT_ID is not set on the server' });
    if (!DB_URL) return res.status(500).json({ error: 'no database' });
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
    const cred = body && body.credential;
    if (!cred) return res.status(400).json({ error: 'credential required' });
    let info;
    try {
      const g = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(cred));
      if (!g.ok) return res.status(401).json({ error: 'Google rejected the token' });
      info = await g.json();
    } catch (e) { return res.status(502).json({ error: 'could not reach Google to verify' }); }
    if (info.aud !== GOOGLE_CLIENT_ID) return res.status(401).json({ error: 'token is for a different app' });
    if (info.email_verified !== 'true' && info.email_verified !== true) return res.status(401).json({ error: 'email not verified with Google' });
    const email = normEmail(info.email);
    if (!companyEmail(email) || (info.hd && String(info.hd).toLowerCase() !== ALLOWED_DOMAIN))
      return res.status(403).json({ denied: true, email, wrongDomain: true,
        error: 'Only @' + ALLOWED_DOMAIN + ' Google accounts can use this tracker.' });
    const sql2 = neon(DB_URL);
    await ensureUsers(sql2);
    const u = await sql2`SELECT email, name, role FROM users WHERE email = ${email}`;
    if (!u.length) return res.status(403).json({ denied: true, email,
      error: 'This Google account is not on the team list. An admin adds it under Admin → Team logins.' });
    const sess = { e: email, n: info.name || u[0].name || email, r: u[0].role, x: Date.now() + 30 * 86400000 };
    // remember the Google subject id (stable per account) and when they last signed in
    try { await sql2`UPDATE users SET last_login = now(), google_sub = COALESCE(google_sub, ${String(info.sub || '')}) WHERE email = ${email}`; } catch (e) {}
    return res.status(200).json({ ok: true, token: signSession(sess), email: sess.e, name: sess.n, role: sess.r, sub: String(info.sub || '') });
  }

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

  // ---- auth gate: a Google-backed session OR the legacy shared password ----
  const want = process.env.APP_PASSWORD || '';
  if (!want) return res.status(500).json({ error: 'APP_PASSWORD is not set on the server' });
  let sess = verifySession(req.headers['x-session']);
  const got = req.headers['x-app-password'] || '';
  const pwOk = !!got && safeEqual(got, want);
  if (!sess && !pwOk) return unauthorized(res);

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

  // A session's role is NOT trusted from the token: it is re-read from the users
  // table on every request, so removing or demoting someone takes effect on
  // their very next click instead of when a 30-day token expires.
  if (sess) {
    try {
      await ensureUsers(sql);
      const u = await sql`SELECT name, role FROM users WHERE email = ${sess.e}`;
      if (!u.length || !companyEmail(sess.e)) return res.status(401).json({ error: 'signed out', revoked: true });
      sess = { e: sess.e, n: sess.n || u[0].name, r: u[0].role, x: sess.x };
    } catch (e) {
      return res.status(500).json({ error: 'DB op failed: ' + (e.message || String(e)) });
    }
  }
  const who = sess ? sess.e : '';   // verified identity, when there is one

  // ---- Google Sheet → CSV (the sheet must be shared "anyone with the link") ----
  // Server-side fetch because the browser cannot read docs.google.com cross-origin.
  if (req.method === 'GET' && req.query && req.query.gsheet === '1') {
    const id = String(req.query.id || ''), gid = String(req.query.gid || '0');
    if (!/^[-\w]{20,}$/.test(id) || !/^\d{0,12}$/.test(gid)) return res.status(400).json({ error: 'bad sheet id or gid' });
    try {
      // gid "0" / blank = the first tab (Google numbers the first tab arbitrarily and 400s on a wrong gid)
      const url = 'https://docs.google.com/spreadsheets/d/' + id + '/export?format=csv' + (gid && gid !== '0' ? '&gid=' + gid : '');
      const g = await fetch(url, { redirect: 'follow' });
      const ct = String(g.headers.get('content-type') || '');
      if (!g.ok || ct.indexOf('text/csv') < 0) return res.status(g.status === 200 ? 403 : g.status).json({ error: 'Google did not return the sheet as CSV (status ' + g.status + '). Share it as “Anyone with the link · Viewer”.' });
      const csv = await g.text();
      if (csv.length > 2_000_000) return res.status(413).json({ error: 'sheet too large' });
      return res.status(200).json({ csv: csv });
    } catch (e) { return res.status(502).json({ error: 'could not reach Google: ' + (e.message || e) }); }
  }

  // ---- who am I: lets the page confirm its session is still good ----
  if (req.method === 'GET' && req.query && req.query.me === '1') {
    return res.status(200).json(sess
      ? { email: sess.e, name: sess.n, role: sess.r, expires: sess.x, method: 'google' }
      : { email: '', name: '', role: 'admin', method: 'password' });
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
          if (who) e.verifiedUser = who;   // Google-verified identity beats a self-declared device name
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

    // ===== EVIDENCE FILE VAULT =====
    // Invoice PDFs attached to sales live here — append-only like the audit
    // log (no delete route), stamped with server time and sender IP, so an
    // attached invoice can't quietly disappear later.
    if (req.query && req.query.file === '1') {
      await sql`CREATE TABLE IF NOT EXISTS file_vault (
        id BIGSERIAL PRIMARY KEY,
        at TIMESTAMPTZ NOT NULL DEFAULT now(),
        ip TEXT, name TEXT, sha TEXT, kb INT, data TEXT
      )`;
      const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
      if (req.method === 'POST') {
        let body = req.body;
        if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
        if (!body || !body.data || !body.name) return res.status(400).json({ error: 'name and data required' });
        const b64 = String(body.data);
        if (b64.length > 7_000_000) return res.status(413).json({ error: 'file too large (5MB max)' });
        const r = await sql`INSERT INTO file_vault (ip, name, sha, kb, data)
          VALUES (${ip}, ${String(body.name).slice(0,200)}, ${String(body.sha||'').slice(0,64)},
                  ${Math.round(b64.length*3/4/1024)}, ${b64}) RETURNING id, at`;
        return res.status(200).json({ ok: true, id: r[0].id, at: r[0].at });
      }
      if (req.method === 'GET') {
        const id = parseInt(req.query.id || '0', 10);
        if (!id) return res.status(400).json({ error: 'id required' });
        const rows = await sql`SELECT name, sha, kb, data, at FROM file_vault WHERE id = ${id}`;
        if (!rows.length) return res.status(404).json({ error: 'not found' });
        return res.status(200).json(rows[0]);
      }
      return res.status(405).json({ error: 'file vault is append-only' });
    }

    // ===== TEAM LOGINS (admin only) =====
    // Who may sign in with Google, and as what role. Root admin is seeded once.
    if (req.query && req.query.users === '1') {
      await ensureUsers(sql);
      const isAdmin = (sess && sess.r === 'admin') || (!sess && pwOk);   // password path counts as admin (legacy)
      if (req.method === 'GET') {
        const rows = await sql`SELECT email, name, role, added_by, added_at, last_login FROM users ORDER BY added_at`;
        return res.status(200).json({ users: rows, you: who || '(password)' });
      }
      if (!isAdmin) return res.status(403).json({ error: 'admins only' });
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
      if (req.method === 'POST') {
        const email = normEmail(body && body.email);
        let role = (body && body.role) === 'admin' ? 'admin' : 'rep';
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'that is not an email address' });
        if (!companyEmail(email)) return res.status(400).json({ error: 'only @' + ALLOWED_DOMAIN + ' addresses can be on the team list' });
        if (email === ROOT_ADMIN) role = 'admin';   // the root admin can never be demoted
        await sql`INSERT INTO users (email, name, role, added_by) VALUES (${email}, ${String(body.name||'').slice(0,80)}, ${role}, ${who||'password-admin'})
          ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role, name = COALESCE(NULLIF(EXCLUDED.name,''), users.name)`;
        return res.status(200).json({ ok: true });
      }
      if (req.method === 'DELETE') {
        const email = normEmail((req.query.email) || (body && body.email));
        if (email === ROOT_ADMIN) return res.status(400).json({ error: 'the root admin cannot be removed' });
        await sql`DELETE FROM users WHERE email = ${email}`;
        return res.status(200).json({ ok: true });
      }
      return res.status(405).json({ error: 'method not allowed' });
    }

    if (req.method === 'GET') {
      const rows = await sql`SELECT data, updated FROM app_state WHERE id = 'main'`;
      if (!rows.length) return res.status(200).json({ empty: true });
      const isAdmin = (sess && sess.r === 'admin') || (!sess && pwOk);
      const data = isAdmin ? rows[0].data : projectState(rows[0].data, who);
      return res.status(200).json({ data, updated: rows[0].updated, scoped: !isAdmin });
    }

    if (req.method === 'POST') {
      // Body is the state JSON as a plain string (may arrive parsed or raw).
      let data = req.body;
      if (data && typeof data === 'object') data = data.data != null ? data.data : JSON.stringify(data);
      if (typeof data !== 'string') data = String(data == null ? '' : data);
      if (!data || data.length < 2) return res.status(400).json({ error: 'empty body' });

      // A non-admin never sent us other people's compensation or ledger, so it may
      // not change them: put the stored values back before anything is written.
      const isAdminW = (sess && sess.r === 'admin') || (!sess && pwOk);
      const pre = await sql`SELECT data FROM app_state WHERE id='main'`;
      if (!isAdminW && pre.length) {
        const merged = mergeProtected(data, pre[0].data, who);
        if (!merged) return res.status(400).json({ error: 'could not merge this save safely' });
        data = merged;
      }

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
