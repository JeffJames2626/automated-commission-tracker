import { stream, api } from '../api.js';
import { esc, icon, md, sheet, toast } from '../ui.js';
import { go } from '../state.js';
import { citeChip } from './common.js';

// The reply to a journal entry: what the assistant saved, answered or
// prepared. The entry itself is already safe; this only shows what came of it.

const STATE = { proposed: null, queued: 'Confirmed — waiting to be applied', verified: 'Done', confirmed: 'Confirmed', cancelled: 'Cancelled', failed: 'Not changed' };

export function journalSheet(capture) {
  const words = String(capture.raw_text || '');
  const s = sheet(`<h3 class="sheet-title">${icon('note')} Journal</h3>
    <blockquote class="journal-entry">${esc(words.length > 280 ? words.slice(0, 279) + '…' : words)}</blockquote>
    <div data-out><p class="muted small" data-status>${icon('sparkle')} Going through it…</p></div>`, { label: 'Journal', tall: true });
  const out = s.el.querySelector('[data-out]');
  let convId = null;
  const paint = m => {
    const byId = Object.fromEntries((m.sources || []).map(x => [x.id, x]));
    const created = (m.created || []).filter(c => c.type === 'capture');
    out.innerHTML = `<div class="answer">${md(m.content || 'Noted.', { cite: id => citeChip(byId[id]) })}</div>
      ${created.length ? `<div class="created">${created.map(c => `<a class="pill ok" href="#/item/${esc(c.id)}">${icon('check')} ${esc(c.title)}</a>`).join('')}</div>` : ''}
      ${(m.actions || []).map(a => `<div class="action-card" data-act="${esc(a.id)}"><p>${esc(a.summary)}</p>${STATE[a.status] ? `<div class="muted small">${esc(STATE[a.status])}</div>` : '<div class="row gap"><button class="btn ghost" data-no>Cancel</button><button class="btn primary" data-yes>Confirm</button></div>'}</div>`).join('')}
      <div class="row gap mt"><button class="btn ghost" data-open>${icon('history')} Today’s journal</button><span class="grow"></span><button class="btn primary" data-done>Done</button></div>`;
    out.querySelectorAll('[data-src]').forEach(b => b.onclick = () => { const x = byId[b.dataset.src]; if (x && x.url) { if (x.url.startsWith('#')) { s.close(); go(x.url); } else window.open(x.url, '_blank', 'noopener'); } });
    out.querySelectorAll('.created a').forEach(a => a.addEventListener('click', () => s.close()));
    out.querySelectorAll('[data-act]').forEach(card => {
      const a = m.actions.find(x => x.id === card.dataset.act);
      const decide = async decision => {
        try {
          const r = await api('action', { method: 'POST', body: { id: a.id, decision } });
          a.status = (r.action && r.action.status) || (decision === 'confirm' ? 'confirmed' : 'cancelled');
          if (r.result && r.result.open_url) window.open(r.result.open_url, '_blank', 'noopener');
          if (r.result && r.result.note) toast(r.result.note, { ms: 6000 });
          paint(m);
        } catch (e) { toast(e.message); }
      };
      const yes = card.querySelector('[data-yes]'), no = card.querySelector('[data-no]');
      if (yes) yes.onclick = () => decide('confirm');
      if (no) no.onclick = () => decide('cancel');
    });
    out.querySelector('[data-open]').onclick = () => { s.close(); go('#/assistant/' + (convId || '')); };
    out.querySelector('[data-done]').onclick = () => s.close();
  };
  stream('journal', { capture_id: capture.id }, ev => {
    if (ev.type === 'conversation') convId = ev.id;
    else if (ev.type === 'status') { const st = out.querySelector('[data-status]'); if (st) st.innerHTML = icon('sparkle') + ' ' + esc(ev.text) + '…'; }
    else if (ev.type === 'message') { paint(ev.message); document.dispatchEvent(new CustomEvent('asst:captured', { detail: null })); }
    else if (ev.type === 'error') out.innerHTML = `<p class="muted">Your words are saved in your journal. The assistant couldn’t go through them just now — it will try again automatically.</p>${ev.ref ? `<p class="muted small">Reference: ${esc(ev.ref)}</p>` : ''}`;
  }).catch(e => {
    out.innerHTML = `<p class="muted">Saved to your journal. ${esc(e.offline ? 'I’ll go through it when you’re back online.' : 'I couldn’t go through it just now — I’ll try again later.')}</p>`;
  });
  return s;
}
