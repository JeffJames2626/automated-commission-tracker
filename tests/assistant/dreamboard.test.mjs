import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, makeApp, fakeGoogle, fakeClaude, text, toolUse } from './helpers.mjs';
import { TOOL_BY_NAME } from '../../lib/assistant/ai/tools.mjs';
import { SourceRegistry } from '../../lib/assistant/ai/citations.mjs';
import { fakeDreamBoard } from './fake-dreamboard.mjs';
import { routeIntent, dreamTitleFromWords, matchGoals } from '../../lib/assistant/apps/routing.mjs';
import { normalizeRecord, diffRecords } from '../../lib/assistant/apps/records.mjs';
import { LIMITS } from '../../lib/assistant/ratelimit.mjs';

// Dream Board integration, end to end against an in-memory Dream Board server
// that follows the connector contract (tests/assistant/fake-dreamboard.mjs).
// Numbers in test names refer to the Phase 2 failure scenarios.

let db, app, db1, userId, lakeId;
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex').toString('base64');
let refN = 0;
const ref = () => 'db-ref-' + (++refN) + '-' + Date.now();
const capture = (text, extra = {}) => app.call('POST', 'capture', { body: Object.assign({ client_ref: ref(), text }, extra) });
const opsOf = id => db.query('SELECT * FROM asst_app_ops WHERE capture_id = $1 ORDER BY created_at', [id]);

before(async () => {
  db = await makeDb();
  // The suite polls far faster than a real board; the limit itself is tested below.
  app = makeApp({ db, google: fakeGoogle(), limits: Object.assign({}, LIMITS, { appsync: { perMinute: 1e6, perDay: 1e6 } }) });
  await app.signIn();
  userId = (await db.query("SELECT id FROM asst_users WHERE email = 'owner@example.com'"))[0].id;
  db1 = fakeDreamBoard(app);
  db1.board.addGoal('Fitness', { status: 'in_progress', category: { id: 'cat-health', name: 'Health' } });
  db1.board.addGoal('Beach House');
});

test('pairing: one-time code, single use, bound to one board', async () => {
  const code = (await app.call('POST', 'apps/pair', { body: { app: 'dreamboard' } })).json.code;
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const bad = await app.call('POST', 'apps/v1/pair', { body: { app: 'dreamboard', code: 'AAAA-AAAA', instance_id: 'x' }, cookies: {} });
  assert.equal(bad.status, 410);
  const ok = await db1.pair(code);
  assert.equal(ok.status, 200);
  assert.match(ok.json.token, /^dbc_/);
  assert.equal((await db1.pair(code)).status, 410, 'a code works once');
  const stored = await db.query("SELECT token_hash, pair_code_hash FROM asst_apps WHERE app = 'dreamboard'");
  assert.notEqual(stored[0].token_hash, ok.json.token, 'only a hash is stored');
  assert.equal(stored[0].pair_code_hash, null);
  // Before the first sync the assistant says so, and routes nothing yet.
  const c = await app.call('GET', 'connections');
  const dbApp = c.json.apps.find(a => a.key === 'dreamboard');
  assert.equal(dbApp.freshness.state, 'waiting_first_sync');
  assert.ok(dbApp.capabilities.some(x => x.label === 'Add dreams' && x.value === 'yes'));
  assert.ok(dbApp.capabilities.some(x => x.key === 'delete' && x.value === 'no'));
  assert.ok(c.json.services.find(s => s.key === 'gmail').capabilities.some(x => x.key === 'send' && x.value === 'no'));
});

test('first sync backfills the board silently; the Health category maps to no project', async () => {
  const r = await db1.syncUntilIdle();
  assert.equal(r.status, 200);
  const goals = await app.call('GET', 'dreams');
  assert.deepEqual(goals.json.goals.map(g => g.title).sort(), ['Beach House', 'Fitness']);
  const ev = await db.query('SELECT count(*)::int AS n FROM asst_events');
  assert.equal(ev[0].n, 0, 'a backfill is not news');
  assert.equal(goals.json.app.freshness.state, 'live');
});

