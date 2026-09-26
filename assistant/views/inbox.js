import { api } from '../api.js';
import { esc, icon, skeleton, emptyState, cacheGet, cacheSet, toast } from '../ui.js';
import { state } from '../state.js';
import { captureCard } from './common.js';
import * as outbox from '../outbox.js';

// Inbox: everything captured, newest first. Filters are a tap, not a form.

const FILTERS = [
  { key: 'inbox', label: 'Inbox', q: { status: 'inbox' } },
  { key: 'all', label: 'Everything', q: {} },
  { key: 'journal', label: 'Journal', q: { kind: 'journal' } },
  { key: 'idea', label: 'Ideas', q: { kind: 'idea' } },
  { key: 'business_idea', label: 'Business', q: { kind: 'business_idea' } },
  { key: 'tasks', label: 'Tasks', q: { open_tasks: '1' } },
  { key: 'dream', label: 'Dreams', q: { kind: 'dream' } },
  { key: 'goal', label: 'Goals', q: { kind: 'goal' } },
  { key: 'note', label: 'Notes', q: { kind: 'note' } },
  { key: 'maybe', label: 'Someday', q: { status: 'maybe' } },
  { key: 'active', label: 'Active', q: { status: 'active' } },
  { key: 'archived', label: 'Archived', q: { status: 'archived' } },
];

function outboxRow(i) {
  return `<div class="card cap pending-item"><div class="cap-kind">${i.error ? '⚠️' : '⏳'}</div><div class="cap-main">
    <div class="cap-title">${esc((i.body.text || 'Attachment').slice(0, 90))}</div>
    <div class="cap-meta">${i.error ? `<span class="bad">Not saved: ${esc(i.error)}</span><button class="link" data-retry="${esc(i.client_ref)}">Retry</button><button class="link" data-discard="${esc(i.client_ref)}">Discard</button>` : '<span>Waiting to sync — safe on this phone</span>'}</div></div></div>`;
}

export async function render(main, params) {
  let filter = FILTERS.find(f => f.key === (params.get('f') || 'inbox')) || FILTERS[0];
  let project = params.get('project') || '';
  const projects = (state.boot && state.boot.projects) || [];
  main.innerHTML = `
    <header class="page-h"><h1>Inbox</h1><div class="page-h-actions"><button class="icon-btn" data-reprocess aria-label="Sort again" title="Sort unsorted captures">${icon('refresh')}</button></div></header>
    <div class="chips" role="tablist">${FILTERS.map(f => `<button class="chip ${f.key === filter.key ? 'on' : ''}" data-f="${f.key}" role="tab">${esc(f.label)}</button>`).join('')}</div>
    <div class="chips"><select class="select-pill" data-project aria-label="Project"><option value="">All projects</option>${projects.map(p => `<option value="${esc(p.id)}" ${p.id === project ? 'selected' : ''}>${esc((p.emoji || '') + ' ' + p.name)}</option>`).join('')}</select></div>
    <div data-outbox></div>
    <div data-list>${skeleton(4)}</div>
    <button class="btn wide ghost" data-more hidden>Load more</button>`;
  const list = main.querySelector('[data-list]');
  const more = main.querySelector('[data-more]');
  let next = null, loading = false;

  const paintOutbox = items => {
    const el = main.querySelector('[data-outbox]');
    if (!el) return;
    el.innerHTML = items.length ? items.map(outboxRow).join('') : '';
    el.querySelectorAll('[data-retry]').forEach(b => b.onclick = () => outbox.retry(b.dataset.retry));
    el.querySelectorAll('[data-discard]').forEach(b => b.onclick = () => outbox.discard(b.dataset.discard));
  };
  outbox.all().then(paintOutbox);
  const unsub = outbox.subscribe(paintOutbox);

  async function load(reset) {
    if (loading) return;
    loading = true;
    const key = 'inbox:' + filter.key + ':' + project;
    const q = Object.assign({ limit: '40' }, filter.q, project ? { project } : {}, !reset && next ? { before: next } : {});
    if (reset) { const c = cacheGet(key); list.innerHTML = c ? c.items.map(x => captureCard(x)).join('') : skeleton(4); }
    try {
      const r = await api('inbox', { query: q });
      if (reset) cacheSet(key, { items: r.items.slice(0, 40) });
      const html = r.items.map(x => captureCard(x)).join('');
      if (reset) list.innerHTML = html || emptyState(filter.key === 'inbox' ? 'Inbox zero' : 'Nothing here yet', filter.key === 'inbox' ? 'Everything you capture lands here first.' : 'Captures you file this way will show up here.', 'inbox');
      else list.insertAdjacentHTML('beforeend', html);
      next = r.next;
      more.hidden = !next;
    } catch (e) {
      if (reset && !cacheGet(key)) list.innerHTML = `<div class="card quiet">${esc(e.offline ? 'Offline — your captures are safe and will appear when you reconnect.' : e.message)}</div>`;
    } finally { loading = false; }
  }
  main.querySelectorAll('[data-f]').forEach(b => b.onclick = () => {
    filter = FILTERS.find(f => f.key === b.dataset.f);
    main.querySelectorAll('[data-f]').forEach(x => x.classList.toggle('on', x === b));
    history.replaceState(null, '', '#/inbox?f=' + filter.key + (project ? '&project=' + project : ''));
    load(true);
  });
  main.querySelector('[data-project]').onchange = e => { project = e.target.value; load(true); };
  more.onclick = () => load(false);
  main.querySelector('[data-reprocess]').onclick = async () => {
    try { const r = await api('reprocess', { method: 'POST' }); toast(r.processed ? 'Sorted ' + r.processed + ' more.' : 'Everything is sorted.'); load(true); }
    catch (e) { toast(e.message); }
  };
  // Infinite scroll for long inboxes.
  const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting) && next) load(false); });
  io.observe(more);
  const onCap = () => load(true);
  document.addEventListener('asst:captured', onCap);
  await load(true);
  return () => { unsub(); io.disconnect(); document.removeEventListener('asst:captured', onCap); };
}
