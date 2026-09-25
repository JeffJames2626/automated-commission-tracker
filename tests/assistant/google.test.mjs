import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, makeApp, fakeGoogle, CONFIG } from './helpers.mjs';
import { createGoogleClient, GoogleApiError } from '../../lib/assistant/integrations/google/transport.mjs';
import { googleContext } from '../../lib/assistant/integrations/google/connection.mjs';
import * as gmail from '../../lib/assistant/integrations/google/gmail.mjs';
import * as drive from '../../lib/assistant/integrations/google/drive.mjs';
import * as sheets from '../../lib/assistant/integrations/google/sheets.mjs';
import * as calendar from '../../lib/assistant/integrations/google/calendar.mjs';
import * as contacts from '../../lib/assistant/integrations/google/contacts.mjs';

const b64 = s => Buffer.from(s).toString('base64url');
const res = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: Object.assign({ 'content-type': 'application/json' }, headers) });

function client(handler, opts = {}) {
  const calls = [];
  let token = 'tok-1', refreshes = 0;
  const c = createGoogleClient({
    fetchImpl: async (url, init) => { calls.push({ url: new URL(url), auth: init.headers.authorization }); return handler(new URL(url), calls.length); },
    getAccessToken: async force => { if (force) { refreshes++; token = 'tok-' + (refreshes + 1); } return token; },
    sleep: async ms => { calls.sleeps = (calls.sleeps || []).concat(ms); },
    ...opts,
  });
  return { c, calls, refreshes: () => refreshes };
}

// ---------------- transport ----------------
test('429 honours Retry-After and then succeeds', async () => {
  const { c, calls } = client((u, n) => n === 1 ? res({ error: { code: 429, message: 'slow' } }, 429, { 'retry-after': '2' }) : res({ ok: 1 }));
  assert.deepEqual(await c.get('https://x.googleapis.com/a'), { ok: 1 });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.sleeps, [2000]);
});

test('403 userRateLimitExceeded is retried; 5xx retried then a typed error', async () => {
  const { c } = client((u, n) => n === 1 ? res({ error: { code: 403, errors: [{ reason: 'userRateLimitExceeded' }] } }, 403) : res({ ok: 2 }));
  assert.deepEqual(await c.get('https://x.googleapis.com/a'), { ok: 2 });
  const { c: c2, calls } = client(() => res({ error: { code: 503, message: 'down' } }, 503));
  await assert.rejects(c2.get('https://x.googleapis.com/a'), e => e instanceof GoogleApiError && e.kind === 'unavailable');
  assert.equal(calls.length, 4, '1 try + 3 retries');
});

test('401 forces exactly one token refresh and retries with the new token', async () => {
  const { c, calls, refreshes } = client((u, n) => n === 1 ? res({ error: { code: 401 } }, 401) : res({ ok: 3 }));
  assert.deepEqual(await c.get('https://x.googleapis.com/a'), { ok: 3 });
  assert.equal(refreshes(), 1);
  assert.equal(calls[1].auth, 'Bearer tok-2');
  const { c: c2 } = client(() => res({ error: { code: 401 } }, 401));
  await assert.rejects(c2.get('https://x.googleapis.com/a'), e => e.kind === 'auth');
});

test('missing scope is a scope error, not retried', async () => {
  const { c, calls } = client(() => res({ error: { code: 403, status: 'PERMISSION_DENIED', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } }, 403));
  await assert.rejects(c.get('https://x.googleapis.com/a'), e => e.kind === 'scope');
  assert.equal(calls.length, 1);
});

