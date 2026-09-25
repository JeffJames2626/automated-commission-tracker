import { searchCaptures } from '../repo/captures.mjs';
import { searchMemories } from '../repo/memories.mjs';
import { listProjects } from '../repo/projects.mjs';
import { listPeople } from '../repo/people.mjs';
import * as gmail from '../integrations/google/gmail.mjs';
import * as calendar from '../integrations/google/calendar.mjs';
import * as drive from '../integrations/google/drive.mjs';
import * as contacts from '../integrations/google/contacts.mjs';
import { describeError } from '../integrations/google/transport.mjs';
import { KINDS } from '../kinds.mjs';
import { getApp, freshness } from '../repo/apps.mjs';
import { searchMirror } from '../repo/mirror.mjs';
import { goalIdOf } from '../apps/dreams.mjs';

// Universal search: one query, every source at once, results grouped by where
// they came from. Each source reports its own status so one slow or broken
// integration never blanks the whole page — the others still answer.

const IDEA_KINDS = new Set(['idea', 'business_idea', 'product_idea', 'dream', 'goal']);
const TASK_KINDS = new Set(['task', 'reminder']);

function timeout(p, ms, label) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => { const e = new Error(label + ' timed out'); e.kind = 'timeout'; rej(e); }, ms); })]).finally(() => clearTimeout(t));
}

function captureResult(c) {
  return {
    provider: 'notes', kind: c.kind, recordId: c.id, title: c.title, url: '#/item/' + c.id, date: c.captured_at,
    snippet: c.headline || c.summary || c.raw_preview || '',
    meta: { kind: c.kind, kindLabel: KINDS[c.kind] ? KINDS[c.kind].label : c.kind, status: c.status, project: c.project_name, emoji: KINDS[c.kind] && KINDS[c.kind].emoji },
  };
}

// Connected apps are first-class sources: their records are searched from the
// assistant's mirror (fast, works while the app's computer is off) and each
// result opens the record, labelled with how current it is.
async function appGroups(db, userId, query, perSource) {
  const app = await getApp(db, userId, 'dreamboard');
  if (!app) return [{ key: 'dreams', label: 'Dream Board', status: 'not_connected', items: [] }];
  const f = freshness(app);
  const rows = await searchMirror(db, userId, 'dreamboard', query, perSource);
  const low = query.toLowerCase();
  return [{
    key: 'dreams', label: 'Dream Board', status: 'ok', freshness: f,
    items: rows.map(g => ({
      provider: 'dreamboard', kind: 'goal', recordId: goalIdOf(g), title: g.title, url: '#/dream/' + encodeURIComponent(goalIdOf(g)), date: g.synced_at,
      snippet: [g.status, g.data && g.data.category ? g.data.category.name : null, (g.aliases || []).find(a => a.toLowerCase().includes(low)) ? 'formerly “' + g.aliases.find(a => a.toLowerCase().includes(low)) + '”' : null].filter(Boolean).join(' · '),
      meta: { status: g.status, asOf: f.lastSeenAt || null },
    })),
  }];
}

