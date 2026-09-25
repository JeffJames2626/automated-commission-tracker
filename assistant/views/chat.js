import { api, stream } from '../api.js';
import { esc, icon, md, ago, toast, sheet, skeleton } from '../ui.js';
import { state, go, takeNav } from '../state.js';
import { citeChip, providerOf, evidenceSheet, sourceRow } from './common.js';
import { composer } from '../capture.js';

// The assistant conversation. Answers render with tappable citations; every
// answer has a "Why?" that shows the exact evidence and what was searched.

const SUGGESTIONS = [
  'Catch me up',
  'What am I supposed to be working on tomorrow?',
  'What ideas have I had recently about ALP sales?',
  'What are my biggest unfinished ideas?',
  'Summarize emails I haven’t dealt with yet',
  'What appointments do I have Thursday?',
];

function actionCard(a) {
  const done = a.status !== 'proposed';
  return `<div class="action-card ${esc(a.status)}" data-action="${esc(a.id)}">
    <div class="ac-h">${icon('shield')} <b>Needs your OK</b><span class="grow"></span><span class="pill">${esc(a.kind.replace(/_/g, ' '))}</span></div>
    <p>${esc(a.summary)}</p>
    ${a.payload && (a.payload.to || a.payload.subject) ? `<div class="ac-detail">${a.payload.to ? '<div><span class="muted">To</span> ' + esc(a.payload.to) + '</div>' : ''}${a.payload.subject ? '<div><span class="muted">Subject</span> ' + esc(a.payload.subject) + '</div>' : ''}${a.payload.body ? '<pre>' + esc(a.payload.body) + '</pre>' : ''}</div>` : ''}
    ${done ? `<div class="muted small">${a.status === 'confirmed' ? 'Confirmed' : 'Cancelled'}</div>` : `<div class="row gap"><button class="btn ghost" data-no>Cancel</button><button class="btn primary" data-yes>Review &amp; confirm</button></div>`}
  </div>`;
}

function messageHtml(m) {
  if (m.role === 'user') return `<div class="msg user"><div class="bubble">${esc(m.content)}</div></div>`;
  const byId = Object.fromEntries((m.sources || []).map(s => [s.id, s]));
  const cited = (m.sources || []).filter(s => s.cited);
  const labels = [...new Set(cited.map(s => providerOf(s.provider).label))];
  return `<div class="msg assistant" data-mid="${esc(m.id)}">
    <div class="answer">${md(m.content, { cite: id => citeChip(byId[id]) })}</div>
    ${(m.created || []).length ? `<div class="created">${m.created.map(c => c.type === 'capture' ? `<a class="pill ok" href="#/item/${esc(c.id)}">${icon('check')} Saved: ${esc(c.title)}</a>` : `<a class="pill ok" href="#/memory">${icon('brain')} Remembered</a>`).join('')}</div>` : ''}
    ${(m.actions || []).map(actionCard).join('')}
    ${cited.length ? `<div class="src-strip">${cited.slice(0, 6).map(s => `<button class="src-mini" data-src="${esc(s.id)}">${icon(providerOf(s.provider).icon)}<span>${esc(s.title)}</span></button>`).join('')}</div>` : ''}
    <div class="msg-foot">${labels.length ? '<span class="muted small">From ' + esc(labels.join(', ')) + '</span>' : (m.degraded ? '<span class="muted small">Search results — no AI</span>' : '<span class="muted small">No sources used</span>')}<span class="grow"></span>
      <button class="link small" data-why>${icon('shield')} Why?</button></div>
  </div>`;
}

