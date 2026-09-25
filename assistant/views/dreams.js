import { api } from '../api.js';
import { esc, icon, ago, when, skeleton, sheet, toast } from '../ui.js';
import { go } from '../state.js';
import { sectionHead } from './common.js';

// Dream Board inside the assistant: where a capture went, "Which dream?",
// and a read-only view of one dream. Dream Board owns the dream — this page
// shows what the assistant knows about it and links to the real one.

const STAGE = { captured: 'Captured', routed: 'Routed', queued: 'Queued', waiting: 'Waiting', needs_choice: 'Asked you', sent: 'Sent', acknowledged: 'Added in Dream Board', rejected: 'Refused', cancelled: 'Cancelled', rerouted: 'Asked again', retry: 'Retried' };

// How current the assistant's copy is, in words.
export function freshLine(f) {
  if (!f) return '';
  switch (f.state) {
    case 'live': return 'Up to date';
    case 'recent': return 'As of ' + ago(f.lastSeenAt);
    case 'stale': return 'As of ' + when(f.lastSeenAt) + ' — Dream Board hasn’t synced since';
    case 'syncing': return 'Syncing with Dream Board…';
    case 'disconnected': return 'Disconnected' + (f.lastSeenAt ? ' — as of ' + when(f.lastSeenAt) : '');
    case 'waiting_first_sync': return 'Waiting for Dream Board’s first sync';
    case 'pairing': return 'Waiting for the pairing code to be entered in Dream Board';
    default: return 'Not connected';
  }
}

// One sentence for where a routed capture is. Used by the toast and item page.
export function routeText(routing) {
  const o = routing && routing.current;
  if (!o) return null;
  const target = o.target && o.target.title ? '“' + o.target.title + '”' : o.title ? '“' + o.title + '”' : 'Dream Board';
  const later = routing.freshness && routing.freshness.state === 'live' ? '' : ' — added when Dream Board next syncs';
  switch (o.status) {
    case 'applied': return o.kind === 'create_goal' ? 'Saved to Dream Board · ' + target : o.kind === 'attach' ? 'Added to ' + target + ' in Dream Board' : 'Added to Dream Board as an unsorted item';
    case 'queued': return (o.kind === 'attach' ? 'Adding to ' + target : o.kind === 'add_item' ? 'Adding to Dream Board' : 'Saving to Dream Board as ' + target) + later;
    case 'waiting': return o.target && !o.target.id ? 'Will be added to ' + target + ' once that dream is created' : 'Saved — waiting to add to Dream Board';
    case 'routing': return 'Saved — sending to Dream Board';
    case 'needs_choice': return 'Which dream? Tap to choose';
    case 'rejected': return 'Dream Board couldn’t add this (' + (o.reason || 'refused') + ')';
    case 'cancelled': return o.reason === 'kept_here' ? 'Kept here, not sent to Dream Board' : null;
    default: return null;
  }
}

export function routingBlock(routing, captureId) {
  const o = routing && routing.current;
  if (!o) return '';
  const text = routeText(routing);
  if (!text) return '';
  const recId = o.result && o.result.type === 'goal' ? o.result.id : o.target && o.target.id;
  return `<section class="block route-block"><div class="block-h">${icon('sparkle')} Dream Board</div>
    <div class="row-item">${icon(o.status === 'applied' ? 'check' : o.status === 'needs_choice' ? 'bolt' : 'clock')}
      <div class="grow"><div class="ri-title">${esc(text)}</div><div class="ri-sub">${esc(freshLine(routing.freshness))}</div></div>
      ${o.status === 'needs_choice' ? `<button class="btn small primary" data-choose="${esc(captureId)}">Choose</button>` : recId ? `<a class="btn small" href="#/dream/${encodeURIComponent(recId)}">Open</a>` : ''}</div>
    <details class="muted small"><summary>Delivery details</summary><ol class="trace">${o.trace.map(t => `<li>${esc(STAGE[t.stage] || t.stage)} · ${esc(when(t.at))}</li>`).join('')}</ol>
      ${o.attempts ? `<p>Handed to Dream Board ${o.attempts} time${o.attempts > 1 ? 's' : ''}${o.reason ? ' · ' + esc(o.reason) : ''}.</p>` : ''}</details></section>`;
}

