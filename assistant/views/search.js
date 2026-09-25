import { api } from '../api.js';
import { esc, icon, when, skeleton, emptyState } from '../ui.js';
import { go } from '../state.js';
import { providerOf, statusNote } from './common.js';
import { freshLine } from './dreams.js';

// One search box, every source at once, grouped by where results came from.

const GROUP_ICON = { dreams: 'sparkle', ideas: 'sparkle', tasks: 'check', notes: 'note', memory: 'brain', projects: 'folderOpen', people: 'person', email: 'mail', sheets: 'table', drive: 'folder', calendar: 'calendar', contacts: 'person' };

function resultRow(it) {
  const internal = it.url && it.url.startsWith('#');
  const pv = providerOf(it.provider);
  const meta = [it.meta && it.meta.kindLabel, it.meta && it.meta.project, it.meta && it.meta.from, it.meta && it.meta.lastModifiedBy, it.date ? when(it.date, { hour: undefined, minute: undefined }) : ''].filter(Boolean).join(' · ');
  // Search headlines mark matches with «»; the text is escaped before the
  // markers become <mark>.
  const snippet = esc(it.snippet || '').replace(/«/g, '<mark>').replace(/»/g, '</mark>');
  return `<a class="result" href="${esc(it.url || '#')}" ${internal ? '' : 'target="_blank" rel="noopener noreferrer"'}>
    <div class="result-ic">${it.meta && it.meta.emoji ? esc(it.meta.emoji) : icon(pv.icon)}</div>
    <div class="grow"><div class="ri-title">${esc(it.title)}</div>${snippet ? `<div class="ri-sub">${snippet}</div>` : ''}${meta ? `<div class="ri-meta">${esc(meta)}</div>` : ''}</div>
    ${internal ? '' : icon('external', 'src-go')}</a>`;
}

export async function render(main, params) {
  const q0 = params.get('q') || '';
  main.innerHTML = `
    <header class="page-h"><h1>Search</h1></header>
    <form class="search-box" role="search" data-form>${icon('search')}<input type="search" data-q placeholder="Search notes, email, Drive, Sheets, calendar…" value="${esc(q0)}" enterkeyhint="search" autocomplete="off" aria-label="Search everything"></form>
    <div data-results>${q0 ? skeleton(3) : emptyState('Search everything at once', 'Ideas, notes, tasks, memory, email, Sheets, Drive, calendar and contacts — grouped by where they live.', 'search')}</div>`;
  const input = main.querySelector('[data-q]');
  const out = main.querySelector('[data-results]');
  let ctrl = null, timer = null;

  async function run(q) {
    q = q.trim();
    if (!q) return;
    history.replaceState(null, '', '#/search?q=' + encodeURIComponent(q));
    if (ctrl) ctrl.abort();
    ctrl = new AbortController();
    out.innerHTML = skeleton(3);
    try {
      const r = await api('search', { query: { q }, signal: ctrl.signal });
      const groups = r.groups.filter(g => g.items.length || g.status !== 'ok');
      const hits = r.groups.reduce((n, g) => n + g.items.length, 0);
      out.innerHTML = (hits ? '' : `<div class="card quiet">Nothing matched “${esc(q)}”.</div>`) +
        groups.map(g => `<section class="result-group"><div class="sec-h">${icon(GROUP_ICON[g.key] || 'note')}<span>${esc(g.label)}</span>${g.items.length ? `<span class="count">${g.items.length}</span>` : ''}</div>
          ${g.freshness && g.freshness.state !== 'live' && g.items.length ? `<div class="status-note">${esc(freshLine(g.freshness))}</div>` : ''}${g.items.map(resultRow).join('')}${statusNote(g)}</section>`).join('') +
        `<button class="btn wide ghost mt" data-ask>${icon('sparkle')} Ask the assistant about “${esc(q)}”</button>`;
      out.querySelector('[data-ask]').onclick = () => go('#/assistant', { ask: q });
    } catch (e) {
      if (e.name === 'AbortError') return;
      out.innerHTML = `<div class="card quiet">${esc(e.offline ? 'Search needs a connection.' : e.message)}</div>`;
    }
  }
  main.querySelector('[data-form]').onsubmit = e => { e.preventDefault(); input.blur(); run(input.value); };
  input.addEventListener('input', () => { clearTimeout(timer); if (input.value.trim().length >= 3) timer = setTimeout(() => run(input.value), 700); });
  if (q0) run(q0); else setTimeout(() => input.focus(), 50);
  return () => { if (ctrl) ctrl.abort(); clearTimeout(timer); };
}
