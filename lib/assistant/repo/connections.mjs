import { newId } from '../ids.mjs';
import { encrypt } from '../crypto.mjs';

// Rows here carry encrypted tokens. `publicConnection` is the ONLY shape that
// may leave the server; route code must never return a raw row.

export async function getConnection(db, userId, provider = 'google') {
  const r = await db.query('SELECT * FROM asst_connections WHERE user_id = $1 AND provider = $2 ORDER BY updated_at DESC LIMIT 1', [userId, provider]);
  return r[0] || null;
}

export async function saveGoogleGrant(db, { userId, accountId, accountEmail, tokens, tokenKey }) {
  const existing = await db.query('SELECT * FROM asst_connections WHERE user_id = $1 AND provider = $2 AND account_id = $3', [userId, 'google', accountId]);
  const prev = existing[0];
  // Google returns `scope` with include_granted_scopes=true: the union of every
  // grant so far. If it is missing, keep what we had rather than guess.
  const scopes = tokens.scopes || (prev ? prev.granted_scopes : []);
  const refreshEnc = tokens.refreshToken ? encrypt(tokens.refreshToken, tokenKey) : (prev ? prev.refresh_token_enc : null);
  const accessEnc = tokens.accessToken ? encrypt(tokens.accessToken, tokenKey) : null;
  if (prev) {
    const r = await db.query(`UPDATE asst_connections SET account_email = $2, granted_scopes = $3, refresh_token_enc = $4,
        access_token_enc = $5, access_expires_at = $6, status = $7, status_detail = NULL, last_refreshed_at = now(), updated_at = now()
      WHERE id = $1 RETURNING *`,
      [prev.id, accountEmail, JSON.stringify(scopes), refreshEnc, accessEnc, tokens.expiresAt, refreshEnc ? 'connected' : 'expired']);
    return r[0];
  }
  const r = await db.query(`INSERT INTO asst_connections (id, user_id, provider, account_id, account_email, granted_scopes,
      refresh_token_enc, access_token_enc, access_expires_at, status, last_refreshed_at)
    VALUES ($1,$2,'google',$3,$4,$5,$6,$7,$8,$9, now()) RETURNING *`,
    [newId('connection'), userId, accountId, accountEmail, JSON.stringify(scopes), refreshEnc, accessEnc, tokens.expiresAt, refreshEnc ? 'connected' : 'expired']);
  return r[0];
}

export async function storeRefreshedAccess(db, id, { accessEnc, expiresAt, scopes }) {
  await db.query(`UPDATE asst_connections SET access_token_enc = $2, access_expires_at = $3,
      granted_scopes = COALESCE($4::jsonb, granted_scopes), status = 'connected', status_detail = NULL,
      last_refreshed_at = now(), last_used_at = now(), updated_at = now() WHERE id = $1`,
    [id, accessEnc, expiresAt, scopes ? JSON.stringify(scopes) : null]);
}

export async function markConnection(db, id, status, detail) {
  await db.query('UPDATE asst_connections SET status = $2, status_detail = $3, updated_at = now() WHERE id = $1', [id, status, detail || null]);
}

export async function touchConnection(db, id) {
  await db.query('UPDATE asst_connections SET last_used_at = now() WHERE id = $1', [id]);
}

export async function setServiceDisabled(db, userId, key, disabled) {
  const c = await getConnection(db, userId);
  if (!c) return null;
  const set = new Set(c.disabled_services || []);
  if (disabled) set.add(key); else set.delete(key);
  const r = await db.query('UPDATE asst_connections SET disabled_services = $2, updated_at = now() WHERE id = $1 RETURNING *', [c.id, JSON.stringify([...set])]);
  return r[0];
}

export async function deleteConnection(db, id) {
  await db.query('DELETE FROM asst_connections WHERE id = $1', [id]);
}