test('#1 create online: saved, sent, acknowledged, linked — words kept verbatim', async () => {
  const words = 'Save this for my Dream Board — someday I want a lake house with a dock and a fire pit.';
  const r = await capture(words);
  assert.equal(r.status, 201);
  assert.equal(r.json.intent, 'capture');
  assert.equal(r.json.routing.current.status, 'queued');
  assert.equal(r.json.routing.current.title, 'Lake House');
  assert.equal(r.json.capture.status, 'filed', 'a filed capture leaves the inbox');
  await db1.syncUntilIdle();
  const g = db1.board.byTitle('Lake House');
  assert.ok(g, 'goal created in Dream Board');
  assert.equal(g.notes[0].text, words, 'the owner’s words, verbatim');
  lakeId = g.id;
  const item = await app.call('GET', 'item', { query: { id: r.json.capture.id } });
  assert.equal(item.json.routing.current.status, 'applied');
  assert.deepEqual(item.json.routing.current.trace.map(t => t.stage), ['captured', 'routed', 'queued', 'sent', 'acknowledged']);
  assert.equal(item.json.item.sources[0].provider, 'dreamboard');
  assert.equal(item.json.item.raw_text, words);
  const op = (await opsOf(r.json.capture.id))[0];
  assert.equal(op.payload.note, undefined, 'the words now live in Dream Board; the op keeps no copy');
  assert.ok(op.linked_at);
  const inbox = await app.call('GET', 'inbox', { query: { status: 'inbox' } });
  assert.ok(!inbox.json.items.some(i => i.id === r.json.capture.id));
  const dream = await app.call('GET', 'dream', { query: { id: lakeId } });
  assert.equal(dream.json.dream.words[0].text, words);
  assert.equal(dream.json.dream.changes[0].by, 'capture', 'our own create is recognised as ours');
});

test('#2 create while Dream Board is offline: waits, then goes through', async () => {
  db1.s.offline = true;
  const r = await capture('Dream board: someday I want to see the northern lights in Norway');
  assert.equal(r.json.routing.current.status, 'queued');
  assert.equal(db1.board.byTitle('See The Northern Lights In Norway'), undefined);
  db1.s.offline = false;
  await db1.syncUntilIdle();
  const item = await app.call('GET', 'item', { query: { id: r.json.capture.id } });
  assert.equal(item.json.routing.current.status, 'applied');
  assert.equal(db1.board.live().filter(g => /northern lights/i.test(g.title)).length, 1);
});

test('#3 #4 #5 response lost after Dream Board created it: the retry resolves to the same goal', async () => {
  db1.s.dropResults = true;
  const r = await capture('Save to my dream board: someday I want a vintage Bronco');
  await db1.sync();                                   // applied, result lost
  await db1.sync();                                   // re-delivered: deduplicated by op id
  db1.s.dropResults = false;
  await db1.syncUntilIdle();
  assert.equal(db1.board.live().filter(g => /bronco/i.test(g.title)).length, 1, 'no duplicate goal');
  const op = (await opsOf(r.json.capture.id))[0];
  assert.equal(op.status, 'applied');
  assert.ok(op.attempts >= 2);
  // The phone retrying the same capture (same client_ref) makes nothing new.
  const again = await app.call('POST', 'capture', { body: { client_ref: (await db.query('SELECT client_ref FROM asst_captures WHERE id = $1', [r.json.capture.id]))[0].client_ref, text: 'Save to my dream board: someday I want a vintage Bronco' } });
  assert.equal(again.json.duplicate, true);
  assert.equal((await opsOf(r.json.capture.id)).length, 1);
});

test('#6 photo attached to an existing dream (exact name match), file served only for that op', async () => {
  const r = await capture('Add this to my lake house dream', { source_type: 'photo', attachments: [{ mime: 'image/png', data: PNG, name: 'dock.png' }] });
  assert.equal(r.json.routing.current.status, 'queued');
  assert.equal(r.json.routing.current.target.id, lakeId);
  const op = (await opsOf(r.json.capture.id))[0];
  const attId = op.payload.attachments[0].id;
  await db1.syncUntilIdle();
  assert.equal(db1.board.goal(lakeId).images.length, 1);
  // After it is applied, the file is no longer available to the app.
  const late = await app.call('GET', 'apps/v1/files', { query: { id: attId, op: op.id }, headers: db1.auth(), cookies: {} });
  assert.equal(late.status, 404);
});

test('#7 another note attached to the same dream', async () => {
  await capture('Add to my lake house dream: the dock should face west for sunsets');
  await db1.syncUntilIdle();
  assert.ok(db1.board.goal(lakeId).notes.some(n => /face west/.test(n.text)));
  const dream = await app.call('GET', 'dream', { query: { id: lakeId } });
  assert.equal(dream.json.dream.words.length, 3);
});

