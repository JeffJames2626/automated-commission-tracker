import { api, attachmentUrl } from '../api.js';
import { esc, icon, when, ago, skeleton, toast, confirmSheet } from '../ui.js';
import { state, go, kindLabel } from '../state.js';
import { captureCard, sourceRow } from './common.js';
import { routingBlock, chooseDream } from './dreams.js';

// The idea card: original thought, AI summary, classification the owner can
// change with a tap, and quietly, related things ("connect the dots").

// One refresh timer for the Dream Board row, cleared whenever the page is
// left or repainted, so timers never pile up or paint over another screen.
let pollTimer = null;

const MAIN_KINDS = ['idea', 'business_idea', 'product_idea', 'task', 'reminder', 'goal', 'dream', 'note', 'decision', 'purchase', 'property', 'travel', 'person', 'website', 'thought'];

export async function render(main, params, id) {
  main.innerHTML = `<header class="page-h"><button class="icon-btn" data-back aria-label="Back">${icon('back')}</button></header>${skeleton(3)}`;
  main.querySelector('[data-back]').onclick = () => history.length > 1 ? history.back() : go('#/inbox');
  let data;
  try { data = await api('item', { query: { id } }); }
  catch (e) { main.innerHTML += `<div class="card quiet">${esc(e.status === 404 ? 'This capture no longer exists.' : e.message)}</div>`; return; }
  paint(main, data);
  return () => clearTimeout(pollTimer);
}

