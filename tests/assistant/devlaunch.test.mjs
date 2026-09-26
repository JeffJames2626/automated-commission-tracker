import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { makeDb, makeApp, fakeGoogle, fakeClaude, text, toolUse, CONFIG } from './helpers.mjs';
import { fakeDreamBoard } from './fake-dreamboard.mjs';
import { getDb, pgliteDb } from '../../lib/assistant/db/index.mjs';
import { migrate } from '../../lib/assistant/db/schema.mjs';
import { dumpAll, restore } from '../../lib/assistant/backup.mjs';
import { scrub } from '../../lib/assistant/log.mjs';
import { guardClassification, isHedged } from '../../lib/assistant/ai/hedge.mjs';

// The real-world development launch: private access, one sign-in address,
// diagnostics without content, beta tools, classification safety, backups,
// the Dream Board "Connect Personal Assistant" flow, and the demo boundary.

const LIMITS = { chat: { perMinute: 999, perDay: 9999 }, classify: { perMinute: 999, perDay: 9999 }, appsync: { perMinute: 999, perDay: 9999 }, appfile: { perMinute: 999, perDay: 9999 }, pair: { perMinute: 999, perDay: 9999 }, link: { perMinute: 999, perDay: 9999 }, linkpoll: { perMinute: 999, perDay: 9999 }, feedback: { perMinute: 999, perDay: 9999 }, export: { perMinute: 999, perDay: 9999 } };
const classification = o => text(JSON.stringify(Object.assign({
  intent: 'capture', kind: 'note', title: 'T', summary: '', project_id: '', new_project_name: '', tags: [], people: [],
  due_at: '', next_action: '', status: 'inbox', memories: [], confidence: 0.9, reason: 'because',
}, o)));

async function signedIn(opts = {}) {
  const db = opts.db || await makeDb();
  const g = fakeGoogle();
  const app = makeApp(Object.assign({ db, google: g, limits: LIMITS }, opts));
  await app.signIn(opts.who || {});
  return { db, g, app };
}

// ---------------- access ----------------

