import STAMP from './build-info.mjs';

// Everything the assistant reads from the environment, in one place.
// Read lazily (a function, not constants) so tests can set env per case.
//
// Env vars (Vercel → Settings → Environment Variables):
//   ASSISTANT_DATABASE_URL      optional; a database for the assistant alone
//                               (e.g. a Neon branch). Unset → DATABASE_URL.
//   DATABASE_URL                shared with the tracker (Neon); assistant tables are asst_*
//   GOOGLE_OAUTH_CLIENT_ID      a "Web application" OAuth client
//   GOOGLE_OAUTH_CLIENT_SECRET  its secret — server only, never sent to the page
//   ASSISTANT_TOKEN_KEY         32+ random bytes (base64 or hex) — encrypts Google tokens at rest
//   ASSISTANT_SESSION_SECRET    signs the session cookie
//   ASSISTANT_ALLOWED_EMAILS    comma-separated Google accounts allowed to sign in
//                               (unset → the tracker's admin users)
//   ANTHROPIC_API_KEY           server-side only
//   ASSISTANT_MODEL             optional, default claude-opus-5
//   ASSISTANT_PUBLIC_URL        the one address people use (e.g. https://assistant-dev.example.com).
//                               Sign-in always happens there, so there is one Google redirect URI.
//   ASSISTANT_ENV               local | development | production — shown as a small badge
//                               (anything but production), and recorded in the build info

export function cfg() {
  const e = process.env;
  return {
    databaseUrl: e.ASSISTANT_DATABASE_URL || e.DATABASE_URL || e.POSTGRES_URL || e.POSTGRES_PRISMA_URL || e.DATABASE_URL_UNPOOLED || '',
    databaseSource: e.ASSISTANT_DATABASE_URL ? 'assistant' : 'shared',
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
    env: appEnv(e),
    // Development and production need the explicit allow-list.
    allowFallback: !['development', 'production'].includes(appEnv(e)),
  };
}

// Which of the three environments this is. Explicit beats inferred: a Vercel
// preview is only "development" when ASSISTANT_ENV says so.
export function appEnv(e = process.env) {
  const v = String(e.ASSISTANT_ENV || '').toLowerCase();
  if (['local', 'development', 'production'].includes(v)) return v;
  if (e.VERCEL_ENV === 'production') return 'production';
  if (e.VERCEL_ENV === 'preview') return 'preview';
  return 'local';
}

// What is running: shown in More → About and on /health, so a bug report can
// name the exact build. Never includes secrets. build-info.mjs is rewritten
// by `npm run vercel-build` with the build time; locally it is empty.
export function buildInfo(e = process.env) {
  const sha = e.VERCEL_GIT_COMMIT_SHA || STAMP.sha || '';
  return {
    env: appEnv(e),
    sha: sha ? sha.slice(0, 7) : 'local',
    branch: e.VERCEL_GIT_COMMIT_REF || STAMP.branch || '',
    builtAt: STAMP.builtAt || null,
  };
}

// What setup is missing, in words a person can act on. Never includes values.
export function setupProblems(c = cfg()) {
  const out = [];
  if (!c.databaseUrl) out.push('DATABASE_URL is not set');
  if (!c.googleClientId || !c.googleClientSecret) out.push('GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET are not set');
  if (!c.tokenKey) out.push('ASSISTANT_TOKEN_KEY is not set');
  if (!c.sessionSecret || c.sessionSecret.length < 32) out.push('ASSISTANT_SESSION_SECRET is missing or shorter than 32 characters');
  if (!c.allowedEmails.length && c.allowFallback === false) out.push('ASSISTANT_ALLOWED_EMAILS is not set (required here: nobody can sign in)');
  return out;
}
