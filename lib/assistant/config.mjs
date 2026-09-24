// Everything the assistant reads from the environment, in one place.
// Read lazily (a function, not constants) so tests can set env per case.
//
// Env vars (Vercel → Settings → Environment Variables):
//   DATABASE_URL                shared with the tracker (Neon)
//   GOOGLE_OAUTH_CLIENT_ID      a "Web application" OAuth client
//   GOOGLE_OAUTH_CLIENT_SECRET  its secret — server only, never sent to the page
//   ASSISTANT_TOKEN_KEY         32+ random bytes (base64 or hex) — encrypts Google tokens at rest
//   ASSISTANT_SESSION_SECRET    signs the session cookie
//   ASSISTANT_ALLOWED_EMAILS    comma-separated Google accounts allowed to sign in
//                               (unset → the tracker's admin users)
//   ANTHROPIC_API_KEY           server-side only
//   ASSISTANT_MODEL             optional, default claude-opus-5
//   ASSISTANT_PUBLIC_URL        optional, e.g. https://example.vercel.app (else derived from the request)

export function cfg() {
  const e = process.env;
  return {
    databaseUrl: e.DATABASE_URL || e.POSTGRES_URL || e.POSTGRES_PRISMA_URL || e.DATABASE_URL_UNPOOLED || '',
    googleClientId: e.GOOGLE_OAUTH_CLIENT_ID || '',
    googleClientSecret: e.GOOGLE_OAUTH_CLIENT_SECRET || '',
    tokenKey: e.ASSISTANT_TOKEN_KEY || '',
    sessionSecret: e.ASSISTANT_SESSION_SECRET || '',
    allowedEmails: String(e.ASSISTANT_ALLOWED_EMAILS || '')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    anthropicKey: e.ANTHROPIC_API_KEY || '',
    model: e.ASSISTANT_MODEL || 'claude-opus-5',
    publicUrl: (e.ASSISTANT_PUBLIC_URL || '').replace(/\/+$/, ''),
    production: e.VERCEL_ENV === 'production' || e.NODE_ENV === 'production',
  };
}

// What setup is missing, in words a person can act on. Never includes values.
export function setupProblems(c = cfg()) {
  const out = [];
  if (!c.databaseUrl) out.push('DATABASE_URL is not set');
  if (!c.googleClientId || !c.googleClientSecret) out.push('GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET are not set');
  if (!c.tokenKey) out.push('ASSISTANT_TOKEN_KEY is not set');
  if (!c.sessionSecret || c.sessionSecret.length < 32) out.push('ASSISTANT_SESSION_SECRET is missing or shorter than 32 characters');
  return out;
}