// "Which dream?" — the owner decides; nothing is guessed.
export function chooseDream(captureId, routing, { onDone, photo = false } = {}) {
  const o = (routing && routing.current) || {};
  const cands = o.candidates || [];
  const suggested = o.suggestedTitle || o.title || '';
  const s = sheet(`<h3 class="sheet-title">Which dream?</h3>
    ${cands.length ? `<p class="muted small">Add it to one of these, or start a new dream.</p>${cands.map((c, i) => `<button class="row-item wide" data-c="${i}">${icon('sparkle')}<div class="grow"><div class="ri-title">${esc(c.title)}</div><div class="ri-sub">${esc(c.kind === 'pending' ? 'being added to Dream Board' : c.status || '')}</div></div>${icon('chevron')}</button>`).join('')}` : ''}
    <form class="form mt" data-new><label class="field"><span>New dream</span><input name="title" value="${esc(suggested)}" maxlength="80" placeholder="Name it"></label><button class="btn primary">Create in Dream Board</button></form>
    ${photo ? '<button class="btn wide ghost mt" data-item>Add to the board without a dream</button>' : ''}
    <button class="btn wide ghost mt" data-keep>Keep it here, don’t send</button>`, { label: 'Which dream?' });
  const send = async choice => {
    try {
      const r = await api('route', { method: 'POST', body: Object.assign({ capture_id: captureId }, choice) });
      s.close();
      toast(routeText(r.routing) || 'Kept here.', { tone: 'ok' });
      onDone && onDone(r);
    } catch (e) { toast(e.message); }
  };
  s.el.querySelectorAll('[data-c]').forEach(b => b.onclick = () => { const c = cands[+b.dataset.c]; send({ choice: c.kind === 'pending' ? { pending: c.id } : { goal: c.id } }); });
  s.el.querySelector('[data-new]').onsubmit = e => { e.preventDefault(); send({ choice: 'new', title: new FormData(e.target).get('title') || null }); };
  const item = s.el.querySelector('[data-item]');
  if (item) item.onclick = () => send({ choice: 'item' });
  s.el.querySelector('[data-keep]').onclick = () => send({ choice: 'keep' });
  return s;
}

export function dreamRow(g, extra = '') {
  return `<a class="row-item" href="#/dream/${encodeURIComponent(g.id)}">${icon('sparkle')}<div class="grow"><div class="ri-title">${esc(g.title)}</div>
    <div class="ri-sub">${esc([g.status, extra || (g.lastProgressAt ? 'progress ' + ago(g.lastProgressAt) : g.lastUpdateAt ? 'updated ' + ago(g.lastUpdateAt) : '')].filter(Boolean).join(' · '))}</div></div>${icon('chevron')}</a>`;
}

const money = (v, k) => (typeof v === 'number' && /amount|budget|saved|price|cost/.test(k) ? '$' + v.toLocaleString('en-US') : String(v));

