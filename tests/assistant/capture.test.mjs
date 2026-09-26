import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, makeApp, fakeGoogle, fakeClaude, text } from './helpers.mjs';
import { heuristicClassify, detectIntent } from '../../lib/assistant/ai/classify.mjs';
import { createCapture } from '../../lib/assistant/repo/captures.mjs';
import { isPrivateAddress, linkPreview } from '../../lib/assistant/linkpreview.mjs';

let db, app, userId;
before(async () => {
  db = await makeDb();
  app = makeApp({ db, google: fakeGoogle() });
  await app.signIn();
  userId = (await db.query("SELECT id FROM asst_users WHERE email = 'owner@example.com'"))[0].id;
});

let refN = 0;
const ref = () => 'test-ref-' + (++refN) + '-' + Date.now();

test('capture is saved before classification and is idempotent on retry', async () => {
  const r = ref();
  const a = await app.call('POST', 'capture', { body: { client_ref: r, text: 'Build a customer portal where ALP clients can see their services and photos.' } });
  assert.equal(a.status, 201);
  const b = await app.call('POST', 'capture', { body: { client_ref: r, text: 'Build a customer portal where ALP clients can see their services and photos.' } });
  assert.equal(b.status, 200);
  assert.equal(b.json.duplicate, true);
  assert.equal(b.json.capture.id, a.json.capture.id);
  const n = await db.query('SELECT count(*)::int AS n FROM asst_captures WHERE client_ref = $1', [r]);
  assert.equal(n[0].n, 1);
  // Without AI the heuristic still files it.
  assert.equal(a.json.capture.kind, 'idea');
  assert.equal(a.json.capture.project_name, 'ALP');
  assert.equal(a.json.capture.status, 'inbox');
  assert.equal(a.json.capture.raw_text, 'Build a customer portal where ALP clients can see their services and photos.');
});

test('intent detection routes questions to the assistant and keeps them out of the inbox', async () => {
  for (const q of ['What did Ashtin email me about yesterday?', 'Find the spreadsheet where we worked on mowing pricing', 'How much did we have budgeted for this?'])
    assert.equal(detectIntent(q), 'question', q);
  for (const c of ['Remember this idea for ALP: route density bonus', 'Remind me to look into this.', 'New business idea: gutter cleaning', 'Look into buying this property'])
    assert.equal(detectIntent(c), 'capture', c);
  const r = await app.call('POST', 'capture', { body: { client_ref: ref(), text: 'What appointments do I have Thursday?' } });
  assert.equal(r.json.intent, 'question');
  assert.equal(r.json.capture.kind, 'question');
  const inbox = await app.call('GET', 'inbox', { query: { status: 'inbox' } });
  assert.ok(!inbox.json.items.some(i => i.id === r.json.capture.id));
  // …but the words are not thrown away.
  const kept = await db.query('SELECT raw_text FROM asst_captures WHERE id = $1', [r.json.capture.id]);
  assert.equal(kept[0].raw_text, 'What appointments do I have Thursday?');
});

test('heuristics: reminders get a local due time, projects by alias, dream board, purchases', () => {
  const projects = [{ id: 'p1', name: 'Sales Tracker', aliases: ['sales app'] }, { id: 'p2', name: 'Dream Board', aliases: [] }];
  const now = Date.parse('2026-09-24T15:00:00Z');
  const r = heuristicClassify({ text: 'Remind me tomorrow to call Josh about the controller', projects, now, tz: 'America/Chicago' });
  assert.equal(r.kind, 'reminder');
  assert.equal(r.dueAt, '2026-09-25T14:00:00.000Z');
  assert.equal(heuristicClassify({ text: 'on the sales app show a player card', projects }).projectId, 'p1');
  const d = heuristicClassify({ text: 'Save this for the dream board: lake house', projects });
  assert.equal(d.kind, 'dream');
  assert.equal(d.projectId, 'p2');
  assert.equal(heuristicClassify({ text: 'Buy a new zero-turn mower', projects }).kind, 'purchase');
  assert.equal(heuristicClassify({ text: 'Look into buying this property on Hwy 9, 12 acres', projects }).kind, 'property');
});