test('#9 canonical link uses the owner-confirmed address only', async () => {
  let d = await app.call('GET', 'dream', { query: { id: lakeId } });
  assert.equal(d.json.dream.link, null, 'no address confirmed yet → no link');
  assert.equal((await app.call('POST', 'apps/base-url', { body: { url: 'javascript:alert(1)' } })).status, 400);
  assert.equal((await app.call('POST', 'apps/base-url', { body: { url: 'http://evil.example' } })).status, 400);
  await app.call('POST', 'apps/base-url', { body: { url: 'https://jeffs-pc.tail1234.ts.net/some/path' } });
  d = await app.call('GET', 'dream', { query: { id: lakeId } });
  assert.equal(d.json.dream.link, 'https://jeffs-pc.tail1234.ts.net/?goal=' + encodeURIComponent(lakeId));
});

test('#10 #11 #13 change in Dream Board: new value current, old value kept as history, capture untouched', async () => {
  db1.board.edit(lakeId, { target_amount: 1200000 });
  await db1.syncUntilIdle();
  db1.board.edit(lakeId, { target_amount: 1800000 });
  await db1.syncUntilIdle();
  const d = (await app.call('GET', 'dream', { query: { id: lakeId } })).json.dream;
  assert.equal(d.current.fields.target_amount, 1800000);
  assert.ok(d.changes.some(c => c.text === 'target amount $1.2M → $1.8M' && c.by === 'dream_board'));
  assert.match(d.words[0].text, /^Save this for my Dream Board/);
});

test('#14 milestone completed is progress', async () => {
  db1.board.completeMilestone(lakeId, 'Pick the lake');
  await db1.syncUntilIdle();
  const ev = await db.query("SELECT * FROM asst_events WHERE record_id = $1 AND progress", [lakeId]);
  assert.equal(ev.length, 1);
  const goals = (await app.call('GET', 'dreams')).json.goals;
  assert.ok(goals.find(g => g.id === lakeId).lastProgressAt);
});

test('#16 #17 rename in Dream Board: old wording still finds it and still routes to it', async () => {
  db1.board.edit(lakeId, { title: 'Lakeside Cabin' });
  await db1.syncUntilIdle();
  const d = (await app.call('GET', 'dream', { query: { id: lakeId } })).json.dream;
  assert.equal(d.title, 'Lakeside Cabin');
  assert.deepEqual(d.aliases, ['Lake House']);
  const r = await capture('Add this to my lake house dream: look at Table Rock');
  assert.equal(r.json.routing.current.target.id, lakeId);
});

test('#20 #21 duplicate and out-of-order snapshots never double count or go backwards', async () => {
  const before = await db.query('SELECT count(*)::int AS n FROM asst_events');
  const g = JSON.parse(JSON.stringify(db1.board.goal(lakeId)));
  const stale = Object.assign({}, g, { type: 'goal', seq: g.seq - 1, title: 'Old Title' });
  const same = Object.assign({ type: 'goal' }, g);
  const r = await app.call('POST', 'apps/v1/sync', { body: { instance_id: 'board-real', epoch: db1.s.epoch, seq: db1.s.seq, records: [same, stale, same] }, headers: db1.auth(), cookies: {} });
  assert.equal(r.status, 200);
  const after = await db.query('SELECT count(*)::int AS n FROM asst_events');
  assert.equal(after[0].n, before[0].n);
  assert.equal((await app.call('GET', 'dream', { query: { id: lakeId } })).json.dream.title, 'Lakeside Cabin');
});

test('#24 #25 similar names and "my house dream": asks instead of guessing, then files where told', async () => {
  const r = await capture('Add this to my house dream: a wraparound porch');
  const cur = r.json.routing.current;
  assert.equal(cur.status, 'needs_choice');
  assert.ok(cur.candidates.some(c => c.title === 'Beach House'));
  assert.equal(r.json.capture.status, 'inbox', 'nothing filed until the owner picks');
  const beach = db1.board.byTitle('Beach House').id;
  const chosen = await app.call('POST', 'route', { body: { capture_id: r.json.capture.id, choice: { goal: beach } } });
  assert.equal(chosen.json.routing.current.status, 'queued');
  await db1.syncUntilIdle();
  assert.ok(db1.board.goal(beach).notes.some(n => /wraparound porch/.test(n.text)));
  // Exact name wins over a longer similar one.
  db1.board.addGoal('Beach House Dock');
  await db1.syncUntilIdle();
  const r2 = await capture('Add this to my beach house dream: outdoor shower');
  assert.equal(r2.json.routing.current.target.id, beach);
  await db1.syncUntilIdle();
});