export async function render(main, params, id) {
  main.innerHTML = `<header class="page-h"><button class="icon-btn" data-back aria-label="Back">${icon('back')}</button></header>${skeleton(3)}`;
  main.querySelector('[data-back]').onclick = () => history.length > 1 ? history.back() : go('#/today');
  let d;
  try { d = (await api('dream', { query: { id } })).dream; }
  catch (e) { main.innerHTML += `<div class="card quiet">${esc(e.status === 404 ? 'The assistant doesn’t know this dream.' : e.message)}</div>`; return; }
  const fields = Object.entries(d.current.fields).filter(([, v]) => v != null && v !== '');
  main.innerHTML = `
    <header class="page-h"><button class="icon-btn" data-back aria-label="Back">${icon('back')}</button><div class="grow"></div>
      <button class="icon-btn" data-ask aria-label="Ask about this">${icon('sparkle')}</button></header>
    <article class="idea">
      <div class="eyebrow">Dream Board · ${esc(freshLine(d.freshness))}</div>
      <h1 class="idea-title">${esc(d.title)}</h1>
      ${d.aliases.length ? `<p class="muted small">Formerly ${d.aliases.map(a => '“' + esc(a) + '”').join(', ')}</p>` : ''}
      ${d.gone ? `<div class="status-note">${d.gone === 'deleted' ? 'Deleted in Dream Board.' : 'No longer in Dream Board (it may have been restored from a backup).'} Kept here so your captures still make sense.</div>` : ''}
      <div class="fields card">
        <div class="field"><span>Status</span><b>${esc(d.status || '—')}</b></div>
        ${d.current.category ? `<div class="field"><span>Category</span><b>${esc(d.current.category)}</b></div>` : ''}
        ${fields.map(([k, v]) => `<div class="field"><span>${esc(k.replace(/_/g, ' '))}</span><b>${esc(money(v, k))}</b></div>`).join('')}
      </div>
      ${d.link ? `<a class="btn wide primary" href="${esc(d.link)}" target="_blank" rel="noopener noreferrer">${icon('external')} Open in Dream Board</a>` : '<p class="muted small">Add your Dream Board address in <a href="#/connections">Connections</a> to open it there.</p>'}
      ${d.current.description ? `<section class="block"><div class="block-h">${icon('note')} In Dream Board</div><p>${esc(d.current.description)}</p></section>` : ''}
      ${d.current.milestones.length ? `<section class="block"><div class="block-h">${icon('check')} Milestones</div>${d.current.milestones.map(m => `<div class="row-item">${icon(m.done ? 'check' : 'clock')}<div class="grow"><div class="ri-title">${esc(m.title)}</div>${m.done_at ? `<div class="ri-sub">${esc(when(m.done_at))}</div>` : ''}</div></div>`).join('')}</section>` : ''}
      <section class="block"><div class="block-h">${icon('note')} Your words</div>
        ${d.words.length ? d.words.map(w => `<a class="row-item" href="#/item/${esc(w.id)}"><div class="grow"><div class="ri-title">“${esc(w.text)}”</div><div class="ri-sub">${esc(when(w.capturedAt))}${w.attachments ? ' · ' + w.attachments + ' attachment' + (w.attachments > 1 ? 's' : '') : ''}</div></div>${icon('chevron')}</a>`).join('') : '<p class="muted small">Nothing captured about this dream yet.</p>'}</section>
      ${d.pending.length ? `<section class="block"><div class="block-h">${icon('clock')} Waiting to reach Dream Board</div><p class="muted small">${d.pending.length} item${d.pending.length > 1 ? 's' : ''}.</p></section>` : ''}
      <section class="block">${sectionHead('What changed', 'history')}
        ${d.changes.length ? `<ol class="timeline">${d.changes.slice().reverse().map(c => `<li class="${c.progress ? 'progress' : ''}"><span>${esc(c.text)}</span><small>${esc(when(c.at))}${c.by === 'assistant' ? ' · from your capture' : ''}</small></li>`).join('')}</ol>` : '<p class="muted small">No changes seen yet.</p>'}
        ${d.historySince ? `<p class="muted small">The assistant has known this board since ${esc(when(d.historySince))}.</p>` : ''}</section>
    </article>`;
  main.querySelector('[data-back]').onclick = () => history.length > 1 ? history.back() : go('#/today');
  main.querySelector('[data-ask]').onclick = () => go('#/assistant', { ask: 'Tell me about my “' + d.title + '” dream — what I said, and what has changed.' });
}
