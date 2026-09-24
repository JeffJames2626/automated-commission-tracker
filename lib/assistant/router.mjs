import { cfg, setupProblems } from './config.mjs';
import { getDb } from './db/index.mjs';
import { HttpError, cookie, publicError } from './http.mjs';
import { SESSION_COOKIE, OAUTH_COOKIE, SESSION_MAX_AGE, issueSession, verifyPayload, signPayload } from './session.mjs';
import { randomToken, pkceChallenge, decrypt } from './crypto.mjs';
import { findUserById, upsertUserFromGoogle, isAllowedEmail, bumpSessionEpoch, setUserTz } from './repo/users.mjs';
import { getConnection, saveGoogleGrant, setServiceDisabled, deleteConnection } from './repo/connections.mjs';
import * as captures from './repo/captures.mjs';
import * as projects from './repo/projects.mjs';
import * as people from './repo/people.mjs';
import * as memories from './repo/memories.mjs';
import * as convs from './repo/conversations.mjs';
import * as external from './repo/external.mjs';
import { setCaptureTags } from './repo/graph.mjs';
import { addAttachment, validateAttachment, getAttachmentData } from './repo/attachments.mjs';
import { buildAuthUrl, exchangeCode, parseIdToken, revokeToken, OAuthError } from './integrations/google/oauth.mjs';
import { googleContext } from './integrations/google/connection.mjs';
import { SERVICES, SERVICE_KEYS, scopesFor, SIGN_IN_SCOPES } from './integrations/google/services.mjs';
import { GoogleApiError } from './integrations/google/transport.mjs';
import * as gmail from './integrations/google/gmail.mjs';
import * as calendar from './integrations/google/calendar.mjs';
import { PROVIDERS } from './integrations/registry.mjs';
import { createClaude } from './ai/claude.mjs';
import { classifyCapture } from './ai/classify.mjs';
import { answer } from './ai/assistant.mjs';
import { searchEverything } from './retrieval/search.mjs';
import { gatherToday, catchMeUp } from './briefing.mjs';
import { checkRate, RateLimitError } from './ratelimit.mjs';
import { linkPreview } from './linkpreview.mjs';
import { validTz } from './time.mjs';
import { KINDS, STATUSES, PROJECT_KINDS } from './kinds.mjs';
import { MEMORY_KINDS } from './repo/memories.mjs';

// Every assistant endpoint. `deps` lets tests inject a database, a fake
// Google (fetchImpl), a fake Claude and a clock; production passes nothing.

const APP_PATH = '/assistant/';