test('create never silently makes a second dream with the same name', async () => {
  const r = await capture('Dream board: someday I want a beach house');
  assert.equal(r.json.routing.current.status, 'needs_choice');
  const k = await app.call('POST', 'route', { body: { capture_id: r.json.capture.id, choice: 'keep' } });
  assert.equal(k.json.routing.current.status, 'cancelled');
  assert.equal(k.json.item.status, 'inbox');
});

test('#18 Dream Board unavailable: queue waits, freshness is honest', async () => {
  db1.s.offline = true;
  const r = await capture('Add to my fitness dream: run a half marathon');
  assert.equal(r.json.routing.current.status, 'queued');
  await db.query("UPDATE asst_apps SET last_seen_at = now() - interval '2 days' WHERE app = 'dreamboard'");
  const c = (await app.call('GET', 'connections')).json.apps[0];
  assert.equal(c.freshness.state, 'stale');
  assert.equal(c.queue.queued, 1);
  db1.s.offline = false;
  await db1.syncUntilIdle();
  assert.equal((await app.call('GET', 'connections')).json.apps[0].freshness.state, 'live');
});

test('#19 assistant unavailable: the board keeps its results and re-sends them; nothing is applied twice', async () => {
  const r = await capture('Add to my fitness dream: buy a rowing machine');
  await db1.sync();                                   // op handed over and applied, result pending
  assert.equal(db1.s.unreported.length, 1);
  const real = db1.s.unreported[0];
  // The assistant is down for the next poll: the fake keeps the result.
  const down = { call: async () => ({ status: 503, json: { error: 'down' } }) };
  const flaky = fakeDreamBoard(down);
  Object.assign(flaky.s, db1.s, { unreported: [real] });
  await flaky.sync();
  assert.equal(flaky.s.unreported.length, 1, 'result kept for the next poll');
  await db1.syncUntilIdle();
  await db1.syncUntilIdle();
  const op = (await opsOf(r.json.capture.id))[0];
  assert.equal(op.status, 'applied');
  assert.equal(db1.board.byTitle('Fitness').notes.filter(n => /rowing machine/.test(n.text)).length, 1);
});

test('restore from backup: epoch change triggers a full resend; goals gone since are hidden, not deleted', async () => {
  const snap = db1.board.snapshot();
  const newId = db1.board.addGoal('Sailboat');
  await db1.syncUntilIdle();
  assert.ok((await app.call('GET', 'dreams')).json.goals.some(g => g.id === newId));
  db1.board.restore(snap);                             // Sailboat did not exist in the backup
  const r = await db1.sync();
  assert.equal(r.json.resync, true);
  await db1.syncUntilIdle();
  const goals = (await app.call('GET', 'dreams')).json.goals;
  assert.ok(!goals.some(g => g.id === newId));
  const row = await db.query("SELECT missing_at FROM asst_external_records WHERE provider_record_id = $1", ['goal:' + newId]);
  assert.ok(row[0].missing_at, 'kept, marked missing');
});

test('a deleted target: the attach is rejected and the owner is asked again', async () => {
  const tmp = db1.board.addGoal('Tiny House');
  await db1.syncUntilIdle();
  db1.s.offline = true;
  const r = await capture('Add this to my tiny house dream: loft ladder');
  db1.board.delete(tmp);
  db1.s.offline = false;
  await db1.syncUntilIdle();
  const item = await app.call('GET', 'item', { query: { id: r.json.capture.id } });
  assert.equal(item.json.routing.current.status, 'needs_choice');
  assert.equal(item.json.item.status, 'inbox');
});

test('deleting a capture cancels work not yet picked up', async () => {
  db1.s.offline = true;
  const r = await capture('Dream board: someday a treehouse for the kids');
  await app.call('DELETE', 'item', { query: { id: r.json.capture.id } });
  db1.s.offline = false;
  await db1.syncUntilIdle();
  assert.equal(db1.board.byTitle('Treehouse For The Kids'), undefined);
  const op = await db.query("SELECT status, payload FROM asst_app_ops WHERE reason = 'capture_deleted'");
  assert.equal(op[0].status, 'cancelled');
  assert.equal(op[0].payload.note, undefined);
});

// ---------------- asking, briefing, changing ----------------