test('voice capture keeps the transcript and the recording', async () => {
  const transcript = 'I had an idea. On the sales app when you open an employee show their truck, picture, KPIs, like a video game player card. Save that under the sales tracker.';
  const audio = Buffer.from('fake-webm-bytes').toString('base64');
  const r = await app.call('POST', 'capture', { body: { client_ref: ref(), text: transcript, source_type: 'voice', attachments: [{ mime: 'audio/webm', name: 'voice.webm', data: audio, transcript }] } });
  assert.equal(r.status, 201);
  const c = r.json.capture;
  assert.equal(c.raw_text, transcript);
  assert.equal(c.source_type, 'voice');
  assert.equal(c.project_name, 'Sales Tracker');
  assert.equal(c.attachments.length, 1);
  assert.equal(c.attachments[0].transcript, transcript);
  const bin = await app.call('GET', 'attachment', { query: { id: c.attachments[0].id } });
  assert.equal(bin.binary.toString(), 'fake-webm-bytes');
  assert.equal(bin.contentType, 'audio/webm');
});

test('attachments: type and size are validated', async () => {
  const bad = await app.call('POST', 'capture', { body: { client_ref: ref(), text: 'x', attachments: [{ mime: 'application/x-msdownload', data: 'AAAA' }] } });
  assert.equal(bad.status, 400);
  const huge = await app.call('POST', 'capture', { body: { client_ref: ref(), text: 'x', attachments: [{ mime: 'image/png', data: 'A'.repeat(5_000_000) }] } });
  assert.equal(huge.status, 400);
});

test('AI classification: project, people without duplicates, memory, tags — and failures fall back safely', async () => {
  const projects = (await app.call('GET', 'projects')).json.projects;
  const alp = projects.find(p => p.name === 'ALP');
  const claude = fakeClaude(() => text(JSON.stringify({
    intent: 'capture', kind: 'decision', title: 'Zach commission: 8% on new mowing', summary: 'We decided Zach gets 8% commission on new mowing contracts.',
    project_id: alp.id, new_project_name: '', tags: ['commission', 'sales'], people: [{ name: 'Zach', email: '' }], due_at: '', next_action: 'Update the comp plan in the tracker',
    status: 'active', memories: [{ kind: 'decision', statement: 'Zach gets 8% commission on new mowing contracts' }], confidence: 0.9,
  })));
  const aiApp = makeApp({ db, google: fakeGoogle(), claude });
  Object.assign(aiApp.jar, app.jar);
  const r1 = await aiApp.call('POST', 'capture', { body: { client_ref: ref(), text: 'We decided Zach gets 8% on new mowing contracts' } });
  const c = r1.json.capture;
  assert.equal(c.kind, 'decision');
  assert.equal(c.project_id, alp.id);
  assert.equal(c.classification_state, 'done');
  assert.deepEqual(c.tags.map(t => t.name).sort(), ['commission', 'sales']);
  assert.equal(c.people[0].display_name, 'Zach');
  // The request carried the capture as data and asked for structured output.
  const req = claude.requests[0];
  assert.equal(req.output_config.format.type, 'json_schema');
  assert.match(JSON.stringify(req.messages), /<capture>/);
  // Second mention of Zach links the same person.
  await aiApp.call('POST', 'capture', { body: { client_ref: ref(), text: 'Zach wants to talk about routes' } });
  const zachs = await db.query("SELECT count(*)::int AS n FROM asst_people WHERE user_id = $1 AND lower(display_name) = 'zach'", [userId]);
  assert.equal(zachs[0].n, 1);
  const mem = await aiApp.call('GET', 'memory');
  assert.ok(mem.json.memories.some(m => /8% commission/.test(m.statement) && m.source_type === 'capture'));

  // AI failure: capture still saved, heuristically filed, marked for retry.
  const broken = makeApp({ db, google: fakeGoogle(), claude: fakeClaude([new Error('boom')]) });
  Object.assign(broken.jar, app.jar);
  const r2 = await broken.call('POST', 'capture', { body: { client_ref: ref(), text: 'Idea: winter lighting install service for ALP' } });
  assert.equal(r2.status, 201);
  assert.equal(r2.json.capture.classification_state, 'failed');
  assert.equal(r2.json.capture.project_name, 'ALP');
});

