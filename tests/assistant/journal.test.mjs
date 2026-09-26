import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, makeApp, fakeGoogle, fakeClaude, text, toolUse } from './helpers.mjs';

// The capture box as a journal: the words are kept whole, and the assistant
// pulls out what to do — separate items, answers, proposals — in one reply.

let db;
before(async () => { db = await makeDb(); });

const ENTRY = 'Long day. Need to call Josh tomorrow at 9 about the controller. Also I keep thinking about the gutter add-on idea. What do I have Thursday?';

test('a journal entry is kept whole, then worked through: items saved and linked, question answered, one reply', async () => {
  const claude = fakeClaude((p, n) => {
    if (n === 0) {
      assert.match(p.system[p.system.length - 1].text, /The owner is journaling/);
      assert.equal(p.messages[p.messages.length - 1].content, ENTRY);
      return toolUse([
        { name: 'save_capture', input: { text: 'Need to call Josh tomorrow at 9 about the controller', kind: 'reminder', due_at: '2026-09-27T14:00:00Z' } },
        { name: 'save_capture', input: { text: 'I keep thinking about the gutter add-on idea', kind: 'business_idea' } },
      ]);
    }
    return text('✓ Reminder: call Josh — tomorrow 9 AM\n✓ Idea: gutter add-on\nThursday looks open.');
  });
  const app = makeApp({ db, google: fakeGoogle(), claude });
  await app.signIn();
  const r = await app.call('POST', 'capture', { body: { client_ref: 'journal-1-xxxx', text: ENTRY, journal: true, source_type: 'voice' } });
  assert.equal(r.json.intent, 'journal');
  assert.equal(r.json.capture.kind, 'journal');
  assert.equal(r.json.capture.raw_text, ENTRY, 'the words are kept exactly');
  const { events } = await app.stream('journal', { capture_id: r.json.capture.id });
  const msg = events.find(e => e.type === 'message').message;
  assert.match(msg.content, /✓ Reminder: call Josh/);
  assert.equal(msg.created.length, 2);
  const kids = await db.query(`SELECT c.kind, c.source_type, c.due_at FROM asst_links l JOIN asst_captures c ON c.id = l.from_id
    WHERE l.to_id = $1 AND l.relation = 'from_journal' ORDER BY c.kind`, [r.json.capture.id]);
  assert.deepEqual(kids.map(k => k.kind), ['business_idea', 'reminder']);
  assert.ok(kids.every(k => k.source_type === 'journal'));
  // The entry stays out of the inbox; what came out of it is in.
  const inbox = await app.call('GET', 'inbox', { query: { status: 'inbox' } });
  assert.ok(!inbox.json.items.some(i => i.kind === 'journal'));
  assert.ok(inbox.json.items.some(i => i.kind === 'business_idea'));
  const journal = await app.call('GET', 'inbox', { query: { kind: 'journal' } });
  assert.equal(journal.json.items.length, 1);
  // One conversation per day holds it.
  const conv = await db.query(`SELECT title FROM asst_conversations WHERE id = $1`, [events.find(e => e.type === 'conversation').id]);
  assert.match(conv[0].title, /^Journal · /);
  // Running it again never acts twice.
  const again = await app.stream('journal', { capture_id: r.json.capture.id });
  assert.equal(again.events.find(e => e.type === 'message').message.id, msg.id);
  assert.equal(claude.requests.length, 2);
});

test('an entry saved offline is worked through when it arrives (Sort again), once', async () => {
  let calls = 0;
  const claude = fakeClaude(() => { calls++; return text('Noted.'); });
  const app = makeApp({ db, google: fakeGoogle(), claude });
  await app.signIn();
  const r = await app.call('POST', 'capture', { body: { client_ref: 'journal-2-xxxx', text: 'Nice evening walk.', journal: true } });
  await app.call('POST', 'reprocess');
  await app.call('POST', 'reprocess');
  assert.equal(calls, 1);
  const c = (await app.call('GET', 'item', { query: { id: r.json.capture.id } })).json.item;
  assert.equal(c.details.journal_state, 'done');
});

test('without AI the capture box still files the words as one item', async () => {
  const app = makeApp({ db, google: fakeGoogle() });
  await app.signIn();
  const r = await app.call('POST', 'capture', { body: { client_ref: 'journal-3-xxxx', text: 'Remind me tomorrow to call Josh', journal: true } });
  assert.equal(r.json.capture.kind, 'reminder');
});