const tool = async (name, input) => {
  const reg = new SourceRegistry();
  const ctx = { db, userId, tz: 'America/Chicago', now: Date.now(), google: async () => null, actions: [], created: [], conversationId: null };
  const r = await TOOL_BY_NAME[name].run(ctx, input, reg);
  return Object.assign(r, { reg, ctx });
};

test('#8 universal search: Dream Board is a first-class group, found by an old name too', async () => {
  const r = await app.call('GET', 'search', { query: { q: 'lake house' } });
  const g = r.json.groups.find(x => x.key === 'dreams');
  assert.equal(g.label, 'Dream Board');
  assert.equal(g.items[0].title, 'Lakeside Cabin');
  assert.match(g.items[0].snippet, /formerly “Lake House”/);
  assert.equal(g.items[0].url, '#/dream/' + encodeURIComponent(lakeId));
  const ideas = r.json.groups.find(x => x.key === 'ideas');
  assert.ok(ideas.items.some(i => i.meta.status === 'filed'), 'the original capture is still findable, marked as filed');
});

test('#12 #13 #23 original vs current: Dream Board is current, earlier values are history, words verbatim', async () => {
  const r = await tool('get_dream', { dream: 'lake house' });
  assert.match(r.text, /<untrusted_app_data source="Dream Board">/);
  assert.match(r.text, /CURRENT \(Dream Board is the record[^\n]*target amount \$1\.8M/);
  assert.match(r.text, /target amount \$1\.2M → \$1\.8M/);
  assert.match(r.text, /OWNER’S OWN WORDS[\s\S]*Save this for my Dream Board — someday I want a lake house/);
  assert.match(r.text, /added to Dream Board \(from the owner’s capture\)/);
  const provs = r.reg.all().map(x => x.provider);
  assert.ok(provs.includes('dreamboard') && provs.includes('notes'));
});

test('#22 two current sources disagree: both are shown and Dream Board is named the record', async () => {
  await app.call('POST', 'memory', { body: { kind: 'fact', statement: 'Lake house budget is $2M' } });
  const r = await tool('get_dream', { dream: 'Lakeside Cabin' });
  assert.match(r.text, /MEMORIES that mention it \(if one disagrees with CURRENT, show both; Dream Board is the record\):\n\[S\d+\] \(the owner told you, [^)]+\) Lake house budget is \$2M/);
});

test('#15 Today and Catch Me Up see Dream Board progress; our own adds are told once, as ours', async () => {
  const t = (await app.call('GET', 'today')).json;
  const lake = t.dreams.items.find(x => x.id === lakeId);
  assert.match(lake.line, /1 milestone completed this month/);
  const c = await app.call('POST', 'catchup', { body: { since: new Date(Date.now() - 3600000).toISOString() } });
  assert.ok(c.json.since);
  assert.match(c.json.text, /\*\*What happened\*\*/);
  assert.match(c.json.text, /You added “Lake House” to Dream Board/);
  assert.match(c.json.text, /Lakeside Cabin: [^\n]*milestone completed: Pick the lake/);
  assert.doesNotMatch(c.json.text, /Lakeside Cabin: added to Dream Board/, 'the echo of our own create is folded');
  assert.ok(c.json.sources.some(x => x.provider === 'dreamboard'));
});

test('propose → confirm → execute → verify a target change; retries never double-send', async () => {
  const p = await tool('propose_dream_change', { dream: 'lakeside cabin', field: 'target_amount', value: '2,000,000' });
  const a = p.ctx.actions[0];
  assert.equal(a.summary, 'Change “Lakeside Cabin” target amount: $1.8M → $2M');
  assert.equal(db1.board.goal(lakeId).fields.target_amount, 1800000, 'nothing changes before the owner confirms');
  const c1 = await app.call('POST', 'action', { body: { id: a.id, decision: 'confirm' } });
  assert.equal(c1.status, 200);
  assert.equal(c1.json.action.status, 'queued');
  const c2 = await app.call('POST', 'action', { body: { id: a.id, decision: 'confirm' } });
  assert.equal(c2.status, 200, 'a retried confirm is safe');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM asst_app_ops WHERE action_id = $1', [a.id]))[0].n, 1);
  await db1.syncUntilIdle();
  assert.equal(db1.board.goal(lakeId).fields.target_amount, 2000000);
  const row = (await db.query('SELECT status, result FROM asst_actions WHERE id = $1', [a.id]))[0];
  assert.equal(row.status, 'verified');
  // The change coming back from Dream Board is recognised as the owner's own.
  const op = (await db.query('SELECT id FROM asst_app_ops WHERE action_id = $1', [a.id]))[0];
  const ev = await db.query(`SELECT changes FROM asst_events WHERE record_id = $1 ORDER BY received_at DESC LIMIT 1`, [lakeId]);
  assert.deepEqual(ev[0].changes.map(c => c.op_id), [op.id]);
  const d = (await app.call('GET', 'dream', { query: { id: lakeId } })).json.dream;
  assert.equal(d.changes[d.changes.length - 1].by, 'confirmed');
});

