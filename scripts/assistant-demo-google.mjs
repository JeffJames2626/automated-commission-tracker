// Demo Google data for the local dev server (and browser tests). Shapes follow
// the real Gmail v1 / Calendar v3 / Drive v3 / Sheets v4 / People v1 APIs.

export const ALL_SCOPES = [
  'openid', 'email', 'profile',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/contacts.readonly',
];

const b64 = s => Buffer.from(s).toString('base64url');
const H = 3600e3;
const today = new Date(); today.setHours(0, 0, 0, 0);
const at = (h, m = 0, day = 0) => new Date(today.getTime() + day * 24 * H + h * H + m * 60e3).toISOString();

const THREADS = [
  { id: 'demo-t1', subject: 'Irrigation plan for the Hendersons', from: 'Josh Carter <josh@example.com>', ago: 26, unread: true,
    body: 'Hey — I walked the property. I think we replace the controller and convert the back beds to drip. Estimate attached. Can you approve by Friday?', attach: 'Henderson-estimate.pdf' },
  { id: 'demo-t2', subject: 'Commission question', from: 'Zach Miller <zach@example.com>', ago: 5, unread: true,
    body: 'Quick one: does the 8% on new mowing contracts apply to the Dawson account I closed last week?' },
  { id: 'demo-t3', subject: 'Re: October schedule', from: 'Ashtin Lee <ashtin@example.com>', ago: 20, unread: false,
    body: 'I moved the aeration crew to Tuesdays in October. Let me know if that breaks anything on your side.' },
];

function thread(t, full) {
  return { id: t.id, snippet: t.body.slice(0, 90), messages: [{
    id: t.id + '-m', threadId: t.id, labelIds: ['INBOX'].concat(t.unread ? ['UNREAD', 'IMPORTANT'] : []),
    internalDate: String(Date.now() - t.ago * H), snippet: t.body.slice(0, 120),
    payload: { mimeType: 'multipart/mixed', headers: [{ name: 'Subject', value: t.subject }, { name: 'From', value: t.from }, { name: 'To', value: 'Jeff <owner@example.com>' }],
      parts: [{ mimeType: 'text/plain', body: { data: full ? b64(t.body) : '' } }].concat(t.attach ? [{ mimeType: 'application/pdf', filename: t.attach, body: { attachmentId: 'a1', size: 48213 } }] : []) },
  }] };
}

const EVENTS = [
  { id: 'ev1', summary: 'Crew huddle', start: { dateTime: at(7, 30) }, end: { dateTime: at(8) }, location: 'Shop' },
  { id: 'ev2', summary: 'Irrigation walk — Henderson', start: { dateTime: at(14) }, end: { dateTime: at(15) }, location: '41 Oak Ridge Dr', attendees: [{ email: 'josh@example.com', displayName: 'Josh Carter' }, { email: 'owner@example.com', self: true, responseStatus: 'accepted' }] },
  { id: 'ev3', summary: 'Sales review with Zach', start: { dateTime: at(9, 0, 1) }, end: { dateTime: at(10, 0, 1) }, attendees: [{ email: 'zach@example.com', displayName: 'Zach Miller' }, { email: 'owner@example.com', self: true }] },
];

const FILES = [
  { id: 'demo-sheet-pricing-000000001', name: 'Pricing Matrix 2026', mimeType: 'application/vnd.google-apps.spreadsheet', modifiedTime: at(-30), lastModifyingUser: { displayName: 'Ashtin Lee' } },
  { id: 'demo-doc-onboarding', name: 'Jon — onboarding plan', mimeType: 'application/vnd.google-apps.document', modifiedTime: at(-50) },
  { id: 'demo-pdf-irrigation', name: 'Irrigation Service Pricing (2025).pdf', mimeType: 'application/pdf', modifiedTime: '2025-03-02T10:00:00Z' },
];

const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });

export async function demoGoogleFetch(url) {
  const u = new URL(url);
  const p = u.host + u.pathname;
  if (p === 'oauth2.googleapis.com/token') return json({ access_token: 'dev-at-' + Date.now(), expires_in: 3600 });
  if (p === 'oauth2.googleapis.com/revoke') return json({});
  if (p === 'gmail.googleapis.com/gmail/v1/users/me/threads') {
    const q = (u.searchParams.get('q') || '').toLowerCase();
    const words = q.split(/\s+/).filter(w => w && !w.includes(':') && !w.startsWith('-'));
    const from = (q.match(/from:(\S+)/) || [])[1];
    const hits = THREADS.filter(t => (!from || t.from.toLowerCase().includes(from)) && words.every(w => (t.subject + ' ' + t.body + ' ' + t.from).toLowerCase().includes(w)));
    return json({ threads: hits.map(t => ({ id: t.id, snippet: t.body.slice(0, 80) })), resultSizeEstimate: hits.length });
  }
  const tm = p.match(/^gmail\.googleapis\.com\/gmail\/v1\/users\/me\/threads\/(.+)$/);
  if (tm) { const t = THREADS.find(x => x.id === decodeURIComponent(tm[1])); return t ? json(thread(t, u.searchParams.get('format') === 'full')) : json({ error: { code: 404 } }, 404); }
  if (p === 'www.googleapis.com/calendar/v3/users/me/calendarList') return json({ items: [{ id: 'primary', primary: true, selected: true, summary: 'Jeff' }] });
  if (p.startsWith('www.googleapis.com/calendar/v3/calendars/')) {
    const min = Date.parse(u.searchParams.get('timeMin') || 0), max = Date.parse(u.searchParams.get('timeMax') || 8e15);
    const q = (u.searchParams.get('q') || '').toLowerCase();
    return json({ items: EVENTS.filter(e => Date.parse(e.end.dateTime) > min && Date.parse(e.start.dateTime) < max && (!q || JSON.stringify(e).toLowerCase().includes(q))).map(e => Object.assign({ htmlLink: 'https://calendar.google.com/' }, e)) });
  }
  if (p === 'www.googleapis.com/drive/v3/files') {
    const q = u.searchParams.get('q') || '';
    const words = [...q.matchAll(/fullText contains '([^']+)'/g)].map(m => m[1].toLowerCase()).slice(0, 1).flatMap(s => s.split(/\s+/));
    const sheetOnly = q.includes("mimeType = 'application/vnd.google-apps.spreadsheet'");
    const hits = FILES.filter(f => (!sheetOnly || f.mimeType.includes('spreadsheet')) && (!words.length || words.some(w => f.name.toLowerCase().includes(w.replace(/s$/, '')))));
    return json({ files: hits.map(f => Object.assign({ webViewLink: 'https://drive.google.com/open?id=' + f.id }, f)) });
  }
  const fm = p.match(/^www\.googleapis\.com\/drive\/v3\/files\/([^/]+)(\/export)?$/);
  if (fm) {
    const f = FILES.find(x => x.id === fm[1]);
    if (!f) return json({ error: { code: 404 } }, 404);
    if (fm[2]) return new Response('Jon onboarding\nDay 1: truck walkaround, safety, uniforms.\nDay 2: ride along on the Tuesday mowing route.\nDay 3: first solo stops with Josh checking in.', { status: 200 });
    return json(Object.assign({ webViewLink: 'https://drive.google.com/open?id=' + f.id }, f));
  }
  if (p.startsWith('sheets.googleapis.com/v4/spreadsheets/demo-sheet-pricing-000000001')) {
    if (p.endsWith('values:batchGet')) {
      const ranges = u.searchParams.getAll('ranges');
      const tabs = { Mowing: [['Service', 'Lot size', 'Price per visit'], ['Mowing', 'Under 1/2 acre', '$45'], ['Mowing', '1/2 – 1 acre', '$65'], ['Mowing', 'Over 1 acre', '$135 / acre']], Irrigation: [['Service', 'Rate'], ['Service call', '$95 minimum'], ['Hourly', '$135/hr']] };
      return json({ valueRanges: ranges.map(r => ({ range: r, values: tabs[(r.match(/'([^']+)'/) || [])[1]] || [] })) });
    }
    return json({ spreadsheetId: 'demo-sheet-pricing-000000001', properties: { title: 'Pricing Matrix 2026' }, spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/demo-sheet-pricing-000000001',
      sheets: [{ properties: { sheetId: 0, title: 'Mowing', index: 0, sheetType: 'GRID', gridProperties: { rowCount: 40, columnCount: 3 } } }, { properties: { sheetId: 1, title: 'Irrigation', index: 1, sheetType: 'GRID', gridProperties: { rowCount: 20, columnCount: 2 } } }] });
  }
  if (p === 'people.googleapis.com/v1/people:searchContacts') {
    const q = (u.searchParams.get('query') || '').toLowerCase();
    const all = [['c1', 'Josh Carter', 'josh@example.com', 'Irrigation lead'], ['c2', 'Zach Miller', 'zach@example.com', 'Sales'], ['c3', 'Ashtin Lee', 'ashtin@example.com', 'Office manager']];
    return json({ results: q ? all.filter(c => c[1].toLowerCase().includes(q)).map(c => ({ person: { resourceName: 'people/' + c[0], names: [{ displayName: c[1] }], emailAddresses: [{ value: c[2] }], organizations: [{ name: 'ALP', title: c[3] }] } })) : [] });
  }
  return json({ error: { code: 404, message: 'demo: no data for ' + p } }, 404);
}