function paint(main, { item: c, related, routing }) {
  const boot = state.boot;
  const statuses = boot.statuses;
  const isTask = c.kind === 'task' || c.kind === 'reminder';
  const audio = (c.attachments || []).filter(a => a.kind === 'audio');
  const images = (c.attachments || []).filter(a => a.kind === 'image');
  const files = (c.attachments || []).filter(a => a.kind === 'file');
  const history = (c.details && c.details.raw_history) || [];
  main.innerHTML = `
    <header class="page-h"><button class="icon-btn" data-back aria-label="Back">${icon('back')}</button><div class="grow"></div>
      <button class="icon-btn" data-ask aria-label="Ask about this">${icon('sparkle')}</button>
      <button class="icon-btn" data-del aria-label="Delete">${icon('trash')}</button></header>
    <article class="idea">
      <div class="eyebrow">${esc(kindLabel(c.kind))} · captured ${esc(when(c.captured_at))} · via ${esc(c.source_type)}</div>
      <h1 class="idea-title" contenteditable="true" spellcheck="true" data-title>${esc(c.title || '')}</h1>
      ${isTask ? `<label class="task-done"><input type="checkbox" data-done ${c.completed_at ? 'checked' : ''}> <span>${c.completed_at ? 'Done ' + esc(ago(c.completed_at)) : 'Mark done'}</span></label>` : ''}

      <div class="seg" role="radiogroup" aria-label="Status">${Object.entries(statuses).filter(([k]) => k !== 'filed' || c.status === 'filed').map(([k, v]) => `<button class="${c.status === k ? 'on' : ''}" data-status="${k}" role="radio" aria-checked="${c.status === k}">${esc(v)}</button>`).join('')}</div>

      <div class="fields card">
        <label class="field"><span>Type</span><select data-kind>${MAIN_KINDS.concat(MAIN_KINDS.includes(c.kind) ? [] : [c.kind]).map(k => `<option value="${k}" ${k === c.kind ? 'selected' : ''}>${esc(boot.kinds[k] ? boot.kinds[k].emoji + ' ' + boot.kinds[k].label : k)}</option>`).join('')}</select></label>
        <label class="field"><span>Project</span><select data-project><option value="">None</option>${boot.projects.map(p => `<option value="${esc(p.id)}" ${p.id === c.project_id ? 'selected' : ''}>${esc((p.emoji || '') + ' ' + p.name)}</option>`).join('')}</select></label>
        <label class="field"><span>${isTask ? 'Due' : 'Revisit on'}</span><input type="datetime-local" data-due value="${c.due_at ? toLocalInput(c.due_at) : ''}"></label>
        <label class="field"><span>Tags</span><input data-tags placeholder="add tags, comma separated" value="${esc((c.tags || []).map(t => t.name).join(', '))}"></label>
      </div>

      ${c.summary ? `<section class="block"><div class="block-h">${icon('sparkle')} Summary</div><p>${esc(c.summary)}</p></section>` : ''}
      ${c.next_action ? `<section class="block"><div class="block-h">${icon('bolt')} Possible next step</div><p>${esc(c.next_action)}</p></section>` : ''}

      <section class="block original"><div class="block-h">${icon(c.source_type === 'voice' ? 'mic' : 'note')} ${c.source_type === 'voice' ? 'What you said' : 'Original thought'}</div>
        ${audio.map(a => `<audio controls preload="none" src="${attachmentUrl(a.id)}"></audio>`).join('')}
        <p class="raw" data-raw>${esc(c.raw_text || '')}</p>
        ${c.source_type === 'voice' ? '<button class="link" data-fix>Fix the transcript</button>' : ''}
        ${history.length ? `<details><summary class="muted small">Earlier wording (${history.length})</summary>${history.map(h => `<p class="muted small">${esc(h.text)}</p>`).join('')}</details>` : ''}
        ${c.url ? `<a class="src" href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">${icon('link', 'src-ic')}<div class="src-main"><div class="src-title">${esc((c.details && c.details.link && c.details.link.title) || c.url)}</div><div class="src-meta">${esc(c.url.replace(/^https?:\/\//, '').slice(0, 60))}</div></div>${icon('external', 'src-go')}</a>` : ''}
      </section>

      ${images.length ? `<section class="gallery">${images.map(a => `<a href="${attachmentUrl(a.id)}" target="_blank" rel="noopener"><img loading="lazy" src="${attachmentUrl(a.id)}" alt="${esc(a.name || 'photo')}"></a>`).join('')}</section>` : ''}
      ${files.length ? `<section class="block">${files.map(a => `<a class="src" href="${attachmentUrl(a.id)}" target="_blank" rel="noopener">${icon('note', 'src-ic')}<div class="src-main"><div class="src-title">${esc(a.name || 'file')}</div><div class="src-meta">${esc(a.mime)}</div></div>${icon('external', 'src-go')}</a>`).join('')}</section>` : ''}

      <div data-route>${routingBlock(routing, c.id)}</div>
      ${(!routing || ['cancelled', 'rejected'].includes(routing.current.status)) && ['dream', 'goal'].includes(c.kind) ? `<button class="btn wide ghost" data-send-board>${icon('sparkle')} Send to Dream Board</button>` : ''}
      ${(c.people || []).length ? `<section class="block"><div class="block-h">${icon('person')} People</div><div class="chips wrap">${c.people.map(p => `<a class="chip" href="#/person/${esc(p.id)}">${esc(p.display_name)}</a>`).join('')}</div></section>` : ''}
      ${(c.sources || []).length ? `<section class="block"><div class="block-h">${icon('link')} Linked sources</div>${c.sources.map(s => sourceRow({ provider: s.provider, title: s.title, url: s.url, date: s.occurred_at }, { showId: false })).join('')}</section>` : ''}

      ${related && related.length ? `<details class="block related"><summary class="block-h">${icon('sparkle')} Connected thoughts <span class="count">${related.length}</span></summary>
        <p class="muted small">Other captures that talk about the same things.</p>${related.map(r => captureCard(r, { compact: true })).join('')}</details>` : ''}
      <p class="muted small center mt">${c.classification_state === 'manual' ? 'Filed by you' : c.ai && c.ai.how === 'ai' ? 'Filed automatically' + (c.ai.confidence ? ' · ' + Math.round(c.ai.confidence * 100) + '% sure' : '') : c.classification_state === 'failed' ? 'Filed with simple rules — the AI will look again' : 'Filed with simple rules'}</p>
    </article>`;

  const save = async patch => {
    try {
      const r = await api('item', { method: 'PATCH', body: Object.assign({ id: c.id }, patch) });
      Object.assign(c, r.item);
      return r.item;
    } catch (e) { toast(e.offline ? 'Offline — change not saved.' : e.message); return null; }
  };
  main.querySelector('[data-back]').onclick = () => window.history.length > 1 ? window.history.back() : go('#/inbox');
  const here = () => location.hash === '#/item/' + c.id;
  const reload = async () => { const r = await api('item', { query: { id: c.id } }); if (here()) paint(main, r); };
  // While Dream Board hasn't confirmed it yet, look again now and then —
  // updating only the Dream Board row, never the fields being edited.
  const bindRoute = rt => {
    const choose = main.querySelector('[data-choose]');
    if (choose) choose.onclick = () => chooseDream(c.id, rt, { onDone: reload, photo: images.length > 0 });
    clearTimeout(pollTimer);
    if (rt && ['routing', 'queued', 'waiting'].includes(rt.current.status)) pollTimer = setTimeout(async () => {
      const r = await api('item', { query: { id: c.id } }).catch(() => null);
      if (!r || !here()) return;
      routing = r.routing;
      main.querySelector('[data-route]').innerHTML = routingBlock(routing, c.id);
      bindRoute(routing);
    }, 4000);
  };
  bindRoute(routing);
  const sendBoard = main.querySelector('[data-send-board]');
  if (sendBoard) sendBoard.onclick = async () => {
    // The owner asked: show every dream to pick from, or a new one — once the
    // board has synced, so a dream that already exists is never duplicated.
    const r = await api('dreams').catch(() => null);
    if (!r || !r.app || !r.app.freshness.historySince) return toast('Dream Board hasn’t synced with the assistant yet — try again once it has.');
    chooseDream(c.id, { current: { candidates: r.goals.filter(g => !g.placeholder).slice(0, 8).map(g => ({ kind: 'goal', id: g.id, title: g.title, status: g.status })), suggestedTitle: c.title } }, { onDone: reload, photo: images.length > 0 });
  };
  main.querySelector('[data-ask]').onclick = () => go('#/assistant', { ask: 'Tell me what else I have that relates to my ' + kindLabel(c.kind).toLowerCase() + ': “' + c.title + '”' });
  main.querySelector('[data-del]').onclick = async () => {
    if (!(await confirmSheet('Delete this capture?', 'The original words, summary and attachments are removed for good.', { ok: 'Delete', danger: true }))) return;
    try { await api('item', { method: 'DELETE', query: { id: c.id } }); toast('Deleted.'); go('#/inbox'); } catch (e) { toast(e.message); }
  };
  const title = main.querySelector('[data-title]');
  title.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); title.blur(); } });
  title.addEventListener('blur', () => { const t = title.textContent.trim(); if (t && t !== c.title) save({ title: t }).then(() => toast('Renamed.')); });
  main.querySelectorAll('[data-status]').forEach(b => b.onclick = async () => {
    main.querySelectorAll('[data-status]').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b); });
    await save({ status: b.dataset.status });
  });
  main.querySelector('[data-kind]').onchange = e => save({ kind: e.target.value }).then(r => r && paint(main, { item: r, related, routing }));
  main.querySelector('[data-project]').onchange = e => save({ project_id: e.target.value || null }).then(() => toast('Moved.'));
  main.querySelector('[data-due]').onchange = e => save({ due_at: e.target.value ? new Date(e.target.value).toISOString() : null });
  main.querySelector('[data-tags]').onchange = e => save({ tags: e.target.value.split(',').map(s => s.trim()).filter(Boolean) });
  const done = main.querySelector('[data-done]');
  if (done) done.onchange = () => save({ completed_at: done.checked ? new Date().toISOString() : null }).then(r => r && paint(main, { item: r, related, routing }));
  const fix = main.querySelector('[data-fix]');
  if (fix) fix.onclick = () => {
    const p = main.querySelector('[data-raw]');
    p.contentEditable = "true"; p.focus();
    fix.textContent = 'Save transcript';
    fix.onclick = async () => { const r = await save({ raw_text: p.textContent }); if (r) paint(main, { item: r, related, routing }); };
  };
}

function toLocalInput(iso) {
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
