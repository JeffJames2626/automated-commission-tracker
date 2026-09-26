import crypto from 'node:crypto';
import { newId } from '../ids.mjs';
import { sha256 } from '../crypto.mjs';

// Connected apps (asst_apps). An app's server authenticates with a bearer
// token it obtained by redeeming a one-time pairing code; only the SHA-256 of
// either is stored. Nothing here is ever returned to a browser as-is — use
// publicApp().

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no I/O/0/1
const TOKEN_RE = /^dbc_[A-Za-z0-9_-]{43}$/;
export const CODE_RE = /^[A-Z2-9]{4}-?[A-Z2-9]{4}$/;
const PAIR_MINUTES = 10;

const normCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export async function getApp(db, userId, app) {
  const r = await db.query('SELECT * FROM asst_apps WHERE user_id = $1 AND app = $2', [userId, app]);
  return r[0] || null;
}

// Start pairing: a short code the owner types into the app. Starting a new
// pairing immediately revokes the current token — "pair again" is also how a
// leaked token is killed. The code carries the owner's session epoch from
// this moment, so "sign out everywhere" also voids a code minted before it.
export async function startPairing(db, userId, app) {
  await db.query(`INSERT INTO asst_apps (id, user_id, app) VALUES ($1,$2,$3) ON CONFLICT (user_id, app) DO NOTHING`, [newId('app'), userId, app]);
  let code = '';
  for (const b of crypto.randomBytes(8)) code += CODE_ALPHABET[b & 31];
  await db.query(`UPDATE asst_apps SET pair_code_hash = $3, pair_expires_at = now() + ($4 || ' minutes')::interval,
      session_epoch = (SELECT session_epoch FROM asst_users WHERE id = $1),
      token_hash = NULL, status = 'pairing', updated_at = now() WHERE user_id = $1 AND app = $2`,
    [userId, app, sha256(normCode(code)), String(PAIR_MINUTES)]);
  return { code: code.slice(0, 4) + '-' + code.slice(4), expiresInMinutes: PAIR_MINUTES };
}

// Redeem a pairing code (called by the app's server). Single use: the code
// hash is cleared in the same statement that issues the token.
export async function redeemPairing(db, { app, code, instanceId, instanceLabel, linkTemplate }) {
  const c = normCode(code);
  if (c.length !== 8) return null;
  const token = 'dbc_' + crypto.randomBytes(32).toString('base64url');
  const r = await db.query(`UPDATE asst_apps SET pair_code_hash = NULL, pair_expires_at = NULL, token_hash = $2,
        status = 'connected', last_error = NULL, updated_at = now()
      WHERE pair_code_hash = $1 AND app = $3 AND pair_expires_at > now() RETURNING *`,
    [sha256(c), sha256(token), app]);
  const row = r[0];
  if (!row) return null;
  // A different app database (a restored copy, another workspace) replaces the
  // binding only through a deliberate pairing — and then everything resyncs.
  // The same board picking up again just resumes, so changes made while
  // unpaired still arrive as changes.
  const changed = !!(row.instance_id && row.instance_id !== instanceId);
  await db.query(`UPDATE asst_apps SET instance_id = $2, instance_label = $3, link_template = COALESCE($4, link_template),
      resync = CASE WHEN $5 OR history_since IS NULL THEN true ELSE resync END,
      epoch = CASE WHEN $5 THEN NULL ELSE epoch END, max_seq = CASE WHEN $5 THEN 0 ELSE max_seq END
    WHERE id = $1`, [row.id, instanceId, instanceLabel, linkTemplate, changed]);
  return { token, app: row.app };
}

export async function findByToken(db, token) {
  if (!TOKEN_RE.test(String(token || ''))) return null;
  const r = await db.query(`SELECT * FROM asst_apps WHERE token_hash = $1 AND status = 'connected'`, [sha256(token)]);
  return r[0] || null;
}

export async function touchApp(db, id, { epoch, maxSeq }) {
  await db.query(`UPDATE asst_apps SET last_seen_at = now(), epoch = COALESCE($2, epoch), max_seq = GREATEST(max_seq, $3), updated_at = now() WHERE id = $1`,
    [id, epoch, maxSeq || 0]);
}

// The app's history was rewound: everything is sent again.
export async function startResync(db, id, epoch) {
  await db.query('UPDATE asst_apps SET resync = true, epoch = $2, max_seq = 0, updated_at = now() WHERE id = $1', [id, epoch]);
}

