import { hmac, safeEqual } from './crypto.mjs';

// Stateless signed session cookie. The payload only names the user and an
// epoch; the router re-reads the user row on every request, so deleting a
// user or bumping their session_epoch ("sign out everywhere") ends every
// outstanding cookie on its next request.

export const SESSION_COOKIE = 'asst_session';
export const OAUTH_COOKIE = 'asst_oauth';
const SESSION_DAYS = 30;

export function signPayload(payload, secret) {
  if (!secret) throw new Error('session secret missing');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return body + '.' + hmac(secret, body);
}

export function verifyPayload(token, secret) {
  if (!token || !secret) return null;
  const [body, sig] = String(token).split('.');
  if (!body || !sig || !safeEqual(sig, hmac(secret, body))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!p || typeof p !== 'object' || !p.x || Date.now() > p.x) return null;
    return p;
  } catch { return null; }
}

export function issueSession(user, secret, now = Date.now()) {
  return signPayload({ u: user.id, ep: user.session_epoch || 0, x: now + SESSION_DAYS * 86400000 }, secret);
}

export const SESSION_MAX_AGE = SESSION_DAYS * 86400;