export async function render(main, params, convId) {
  const nav = takeNav();
  main.classList.add('chat-page');
  main.innerHTML = `
    <header class="page-h"><h1>Assistant</h1><div class="page-h-actions">
      <button class="icon-btn" data-history aria-label="Conversations">${icon('history')}</button>
      <button class="icon-btn" data-new aria-label="New conversation">${icon('plus')}</button></div></header>
    <div class="thread" data-thread aria-live="polite"></div>
    <div class="dock-spacer"></div>`;
  const thread = main.querySelector('[data-thread]');
  const dock = document.createElement('div');
  dock.className = 'dock';
  const comp = composer({ placeholder: 'Ask anything…', mode: 'chat', onAsk: q => ask(q) });
  dock.appendChild(comp);
  main.appendChild(dock);

  let conv = null, busy = false, messages = [];
  const byMid = new Map();

  const bind = () => {
    thread.querySelectorAll('.msg.assistant').forEach(el => {
      const m = byMid.get(el.dataset.mid);
      if (!m) return;
      el.querySelectorAll('[data-src]').forEach(b => b.onclick = () => openSource(m, b.dataset.src));
      const why = el.querySelector('[data-why]');
      if (why) why.onclick = () => evidenceSheet(m);
      el.querySelectorAll('[data-action]').forEach(card => {
        const a = (m.actions || []).find(x => x.id === card.dataset.action);
        const yes = card.querySelector('[data-yes]'), no = card.querySelector('[data-no]');
        if (yes) yes.onclick = async () => {
          try {
            const r = await api('action', { method: 'POST', body: { id: a.id, decision: 'confirm' } });
            a.status = 'confirmed';
            card.outerHTML = actionCard(a);
            if (r.result && r.result.open_url) window.open(r.result.open_url, '_blank', 'noopener');
            toast(r.result && r.result.note ? r.result.note : 'Confirmed.', { ms: 6000 });
          } catch (e) { toast(e.message); }
        };
        if (no) no.onclick = async () => { try { await api('action', { method: 'POST', body: { id: a.id, decision: 'cancel' } }); a.status = 'cancelled'; card.outerHTML = actionCard(a); } catch (e) { toast(e.message); } };
      });
    });
    renderContext();
  };
  const paint = () => {
    if (!messages.length) {
      thread.innerHTML = `<div class="chat-empty">${icon('sparkle', 'big')}<h3>Ask about anything you’ve captured or connected</h3>
        <p class="muted">Notes, ideas, email, calendar, Drive and Sheets. Answers show exactly where they came from.</p>
        <div class="suggest">${SUGGESTIONS.map(s => `<button class="chip" data-s="${esc(s)}">${esc(s)}</button>`).join('')}</div></div>`;
      thread.querySelectorAll('[data-s]').forEach(b => b.onclick = () => ask(b.dataset.s));
      return;
    }
    thread.innerHTML = messages.map(messageHtml).join('');
    bind();
  };
  const scrollDown = () => requestAnimationFrame(() => { const last = thread.lastElementChild; if (last) last.scrollIntoView({ block: 'end', behavior: 'smooth' }); });

  function openSource(m, id) {
    const s = (m.sources || []).find(x => x.id === id);
    if (!s || !s.url) return evidenceSheet(m);
    if (s.url.startsWith('#')) go(s.url);
    else window.open(s.url, '_blank', 'noopener');
  }

  // Desktop: the right-hand panel shows the latest answer's sources.
  function renderContext() {
    const last = [...messages].reverse().find(m => m.role === 'assistant');
    state.context = () => {
      if (!last) return '<div class="ctx-empty muted">Sources for answers appear here.</div>';
      const cited = (last.sources || []).filter(s => s.cited);
      const other = (last.sources || []).filter(s => !s.cited);
      return `<div class="ctx-h">Sources</div>${cited.length ? cited.map(s => sourceRow(s)).join('') : '<p class="muted small">The latest answer did not cite any source.</p>'}
        ${other.length ? `<div class="ctx-h mt">Also retrieved</div>${other.slice(0, 8).map(s => sourceRow(s)).join('')}` : ''}
        ${(last.trace || []).length ? `<div class="ctx-h mt">Searched</div><ul class="trace">${last.trace.map(t => `<li>${esc(t.tool.replace(/_/g, ' '))} — ${t.error ? esc(t.error) : t.count + ' found'}</li>`).join('')}</ul>` : ''}`;
    };
    document.dispatchEvent(new Event('asst:context'));
  }

  async function ask(q) {
    q = String(q || '').trim();
    if (!q || busy) return;
    if (q.toLowerCase() === 'catch me up') { const { catchMeUp } = await import('./today.js'); return catchMeUp(); }
    busy = true;
    messages.push({ role: 'user', content: q, id: 'local-' + Date.now() });
    paint();
    thread.insertAdjacentHTML('beforeend', `<div class="msg assistant pending"><div class="typing"><span></span><span></span><span></span></div><div class="status-line" data-status>Thinking…</div></div>`);
    scrollDown();
    const statusEl = () => thread.querySelector('[data-status]');
    try {
      await stream('chat', { message: q, conversation_id: conv ? conv.id : undefined }, ev => {
        if (ev.type === 'conversation' && (!conv || conv.id !== ev.id)) { conv = { id: ev.id }; history.replaceState(null, '', '#/assistant/' + ev.id); }
        else if (ev.type === 'status' && statusEl()) statusEl().textContent = ev.text + '…';
        else if (ev.type === 'message') { byMid.set(ev.message.id, ev.message); messages.push(ev.message); }
        else if (ev.type === 'error') throw new Error(ev.error);
      });
    } catch (e) {
      messages.push({ role: 'assistant', id: 'err-' + Date.now(), content: e.offline ? 'You’re offline. I can’t reach your sources right now — but anything you capture is saved on this phone.' : 'Something went wrong: ' + e.message, sources: [] });
      byMid.set(messages[messages.length - 1].id, messages[messages.length - 1]);
    } finally {
      busy = false;
      paint();
      scrollDown();
    }
  }

  main.querySelector('[data-new]').onclick = () => { conv = null; messages = []; byMid.clear(); history.replaceState(null, '', '#/assistant'); paint(); renderContext(); comp.focusInput(); };
  main.querySelector('[data-history]').onclick = async () => {
    const s = sheet(`<h3 class="sheet-title">Conversations</h3><div data-l>${skeleton(3)}</div>`, { tall: true, label: 'Conversations' });
    try {
      const r = await api('conversations');
      s.el.querySelector('[data-l]').innerHTML = r.conversations.length ? r.conversations.map(c => `<a class="row-item" href="#/assistant/${esc(c.id)}"><div class="grow"><div class="ri-title">${esc(c.title || 'Conversation')}</div><div class="ri-sub">${esc((c.last || '').replace(/\[S\d+\]/g, '').slice(0, 90))}</div></div><div class="ri-time">${esc(ago(c.updated_at))}</div></a>`).join('') : '<p class="muted">No conversations yet.</p>';
      s.el.querySelectorAll('a').forEach(a => a.addEventListener('click', () => s.close()));
    } catch (e) { s.el.querySelector('[data-l]').innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
  };

  if (convId) {
    thread.innerHTML = skeleton(2);
    try {
      const r = await api('conversation', { query: { id: convId } });
      conv = r.conversation;
      messages = conv.messages;
      messages.forEach(m => byMid.set(m.id, m));
    } catch (e) { toast(e.status === 404 ? 'That conversation is gone.' : e.message); }
  }
  paint();
  scrollDown();
  if (nav.ask) ask(nav.ask);
  return () => { main.classList.remove('chat-page'); state.context = null; document.dispatchEvent(new Event('asst:context')); };
}