test('AI proposes a new project only when named; manual edits stick', async () => {
  const claude = fakeClaude(() => text(JSON.stringify({
    intent: 'capture', kind: 'business_idea', title: 'Mobile dog wash', summary: '', project_id: '', new_project_name: 'Dog Wash Co',
    tags: [], people: [], due_at: '', next_action: '', status: 'inbox', memories: [], confidence: 0.7,
  })));
  const aiApp = makeApp({ db, google: fakeGoogle(), claude });
  Object.assign(aiApp.jar, app.jar);
  const r = await aiApp.call('POST', 'capture', { body: { client_ref: ref(), text: 'Save under Dog Wash Co: mobile dog wash trailer' } });
  assert.equal(r.json.capture.project_name, 'Dog Wash Co');
  const personal = (await app.call('GET', 'projects')).json.projects.find(p => p.name === 'Personal');
  const e = await app.call('PATCH', 'item', { body: { id: r.json.capture.id, kind: 'idea', project_id: personal.id, status: 'maybe', tags: ['someday'] } });
  assert.equal(e.json.item.kind, 'idea');
  assert.equal(e.json.item.classification_state, 'manual');
  // Reprocessing never overrides the owner's choices.
  await db.query("UPDATE asst_captures SET classification_state = 'manual' WHERE id = $1", [r.json.capture.id]);
  const again = await aiApp.call('POST', 'reprocess');
  assert.equal(again.status, 200);
  const it = await app.call('GET', 'item', { query: { id: r.json.capture.id } });
  assert.equal(it.json.item.project_id, personal.id);
  assert.deepEqual(it.json.item.tags.map(t => t.name), ['someday']);
});

test('correcting a transcript keeps the original words', async () => {
  const r = await app.call('POST', 'capture', { body: { client_ref: ref(), text: 'call the lawn guy about aeration', source_type: 'voice' } });
  const e = await app.call('PATCH', 'item', { body: { id: r.json.capture.id, raw_text: 'Call the lawn guy about aeration on Friday' } });
  assert.equal(e.json.item.raw_text, 'Call the lawn guy about aeration on Friday');
  assert.equal(e.json.item.details.raw_history[0].text, 'call the lawn guy about aeration');
});

test('another user can never read or change my captures', async () => {
  const other = makeApp({ db, google: fakeGoogle() });
  await other.signIn({ sub: '2002', email: 'second@example.com' });
  const mine = await app.call('POST', 'capture', { body: { client_ref: ref(), text: 'Private: Georgia property budget $400k' } });
  const id = mine.json.capture.id;
  assert.equal((await other.call('GET', 'item', { query: { id } })).status, 404);
  assert.equal((await other.call('PATCH', 'item', { body: { id, title: 'hacked' } })).status, 404);
  assert.equal((await other.call('DELETE', 'item', { query: { id } })).json.deleted, false);
  const s = await other.call('GET', 'search', { query: { q: 'Georgia property' } });
  assert.ok(!JSON.stringify(s.json).includes(id));
  const inbox = await other.call('GET', 'inbox');
  assert.ok(!inbox.json.items.some(i => i.id === id));
});