test('timeouts become typed errors', async () => {
  const c = createGoogleClient({
    fetchImpl: (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
    getAccessToken: async () => 't', timeoutMs: 20, sleep: async () => {},
  });
  await assert.rejects(c.get('https://x.googleapis.com/a'), e => e.kind === 'timeout');
});

test('pagination stops at maxItems even when Google has more', async () => {
  let pages = 0;
  const { c } = client(u => { pages++; return res({ items: Array.from({ length: 10 }, (_, i) => ({ id: pages + '-' + i })), nextPageToken: 'p' + pages }); });
  const r = await c.paginate('https://x.googleapis.com/list', { itemsKey: 'items', maxItems: 25, pageSizeParam: 'maxResults', pageSize: 10 });
  assert.equal(r.items.length, 25);
  assert.equal(r.truncated, true);
  assert.equal(pages, 3);
});

// ---------------- token vault ----------------
async function connectedUser(db, g) {
  const app = makeApp({ db, google: g });
  await app.signIn();
  const u = (await db.query("SELECT * FROM asst_users WHERE email = 'owner@example.com'"))[0];
  return { app, user: u };
}

test('expired access token is refreshed before use and the new one stored', async () => {
  const db = await makeDb();
  const g = fakeGoogle();
  const { user } = await connectedUser(db, g);
  await db.query("UPDATE asst_connections SET access_expires_at = now() - interval '1 minute'");
  g.on('GET gmail.googleapis.com/gmail/v1/users/me/threads', () => ({ threads: [] }));
  const ctx = await googleContext({ db, userId: user.id, config: CONFIG, fetchImpl: g.fetchImpl, sleep: async () => {} });
  await gmail.searchThreads(ctx.client('gmail'), { query: 'x' });
  const gm = g.calls.find(c => c.url.host === 'gmail.googleapis.com');
  assert.equal(gm.auth, 'Bearer at-2');
  const row = (await db.query('SELECT * FROM asst_connections'))[0];
  assert.ok(new Date(row.access_expires_at) > new Date());
  assert.equal(row.status, 'connected');
});

test('revoked grant (invalid_grant) marks the connection and asks to reconnect', async () => {
  const db = await makeDb();
  const g = fakeGoogle();
  const { app, user } = await connectedUser(db, g);
  await db.query("UPDATE asst_connections SET access_expires_at = now() - interval '1 minute'");
  g.state.refreshStatus = 400;
  g.state.refreshResponse = { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' };
  const ctx = await googleContext({ db, userId: user.id, config: CONFIG, fetchImpl: g.fetchImpl, sleep: async () => {} });
  await assert.rejects(gmail.searchThreads(ctx.client('gmail'), { query: 'x' }), e => e.kind === 'auth');
  const conns = await app.call('GET', 'connections');
  assert.equal(conns.json.google.status, 'revoked');
  assert.match(conns.json.google.detail, /reconnect/i);
  assert.equal(conns.json.services.find(s => s.key === 'gmail').state, 'reconnect');
});

test('scopes shrinking on refresh (permission change) are recorded', async () => {
  const db = await makeDb();
  const g = fakeGoogle();
  const { user } = await connectedUser(db, g);
  await db.query("UPDATE asst_connections SET access_expires_at = now() - interval '1 minute'");
  g.state.refreshResponse = { access_token: 'at-9', expires_in: 3600, scope: 'openid email profile https://www.googleapis.com/auth/gmail.readonly' };
  g.on('GET gmail.googleapis.com', () => ({ threads: [] }));
  const ctx = await googleContext({ db, userId: user.id, config: CONFIG, fetchImpl: g.fetchImpl, sleep: async () => {} });
  await gmail.searchThreads(ctx.client('gmail'), { query: 'x' });
  const ctx2 = await googleContext({ db, userId: user.id, config: CONFIG, fetchImpl: g.fetchImpl });
  assert.equal(ctx2.states.gmail, 'connected');
  assert.equal(ctx2.states.drive, 'not_granted');
  assert.throws(() => ctx2.client('drive'), e => e.kind === 'scope');
});

// ---------------- Gmail ----------------
function thread(id, subject, from, body, extra = {}) {
  return {
    id, snippet: body.slice(0, 50),
    messages: [{
      id: id + 'm1', threadId: id, labelIds: extra.labels || ['INBOX'], internalDate: String(Date.parse(extra.date || '2026-09-18T15:00:00Z')), snippet: body.slice(0, 80),
      payload: {
        mimeType: 'multipart/mixed',
        headers: [{ name: 'Subject', value: subject }, { name: 'From', value: from }, { name: 'To', value: 'Owner <owner@example.com>' }],
        parts: [
          { mimeType: 'multipart/alternative', parts: [
            { mimeType: 'text/plain', body: { data: b64(body + '\n\nOn Tue, Sep 16, 2026 Owner wrote:\n> old quoted text') } },
            { mimeType: 'text/html', body: { data: b64('<p>' + body + '</p>') } },
          ] },
          { mimeType: 'application/pdf', filename: 'estimate.pdf', body: { attachmentId: 'att1', size: 12345 } },
        ],
      },
    }],
  };
}

test('Gmail search maps threads; one failing thread degrades instead of failing the search', async () => {
  const g = fakeGoogle();
  g.on('GET gmail.googleapis.com/gmail/v1/users/me/threads/t1', () => thread('t1', 'Irrigation controller', 'Josh Smith <josh@example.com>', 'Replace the controller and convert back beds to drip.', { labels: ['INBOX', 'UNREAD'] }));
  g.on('GET gmail.googleapis.com/gmail/v1/users/me/threads/t2', () => new Response('{}', { status: 404 }));
  g.on(/GET gmail\.googleapis\.com\/gmail\/v1\/users\/me\/threads$/, u => { assert.equal(u.searchParams.get('q'), 'from:josh irrigation'); return { threads: [{ id: 't1' }, { id: 't2', snippet: 'second' }], resultSizeEstimate: 2 }; });
  const c = createGoogleClient({ fetchImpl: g.fetchImpl, getAccessToken: async () => 't', sleep: async () => {} });
  const r = await gmail.searchThreads(c, { query: 'from:josh irrigation', accountEmail: 'owner@example.com' });
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].title, 'Irrigation controller');
  assert.equal(r.items[0].meta.fromEmail, 'josh@example.com');
  assert.equal(r.items[0].meta.unread, true);
  assert.match(r.items[0].url, /^https:\/\/mail\.google\.com\/mail\/\?authuser=owner%40example\.com#all\/t1$/);
  assert.equal(r.items[1].meta.partial, true);
});

test('Gmail thread retrieval decodes bodies, drops quoted history, lists attachments', async () => {
  const g = fakeGoogle();
  g.on('GET gmail.googleapis.com/gmail/v1/users/me/threads/t1', u => { assert.equal(u.searchParams.get('format'), 'full'); return thread('t1', 'Irrigation', 'Josh <josh@example.com>', 'Convert the back beds to drip.'); });
  const c = createGoogleClient({ fetchImpl: g.fetchImpl, getAccessToken: async () => 't' });
  const t = await gmail.getThread(c, 't1', {});
  assert.equal(t.messages.length, 1);
  assert.equal(t.messages[0].text, 'Convert the back beds to drip.');
  assert.deepEqual(t.messages[0].attachments.map(a => a.filename), ['estimate.pdf']);
});

test('huge thread is clipped to the newest messages', async () => {
  const g = fakeGoogle();
  const big = thread('t9', 'Long', 'A <a@x.com>', 'x'.repeat(3000));
  big.messages = Array.from({ length: 30 }, (_, i) => Object.assign({}, big.messages[0], { id: 'm' + i, internalDate: String(1e12 + i) }));
  g.on('GET gmail.googleapis.com/gmail/v1/users/me/threads/t9', () => big);
  const c = createGoogleClient({ fetchImpl: g.fetchImpl, getAccessToken: async () => 't' });
  const t = await gmail.getThread(c, 't9', { maxChars: 10000 });
  assert.ok(t.messages.length < 30);
  assert.ok(t.omittedEarlier > 0);
  assert.equal(t.messages[t.messages.length - 1].id, 'm29', 'newest kept');
});

// ---------------- Drive ----------------
test('Drive query escaping and content search', () => {
  const q = drive.buildQuery({ query: "Jon's onboarding \\ plan", type: 'doc' });
  assert.ok(q.includes("fullText contains 'Jon\\'s onboarding \\\\ plan'"));
  assert.ok(q.includes("mimeType = 'application/vnd.google-apps.document'"));
  assert.ok(q.startsWith('trashed = false'));
});

test('Drive search maps Sheets separately; Doc retrieval exports plain text; PDFs come back as bytes', async () => {
  const g = fakeGoogle();
  g.on(/GET www\.googleapis\.com\/drive\/v3\/files$/, u => {
    assert.equal(u.searchParams.get('supportsAllDrives'), 'true');
    return { files: [
      { id: 's1', name: 'Pricing Matrix', mimeType: 'application/vnd.google-apps.spreadsheet', modifiedTime: '2026-09-10T00:00:00Z' },
      { id: 'doc1', name: 'Onboarding plan', mimeType: 'application/vnd.google-apps.document' },
    ] };
  });
  g.on('GET www.googleapis.com/drive/v3/files/doc1', () => ({ id: 'doc1', name: 'Onboarding plan', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-09-01T00:00:00Z' }));
  g.on('GET www.googleapis.com/drive/v3/files/pdf1', u => u.searchParams.get('alt') === 'media' ? new Response(Buffer.from('%PDF-1.4 fake'), { status: 200 }) : ({ id: 'pdf1', name: 'Irrigation Service Pricing.pdf', mimeType: 'application/pdf', size: '20' }));
  g.on('GET www.googleapis.com/drive/v3/files/doc1/export', u => { assert.equal(u.searchParams.get('mimeType'), 'text/plain'); return new Response('Jon onboarding: day 1 truck, day 2 routes', { status: 200 }); });
  const c = createGoogleClient({ fetchImpl: g.fetchImpl, getAccessToken: async () => 't' });
  const r = await drive.searchFiles(c, { query: 'pricing' });
  assert.equal(r.items[0].provider, 'google_sheets');
  assert.equal(r.items[1].provider, 'google_drive');
  const d = await drive.readFile(c, 'doc1');
  assert.match(d.content, /day 1 truck/);
  const p = await drive.readFile(c, 'pdf1');
  assert.equal(Buffer.from(p.pdfBase64, 'base64').toString().slice(0, 8), '%PDF-1.4');
});

// ---------------- Sheets ----------------
function sheetsFake() {
  const g = fakeGoogle();
  g.on('GET sheets.googleapis.com/v4/spreadsheets/SHEET123456789012345678', u => {
    assert.match(u.searchParams.get('fields'), /sheets\(properties/);
    return {
      spreadsheetId: 'SHEET123456789012345678', properties: { title: 'Pricing Matrix' }, spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/SHEET123456789012345678/edit',
      sheets: [
        { properties: { sheetId: 0, title: 'Pricing', index: 0, sheetType: 'GRID', gridProperties: { rowCount: 100, columnCount: 3 } },
          tables: [{ name: 'Mowing', range: { sheetId: 0, startRowIndex: 1, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 3 }, columnProperties: [{ columnName: 'Service', columnType: 'TEXT' }] }] },
        { properties: { sheetId: 7, title: "Emp's Roster", index: 1, sheetType: 'GRID', gridProperties: { rowCount: 50, columnCount: 2 } } },
      ],
    };
  });
  g.on('GET sheets.googleapis.com/v4/spreadsheets/SHEET123456789012345678/values:batchGet', u => {
    const ranges = u.searchParams.getAll('ranges');
    if (u.searchParams.get('valueRenderOption') === 'FORMULA') return { valueRanges: [{ range: "'Pricing'!A1:C3", values: [['Service', 'Size', 'Price'], ['Mow', '1+ acre', '=B2*45'], ['Mow', '<1 acre', '45']] }] };
    if (ranges.length > 1 || /A1:[A-Z]+6$/.test(ranges[0])) return { valueRanges: ranges.map((r, i) => ({ range: r, values: i === 0 ? [['Pricing Matrix'], ['Service', 'Size', 'Price'], ['Mow', '1+ acre', '$135']] : [['Name', 'Status'], ['Zach', 'Active']] })) };
    return { valueRanges: [{ range: "'Pricing'!A1:C3", values: [['Service', 'Size', 'Price'], ['Mow', '1+ acre', '$135'], ['Mow', '<1 acre', '$45']] }] };
  });
  return g;
}

test('Sheets: tab discovery with headers, samples and tables', async () => {
  const g = sheetsFake();
  const c = createGoogleClient({ fetchImpl: g.fetchImpl, getAccessToken: async () => 't' });
  const w = await sheets.inspectSpreadsheet(c, sheets.parseSpreadsheetId('https://docs.google.com/spreadsheets/d/SHEET123456789012345678/edit#gid=0'));
  assert.equal(w.title, 'Pricing Matrix');
  assert.deepEqual(w.tabs.map(t => t.title), ['Pricing', "Emp's Roster"]);
  assert.deepEqual(w.tabs[0].header, ['Service', 'Size', 'Price'], 'title row skipped, real header detected');
  assert.equal(w.tabs[0].headerRow, 2);
  assert.equal(w.tabs[0].tables[0].range, "'Pricing'!A2:C3");
  const batch = g.calls.find(x => x.url.pathname.endsWith('values:batchGet'));
  assert.ok(batch.url.searchParams.getAll('ranges').includes("'Emp''s Roster'!A1:B6"), 'tab names quoted and escaped');
});

test('Sheets: range retrieval with formulas', async () => {
  const g = sheetsFake();
  const c = createGoogleClient({ fetchImpl: g.fetchImpl, getAccessToken: async () => 't' });
  const r = await sheets.readRange(c, 'SHEET123456789012345678', "'Pricing'!A1:C3", { formulas: true });
  assert.equal(r.rows[1][2], '$135');
  assert.deepEqual(r.formulas, [{ cell: 'C2', formula: '=B2*45' }]);
});

test('Sheets: very large ranges are truncated by cell budget', async () => {
  const g = fakeGoogle();
  g.on('GET sheets.googleapis.com', () => ({ valueRanges: [{ range: "'Big'!A1:J2000", values: Array.from({ length: 2000 }, (_, i) => Array.from({ length: 10 }, (_, j) => i + ':' + j)) }] }));
  const c = createGoogleClient({ fetchImpl: g.fetchImpl, getAccessToken: async () => 't' });
  const r = await sheets.readRange(c, 'x'.repeat(25), "'Big'!A1:J2000");
  assert.equal(r.truncated, true);
  assert.equal(r.rows.length, 500);
  assert.equal(r.totalRows, 2000);
});

// ---------------- Calendar ----------------
test('Calendar: events across selected calendars, all-day handled, declined and cancelled dropped', async () => {
  const g = fakeGoogle();
  g.on('GET www.googleapis.com/calendar/v3/users/me/calendarList', () => ({ items: [{ id: 'primary@x', primary: true, selected: true, summary: 'Me' }, { id: 'team@x', selected: true, summary: 'Team' }, { id: 'hidden@x', hidden: true }] }));
  g.on('GET www.googleapis.com/calendar/v3/calendars/primary%40x/events', u => {
    assert.equal(u.searchParams.get('singleEvents'), 'true');
    assert.equal(u.searchParams.get('orderBy'), 'startTime');
    return { items: [
      { id: 'e1', summary: 'Irrigation walk with Josh', start: { dateTime: '2026-09-24T14:00:00-05:00' }, end: { dateTime: '2026-09-24T15:00:00-05:00' }, attendees: [{ email: 'josh@example.com' }, { email: 'owner@example.com', self: true, responseStatus: 'accepted' }] },
      { id: 'e2', summary: 'Declined thing', start: { dateTime: '2026-09-24T09:00:00-05:00' }, end: { dateTime: '2026-09-24T10:00:00-05:00' }, attendees: [{ email: 'owner@example.com', self: true, responseStatus: 'declined' }] },
      { id: 'e3', status: 'cancelled', summary: 'Gone' },
    ] };
  });
  g.on('GET www.googleapis.com/calendar/v3/calendars/team%40x/events', () => ({ items: [{ id: 'e1', summary: 'Company holiday', start: { date: '2026-09-24' }, end: { date: '2026-09-25' } }] }));
  const c = createGoogleClient({ fetchImpl: g.fetchImpl, getAccessToken: async () => 't' });
  const r = await calendar.listEvents(c, { timeMin: '2026-09-24T05:00:00Z', timeMax: '2026-09-25T05:00:00Z' });
  assert.deepEqual(r.items.map(e => e.title), ['Company holiday', 'Irrigation walk with Josh']);
  assert.equal(r.items[0].meta.allDay, true);
  assert.notEqual(r.items[0].recordId, r.items[1].recordId, 'same event id on two calendars stays distinct');
});

// ---------------- Contacts ----------------
test('Contacts: warmup request then search, stable resourceName ids', async () => {
  contacts._resetWarmup();
  const g = fakeGoogle();
  g.on('GET people.googleapis.com/v1/people:searchContacts', u => u.searchParams.get('query') === '' ? { results: [] } : { results: [{ person: { resourceName: 'people/c42', names: [{ displayName: 'Ashtin Lee' }], emailAddresses: [{ value: 'Ashtin@Example.com' }], organizations: [{ name: 'ALP', title: 'Office Manager' }] } }] });
  const c = createGoogleClient({ fetchImpl: g.fetchImpl, getAccessToken: async () => 't' });
  const r = await contacts.searchContacts(c, { query: 'ashtin' });
  const searches = g.calls.filter(x => x.url.pathname.endsWith(':searchContacts'));
  assert.equal(searches[0].url.searchParams.get('query'), '');
  assert.equal(r.items[0].recordId, 'people/c42');
  assert.deepEqual(r.items[0].meta.emails, ['ashtin@example.com']);
});