// A complete resend finished. `fromSeq` is the app's sequence when it began
// the resend: anything changed after that is sent again as a normal update.
export async function markBackfilled(db, id, { epoch, fromSeq }) {
  await db.query(`UPDATE asst_apps SET resync = false, epoch = $2, max_seq = $3, history_since = COALESCE(history_since, now()),
      last_seen_at = now(), updated_at = now() WHERE id = $1`, [id, epoch, fromSeq]);
}

export async function setAppError(db, id, message) {
  await db.query('UPDATE asst_apps SET last_error = $2, updated_at = now() WHERE id = $1', [id, message ? String(message).slice(0, 200) : null]);
}

// Disconnect = the token dies. Queued work and the mirror stay (labelled as
// out of date) so reconnecting resumes exactly where it stopped.
export async function disconnectApp(db, userId, app, reason = null) {
  await db.query(`UPDATE asst_apps SET status = 'disconnected', token_hash = NULL, pair_code_hash = NULL, last_error = COALESCE($3, last_error),
      updated_at = now() WHERE user_id = $1 AND app = $2`, [userId, app, reason]);
}

export async function setBaseUrl(db, userId, app, url) {
  await db.query('UPDATE asst_apps SET base_url = $3, updated_at = now() WHERE user_id = $1 AND app = $2', [userId, app, url]);
}

// "Forget Dream Board data": the explicit, destructive reset. Work not yet
// sent is cancelled, its captures go back to the inbox, and confirmed changes
// still waiting are marked as not made.
export async function forgetAppData(db, userId, app) {
  const cancelled = await db.query(`UPDATE asst_app_ops SET status = 'cancelled', reason = 'forgotten', done_at = now(), payload = payload - 'note', updated_at = now()
    WHERE user_id = $1 AND app = $2 AND status IN ('routing','needs_choice','waiting','queued') RETURNING capture_id, action_id`, [userId, app]);
  const caps = cancelled.map(o => o.capture_id).filter(Boolean), acts = cancelled.map(o => o.action_id).filter(Boolean);
  if (caps.length) await db.query(`UPDATE asst_captures SET status = 'inbox', updated_at = now() WHERE user_id = $1 AND id = ANY($2) AND status = 'filed'`, [userId, caps]);
  if (acts.length) await db.query(`UPDATE asst_actions SET status = 'failed', result = $3 WHERE user_id = $1 AND id = ANY($2) AND status = 'queued'`,
    [userId, acts, JSON.stringify({ reason: 'forgotten', message: 'Dream Board data was forgotten before this change was applied. Nothing was changed.' })]);
  await db.query(`DELETE FROM asst_links WHERE user_id = $1 AND to_type = 'external' AND to_id IN
    (SELECT id FROM asst_external_records WHERE user_id = $1 AND provider = $2)`, [userId, app]);
  await db.query('DELETE FROM asst_events WHERE user_id = $1 AND app = $2', [userId, app]);
  await db.query('DELETE FROM asst_external_records WHERE user_id = $1 AND provider = $2', [userId, app]);
  await db.query(`UPDATE asst_apps SET history_since = NULL, epoch = NULL, max_seq = 0, resync = true WHERE user_id = $1 AND app = $2`, [userId, app]);
}

// Freshness of what the assistant knows about an app, for honest wording.
// A dead token is never "up to date", however recent the last sync.
export function freshness(row, now = Date.now()) {
  if (!row || (row.status === 'disconnected' && !row.last_seen_at)) return { state: 'not_connected' };
  const seen = row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null;
  const at = { lastSeenAt: seen, historySince: row.history_since ? new Date(row.history_since).toISOString() : null };
  if (row.status === 'pairing') return Object.assign({ state: 'pairing' }, at);
  if (row.status !== 'connected' || !row.token_hash) return Object.assign({ state: 'disconnected' }, at);
  if (!seen) return { state: 'waiting_first_sync' };
  const age = now - Date.parse(seen);
  return Object.assign({ state: row.resync ? 'syncing' : age < 5 * 60e3 ? 'live' : age < 24 * 3600e3 ? 'recent' : 'stale' }, at);
}

export function publicApp(row, now = Date.now()) {
  if (!row) return null;
  return { app: row.app, status: row.status, instanceLabel: row.instance_label, baseUrl: row.base_url, lastError: row.last_error, freshness: freshness(row, now) };
}