test('a stale card is refused; a change Dream Board overtook is reported, not forced', async () => {
  const stale = (await tool('propose_dream_change', { dream: 'lakeside cabin', field: 'target_amount', value: '2500000' })).ctx.actions[0];
  db1.board.edit(lakeId, { target_amount: 2200000 });
  await db1.syncUntilIdle();
  const r = await app.call('POST', 'action', { body: { id: stale.id, decision: 'confirm' } });
  assert.equal(r.json.action.status, 'failed');
  assert.match(r.json.result.note, /changed since this was suggested/);
  assert.equal(db1.board.goal(lakeId).fields.target_amount, 2200000);

  const race = (await tool('propose_dream_change', { dream: 'lakeside cabin', field: 'status', value: 'achieved' })).ctx.actions[0];
  await app.call('POST', 'action', { body: { id: race.id, decision: 'confirm' } });
  db1.board.edit(lakeId, { status: 'planned' });             // edited on the PC before the op arrives
  await db1.syncUntilIdle();
  const row = (await db.query('SELECT status, result FROM asst_actions WHERE id = $1', [race.id]))[0];
  assert.equal(row.status, 'failed');
  assert.match(row.result.message, /newer value/);
  assert.equal(db1.board.goal(lakeId).status, 'planned');
});

test('milestones need confirmation too; delete and merge are not possible', async () => {
  const m = (await tool('propose_dream_change', { dream: 'lakeside cabin', milestone: 'Get pre-approved' })).ctx.actions[0];
  assert.equal(m.summary, 'Add milestone to “Lakeside Cabin”: Get pre-approved');
  await app.call('POST', 'action', { body: { id: m.id, decision: 'confirm' } });
  await db1.syncUntilIdle();
  assert.ok(db1.board.goal(lakeId).milestones.some(x => x.title === 'Get pre-approved'));
  assert.equal((await db.query('SELECT status FROM asst_actions WHERE id = $1', [m.id]))[0].status, 'verified');
  const bad = await tool('propose_dream_change', { dream: 'lakeside cabin', field: 'deleted', value: 'true' });
  assert.match(bad.text, /I can only change/);
  assert.ok(!TOOL_BY_NAME.delete_dream && !TOOL_BY_NAME.merge_dreams);
});

test('real questions: the tools return what an answer needs', async () => {
  // "Save this to my Dream Board" said in chat
  const saved = await tool('save_capture', { text: 'Dream board: someday a cabin in Colorado' });
  assert.match(saved.text, /queued for Dream Board/);
  await db1.syncUntilIdle();
  assert.ok(db1.board.byTitle('Cabin in Colorado'));
  // "Show me progress on my biggest goals"
  const big = await tool('list_dreams', { sort: 'amount' });
  assert.match(big.text.split('\n')[2], /“Lakeside Cabin” · planned · target amount \$2\.2M · milestones 1\/2 done/);
  // "Which dreams am I actively working on?"
  const active = await tool('list_dreams', {});
  assert.match(active.text, /“Fitness” · in_progress · Health/);
  // "Which goals haven't moved in 6 months?" — honest about what it can't know
  const quiet = await tool('list_dreams', { quiet_days: 180 });
  assert.match(quiet.text, /cannot confirm which dreams were quiet for 180 days/);
  // "What have I captured but never touched?" — filed captures live in Dream Board now
  const untouched = await tool('list_my_items', { statuses: ['inbox'], order: 'oldest' });
  assert.doesNotMatch(untouched.text, /lake house with a dock/);
  // "Catch me up since Monday"
  const cu = await tool('catch_up', { since: new Date(Date.now() - 3 * 86400000).toISOString() });
  assert.match(cu.text, /SENT TO DREAM BOARD \(sent by you\): new dream “Lake House”/);
  assert.match(cu.text, /DREAM BOARD PROGRESS: Lakeside Cabin/);
  // "Find the property on the water I saved"
  const water = await tool('search_my_notes', { query: 'lake dock waterfront property' });
  assert.match(water.text, /Dream Board goal “Lakeside Cabin” \(formerly Lake House\)/);
  assert.match(water.text, /lake house with a dock/);
});

