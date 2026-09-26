import { api } from '../api.js';
import { esc, icon, when, ago, skeleton, emptyState, sheet, toast } from '../ui.js';
import { state, go, kindEmoji, kindLabel } from '../state.js';

// Beta tools: the capture review (what the assistant made of each capture,
// for tuning), About this build, and Report / Idea.

const pct = x => (x == null ? '—' : Math.round(x * 100) + '%');
const FILING = { done: 'Filed by AI', heuristic: 'Filed by rules (no AI)', failed: 'AI failed — filed by rules', manual: 'Edited by you', pending: 'Waiting to be filed' };

export async function renderReview(main) {
  main.innerHTML = `<header class="page-h"><button class="icon-btn" data-back aria-label="Back">${icon('back')}</button><h1>Capture review</h1></header>
    <p class="muted small">What the assistant made of each capture, newest first — to spot misfiling. Tap one to fix it.</p>
    <div data-l>${skeleton(4)}</div><div class="center mt"><button class="btn ghost" data-more hidden>Older</button></div>`;
  main.querySelector('[data-back]').onclick = () => go('#/more');
  const list = main.querySelector('[data-l]'), more = main.querySelector('[data-more]');
  let before = null, first = true;
  const load = async () => {
    const r = await api('review', { query: before ? { before } : {} });
    if (first) list.innerHTML = '';
    first = false;
    if (!r.items.length && !list.children.length) { list.innerHTML = emptyState('Nothing captured yet', 'Captures appear here with how they were filed.', 'inbox'); return; }
    list.insertAdjacentHTML('beforeend', r.items.map(row).join(''));
    before = r.items.length ? r.items[r.items.length - 1].capturedAt : before;
    more.hidden = r.items.length < 40;
  };
  more.onclick = () => load().catch(e => toast(e.message));
  await load();
}

function row(it) {
  const facts = [
    ['Type', `${kindEmoji(it.kind)} ${esc(kindLabel(it.kind))}`],
    ['Project', esc(it.project || '—')],
    ['People', esc((it.people || []).join(', ') || '—')],
    ['Due', it.dueAt ? esc(when(it.dueAt)) : '—'],
    ['Status', esc(it.status)],
    ['Filed', esc(FILING[it.filing] || it.filing) + (it.how === 'ai' ? ' · confidence ' + pct(it.confidence) : '')],
  ];
  if (it.reason) facts.push(['Why', esc(it.reason)]);
  if (it.guard && it.guard.length) facts.push(['Safety', esc(it.guard.join('; '))]);
  if (it.error) facts.push(['Note', esc(it.error)]);
  if (it.journal) facts.push(['Journal', it.journal === 'done' ? 'Gone through' : 'Waiting — AI filing will retry']);
  if (it.routing) facts.push(['Routing', esc('Dream Board · ' + it.routing.status + (it.routing.title ? ' · ' + it.routing.title : '') + (it.routing.reason ? ' (' + it.routing.reason + ')' : ''))]);
  const linked = (it.links || []).filter(l => l.type === 'capture');
  if (linked.length) facts.push(['Linked', linked.map(l => `<a href="#/item/${esc(l.id)}">${esc(l.relation === 'from_journal' ? 'from journal' : l.relation)}</a>`).join(', ')]);
  return `<a class="card review" href="#/item/${esc(it.id)}">
    <div class="review-raw">${esc(it.raw || it.title || '(no text)')}</div>
    <dl class="review-facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
    <div class="muted small">${esc(it.source)}${it.attachments ? ' · ' + it.attachments + ' attachment' + (it.attachments > 1 ? 's' : '') : ''} · ${esc(ago(it.capturedAt))}</div>
  </a>`;
}

export async function renderAbout(main) {
  const b = (state.boot && state.boot.build) || {};
  main.innerHTML = `<header class="page-h"><button class="icon-btn" data-back aria-label="Back">${icon('back')}</button><h1>About this build</h1></header>
    <section class="card"><dl class="review-facts">
      <dt>Environment</dt><dd>${esc(ENV_LABEL[b.env] || b.env || 'unknown')}</dd>
      <dt>Build</dt><dd><code>${esc(b.sha || 'unknown')}</code>${b.branch ? ' · ' + esc(b.branch) : ''}</dd>
      <dt>Deployed</dt><dd>${b.builtAt ? esc(when(b.builtAt)) : 'not recorded'}</dd>
      <dt>AI</dt><dd>${state.boot && state.boot.ai ? 'On' : 'Off — captures are kept and filed by simple rules'}</dd>
    </dl></section>
    <p class="muted small">Quote the build when you report a problem. Reports and ideas go to your Personal Assistant project.</p>
    <button class="btn primary wide" data-report>${icon('note')} Report a problem or idea</button>`;
  main.querySelector('[data-back]').onclick = () => go('#/more');
  main.querySelector('[data-report]').onclick = () => feedbackSheet();
}

export const ENV_LABEL = { development: 'Development (real data, beta)', local: 'Local (test data)', preview: 'Preview', production: 'Production' };

export function feedbackSheet() {
  const s = sheet(`<h3 class="sheet-title">${icon('note')} Report / Idea</h3>
    <div class="theme-seg" role="radiogroup" aria-label="Kind"><button data-type="problem" class="on" role="radio" aria-checked="true">Problem</button><button data-type="idea" role="radio" aria-checked="false">Idea</button></div>
    <div class="form mt"><textarea rows="5" data-t placeholder="What happened, or what would make this better?"></textarea></div>
    <p class="muted small">Saved as a capture in your Personal Assistant project, with this screen and build attached.</p>
    <div class="row gap"><span class="grow"></span><button class="btn ghost" data-cancel>Cancel</button><button class="btn primary" data-send>Save</button></div>`, { label: 'Report or idea' });
  let type = 'problem';
  s.el.querySelectorAll('[data-type]').forEach(b => b.onclick = () => {
    type = b.dataset.type;
    s.el.querySelectorAll('[data-type]').forEach(x => { const on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-checked', on); });
  });
  const ta = s.el.querySelector('[data-t]');
  setTimeout(() => ta.focus(), 50);
  s.el.querySelector('[data-cancel]').onclick = () => s.close();
  s.el.querySelector('[data-send]').onclick = async () => {
    const text = ta.value.trim();
    if (!text) { ta.focus(); return; }
    try {
      const r = await api('feedback', { method: 'POST', body: { type, text, screen: location.hash.split('?')[0].slice(0, 80) } });
      s.close();
      toast(type === 'idea' ? 'Idea saved' : 'Problem saved', { tone: 'ok', action: 'View', onAction: () => go('#/item/' + r.item.id) });
    } catch (e) { toast(e.message); }
  };
  return s;
}
