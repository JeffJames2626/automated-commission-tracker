import crypto from 'node:crypto';
import { newId } from '../ids.mjs';
import { sha256, encrypt, decrypt } from '../crypto.mjs';
import { startPairing, redeemPairing, getApp } from '../repo/apps.mjs';

// "Connect Personal Assistant" started from the app, finished in the browser:
//
//   1. The app's server calls apps/v1/link/start and gets a secret to wait
//      with (device_code) and an address to open (approve_url).
//   2. The owner's browser opens the assistant at #/link?code=…, they sign in
//      with Google (if they aren't already) and press Allow — or Don't allow.
//   3. The app's server polls apps/v1/link/poll with its secret. Once allowed
//      it receives its bearer token exactly once.
//
// Approval is an ordinary pairing under the hood (startPairing +
// redeemPairing), so the binding rules are the same: one board per owner,
// the token dies with "sign out everywhere", a different board resyncs.

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LINK_MINUTES = 10;
export const USER_CODE_RE = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/;
const DEVICE_RE = /^dbl_[A-Za-z0-9_-]{43}$/;

function userCode() {
  let c = '';
  for (const b of crypto.randomBytes(8)) c += ALPHABET[b & 31];
  return c.slice(0, 4) + '-' + c.slice(4);
}

export async function startLink(db, { app, instanceId, instanceLabel, linkTemplate }) {
  const device = 'dbl_' + crypto.randomBytes(32).toString('base64url');
  const code = userCode();
  const row = (await db.query(`INSERT INTO asst_app_links (id, app, device_hash, user_code, instance_id, instance_label, link_template, expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7, now() + ($8 || ' minutes')::interval) RETURNING *`,
    [newId('applink'), app, sha256(device), code, instanceId, instanceLabel, linkTemplate, String(LINK_MINUTES)]))[0];
  // Old requests are cleared opportunistically.
  db.query(`DELETE FROM asst_app_links WHERE expires_at < now() - interval '1 day'`).catch(() => {});
  return { device, code, expiresInSeconds: LINK_MINUTES * 60, row };
}

// What the approve page shows. Only a pending, unexpired request is offered.
export async function findLink(db, code) {
  const c = String(code || '').toUpperCase().trim();
  if (!USER_CODE_RE.test(c)) return null;
  // Expiry by the database clock, the same one the approve step checks.
  const r = await db.query(`SELECT *, (expires_at < now()) AS lapsed FROM asst_app_links WHERE user_code = $1
    ORDER BY (status = 'pending') DESC, created_at DESC LIMIT 1`, [c]);
  const row = r[0];
  if (!row) return null;
  if ((row.status === 'pending' || row.status === 'approving') && row.lapsed) row.status = 'expired';
  return row;
}

export async function describeLink(db, userId, row) {
  const current = await getApp(db, userId, row.app);
  return {
    code: row.user_code, app: row.app, status: row.status,
    instanceLabel: row.instance_label || null,
    expiresAt: new Date(row.expires_at).toISOString(),
    // Allowing replaces the board this assistant is connected to now.
    replaces: current && current.status === 'connected' && current.instance_id && current.instance_id !== row.instance_id ? (current.instance_label || 'another board') : null,
    mine: row.user_id ? row.user_id === userId : null,
  };
}

// The owner decides. Allow mints a one-time pairing code for the owner and
// keeps it (encrypted) until the app collects its token.
export async function decideLink(db, userId, code, allow, tokenKey) {
  const row = await findLink(db, code);
  if (!row || row.status !== 'pending') return { error: !row ? 'not_found' : row.status === 'expired' ? 'expired' : 'decided' };
  if (!allow) {
    const r = await db.query(`UPDATE asst_app_links SET status = 'denied', user_id = $2, decided_at = now() WHERE id = $1 AND status = 'pending' RETURNING id`, [row.id, userId]);
    return r.length ? { status: 'denied' } : { error: 'decided' };
  }
  const claim = await db.query(`UPDATE asst_app_links SET status = 'approving', user_id = $2 WHERE id = $1 AND status = 'pending' AND expires_at > now() RETURNING id`, [row.id, userId]);
  if (!claim.length) return { error: 'expired' };
  try {
    const pairing = await startPairing(db, userId, row.app);
    await db.query(`UPDATE asst_app_links SET status = 'approved', pair_code_enc = $2, decided_at = now() WHERE id = $1`,
      [row.id, encrypt(pairing.code, tokenKey)]);
  } catch (e) {
    // Not half-approved: the request goes back to waiting for a decision.
    await db.query(`UPDATE asst_app_links SET status = 'pending', user_id = NULL WHERE id = $1 AND status = 'approving'`, [row.id]).catch(() => {});
    throw e;
  }
  return { status: 'approved' };
}

// The app collects its token: once, with the secret it was given.
export async function pollLink(db, device, tokenKey) {
  if (!DEVICE_RE.test(String(device || ''))) return { status: 'invalid' };
  const r = await db.query('SELECT * FROM asst_app_links WHERE device_hash = $1', [sha256(device)]);
  const row = r[0];
  if (!row) return { status: 'invalid' };
  if (row.status === 'approved') {
    const took = await db.query(`UPDATE asst_app_links SET status = 'claimed', pair_code_enc = NULL WHERE id = $1 AND status = 'approved' RETURNING pair_code_enc`, [row.id]);
    if (!took.length) return { status: 'claimed' };
    let code = null;
    try { code = decrypt(row.pair_code_enc, tokenKey); } catch { code = null; }
    let out;
    try { out = code ? await redeemPairing(db, { app: row.app, code, instanceId: row.instance_id, instanceLabel: row.instance_label, linkTemplate: row.link_template }) : null; }
    catch (e) {
      // The next poll can try again.
      await db.query(`UPDATE asst_app_links SET status = 'approved', pair_code_enc = $2 WHERE id = $1 AND status = 'claimed'`, [row.id, row.pair_code_enc]).catch(() => {});
      throw e;
    }
    if (!out) return { status: 'expired' };
    return { status: 'approved', token: out.token, app: out.app };
  }
  if (row.status === 'pending' || row.status === 'approving') {
    const lapsed = (await db.query('SELECT expires_at < now() AS lapsed FROM asst_app_links WHERE id = $1', [row.id]))[0];
    return lapsed && lapsed.lapsed ? { status: 'expired' } : { status: 'pending' };
  }
  return { status: row.status };   // denied | claimed
}