export function createRouter(deps = {}) {
  const config = () => Object.assign(cfg(), deps.config || {});
  const now = () => (deps.now ? deps.now() : Date.now());
  const fetchImpl = deps.fetchImpl || fetch;

  async function db() {
    if (deps.db) return deps.db;
    const c = config();
    if (!c.databaseUrl) throw new HttpError(503, 'No database is connected (DATABASE_URL).');
    return getDb(c.databaseUrl);
  }
  function claudeFor(c) {
    if (deps.claude !== undefined) return deps.claude;
    return createClaude({ apiKey: c.anthropicKey, model: c.model });
  }
  function secureCookies(req) { return !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.origin); }
  function base(req) { return config().publicUrl || req.origin; }
  function redirectUri(req) { return base(req) + '/api/assistant/auth/callback'; }

  async function currentUser(req, d) {
    const c = config();
    const p = verifyPayload(req.cookies[SESSION_COOKIE], c.sessionSecret);
    if (!p) return null;
    const u = await findUserById(d, p.u);
    if (!u || (u.session_epoch || 0) !== (p.ep || 0)) return null;
    // Access can be withdrawn after sign-in (allow-list edit) — re-checked here.
    if (!(await isAllowedEmail(d, u.email, c.allowedEmails))) return null;
    return u;
  }

  function googleFor(d, user) {
    let memo = null;
    return () => (memo || (memo = googleContext({ db: d, userId: user.id, config: config(), fetchImpl, sleep: deps.sleep })));
  }

  const json = (body, status = 200, extra = {}) => Object.assign({ status, json: body }, extra);

  // ---------------- public routes ----------------
  async function health() {
    const c = config();
    return json({ ok: true, setup: setupProblems(c), ai: !!c.anthropicKey || deps.claude != null });
  }

  async function authStart(req) {
    const c = config();
    if (!c.googleClientId || !c.googleClientSecret) throw new HttpError(503, 'Google sign-in is not configured yet.');
    const intent = req.query.intent === 'connect' ? 'connect' : 'signin';
    const services = String(req.query.services || '').split(',').filter(k => SERVICE_KEYS.includes(k));
    let uid = null, loginHint = null;
    if (intent === 'connect') {
      const d = await db();
      const u = await currentUser(req, d);
      if (!u) throw new HttpError(401, 'Sign in first.');
      uid = u.id; loginHint = u.email;
    }
    const state = randomToken(24), verifier = randomToken(48);
    const box = signPayload({ s: state, v: verifier, i: intent, sv: services, u: uid, x: now() + 10 * 60 * 1000 }, c.sessionSecret);
    const url = buildAuthUrl({
      clientId: c.googleClientId, redirectUri: redirectUri(req),
      scopes: intent === 'connect' ? scopesFor(services) : SIGN_IN_SCOPES,
      state, codeChallenge: pkceChallenge(verifier), loginHint, consent: intent === 'connect',
    });
    return { status: 302, redirect: url, cookies: [cookie(OAUTH_COOKIE, box, { maxAge: 600, secure: secureCookies(req), path: '/api/assistant' })] };
  }

  async function authCallback(req) {
    const c = config();
    const back = (params) => ({ status: 302, redirect: APP_PATH + '#/' + params, cookies: [cookie(OAUTH_COOKIE, '', { maxAge: 0, secure: secureCookies(req), path: '/api/assistant' })] });
    const fail = msg => back('signin?error=' + encodeURIComponent(msg));
    const box = verifyPayload(req.cookies[OAUTH_COOKIE], c.sessionSecret);
    if (req.query.error) return fail(req.query.error === 'access_denied' ? 'Google sign-in was cancelled.' : 'Google returned an error: ' + req.query.error);
    if (!box || !req.query.state || box.s !== req.query.state) return fail('That sign-in link expired. Please try again.');
    if (!req.query.code) return fail('Google did not return an authorization code.');
    let tokens, who;
    try {
      tokens = await exchangeCode({ fetchImpl, clientId: c.googleClientId, clientSecret: c.googleClientSecret, code: req.query.code, verifier: box.v, redirectUri: redirectUri(req) });
      who = parseIdToken(tokens.idToken, c.googleClientId, now());
    } catch (e) {
      return fail(e instanceof OAuthError ? e.message : 'Sign-in failed.');
    }
    const d = await db();
    if (!(await isAllowedEmail(d, who.email, c.allowedEmails))) return fail(who.email + ' is not allowed to use this assistant.');
    const { user, created } = await upsertUserFromGoogle(d, who);
    if (box.i === 'connect' && box.u && box.u !== user.id) return fail('Connect the same Google account you signed in with (' + who.email + ' is a different account).');
    if (created) await projects.seedDefaultProjects(d, user.id);
    await saveGoogleGrant(d, { userId: user.id, accountId: who.sub, accountEmail: who.email, tokens, tokenKey: c.tokenKey });
    // If someone unticked a box on Google's consent screen, tell them which.
    const granted = new Set(tokens.scopes || []);
    const missing = (box.sv || []).filter(k => !SERVICES[k].scopes.every(s => granted.has(s)));
    const sessionCookie = cookie(SESSION_COOKIE, issueSession(user, c.sessionSecret, now()), { maxAge: SESSION_MAX_AGE, secure: secureCookies(req) });
    const out = back(box.i === 'connect' ? 'connections?' + (missing.length ? 'missing=' + missing.join(',') : 'connected=1') : 'today');
    out.cookies.push(sessionCookie);
    return out;
  }

  // ---------------- authenticated routes ----------------
  const routes = {
    'GET me': async ({ user, d }) => {
      const conn = await getConnection(d, user.id);
      return json({ user: publicUser(user), ai: !!claudeFor(config()), counts: await captures.counts(d, user.id), google: conn ? { email: conn.account_email, status: conn.status } : null });
    },
    'GET bootstrap': async ({ user, d }) => {
      const [p, cnt, conn] = await Promise.all([projects.listProjects(d, user.id), captures.counts(d, user.id), getConnection(d, user.id)]);
      return json({
        user: publicUser(user), ai: !!claudeFor(config()), counts: cnt, projects: p,
        kinds: KINDS, statuses: STATUSES, projectKinds: PROJECT_KINDS, memoryKinds: MEMORY_KINDS,
        google: conn ? { email: conn.account_email, status: conn.status } : null,
      });
    },
    'POST settings': async ({ user, d, body }) => {
      if (body && body.tz && validTz(body.tz)) await setUserTz(d, user.id, body.tz);
      return json({ ok: true });
    },

    // ---- capture ----
    'POST capture': async ({ user, d, body, tz }) => {
      const b = body || {};
      const text = String(b.text || '').slice(0, 20000);
      const url = b.url ? String(b.url).slice(0, 2000) : (text.match(/https?:\/\/[^\s<>"]+/) || [null])[0];
      const atts = Array.isArray(b.attachments) ? b.attachments.slice(0, 4) : [];
      for (const a of atts) { const err = validateAttachment(a); if (err) throw new HttpError(400, err); }
      if (!text.trim() && !url && !atts.length) throw new HttpError(400, 'Nothing to capture.');
      if (!b.client_ref || !/^[\w:.-]{8,80}$/.test(b.client_ref)) throw new HttpError(400, 'client_ref required');
      const sourceType = ['text', 'voice', 'photo', 'file', 'link', 'share', 'clipboard'].includes(b.source_type) ? b.source_type : 'text';
      const capturedAt = b.captured_at && !isNaN(Date.parse(b.captured_at)) && Date.parse(b.captured_at) <= now() + 60000 ? b.captured_at : null;
      const details = {};
      if (sourceType === 'voice') details.transcript_source = b.transcript_source || 'device';
      const { capture, duplicate } = await captures.createCapture(d, user.id, { clientRef: b.client_ref, rawText: text, sourceType, url, capturedAt, details });
      if (duplicate) return json({ capture: await captures.getCapture(d, user.id, capture.id), duplicate: true, intent: capture.kind === 'question' ? 'question' : 'capture' });
      for (const a of atts) await addAttachment(d, user.id, capture.id, a);
      // From here on the capture is safe. Enrichment may fail without loss.
      if (url && text.replace(url, '').trim().length < 3) {
        try {
          const lp = await linkPreview(url, { fetchImpl: deps.linkFetch || fetchImpl, lookup: deps.lookup });
          if (lp && (lp.title || lp.description)) {
            await captures.mergeDetails(d, user.id, capture.id, { link: lp });
            if (!text.replace(url, '').trim()) await captures.appendRawText(d, user.id, capture.id, '\n' + (lp.title || '') + (lp.description ? ' — ' + lp.description : ''));
          }
        } catch { /* preview is optional */ }
      }
      let intent = 'capture';
      try {
        await checkRate(d, user.id, 'classify', now());
        const fresh = await captures.getCapture(d, user.id, capture.id);
        const r = await classifyCapture({ db: d, userId: user.id, claude: claudeFor(config()), capture: fresh, tz, now: now() });
        intent = b.force_capture ? 'capture' : r.intent;
        if (b.force_capture && r.intent === 'question') await captures.updateCapture(d, user.id, capture.id, { kind: 'note', status: 'inbox' });
      } catch (e) { if (!(e instanceof RateLimitError)) console.error('classify failed', e && e.message); }
      return json({ capture: await captures.getCapture(d, user.id, capture.id), duplicate: false, intent }, 201);
    },
    'POST reprocess': async ({ user, d, tz }) => {
      const claude = claudeFor(config());
      if (!claude) return json({ processed: 0 });
      const pending = await captures.pendingClassification(d, user.id, 3);
      let n = 0;
      for (const c of pending) {
        try { await checkRate(d, user.id, 'classify', now()); await classifyCapture({ db: d, userId: user.id, claude, capture: c, tz, now: now() }); n++; } catch { break; }
      }
      return json({ processed: n });
    },
    'GET inbox': async ({ user, d, query }) => json(await captures.listCaptures(d, user.id, {
      status: query.status || null, kind: query.kind || null, projectId: query.project || null,
      limit: Math.min(100, +query.limit || 40), before: query.before || null, openTasks: query.open_tasks === '1',
    })),
    'GET item': async ({ user, d, query }) => {
      const c = await captures.getCapture(d, user.id, String(query.id || ''));
      if (!c) throw new HttpError(404, 'Not found');
      return json({ item: c, related: await captures.relatedCaptures(d, user.id, c, 5) });
    },
    'PATCH item': async ({ user, d, body }) => {
      const b = body || {};
      const c = await captures.updateCapture(d, user.id, String(b.id || ''), b);
      if (!c) throw new HttpError(404, 'Not found');
      if (Array.isArray(b.tags)) await setCaptureTags(d, user.id, c.id, b.tags.map(String), 'user');
      return json({ item: await captures.getCapture(d, user.id, c.id) });
    },
    'DELETE item': async ({ user, d, query }) => json({ deleted: await captures.deleteCapture(d, user.id, String(query.id || '')) }),
    'GET attachment': async ({ user, d, query }) => {
      const a = await getAttachmentData(d, user.id, String(query.id || ''));
      if (!a) throw new HttpError(404, 'Not found');
      return { status: 200, binary: Buffer.from(a.data_b64, 'base64'), contentType: a.mime, headers: { 'cache-control': 'private, max-age=86400', 'content-disposition': 'inline', 'content-security-policy': "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'" } };
    },

    // ---- projects ----
    'GET projects': async ({ user, d }) => json({ projects: await projects.listProjects(d, user.id) }),
    'GET project': async ({ user, d, query }) => {
      const p = await projects.getProject(d, user.id, String(query.id || ''));
      if (!p) throw new HttpError(404, 'Not found');
      const [items, mems, ext] = await Promise.all([
        captures.listCaptures(d, user.id, { projectId: p.id, limit: 60 }),
        memories.listMemories(d, user.id, { limit: 500 }).then(ms => ms.filter(m => m.subject_type === 'project' && m.subject_id === p.id)),
        external.externalForProject(d, user.id, p.id),
      ]);
      return json({ project: p, items: items.items, memories: mems, external: ext });
    },
    'POST projects': async ({ user, d, body }) => {
      const p = await projects.createProject(d, user.id, body || {});
      if (!p) throw new HttpError(400, 'Name required');
      return json({ project: p }, 201);
    },
    'PATCH project': async ({ user, d, body }) => {
      const p = await projects.updateProject(d, user.id, String((body || {}).id || ''), body || {});
      if (!p) throw new HttpError(404, 'Not found');
      return json({ project: p });
    },
    'DELETE project': async ({ user, d, query }) => json({ deleted: await projects.deleteProject(d, user.id, String(query.id || '')) }),

    // ---- people ----
    'GET people': async ({ user, d }) => json({ people: await people.listPeople(d, user.id) }),
    'GET person': async ({ user, d, query, google }) => {
      const p = await people.getPerson(d, user.id, String(query.id || ''));
      if (!p) throw new HttpError(404, 'Not found');
      const items = await people.captureIdsForPerson(d, user.id, p.id, 30);
      const emails = p.identities.filter(i => i.provider === 'email').map(i => i.provider_id);
      const g = await google();
      const extra = { emails: { status: 'not_connected', items: [] }, meetings: { status: 'not_connected', items: [] } };
      if (emails.length && g && g.usable('gmail')) {
        try { extra.emails = { status: 'ok', items: (await gmail.searchThreads(g.client('gmail'), { query: emails.map(e => `from:${e} OR to:${e}`).join(' OR '), max: 6, accountEmail: g.connection.account_email })).items }; }
        catch (e) { extra.emails = { status: 'error', message: e.publicMessage, items: [] }; }
      } else if (!emails.length) extra.emails.status = 'no_email';
      if (emails.length && g && g.usable('calendar')) {
        try {
          const r = await calendar.listEvents(g.client('calendar'), { timeMin: new Date(now()).toISOString(), timeMax: new Date(now() + 30 * 86400000).toISOString(), query: emails[0], max: 10 });
          extra.meetings = { status: 'ok', items: r.items };
        } catch (e) { extra.meetings = { status: 'error', message: e.publicMessage, items: [] }; }
      } else if (!emails.length) extra.meetings.status = 'no_email';
      return json({ person: p, items, ...extra });
    },
    'PATCH person': async ({ user, d, body }) => {
      const p = await people.updatePerson(d, user.id, String((body || {}).id || ''), body || {});
      if (!p) throw new HttpError(404, 'Not found');
      return json({ person: p });
    },
    'POST people/merge': async ({ user, d, body }) => {
      const p = await people.mergePeople(d, user.id, String((body || {}).from || ''), String((body || {}).into || ''));
      if (!p) throw new HttpError(400, 'Could not merge those people.');
      return json({ person: p });
    },

    // ---- memory ----
    'GET memory': async ({ user, d }) => json({ memories: await memories.listMemories(d, user.id) }),
    'POST memory': async ({ user, d, body }) => {
      const b = body || {};
      const m = await memories.addMemory(d, user.id, { kind: b.kind, statement: b.statement, sourceType: 'user' });
      if (!m) throw new HttpError(400, 'Statement required');
      return json({ memory: m }, 201);
    },
    'PATCH memory': async ({ user, d, body }) => {
      const m = await memories.supersedeMemory(d, user.id, String((body || {}).id || ''), String((body || {}).statement || ''));
      if (!m) throw new HttpError(404, 'Not found');
      return json({ memory: m });
    },
    'DELETE memory': async ({ user, d, query }) => json({ archived: await memories.archiveMemory(d, user.id, String(query.id || '')) }),

    // ---- search ----
    'GET search': async ({ user, d, query, google }) => {
      await checkRate(d, user.id, 'search', now());
      return json(await searchEverything({ db: d, userId: user.id, google, q: query.q }));
    },

    // ---- assistant ----
    'GET conversations': async ({ user, d }) => json({ conversations: await convs.listConversations(d, user.id) }),
    'GET conversation': async ({ user, d, query }) => {
      const c = await convs.getConversation(d, user.id, String(query.id || ''));
      if (!c) throw new HttpError(404, 'Not found');
      return json({ conversation: c });
    },
    'DELETE conversation': async ({ user, d, query }) => json({ deleted: await convs.deleteConversation(d, user.id, String(query.id || '')) }),
    'GET message': async ({ user, d, query }) => {
      const m = await convs.getMessage(d, user.id, String(query.id || ''));
      if (!m) throw new HttpError(404, 'Not found');
      return json({ message: m });
    },
    'POST chat': async ({ user, d, body, tz, google }) => {
      const b = body || {};
      const question = String(b.message || '').trim().slice(0, 8000);
      if (!question) throw new HttpError(400, 'Ask something.');
      await checkRate(d, user.id, 'chat', now());
      let convId = b.conversation_id ? String(b.conversation_id) : null;
      if (convId && !(await convs.getConversation(d, user.id, convId))) throw new HttpError(404, 'Conversation not found');
      if (!convId) convId = (await convs.createConversation(d, user.id, 'New conversation')).id;
      const claude = claudeFor(config());
      return {
        status: 200,
        stream: async emit => {
          emit({ type: 'conversation', id: convId });
          const msg = await answer({ db: d, user, claude, google, conversationId: convId, question, tz, now: now(), emit });
          emit({ type: 'message', message: msg });
        },
      };
    },
    'POST action': async ({ user, d, body }) => {
      const b = body || {};
      const a = await external.getAction(d, user.id, String(b.id || ''));
      if (!a) throw new HttpError(404, 'Not found');
      if (b.decision !== 'confirm') return json({ action: await external.decideAction(d, user.id, a.id, 'cancel') || a });
      // V1 holds no Google write scopes. A confirmed email or event opens a
      // pre-filled Gmail / Calendar screen; the owner presses Send/Save there.
      const p = a.payload || {};
      let result;
      if (a.kind === 'send_email' || a.kind === 'reply_email') {
        const q = new URLSearchParams({ view: 'cm', fs: '1', to: p.to || '', su: p.subject || '', body: p.body || '' });
        result = { open_url: 'https://mail.google.com/mail/?' + q.toString(), note: 'Opens Gmail with the message ready — nothing is sent until you press Send.' };
      } else if (a.kind === 'create_event') {
        const q = new URLSearchParams({ action: 'TEMPLATE', text: p.subject || a.summary || '', details: p.body || '' });
        if (p.when && !isNaN(Date.parse(p.when))) {
          const s = new Date(p.when), e = new Date(s.getTime() + 3600000);
          const f = x => x.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
          q.set('dates', f(s) + '/' + f(e));
        }
        result = { open_url: 'https://calendar.google.com/calendar/render?' + q.toString(), note: 'Opens Google Calendar with the event filled in — it is not saved until you press Save.' };
      } else {
        result = { note: 'This kind of change is not enabled yet. Nothing was changed.' };
      }
      const done = await external.decideAction(d, user.id, a.id, 'confirm', result);
      if (!done) throw new HttpError(409, 'This action was already decided.');
      return json({ action: done, result });
    },

    // ---- today ----
    'GET today': async ({ user, d, tz, google }) => json(await gatherToday({ db: d, userId: user.id, google, tz, now: now() })),
    'POST catchup': async ({ user, d, tz, google }) => {
      await checkRate(d, user.id, 'briefing', now());
      const data = await gatherToday({ db: d, userId: user.id, google, tz, now: now() });
      return json(await catchMeUp({ claude: claudeFor(config()), data, tz }));
    },

    // ---- connections ----
    'GET connections': async ({ user, d, google }) => {
      const g = await google();
      const conn = g.connection;
      return json({
        providers: PROVIDERS,
        google: conn ? {
          email: conn.account_email, status: conn.status, detail: conn.status_detail,
          connectedAt: conn.created_at, lastUsedAt: conn.last_used_at, lastRefreshedAt: conn.last_refreshed_at,
        } : null,
        services: SERVICE_KEYS.map(k => ({ key: k, label: SERVICES[k].label, icon: SERVICES[k].icon, state: g.states[k], can: SERVICES[k].can, cannot: SERVICES[k].cannot, note: SERVICES[k].note || null, scopes: SERVICES[k].scopes })),
      });
    },
    'POST connections/service': async ({ user, d, body }) => {
      const b = body || {};
      if (!SERVICE_KEYS.includes(b.service)) throw new HttpError(400, 'Unknown service');
      const c = await setServiceDisabled(d, user.id, b.service, !b.enabled);
      if (!c) throw new HttpError(400, 'Google is not connected.');
      return json({ ok: true });
    },
    'POST connections/disconnect': async ({ user, d }) => {
      const conn = await getConnection(d, user.id);
      if (!conn) return json({ ok: true });
      // Revoke at Google first so the grant is really gone, then forget it.
      let revoked = false;
      try {
        const t = conn.refresh_token_enc ? decrypt(conn.refresh_token_enc, config().tokenKey) : null;
        if (t) revoked = await revokeToken({ fetchImpl, token: t });
      } catch { revoked = false; }
      await deleteConnection(d, conn.id);
      return json({ ok: true, revokedAtGoogle: revoked });
    },

    // ---- session ----
    'POST auth/signout': async ({ req }) => json({ ok: true }, 200, { cookies: [cookie(SESSION_COOKIE, '', { maxAge: 0, secure: secureCookies(req) })] }),
    'POST auth/signout-all': async ({ user, d, req }) => {
      await bumpSessionEpoch(d, user.id);
      return json({ ok: true }, 200, { cookies: [cookie(SESSION_COOKIE, '', { maxAge: 0, secure: secureCookies(req) })] });
    },
  };

  return async function handle(req) {
    try {
      const route = req.route;
      if (req.method === 'GET' && route === 'health') return await health();
      if (req.method === 'GET' && route === 'auth/start') return await authStart(req);
      if (req.method === 'GET' && route === 'auth/callback') return await authCallback(req);

      const c = config();
      if (!c.sessionSecret) throw new HttpError(503, 'The assistant is not configured yet (ASSISTANT_SESSION_SECRET).');
      // State-changing requests must carry a header a cross-site form cannot
      // set; together with SameSite cookies this blocks CSRF.
      if (req.method !== 'GET' && req.headers['x-assistant'] !== '1') throw new HttpError(403, 'Missing request header.');
      const d = await db();
      const user = await currentUser(req, d);
      if (!user) return json({ error: 'signed_out' }, 401);
      const fn = routes[req.method + ' ' + route];
      if (!fn) throw new HttpError(404, 'Unknown endpoint');
      const tzHeader = req.headers['x-timezone'];
      const tz = validTz(tzHeader) ? tzHeader : (user.tz && validTz(user.tz) ? user.tz : 'America/New_York');
      if (tzHeader && validTz(tzHeader) && tzHeader !== user.tz) setUserTz(d, user.id, tzHeader).catch(() => {});
      return await fn({ req, d, user, body: req.body, query: req.query, tz, google: googleFor(d, user) });
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      if (e instanceof RateLimitError) return json({ error: e.publicMessage, retryAfter: e.retryAfter }, 429, { headers: { 'retry-after': String(e.retryAfter) } });
      if (e instanceof GoogleApiError) return json({ error: e.publicMessage, kind: e.kind }, e.kind === 'auth' || e.kind === 'not_connected' ? 409 : 502);
      if (e && e.status === 404) return json({ error: 'Not found' }, 404);
      if (e && e.status === 413) return json({ error: 'That upload is too large.' }, 413);
      console.error('assistant error', e && (e.stack || e.message));
      return json({ error: publicError(e) }, 500);
    }
  };
}

function publicUser(u) {
  return { id: u.id, email: u.email, name: u.name, picture: u.picture, tz: u.tz };
}