test('the assistant is private: strangers get one sentence, no session, no data', async () => {
  const db = await makeDb();
  const app = makeApp({ db, google: fakeGoogle(), limits: LIMITS });
  const { cb } = await app.signIn({ sub: '777', email: 'someone@gmail.com' });
  assert.equal(decodeURIComponent(cb.redirect), '/assistant/#/signin?error=This Personal Assistant is private.');
  assert.equal(app.jar.asst_session, undefined);
  for (const [m, r] of [['GET', 'bootstrap'], ['GET', 'inbox'], ['GET', 'review'], ['GET', 'export'], ['GET', 'dreams'], ['POST', 'feedback'], ['GET', 'apps/link']]) {
    const out = await app.call(m, r, { body: {} });
    assert.equal(out.status, 401, r);
  }
  // No user row was created for them either.
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM asst_users`))[0].n, 0);
});

test('development and production need the explicit allow-list: tracker admins are not let in by default', async () => {
  const db = await makeDb();
  await db.query(`CREATE TABLE users (email TEXT, role TEXT)`);
  await db.query(`INSERT INTO users VALUES ('boss@example.com', 'admin')`);
  const dev = makeApp({ db, google: fakeGoogle(), limits: LIMITS, config: { allowedEmails: [], allowFallback: false } });
  const r = await dev.signIn({ sub: '42', email: 'boss@example.com' });
  assert.match(decodeURIComponent(r.cb.redirect), /This Personal Assistant is private/);
  const local = makeApp({ db, google: fakeGoogle(), limits: LIMITS, config: { allowedEmails: [], allowFallback: true } });
  await local.signIn({ sub: '42', email: 'boss@example.com' });
  assert.ok(local.jar.asst_session);
  // Unconfigured sign-in answers with the sign-in page, not an error document.
  const bare = makeApp({ db, google: fakeGoogle(), limits: LIMITS, config: { googleClientId: '' } });
  const s = await bare.call('GET', 'auth/start', { query: { intent: 'signin' } });
  assert.equal(s.status, 302);
  assert.match(decodeURIComponent(s.redirect), /#\/signin\?error=Sign-in is not set up on this server yet\./);
});

test('sign-in always happens on the one public address, and returns to the screen it started from', async () => {
  const db = await makeDb();
  const g = fakeGoogle();
  const other = makeApp({ db, google: g, limits: LIMITS, config: { publicUrl: 'https://assistant-dev.example.com' }, origin: 'https://automated-commission-tracker-git-dev.vercel.app' });
  const moved = await other.call('GET', 'auth/start', { query: { intent: 'signin', next: '#/link?code=ABCD-EFGH', r: 'auth/start' } });
  assert.equal(moved.status, 302);
  assert.equal(moved.redirect, 'https://assistant-dev.example.com/api/assistant/auth/start?intent=signin&next=%23%2Flink%3Fcode%3DABCD-EFGH');

  const app = makeApp({ db, google: g, limits: LIMITS, config: { publicUrl: 'https://assistant-dev.example.com' }, origin: 'https://assistant-dev.example.com' });
  const start = await app.call('GET', 'auth/start', { query: { intent: 'signin', next: '#/link?code=ABCD-EFGH' } });
  const u = new URL(start.redirect);
  assert.equal(u.searchParams.get('redirect_uri'), 'https://assistant-dev.example.com/api/assistant/auth/callback');
  const cb = await app.call('GET', 'auth/callback', { query: { code: 'c', state: u.searchParams.get('state') } });
  assert.equal(cb.redirect, '/assistant/#/link?code=ABCD-EFGH');

  // Anything that isn't a screen inside the app is ignored.
  for (const bad of ['https://evil.example', '//evil.example', '#//evil.example', 'javascript:alert(1)', '#/link?code=<x>']) {
    const s2 = await app.call('GET', 'auth/start', { query: { intent: 'signin', next: bad } });
    const cb2 = await app.call('GET', 'auth/callback', { query: { code: 'c', state: new URL(s2.redirect).searchParams.get('state') } });
    assert.equal(cb2.redirect, '/assistant/#/today', bad);
  }
});

test('one person, one account: email case and a different address never make a second user', async () => {
  const db = await makeDb();
  const g = fakeGoogle();
  const app = makeApp({ db, google: g, limits: LIMITS });
  await app.signIn({ sub: '1001', email: 'Owner@Example.COM' });
  assert.ok(app.jar.asst_session, 'mixed-case address is on the allow-list');
  await app.signIn({ sub: '1001', email: 'owner@example.com' });
  const other = makeApp({ db, google: g, limits: LIMITS, origin: 'https://another-host.test' });
  await other.signIn({ sub: '1001', email: 'OWNER@example.com' });
  const users = await db.query('SELECT email FROM asst_users');
  assert.deepEqual(users.map(u => u.email), ['owner@example.com']);
});

// ---------------- diagnostics ----------------

test('every request is logged by reference, with no content; server errors show the reference', async () => {
  const { app, db } = await signedIn();
  await app.call('POST', 'capture', { body: { client_ref: 'log-test-0001', text: 'Secret plan: call jane@example.com about the 12345678 deal' } });
  const line = app.logs.find(l => l.route === 'capture');
  assert.ok(line && /^req_[0-9a-f]{12}$/.test(line.req) && line.status === 201 && typeof line.ms === 'number' && line.user);
  assert.doesNotMatch(JSON.stringify(app.logs), /Secret plan|jane@|12345678/);

  // A database failure whose message quotes data.
  const broken = Object.assign({}, db, { query: (t, p) => (/FROM asst_projects/.test(t) ? Promise.reject(Object.assign(new Error('duplicate key (email)=(jane@example.com) "Secret plan"'), { code: '23505' })) : db.query(t, p)) });
  const app2 = makeApp({ db: broken, google: fakeGoogle(), limits: LIMITS });
  const out = await app2.call('GET', 'projects', { cookies: Object.assign({}, app.jar) });
  assert.equal(out.status, 500);
  assert.equal(out.json.error, 'Something went wrong on the server.');
  assert.match(out.json.ref, /^req_/);
  assert.equal(out.headers['x-request-id'], out.json.ref);
  const err = app2.logs.find(l => l.level === 'error');
  assert.equal(err.req, out.json.ref);
  assert.equal(err.code, '23505');
  assert.doesNotMatch(JSON.stringify(err), /jane@|Secret plan/);
  assert.doesNotMatch(scrub('token ya29.abcdef sk-ant-xyz dbc_123'), /ya29|sk-ant|dbc_1/);
});

test('health and bootstrap name the build and environment', async () => {
  const { app } = await signedIn();
  const prev = { ...process.env };
  Object.assign(process.env, { ASSISTANT_ENV: 'development', VERCEL_GIT_COMMIT_SHA: 'abcdef1234567', VERCEL_GIT_COMMIT_REF: 'dev' });
  try {
    const h = await app.call('GET', 'health');
    assert.deepEqual(h.json.build, { env: 'development', sha: 'abcdef1', branch: 'dev', builtAt: null });
    const b = await app.call('GET', 'bootstrap');
    assert.equal(b.json.build.env, 'development');
  } finally { for (const k of ['ASSISTANT_ENV', 'VERCEL_GIT_COMMIT_SHA', 'VERCEL_GIT_COMMIT_REF']) if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
});

test('tests cannot reach a real database', async () => {
  await assert.rejects(getDb('postgres://real.example/db'), /Tests must not connect to a real database/);
});

// ---------------- beta tools ----------------

test('Report / Idea saves a capture under the Personal Assistant project, filed by hand', async () => {
  const { app } = await signedIn();
  const a = await app.call('POST', 'feedback', { body: { type: 'problem', text: 'The mic button did nothing on my phone', screen: '#/today' } });
  assert.equal(a.status, 201);
  assert.equal(a.json.item.kind, 'task');
  assert.equal(a.json.item.project_name, 'Personal Assistant');
  assert.equal(a.json.item.classification_state, 'manual');
  assert.equal(a.json.item.details.feedback.screen, '#/today');
  const b = await app.call('POST', 'feedback', { body: { type: 'idea', text: 'A widget for quick capture' } });
  assert.equal(b.json.item.kind, 'product_idea');
  const ps = (await app.call('GET', 'projects')).json.projects.filter(p => p.name === 'Personal Assistant');
  assert.equal(ps.length, 1, 'the project is made once');
  assert.equal((await app.call('POST', 'feedback', { body: { text: '  ' } })).status, 400);
});

test('capture review shows the raw words beside what was made of them', async () => {
  const claude = fakeClaude(() => classification({ kind: 'task', title: 'Call Josh', people: [{ name: 'Josh', email: '' }], confidence: 0.62, reason: 'asks to call someone' }));
  const { app } = await signedIn({ claude });
  await app.call('POST', 'capture', { body: { client_ref: 'review-0001', text: 'call josh about the mower' } });
  const r = await app.call('GET', 'review');
  const it = r.json.items[0];
  assert.equal(it.raw, 'call josh about the mower');
  assert.equal(it.kind, 'task');
  assert.deepEqual(it.people, ['Josh']);
  assert.equal(it.confidence, 0.62);
  assert.equal(it.reason, 'asks to call someone');
  assert.equal(it.filing, 'done');
});

// ---------------- classification safety ----------------

test('"Maybe we should pay 5%" is an idea, never a decision or a memory', async () => {
  const claude = fakeClaude(() => classification({ kind: 'decision', title: 'Pay 5%', memories: [{ kind: 'decision', statement: 'We pay 5%' }], status: 'active' }));
  const { app, db } = await signedIn({ claude });
  const r = await app.call('POST', 'capture', { body: { client_ref: 'hedge-0001', text: 'Maybe we should pay 5% on renewals' } });
  assert.equal(r.json.capture.kind, 'idea');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM asst_memories'))[0].n, 0);
  assert.ok(r.json.capture.ai.guard.some(g => /decision → idea/.test(g)));
  assert.equal(r.json.capture.raw_text, 'Maybe we should pay 5% on renewals', 'the raw words are kept');
});

test('a settled decision is kept as one, with its memory', async () => {
  const claude = fakeClaude(() => classification({ kind: 'decision', title: 'Zach 8%', memories: [{ kind: 'decision', statement: 'Zach gets 8% on new mowing contracts' }] }));
  const { app, db } = await signedIn({ claude });
  const r = await app.call('POST', 'capture', { body: { client_ref: 'hedge-0002', text: 'We decided Zach gets 8% on new mowing contracts' } });
  assert.equal(r.json.capture.kind, 'decision');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM asst_memories'))[0].n, 1);
});

test('unsure filing stays in the Inbox and invents no project', async () => {
  const claude = fakeClaude(() => classification({ kind: 'business_idea', status: 'active', new_project_name: 'Gutter Co', confidence: 0.3 }));
  const { app } = await signedIn({ claude });
  const r = await app.call('POST', 'capture', { body: { client_ref: 'hedge-0003', text: 'gutters thing' } });
  assert.equal(r.json.capture.status, 'inbox');
  assert.equal(r.json.capture.project_id, null);
  assert.ok(!(await app.call('GET', 'projects')).json.projects.some(p => p.name === 'Gutter Co'));
});

test('the assistant cannot remember a tentative thought as a decision', async () => {
  const claude = fakeClaude((p, n) => (n === 0 ? toolUse([{ name: 'remember', input: { kind: 'decision', statement: 'We pay 5% on renewals' } }]) : text('Okay.')));
  const { app, db } = await signedIn({ claude });
  await app.stream('chat', { message: 'maybe we should pay 5% on renewals?' });
  assert.equal((await db.query('SELECT count(*)::int AS n FROM asst_memories'))[0].n, 0);
  const tool = claude.requests[1].messages.at(-1).content.find(c => c.type === 'tool_result');
  assert.match(JSON.stringify(tool), /Not remembered/);
});

test('hedge rules', () => {
  for (const t of ['Maybe we should pay 5%', 'what if we raised prices', 'thinking about a second truck', 'Should we hire Sam?']) assert.ok(isHedged(t), t);
  assert.ok(!isHedged('We decided to hire Sam'));
  assert.equal(guardClassification({ kind: 'decision', memories: [] }, 'we might go with Sam').c.kind, 'idea');
});

// ---------------- journal: never lost, retried without duplicates ----------------

test('a journal entry the AI could not finish stays saved, is retried, and does not repeat what was saved', async () => {
  let fail = true;
  const claude = fakeClaude((p, n) => {
    if (fail) { if (n === 0) return toolUse([{ name: 'save_capture', input: { text: 'Call Josh tomorrow', kind: 'task' } }]); return new Error('overloaded'); }
    assert.match(p.system.map(s => s.text).join('\n'), /Already saved from this entry.*Call Josh tomorrow/s);
    return text('✓ Already had the task.');
  });
  const { app, db } = await signedIn({ claude });
  const r = await app.call('POST', 'capture', { body: { client_ref: 'journal-fail-01', text: 'Call Josh tomorrow. Also the fence needs paint.', journal: true } });
  const first = await app.stream('journal', { capture_id: r.json.capture.id });
  assert.ok(first.events.some(e => e.type === 'error'));
  const c1 = (await app.call('GET', 'item', { query: { id: r.json.capture.id } })).json.item;
  assert.equal(c1.details.journal_state, 'pending');
  assert.equal(c1.raw_text, 'Call Josh tomorrow. Also the fence needs paint.');
  fail = false;
  await app.call('POST', 'reprocess');
  const c2 = (await app.call('GET', 'item', { query: { id: r.json.capture.id } })).json.item;
  assert.equal(c2.details.journal_state, 'done');
  const kids = await db.query(`SELECT count(*)::int AS n FROM asst_links WHERE relation = 'from_journal' AND to_id = $1`, [r.json.capture.id]);
  assert.equal(kids[0].n, 1);
});

test('a retried capture whose attachments were lost gets them back', async () => {
  const { app, db } = await signedIn();
  const photo = { kind: 'image', mime: 'image/png', name: 'a.png', data: Buffer.from('fakepng').toString('base64') };
  const r = await app.call('POST', 'capture', { body: { client_ref: 'att-retry-0001', text: 'receipt', source_type: 'photo', attachments: [photo] } });
  await db.query('DELETE FROM asst_attachments WHERE capture_id = $1', [r.json.capture.id]);
  const again = await app.call('POST', 'capture', { body: { client_ref: 'att-retry-0001', text: 'receipt', source_type: 'photo', attachments: [photo] } });
  assert.equal(again.json.duplicate, true);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM asst_attachments WHERE capture_id = $1', [r.json.capture.id]))[0].n, 1);
});

// ---------------- backup and export ----------------

test('export is the owner\'s data without secrets; a full backup restores exactly and never overwrites', async () => {
  const { app, db } = await signedIn();
  await app.call('POST', 'capture', { body: { client_ref: 'backup-0001', text: 'Keep this', attachments: [{ kind: 'image', mime: 'image/png', name: 'p.png', data: Buffer.from('png-bytes').toString('base64') }] } });
  await app.call('POST', 'connections/service', { body: { service: 'gmail', enabled: true } });
  const ex = await app.call('GET', 'export');
  assert.match(ex.headers['content-disposition'], /attachment; filename="assistant-export-/);
  const dump = JSON.parse(ex.binary.toString('utf8'));
  assert.equal(dump.tables.asst_captures.length, 1);
  assert.equal(dump.tables.asst_users.length, 1);
  assert.doesNotMatch(ex.binary.toString('utf8'), /refresh_token_enc|access_token_enc|token_hash|data_b64/);

  const full = await dumpAll(db);
  assert.ok(full.tables.asst_attachments[0].data_b64);
  const db2 = pgliteDb(new PGlite());
  await migrate(db2);
  const rep = await restore(db2, JSON.parse(JSON.stringify(full)));
  assert.equal(rep.asst_captures.inserted, 1);
  const back = await db2.query('SELECT raw_text FROM asst_captures');
  assert.equal(back[0].raw_text, 'Keep this');
  assert.equal((await db2.query('SELECT data_b64 FROM asst_attachments'))[0].data_b64, full.tables.asst_attachments[0].data_b64);
  const again = await restore(db2, JSON.parse(JSON.stringify(full)));
  assert.equal(again.asst_captures.inserted, 0);
  assert.equal(again.asst_captures.skipped, 1);
});

// ---------------- Dream Board: Connect Personal Assistant ----------------

test('Dream Board → Connect → sign in with Google → Allow → linked to that account', async () => {
  const { app, db } = await signedIn();
  const board = fakeDreamBoard(app);
  board.board.addGoal('Lake house');
  const start = await board.linkStart();
  assert.equal(start.status, 200);
  assert.match(start.json.approve_url, /^https:\/\/assistant\.test\/assistant\/#\/link\?code=[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const code = start.json.user_code;
  assert.equal((await board.linkPoll()).json.status, 'pending');

  // The page the browser opens.
  const view = await app.call('GET', 'apps/link', { query: { code } });
  assert.equal(view.json.link.status, 'pending');
  assert.equal(view.json.link.instanceLabel, 'Jeff’s PC');
  assert.equal(view.json.label, 'Dream Board');
  assert.equal((await app.call('POST', 'apps/link/approve', { body: { code } })).json.status, 'approved');

  const poll = await board.linkPoll();
  assert.equal(poll.json.status, 'approved');
  assert.match(poll.json.token, /^dbc_/);
  assert.equal((await board.linkPoll()).json.status, 'claimed', 'the token is handed over once');
  await board.syncUntilIdle();
  const dreams = await app.call('GET', 'dreams');
  assert.deepEqual(dreams.json.goals.map(g => g.title), ['Lake house']);
  const row = (await db.query(`SELECT a.status, u.email FROM asst_apps a JOIN asst_users u ON u.id = a.user_id`))[0];
  assert.deepEqual(row, { status: 'connected', email: 'owner@example.com' });
  // The stored link keeps no secret.
  assert.equal((await db.query('SELECT pair_code_enc FROM asst_app_links'))[0].pair_code_enc, null);
});

test('Don\'t allow, expiry, a signed-out browser and a wrong code all leave the board unconnected', async () => {
  const { app, db } = await signedIn();
  const board = fakeDreamBoard(app);
  const s1 = await board.linkStart();
  assert.equal((await app.call('POST', 'apps/link/deny', { body: { code: s1.json.user_code } })).json.status, 'denied');
  assert.equal((await board.linkPoll()).json.status, 'denied');
  assert.equal((await app.call('POST', 'apps/link/approve', { body: { code: s1.json.user_code } })).status, 409);

  const s2 = await board.linkStart();
  const stranger = makeApp({ db, google: fakeGoogle(), limits: LIMITS });
  assert.equal((await stranger.call('POST', 'apps/link/approve', { body: { code: s2.json.user_code } })).status, 401);
  assert.equal((await app.call('GET', 'apps/link', { query: { code: 'ZZZZ-ZZZZ' } })).status, 404);
  await db.query(`UPDATE asst_app_links SET expires_at = now() - interval '1 minute' WHERE user_code = $1`, [s2.json.user_code]);
  assert.equal((await app.call('POST', 'apps/link/approve', { body: { code: s2.json.user_code } })).status, 410);
  assert.equal((await board.linkPoll()).json.status, 'expired');
  assert.equal((await app.call('POST', 'apps/v1/link/poll', { body: { device_code: 'dbl_nope' }, cookies: {} })).status, 400);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM asst_apps WHERE status = 'connected'`))[0].n, 0);
});