test('chat: the assistant answers about a dream with Dream Board and capture citations', async () => {
  const claude = fakeClaude((p, n) => {
    if (n === 0) {
      assert.match(p.system[0].text, /Dream Board's CURRENT values are the truth now/);
      assert.match(p.system[1].text, /Dream Board: live/);
      assert.ok(p.tools.some(t => t.name === 'get_dream'));
      return toolUse([{ name: 'get_dream', input: { dream: 'lake house' } }]);
    }
    const r = p.messages[p.messages.length - 1].content[0];
    assert.match(r.content, /untrusted_app_data/);
    return text('Originally $1.2M, now $2.2M [S1]. You first said you wanted a dock and a fire pit [S2].');
  });
  const chat = makeApp({ db, google: fakeGoogle(), claude });
  await chat.signIn();
  const { events } = await chat.stream('chat', { message: 'What did I originally want for the lake house vs now?' });
  const msg = events.find(e => e.type === 'message').message;
  assert.deepEqual(msg.sources.filter(x => x.cited).map(x => x.provider), ['dreamboard', 'notes']);
  assert.equal(msg.sources[0].url, '#/dream/' + encodeURIComponent(lakeId));
  // Without AI, search still surfaces the dream.
  const plain = makeApp({ db, google: fakeGoogle() });
  await plain.signIn();
  const p2 = (await plain.stream('chat', { message: 'lakeside cabin' })).events.find(e => e.type === 'message').message;
  assert.match(p2.content, /\*\*Dream Board\*\*\n- Lakeside Cabin \[S\d+\]/);
});

// ---------------- security ----------------

test('security: bearer token and cookie never cross over', async () => {
  const bearerOnly = await app.call('GET', 'me', { headers: db1.auth(), cookies: {} });
  assert.equal(bearerOnly.status, 401);
  const cookieOnly = await app.call('POST', 'apps/v1/sync', { body: { instance_id: 'board-real', epoch: 'e1', seq: 0 } });
  assert.equal(cookieOnly.status, 401);
  const forged = await app.call('POST', 'apps/v1/sync', { body: { instance_id: 'board-real', epoch: 'e1', seq: 0 }, headers: { authorization: 'Bearer dbc_' + 'A'.repeat(43) }, cookies: {} });
  assert.equal(forged.status, 401);
});

test('security: wrong board gets 409 and drains nothing', async () => {
  await capture('Add to my fitness dream: kettlebells');
  const r = await app.call('POST', 'apps/v1/sync', { body: { instance_id: 'zz-test-board', epoch: 'e1', seq: 0 }, headers: db1.auth(), cookies: {} });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'wrong_board');
  await db1.syncUntilIdle();
});

test('security: another user’s board can’t see or settle this user’s ops', async () => {
  const app2 = makeApp({ db, google: fakeGoogle(), config: { allowedEmails: ['owner@example.com', 'partner@example.com'] } });
  await app2.signIn({ sub: '3003', email: 'partner@example.com' });
  const board2 = fakeDreamBoard(app2, { instanceId: 'board-partner' });
  await board2.pair((await app2.call('POST', 'apps/pair', { body: { app: 'dreamboard' } })).json.code);
  db1.s.offline = true;
  const mine = await capture('Add to my fitness dream: foam roller');
  const opId = (await opsOf(mine.json.capture.id))[0].id;
  const r = await board2.sync();
  assert.equal(r.json.ops.length, 0);
  const spoof = await app2.call('POST', 'apps/v1/sync', { body: { instance_id: 'board-partner', epoch: 'e1', seq: 0, results: [{ op_id: opId, status: 'rejected', reason: 'x' }] }, headers: board2.auth(), cookies: {} });
  assert.deepEqual(spoof.json.acks, []);
  assert.equal((await opsOf(mine.json.capture.id))[0].status, 'queued');
  const file = await app2.call('GET', 'apps/v1/files', { query: { id: 'att_x', op: opId }, headers: board2.auth(), cookies: {} });
  assert.equal(file.status, 404);
  db1.s.offline = false;
  await db1.syncUntilIdle();
});

