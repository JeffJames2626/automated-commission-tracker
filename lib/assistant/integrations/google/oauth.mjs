// Google OAuth 2.0 authorization-code flow for a web server app, with PKCE.
// Endpoints from https://accounts.google.com/.well-known/openid-configuration.
// Pure functions over an injected fetch — no database, no cookies.

export const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

export class OAuthError extends Error {
  constructor(code, message, status) {
    super(message || code);
    this.code = code;          // e.g. invalid_grant — the refresh token is dead
    this.status = status;
  }
  get revoked() { return this.code === 'invalid_grant' || this.code === 'unauthorized_client'; }
}

export function buildAuthUrl({ clientId, redirectUri, scopes, state, codeChallenge, loginHint, consent, selectAccount }) {
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    access_type: 'offline',            // we need a refresh token for later reads
    include_granted_scopes: 'true',    // incremental authorization
  });
  // Google only returns a refresh token on consent; ask for it explicitly when
  // adding services so a stale grant cannot leave us without one.
  if (consent) p.set('prompt', 'consent');
  else if (selectAccount) p.set('prompt', 'select_account');
  if (loginHint) p.set('login_hint', loginHint);
  return AUTH_ENDPOINT + '?' + p.toString();
}

async function tokenCall(fetchImpl, params, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let r;
  try {
    r = await fetchImpl(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new OAuthError('network', 'Could not reach Google to authorize (' + (e.name === 'AbortError' ? 'timeout' : e.message) + ')');
  } finally { clearTimeout(t); }
  let data = {};
  try { data = await r.json(); } catch { data = {}; }
  if (!r.ok) throw new OAuthError(data.error || ('http_' + r.status), data.error_description || data.error || 'token request failed', r.status);
  return data;
}

export async function exchangeCode({ fetchImpl = fetch, clientId, clientSecret, code, verifier, redirectUri }) {
  const data = await tokenCall(fetchImpl, {
    code, client_id: clientId, client_secret: clientSecret,
    redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier,
  });
  return normalizeTokens(data);
}

export async function refreshAccessToken({ fetchImpl = fetch, clientId, clientSecret, refreshToken }) {
  const data = await tokenCall(fetchImpl, {
    client_id: clientId, client_secret: clientSecret,
    refresh_token: refreshToken, grant_type: 'refresh_token',
  });
  return normalizeTokens(data);
}

export async function revokeToken({ fetchImpl = fetch, token }) {
  try {
    const r = await fetchImpl(REVOKE_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    });
    return r.ok || r.status === 400;   // 400 = already revoked/expired: the goal is met
  } catch { return false; }
}

function normalizeTokens(d) {
  return {
    accessToken: d.access_token || null,
    refreshToken: d.refresh_token || null,          // only present on first consent
    expiresAt: new Date(Date.now() + Math.max(60, +d.expires_in || 3600) * 1000),
    scopes: d.scope ? String(d.scope).split(/\s+/).filter(Boolean) : null,
    idToken: d.id_token || null,
  };
}

// The ID token arrives directly from Google's token endpoint over TLS in the
// same response as the access token, which OpenID Connect Core §3.1.3.7 allows
// us to trust without fetching signing keys. We still check who it is for,
// who issued it and that it is current.
export function parseIdToken(idToken, clientId, now = Date.now()) {
  if (!idToken) throw new OAuthError('no_id_token', 'Google did not return an identity');
  const parts = String(idToken).split('.');
  if (parts.length !== 3) throw new OAuthError('bad_id_token', 'malformed identity token');
  let c;
  try { c = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); }
  catch { throw new OAuthError('bad_id_token', 'unreadable identity token'); }
  if (!ISSUERS.includes(c.iss)) throw new OAuthError('bad_id_token', 'identity token from an unexpected issuer');
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(clientId)) throw new OAuthError('bad_id_token', 'identity token is for a different app');
  if (!c.exp || c.exp * 1000 < now - 60000) throw new OAuthError('bad_id_token', 'identity token expired');
  if (!c.sub) throw new OAuthError('bad_id_token', 'identity token has no subject');
  if (c.email_verified !== true && c.email_verified !== 'true') throw new OAuthError('unverified_email', 'This Google account email is not verified');
  return { sub: String(c.sub), email: String(c.email || '').toLowerCase(), name: c.name || '', picture: c.picture || '' };
}