test('a board linked this way loses access with "sign out everywhere", like a paired one', async () => {
  const { app } = await signedIn();
  const board = fakeDreamBoard(app);
  const s = await board.linkStart();
  await app.call('POST', 'apps/link/approve', { body: { code: s.json.user_code } });
  await board.linkPoll();
  assert.equal((await board.sync()).status, 200);
  await app.call('POST', 'auth/signout-all');
  assert.equal((await board.sync()).status, 401);
});

// ---------------- the demo can never touch real data ----------------

test('the demo is fenced off from the real assistant', async () => {
  const src = fs.readFileSync(new URL('../../lib/assistant/router.mjs', import.meta.url), 'utf8');
  const routes = [...src.matchAll(/'(GET|POST|PATCH|DELETE) ([\w/-]+)'/g)].map(m => m[2]);
  assert.ok(routes.length > 30);
  assert.ok(!routes.some(r => /reset|wipe|seed|demo|__dev|truncate|purge/i.test(r)), 'no server route can reset or seed data');
  for (const f of fs.readdirSync(new URL('../../assistant/', import.meta.url)).filter(f => /\.(js|html)$/.test(f)).map(f => 'assistant/' + f)
    .concat(fs.readdirSync(new URL('../../assistant/views/', import.meta.url)).map(f => 'assistant/views/' + f))) {
    const s = fs.readFileSync(new URL('../../' + f, import.meta.url), 'utf8');
    assert.doesNotMatch(s, /demo-api|__asstDemoReset|__ASST_DEMO__ = true/, f + ' must not carry the demo');
  }
  const ignore = fs.readFileSync(new URL('../../.vercelignore', import.meta.url), 'utf8');
  assert.match(ignore, /^\/scripts\/assistant-demo$/m);
  assert.match(ignore, /^\/scripts\/assistant-dev\.mjs$/m);
  const demo = fs.readFileSync(new URL('../../scripts/assistant-demo/demo-api.js', import.meta.url), 'utf8');
  assert.match(demo, /if \(window\.__ASST_DEMO__ !== true \|\| \/\^\\\/\(assistant\|api\)\\\/\/\.test\(location\.pathname\)\) return;/);
  assert.doesNotMatch(demo, /removeItem\('asst:/);
});

// ---------------- regressions from the pre-push review ----------------

test('path-form routes reach the router intact on Vercel (the rewrite adds no stray space)', async () => {
  const { toRequest } = await import('../../lib/assistant/http.mjs');
  const vj = JSON.parse(fs.readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'));
  assert.equal(vj.rewrites.find(r => r.source === '/api/assistant/:path+').destination, '/api/assistant?r=:path');
  // What the old rule produced: r=auth/start%20
  const req = { method: 'GET', url: '/api/assistant?r=auth/start%20&path=auth/start', headers: { host: 'assistant-dev.example.com', 'x-forwarded-proto': 'https' }, body: null };
  assert.equal((await toRequest(req)).route, 'auth/start');
});

test('the public address is compared as an origin (case, trailing slash, spaces)', async () => {
  const { originOf } = await import('../../lib/assistant/config.mjs');
  assert.equal(originOf(' https://Assistant-Dev.Example.com/ \n'), 'https://assistant-dev.example.com');
  assert.equal(originOf('https://assistant-dev.example.com:443'), 'https://assistant-dev.example.com');
  assert.equal(originOf('http://assistant-dev.example.com'), '');
  const app = makeApp({ db: await makeDb(), google: fakeGoogle(), limits: LIMITS, config: { publicUrl: originOf('https://Assistant-Dev.Example.com/') }, origin: 'https://assistant-dev.example.com' });
  const s = await app.call('GET', 'auth/start', { query: { intent: 'signin' } });
  assert.match(s.redirect, /^https:\/\/accounts\.google\.com\//, 'no self-redirect loop');
});

test('a refused sign-in keeps where it was going, and "use a different account" shows the chooser', async () => {
  const db = await makeDb();
  const g = fakeGoogle();
  const app = makeApp({ db, google: g, limits: LIMITS });
  g.state.tokenResponse.id_token = (await import('./helpers.mjs')).idToken({ sub: '9', email: 'other@automatedlawnandpest.com' });
  const start = await app.call('GET', 'auth/start', { query: { intent: 'signin', next: '#/link?code=ABCD-EFGH', switch: '1' } });
  assert.equal(new URL(start.redirect).searchParams.get('prompt'), 'select_account');
  const cb = await app.call('GET', 'auth/callback', { query: { code: 'c', state: new URL(start.redirect).searchParams.get('state') } });
  assert.equal(decodeURIComponent(cb.redirect), '/assistant/#/signin?error=This Personal Assistant is private.&next=#/link?code=ABCD-EFGH');
});

test('a journal entry answered while the AI is down (search-only reply) stays pending and is retried', async () => {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  let down = true;
  const claude = fakeClaude(() => (down ? new Anthropic.InternalServerError(529, { error: { type: 'overloaded_error' } }, 'Overloaded', new Headers()) : text('✓ Noted.')));
  const { app, db } = await signedIn({ claude });
  const r = await app.call('POST', 'capture', { body: { client_ref: 'journal-down-01', text: 'Order more fertilizer.', journal: true } });
  const first = await app.stream('journal', { capture_id: r.json.capture.id });
  assert.ok(first.events.some(e => e.type === 'error' && /retry automatically/.test(e.error)));
  let c = (await app.call('GET', 'item', { query: { id: r.json.capture.id } })).json.item;
  assert.equal(c.details.journal_state, 'pending');
  down = false;
  await app.call('POST', 'reprocess');
  c = (await app.call('GET', 'item', { query: { id: r.json.capture.id } })).json.item;
  assert.equal(c.details.journal_state, 'done');
  // The entry appears once in the day's journal conversation, however many tries it took.
  const users = await db.query(`SELECT count(*)::int AS n FROM asst_messages WHERE conversation_id = $1 AND role = 'user'`, [c.details.journal_conversation_id]);
  assert.equal(users[0].n, 1);
});

test('the capture sheet and a background retry never both work through one journal entry', async () => {
  // Each run saves the task on its first turn (decided per run, not per call).
  const claude = fakeClaude(async p => {
    await new Promise(res => setTimeout(res, 150));
    const last = p.messages[p.messages.length - 1];
    return typeof last.content === 'string' ? toolUse([{ name: 'save_capture', input: { text: 'Call Josh', kind: 'task' } }]) : text('✓ Task: call Josh');
  });
  const { app, db } = await signedIn({ claude });
  const r = await app.call('POST', 'capture', { body: { client_ref: 'journal-race-01', text: 'Call Josh.', journal: true } });
  const [sheet] = await Promise.all([
    app.stream('journal', { capture_id: r.json.capture.id }),
    new Promise(res => setTimeout(res, 40)).then(() => app.call('POST', 'reprocess')),
  ]);
  assert.ok(sheet.events.some(e => e.type === 'message'));
  const kids = await db.query(`SELECT count(*)::int AS n FROM asst_links WHERE relation = 'from_journal' AND to_id = $1`, [r.json.capture.id]);
  assert.equal(kids[0].n, 1);
});

test('explicit "remember" is honoured sentence by sentence; a yes to the assistant\'s offer counts', async () => {
  for (const [msg, kind, want] of [
    ['Can you remember that the Miller gate code is 4412?', 'fact', 1],
    ['Remember the Miller gate code is 4412. What’s on my calendar tomorrow?', 'fact', 1],
    ['Remember Zach gets 8% on new mowing contracts', 'decision', 1],
    ['Maybe we should remember to pay 5%?', 'decision', 0],
  ]) {
    const claude = fakeClaude((p, n) => (n === 0 ? toolUse([{ name: 'remember', input: { kind, statement: msg.replace(/\?$/, '') } }]) : text('Okay.')));
    const { app, db } = await signedIn({ claude });
    await app.stream('chat', { message: msg });
    assert.equal((await db.query('SELECT count(*)::int AS n FROM asst_memories'))[0].n, want, msg);
  }
  // "yes" to the assistant's own offer.
  const claude = fakeClaude((p, n) => (n === 0 ? text('Want me to remember that the gate code is 4412?') : n === 1 ? toolUse([{ name: 'remember', input: { kind: 'fact', statement: 'Miller gate code is 4412' } }]) : text('Done.')));
  const { app, db } = await signedIn({ claude });
  const first = await app.stream('chat', { message: 'the miller gate code is 4412' });
  const conv = first.events.find(e => e.type === 'conversation').id;
  await app.stream('chat', { message: 'yes please do', conversation_id: conv });
  assert.equal((await db.query('SELECT count(*)::int AS n FROM asst_memories'))[0].n, 1);
});

test('settled decisions stay decisions: "Decision: …", "We\'ll …"', () => {
  for (const t of ['Decision: use Acme for fertilizer', 'We\'ll raise prices 5% in January', 'Decided: Zach gets 8%', 'We decided Zach gets 8%. Maybe also a bonus later?']) {
    assert.equal(guardClassification({ kind: 'decision', memories: [] }, t).c.kind, 'decision', t);
  }
  assert.equal(guardClassification({ kind: 'decision', memories: [] }, 'Maybe we should pay 5% on renewals').c.kind, 'idea');
});

test('an approve that fails part-way leaves the request answerable, not stuck', async () => {
  const { app, db } = await signedIn();
  const board = fakeDreamBoard(app);
  const s = await board.linkStart();
  let broken = true;
  const flaky = Object.assign({}, db, { query: (t, p) => (broken && /SET status = 'approved'/.test(t) ? Promise.reject(new Error('connection reset')) : db.query(t, p)) });
  const app2 = makeApp({ db: flaky, google: fakeGoogle(), limits: LIMITS });
  const out = await app2.call('POST', 'apps/link/approve', { body: { code: s.json.user_code }, cookies: Object.assign({}, app.jar) });
  assert.equal(out.status, 500);
  assert.equal((await db.query('SELECT status FROM asst_app_links'))[0].status, 'pending');
  broken = false;
  assert.equal((await app.call('POST', 'apps/link/approve', { body: { code: s.json.user_code } })).json.status, 'approved');
  assert.equal((await board.linkPoll()).json.status, 'approved');
});

test('backups read in pages and a restore skips rows whose parent is missing', async () => {
  const { app, db } = await signedIn();
  for (let i = 0; i < 11; i++) {
    await app.call('POST', 'capture', { body: { client_ref: 'page-att-' + String(i).padStart(4, '0'), text: 'p' + i, attachments: [{ kind: 'image', mime: 'image/png', name: 'p.png', data: Buffer.from('bytes-' + i).toString('base64') }] } });
  }
  const full = await dumpAll(db);
  assert.equal(full.tables.asst_attachments.length, 11, 'more than one page of attachments');
  // A capture written after its table was read, whose attachment was read later.
  full.tables.asst_captures = full.tables.asst_captures.slice(1);
  const db2 = pgliteDb(new PGlite());
  await migrate(db2);
  const rep = await restore(db2, JSON.parse(JSON.stringify(full)));
  assert.equal(rep.asst_attachments.orphaned, 1);
  assert.equal(rep.asst_attachments.inserted, 10);
});

test('the feedback project never captures other notes by name', async () => {
  const { app } = await signedIn();
  await app.call('POST', 'feedback', { body: { type: 'idea', text: 'Bigger buttons' } });
  const r = await app.call('POST', 'capture', { body: { client_ref: 'pa-name-0001', text: 'Look into hiring a personal assistant for the office' } });
  assert.notEqual(r.json.capture.project_name, 'Personal Assistant');
});

test('a retried capture gets back every attachment that did not make it', async () => {
  const { app, db } = await signedIn();
  const atts = ['a', 'b', 'c'].map(x => ({ kind: 'image', mime: 'image/png', name: x + '.png', data: Buffer.from('img-' + x).toString('base64') }));
  const r = await app.call('POST', 'capture', { body: { client_ref: 'att-partial-01', text: 'three photos', attachments: atts } });
  await db.query(`DELETE FROM asst_attachments WHERE capture_id = $1 AND name <> 'a.png'`, [r.json.capture.id]);
  await app.call('POST', 'capture', { body: { client_ref: 'att-partial-01', text: 'three photos', attachments: atts } });
  assert.equal((await db.query('SELECT count(*)::int AS n FROM asst_attachments WHERE capture_id = $1', [r.json.capture.id]))[0].n, 3);
});
