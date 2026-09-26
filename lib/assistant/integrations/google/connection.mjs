import { decrypt, encrypt } from '../../crypto.mjs';
import { getConnection, storeRefreshedAccess, markConnection, touchConnection } from '../../repo/connections.mjs';
import { refreshAccessToken } from './oauth.mjs';
import { createGoogleClient, GoogleApiError } from './transport.mjs';
import { SERVICES, SERVICE_KEYS, serviceState } from './services.mjs';

// The token vault: the only place that decrypts Google credentials. It hands
// adapters a ready-to-use HTTP client per service, refreshing the access
// token when it is about to expire and recording what went wrong when Google
// says the grant is gone.

const SKEW_MS = 90 * 1000;

export async function googleContext({ db, userId, config, fetchImpl = fetch, sleep }) {
  const conn = await getConnection(db, userId, 'google');
  let accessToken = null, expiresAt = 0, refreshing = null;
  if (conn && conn.access_token_enc && conn.access_expires_at) {
    try { accessToken = decrypt(conn.access_token_enc, config.tokenKey); expiresAt = new Date(conn.access_expires_at).getTime(); }
    catch { accessToken = null; }
  }

  async function refresh() {
    if (!conn.refresh_token_enc) {
      await markConnection(db, conn.id, 'expired', 'No refresh token — reconnect Google.');
      conn.status = 'expired';
      throw new GoogleApiError({ kind: 'auth', message: 'no refresh token' });
    }
    let rt;
    try { rt = decrypt(conn.refresh_token_enc, config.tokenKey); }
    catch {
      await markConnection(db, conn.id, 'expired', 'Stored credentials could not be read — reconnect Google.');
      conn.status = 'expired';
      throw new GoogleApiError({ kind: 'auth', message: 'token key mismatch' });
    }
    try {
      const t = await refreshAccessToken({ fetchImpl, clientId: config.googleClientId, clientSecret: config.googleClientSecret, refreshToken: rt });
      accessToken = t.accessToken;
      expiresAt = t.expiresAt.getTime();
      if (t.scopes) conn.granted_scopes = t.scopes;
      await storeRefreshedAccess(db, conn.id, { accessEnc: encrypt(t.accessToken, config.tokenKey), expiresAt: t.expiresAt, scopes: t.scopes });
      conn.status = 'connected';
      return accessToken;
    } catch (e) {
      if (e.revoked) {
        // The person revoked access at myaccount.google.com, changed their
        // password, or the grant aged out. Nothing we can retry — say so.
        await markConnection(db, conn.id, 'revoked', 'Google access was revoked or expired — reconnect to continue.');
        conn.status = 'revoked';
        throw new GoogleApiError({ kind: 'auth', message: 'grant revoked' });
      }
      throw new GoogleApiError({ kind: 'unavailable', message: e.message });
    }
  }

  async function getAccessToken(force) {
    if (!force && accessToken && Date.now() < expiresAt - SKEW_MS) return accessToken;
    // Concurrent adapters share one refresh.
    if (!refreshing) refreshing = refresh().finally(() => { refreshing = null; });
    return refreshing;
  }

  const states = {};
  SERVICE_KEYS.forEach(k => { states[k] = serviceState(conn, k); });
  let touched = false;

  return {
    connection: conn,
    states,
    usable: key => states[key] === 'connected',
    client(key) {
      const st = serviceState(conn, key);
      const label = SERVICES[key].label;
      if (st === 'not_connected' || st === 'not_granted') throw new GoogleApiError({ kind: st === 'not_granted' ? 'scope' : 'not_connected', service: label });
      if (st === 'disabled') throw new GoogleApiError({ kind: 'disabled', service: label });
      if (st === 'reconnect') throw new GoogleApiError({ kind: 'auth', service: label });
      if (!touched) { touched = true; touchConnection(db, conn.id).catch(() => {}); }
      return createGoogleClient({ fetchImpl, getAccessToken, service: label, sleep });
    },
  };
}
