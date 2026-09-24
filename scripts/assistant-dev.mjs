// Local development server for the Personal Assistant.
//
//   node scripts/assistant-dev.mjs            → http://localhost:8787/assistant/
//
// Runs the real router against an in-process Postgres (PGlite) with demo
// Google data, so the whole app works offline and without any credentials.
// Visit /__dev/login to get a session. This file is never deployed: the dev
// login and the fake Google live only here, not in the API code.
//
// Env: PORT, ANTHROPIC_API_KEY (optional — without it the assistant runs in
// search-only mode and capture uses the rule-based classifier).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgliteDb } from '../lib/assistant/db/index.mjs';
import { migrate } from '../lib/assistant/db/schema.mjs';
import { createRouter } from '../lib/assistant/router.mjs';
import { toRequest, sendResponse, cookie } from '../lib/assistant/http.mjs';
import { upsertUserFromGoogle } from '../lib/assistant/repo/users.mjs';
import { saveGoogleGrant } from '../lib/assistant/repo/connections.mjs';
import { seedDefaultProjects } from '../lib/assistant/repo/projects.mjs';
import { issueSession, SESSION_COOKIE } from '../lib/assistant/session.mjs';
import { createClaude } from '../lib/assistant/ai/claude.mjs';
import { demoGoogleFetch, ALL_SCOPES } from './assistant-demo-google.mjs';

const PORT = +process.env.PORT || 8787;
const ROOT = path.resolve('.');
const config = {
  databaseUrl: 'pglite://dev', googleClientId: 'dev-client', googleClientSecret: 'dev-secret',
  tokenKey: 'd'.repeat(64), sessionSecret: 'dev-session-secret-dev-session-secret!!',
  allowedEmails: ['owner@example.com'], publicUrl: '',
};

const db = pgliteDb(new PGlite());
await migrate(db);
const { user } = await upsertUserFromGoogle(db, { sub: 'dev-1', email: 'owner@example.com', name: 'Jeff Demo', picture: '' });
await seedDefaultProjects(db, user.id);
await saveGoogleGrant(db, { userId: user.id, accountId: 'dev-1', accountEmail: 'owner@example.com', tokenKey: config.tokenKey,
  tokens: { accessToken: 'dev-at', refreshToken: 'dev-rt', expiresAt: new Date(Date.now() + 3600e3), scopes: ALL_SCOPES } });

const claude = process.env.ANTHROPIC_API_KEY ? createClaude({ apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.ASSISTANT_MODEL || 'claude-opus-5' }) : null;
const handle = createRouter({ db, config, fetchImpl: demoGoogleFetch, claude, lookup: async () => [{ address: '93.184.216.34' }] });

// Serve the same security headers production uses (vercel.json), so a CSP
// mistake shows up locally.
const VERCEL = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const appHeaders = Object.fromEntries(VERCEL.headers.find(h => h.source === '/assistant/(.*)').headers.map(h => [h.key, h.value]));

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/__dev/login') {
    res.writeHead(302, { location: '/assistant/#/today', 'set-cookie': cookie(SESSION_COOKIE, issueSession(user, config.sessionSecret), { maxAge: 86400, secure: false }) });
    return res.end();
  }
  if (url.pathname === '/api/assistant' || url.pathname.startsWith('/api/assistant/')) {
    const r = await toRequest(req);
    return sendResponse(res, await handle(r));
  }
  let p = decodeURIComponent(url.pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(path.join(ROOT, 'assistant'))) { res.writeHead(404); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, Object.assign({ 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }, appHeaders));
    res.end(data);
  });
}).listen(PORT, () => console.log(`Assistant dev server: http://localhost:${PORT}/__dev/login  (AI: ${claude ? 'on' : 'off — search-only mode'})`));