test('1000+ captures: fast keyset paging and full-text search', async () => {
  const words = ['sprinkler', 'pricing', 'mowing', 'aeration', 'route', 'truck', 'hire', 'georgia', 'property', 'dream'];
  const vals = [], params = [];
  for (let i = 0; i < 1500; i++) {
    const w = words[i % words.length] + ' ' + words[(i * 7) % words.length];
    params.push(`($${vals.length + 1}, $${vals.length + 2}, 'idea', $${vals.length + 3}, $${vals.length + 3}, now() - ($${vals.length + 4} || ' minutes')::interval, 'done')`);
    vals.push('cap_bulk' + String(i).padStart(16, '0'), userId, 'Bulk ' + i + ' ' + w, String(i));
  }
  await db.query(`INSERT INTO asst_captures (id, user_id, kind, title, raw_text, captured_at, classification_state) VALUES ${params.join(',')}`, vals);
  let t = Date.now();
  const seen = new Set();
  let next = null, pages = 0;
  do {
    const r = await app.call('GET', 'inbox', { query: next ? { before: next, limit: '100' } : { limit: '100' } });
    r.json.items.forEach(i => seen.add(i.id));
    next = r.json.next; pages++;
  } while (next && pages < 30);
  assert.ok(seen.size >= 1500, 'every capture reachable by paging: ' + seen.size);
  const pagingMs = Date.now() - t;
  t = Date.now();
  const s = await app.call('GET', 'search', { query: { q: 'sprinkler pricing' } });
  const searchMs = Date.now() - t;
  const ideas = s.json.groups.find(g => g.key === 'ideas');
  assert.equal(ideas.status, 'ok');
  assert.ok(ideas.items.length > 0);
  assert.ok(ideas.items.every(i => /sprinkler|pricing/i.test(i.title)));
  assert.ok(searchMs < 3000, 'search took ' + searchMs + 'ms');
  assert.ok(pagingMs < 15000, 'paging took ' + pagingMs + 'ms');
});

test('link capture: preview fetched with SSRF guard; private addresses refused', async () => {
  assert.ok(isPrivateAddress('10.1.2.3') && isPrivateAddress('127.0.0.1') && isPrivateAddress('169.254.169.254') && isPrivateAddress('::1') && isPrivateAddress('fd00::1'));
  assert.ok(!isPrivateAddress('8.8.8.8'));
  await assert.rejects(linkPreview('http://169.254.169.254/latest/meta-data', { lookup: async () => [{ address: '169.254.169.254' }] }));
  await assert.rejects(linkPreview('http://intranet.local/', { lookup: async () => [{ address: '10.0.0.5' }] }));
  const html = '<html><head><title>Lake House for sale</title><meta property="og:description" content="12 acres in Georgia"></head></html>';
  const lp = await linkPreview('https://homes.example.com/x', { lookup: async () => [{ address: '93.184.216.34' }], fetchImpl: async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }) });
  assert.equal(lp.title, 'Lake House for sale');
  assert.equal(lp.description, '12 acres in Georgia');
  // Redirect to a private address is refused at the second hop.
  await assert.rejects(linkPreview('https://short.example.com/a', {
    lookup: async h => h === 'short.example.com' ? [{ address: '93.184.216.34' }] : [{ address: '192.168.1.1' }],
    fetchImpl: async () => new Response('', { status: 302, headers: { location: 'http://router.home/' } }),
  }));
});

test('capture of a bare link stores the page title beside the link', async () => {
  const html = '<title>Zero-turn mower sale</title>';
  const la = makeApp({ db, google: fakeGoogle(), lookup: async () => [{ address: '93.184.216.34' }], linkFetch: async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }) });
  Object.assign(la.jar, app.jar);
  const r = await la.call('POST', 'capture', { body: { client_ref: ref(), text: 'https://shop.example.com/mower', source_type: 'link' } });
  assert.equal(r.json.capture.url, 'https://shop.example.com/mower');
  assert.match(r.json.capture.raw_text, /Zero-turn mower sale/);
  assert.equal(r.json.capture.details.link.title, 'Zero-turn mower sale');
});

test('repository-level duplicate client refs never create two rows under concurrency', async () => {
  const r = ref();
  const results = await Promise.all(Array.from({ length: 5 }, () => createCapture(db, userId, { clientRef: r, rawText: 'same thought' })));
  assert.equal(new Set(results.map(x => x.capture.id)).size, 1);
  assert.equal(results.filter(x => !x.duplicate).length, 1);
});