export async function searchEverything({ db, userId, google, q, perSource = 6, timeoutMs = 9000 }) {
  const query = String(q || '').trim().slice(0, 200);
  const groups = [];
  if (!query) return { query, groups };
  const g = google ? await google() : null;
  const states = g ? g.states : {};
  const acct = g && g.connection ? g.connection.account_email : null;

  const local = (async () => {
    const [caps, mems, projects, people] = await Promise.all([
      searchCaptures(db, userId, query, { limit: 30 }),
      searchMemories(db, userId, query, perSource),
      listProjects(db, userId),
      listPeople(db, userId, { limit: 500 }),
    ]);
    const low = query.toLowerCase();
    const ideas = caps.filter(c => IDEA_KINDS.has(c.kind)).slice(0, perSource).map(captureResult);
    const tasks = caps.filter(c => TASK_KINDS.has(c.kind)).slice(0, perSource).map(captureResult);
    const notes = caps.filter(c => !IDEA_KINDS.has(c.kind) && !TASK_KINDS.has(c.kind)).slice(0, perSource).map(captureResult);
    const proj = projects.filter(p => p.name.toLowerCase().includes(low) || (p.aliases || []).some(a => a.toLowerCase().includes(low)))
      .map(p => ({ provider: 'project', kind: p.kind, recordId: p.id, title: (p.emoji ? p.emoji + ' ' : '') + p.name, url: '#/project/' + p.id, snippet: p.capture_count + (p.capture_count === 1 ? ' item' : ' items'), date: p.last_capture_at }));
    const ppl = people.filter(p => p.display_name.toLowerCase().includes(low) || (p.emails || '').includes(low))
      .slice(0, perSource).map(p => ({ provider: 'person', kind: 'person', recordId: p.id, title: p.display_name, url: '#/person/' + p.id, snippet: p.emails || p.role || '', date: null }));
    return [
      { key: 'ideas', label: 'Ideas', status: 'ok', items: ideas },
      { key: 'tasks', label: 'Tasks & reminders', status: 'ok', items: tasks },
      { key: 'notes', label: 'Notes', status: 'ok', items: notes },
      { key: 'memory', label: 'Memory', status: 'ok', items: mems.map(m => ({ provider: 'memory', kind: m.kind, recordId: m.id, title: m.statement, url: '#/memory', date: m.created_at, snippet: m.project_name || m.kind })) },
      { key: 'projects', label: 'Projects', status: 'ok', items: proj },
      { key: 'people', label: 'People', status: 'ok', items: ppl },
    ];
  })();

  const remote = [
    { key: 'email', label: 'Email', service: 'gmail', run: c => gmail.searchThreads(c, { query, max: perSource, accountEmail: acct }) },
    { key: 'calendar', label: 'Calendar', service: 'calendar', run: c => calendar.listEvents(c, { query, timeMin: new Date(Date.now() - 365 * 86400000).toISOString(), timeMax: new Date(Date.now() + 180 * 86400000).toISOString(), max: perSource }) },
    { key: 'drive', label: 'Drive & Docs', service: 'drive', run: async c => { const r = await drive.searchFiles(c, { query, max: perSource * 2 }); return { items: r.items.filter(i => i.kind !== 'spreadsheet').slice(0, perSource), sheets: r.items.filter(i => i.kind === 'spreadsheet').slice(0, perSource) }; } },
    { key: 'contacts', label: 'Contacts', service: 'contacts', run: c => contacts.searchContacts(c, { query, max: perSource }) },
  ].map(async src => {
    const state = states[src.service] || 'not_connected';
    if (state !== 'connected') return [{ key: src.key, label: src.label, status: state, items: [] }];
    try {
      const r = await timeout(src.run(g.client(src.service)), timeoutMs, src.label);
      const out = [{ key: src.key, label: src.label, status: 'ok', items: r.items || [] }];
      if (r.sheets) out.push({ key: 'sheets', label: 'Sheets', status: 'ok', items: r.sheets });
      return out;
    } catch (e) {
      return [{ key: src.key, label: src.label, status: 'error', error: e.kind || 'failed', message: describeError(Object.assign({ kind: e.kind, status: e.status }, { service: '' })), items: [] }];
    }
  });

  const results = await Promise.all([local, appGroups(db, userId, query, perSource), ...remote]);
  results.forEach(r => r.forEach(x => groups.push(x)));
  // Sheets come out of the Drive search; if Drive is off, say why Sheets is empty.
  if (!groups.find(x => x.key === 'sheets')) {
    const d = groups.find(x => x.key === 'drive');
    groups.push({ key: 'sheets', label: 'Sheets', status: d && d.status !== 'ok' ? d.status : 'ok', items: [] });
  }
  const order = ['ideas', 'dreams', 'tasks', 'notes', 'memory', 'projects', 'people', 'email', 'sheets', 'drive', 'calendar', 'contacts'];
  groups.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  return { query, groups };
}
