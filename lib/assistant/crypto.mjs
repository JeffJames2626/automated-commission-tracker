import crypto from 'node:crypto';

// Google refresh/access tokens are encrypted at rest with AES-256-GCM. The key
// lives only in the server environment (ASSISTANT_TOKEN_KEY); a database dump
// alone does not yield usable Google credentials.
//
// Format: v1.<iv b64url>.<tag b64url>.<ciphertext b64url>

function keyBytes(secret) {
  if (!secret) throw new Error('ASSISTANT_TOKEN_KEY is not set');
  // Accept hex or base64 of 32 bytes; anything else is stretched with SHA-256
  // so a long passphrase still works.
  if (/^[0-9a-f]{64}$/i.test(secret)) return Buffer.from(secret, 'hex');
  const b = Buffer.from(secret, 'base64');
  if (b.length === 32) return b;
  return crypto.createHash('sha256').update(String(secret)).digest();
}

export function encrypt(plain, secret) {
  if (plain == null || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyBytes(secret), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function decrypt(box, secret) {
  if (!box) return null;
  const [v, iv, tag, ct] = String(box).split('.');
  if (v !== 'v1' || !iv || !tag || ct == null) throw new Error('unrecognised token envelope');
  const d = crypto.createDecipheriv('aes-256-gcm', keyBytes(secret), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

export function hmac(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function pkceChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}