test('security: records are clipped and validated; oversized batches are capped', async () => {
  assert.equal(normalizeRecord({ type: 'goal', id: '../../etc', seq: 1 }), null);
  assert.equal(normalizeRecord({ type: 'board', id: 'x', seq: 1 }), null);
  const big = normalizeRecord({ type: 'goal', id: 'g1', seq: 1, title: 'x'.repeat(5000), notes: Array.from({ length: 80 }, (_, i) => ({ id: 'n' + i, text: 'y'.repeat(900) })), fields: { 'Bad Key': 1, ok: 2 } });
  assert.equal(big.title.length, 300);
  assert.ok(big.notes.reduce((n, x) => n + x.text.length, 0) <= 20000);
  assert.deepEqual(big.fields, { ok: 2 });
  const recs = Array.from({ length: 150 }, (_, i) => ({ type: 'goal', id: 'bulk-' + i, seq: 100000 + i, title: 'Bulk ' + i }));
  const r = await app.call('POST', 'apps/v1/sync', { body: { instance_id: 'board-real', epoch: db1.s.epoch, seq: 100149, records: recs }, headers: db1.auth(), cookies: {} });
  assert.equal(r.json.since, 100099, 'only the first 100 were taken; the rest are asked for again');
  assert.equal(r.json.next_poll_seconds, 1);
});

test('security: a leaked token can’t hammer the assistant', async () => {
  const strict = makeApp({ db, google: fakeGoogle(), limits: Object.assign({}, LIMITS, { appsync: { perMinute: 3, perDay: 100 } }) });
  const hit = () => strict.call('POST', 'apps/v1/sync', { body: { instance_id: 'board-real', epoch: db1.s.epoch, seq: db1.s.seq }, headers: db1.auth(), cookies: {} });
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await hit()).status);
  assert.deepEqual(codes.slice(-2), [429, 429]);
});

test('security: sign out everywhere and allow-list removal both end the app token', async () => {
  const locked = makeApp({ db, google: fakeGoogle(), config: { allowedEmails: ['someone-else@example.com'] } });
  const r = await locked.call('POST', 'apps/v1/sync', { body: { instance_id: 'board-real', epoch: db1.s.epoch, seq: db1.s.seq }, headers: db1.auth(), cookies: {} });
  assert.equal(r.status, 401);
  await app.call('POST', 'auth/signout-all');
  const r2 = await db1.sync();
  assert.equal(r2.status, 401);
});

// ---------------- pure logic ----------------

test('routing words: explicit only', () => {
  assert.equal(routeIntent('Save this for my Dream Board — someday I want a lake house').mode, 'create');
  assert.equal(routeIntent('Dream board. I love this garage setup.', true).mode, 'item');
  assert.equal(routeIntent('Dream board — someday I want this garage', true).mode, 'create');
  assert.deepEqual(routeIntent('add this to my lake house dream'), { app: 'dreamboard', mode: 'attach', target: 'lake house' });
  assert.equal(routeIntent('I want a lake house someday'), null, 'a dream the owner didn’t send stays here');
  assert.equal(dreamTitleFromWords('Save this for my Dream Board — someday I want a lake house with a dock'), 'Lake House');
  assert.equal(dreamTitleFromWords('Also dream board: someday I want a boat for the lake house.'), 'Boat for the Lake House');
  const goals = [{ id: 1, title: 'Lake House' }, { id: 2, title: 'Lake House Dock' }, { id: 3, title: 'Beach House' }];
  assert.deepEqual(matchGoals('lake house', goals).strong.map(g => g.id), [1]);
  assert.deepEqual(matchGoals('lakehouse', goals).strong.map(g => g.id), [1]);
  assert.deepEqual(matchGoals('house', goals).strong, []);
  assert.deepEqual(matchGoals('lake house', [{ id: 1, title: 'Lake House', inactive: true }]).strong, [], 'achieved goals are never auto-targets');
});

test('snapshot diff: presentation never becomes an event; progress is progress', () => {
  const a = normalizeRecord({ type: 'goal', id: 'g', seq: 1, title: 'T', status: 'dreaming', fields: { saved_amount: 100 } });
  const b = normalizeRecord({ type: 'goal', id: 'g', seq: 2, title: 'T', status: 'dreaming', fields: { saved_amount: 100 }, x: 10, rotation: 5, z: 3 });
  assert.equal(diffRecords(a, b).changes.length, 0);
  const c = normalizeRecord({ type: 'goal', id: 'g', seq: 3, title: 'T', status: 'in_progress', fields: { saved_amount: 250 } });
  const d = diffRecords(a, c);
  assert.equal(d.progress, true);
  assert.deepEqual(d.changes.map(x => x.kind), ['status_changed', 'updated']);
});
