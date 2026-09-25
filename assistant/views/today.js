import { api } from '../api.js';
import { esc, icon, md, timeOnly, when, sameDay, skeleton, cacheGet, cacheSet, sheet, toast } from '../ui.js';
import { state, go } from '../state.js';
import { captureCard, sectionHead, statusNote, citeChip, sourcesBlock, evidenceSheet } from './common.js';
import { composer } from '../capture.js';
import { dreamRow, freshLine } from './dreams.js';

// Today — a chief of staff, not a task dashboard.

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Still up' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

function eventRow(e) {
  const now = Date.now();
  const live = !e.meta.allDay && Date.parse(e.meta.start) <= now && Date.parse(e.meta.end) > now;
  const day = e.meta.allDay ? '' : (sameDay(e.meta.start, now) ? '' : 'Tomorrow ');
  const with_ = (e.meta.attendees || []).filter(a => !a.self).map(a => a.name || a.email.split('@')[0]).slice(0, 3).join(', ');
  return `<a class="row-item ${live ? 'live' : ''}" href="${esc(e.url || '#')}" target="_blank" rel="noopener noreferrer">
    <div class="time">${e.meta.allDay ? 'All day' : esc(day + timeOnly(e.meta.start))}</div>
    <div class="grow"><div class="ri-title">${esc(e.title)}</div>${with_ || e.meta.location ? `<div class="ri-sub">${esc([with_, e.meta.location].filter(Boolean).join(' · '))}</div>` : ''}</div>
    ${live ? '<span class="pill live">Now</span>' : ''}
  </a>`;
}

function mailRow(t) {
  return `<a class="row-item" href="${esc(t.url)}" target="_blank" rel="noopener noreferrer">
    <div class="avatar">${esc((t.meta.lastFrom || '?').trim()[0] || '?')}</div>
    <div class="grow"><div class="ri-title">${t.meta.unread ? '<span class="dot"></span>' : ''}${esc(t.meta.lastFrom)}</div><div class="ri-sub">${esc(t.title)}</div></div>
    <div class="ri-time">${esc(when(t.date, { weekday: undefined }))}</div>
  </a>`;
}

function fileRow(f) {
  return `<a class="row-item" href="${esc(f.url)}" target="_blank" rel="noopener noreferrer">${icon(f.provider === 'google_sheets' ? 'table' : 'note')}
    <div class="grow"><div class="ri-title">${esc(f.title)}</div><div class="ri-sub">${esc(f.meta.lastModifiedBy || f.meta.owner || '')}</div></div></a>`;
}

export async function catchMeUp() {
  const s = sheet(`<h3 class="sheet-title">${icon('bolt')} Catch me up</h3><div data-b>${skeleton(2)}</div>`, { tall: true, label: 'Catch me up' });
  try {
    const r = await api('catchup', { method: 'POST' });
    const byId = Object.fromEntries(r.sources.map(x => [x.id, x]));
    s.el.querySelector('[data-b]').innerHTML = `${r.since ? `<p class="eyebrow">Since ${esc(when(r.since))}</p>` : ''}<div class="answer">${md(r.text, { cite: id => citeChip(byId[id]) })}</div>${sourcesBlock(r.sources)}
      <div class="row gap mt"><button class="btn ghost" data-why>${icon('shield')} Why?</button><button class="btn ghost" data-ask>${icon('sparkle')} Ask a follow-up</button></div>`;
    s.el.querySelectorAll('[data-src]').forEach(b => b.onclick = () => { const x = byId[b.dataset.src]; if (x && x.url) window.open(x.url, x.url.startsWith('#') ? '_self' : '_blank', 'noopener'); });
    s.el.querySelector('[data-why]').onclick = () => evidenceSheet({ sources: r.sources, trace: [], model: r.ai ? 'Claude' : null });
    s.el.querySelector('[data-ask]').onclick = () => { s.close(); go('#/assistant', {}); };
  } catch (e) {
    s.el.querySelector('[data-b]').innerHTML = `<p class="muted">${esc(e.offline ? 'You’re offline — Catch Me Up needs a connection.' : e.message)}</p>`;
  }
}

export async function render(main) {
  const name = state.boot && state.boot.user.name ? state.boot.user.name.split(' ')[0] : '';
  main.innerHTML = `
    <header class="page-h"><div><div class="eyebrow">${esc(new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }))}</div>
      <h1>${esc(greeting())}${name ? ', ' + esc(name) : ''}</h1></div></header>
    <button class="hero-btn" data-catchup>${icon('bolt')}<span><b>Catch me up</b><small>What changed since you last looked, and what’s next</small></span>${icon('chevron')}</button>
    <div data-body>${skeleton(3)}</div>
    <div class="dock-spacer"></div>`;
  main.querySelector('[data-catchup]').onclick = catchMeUp;
  const dock = document.createElement('div');
  dock.className = 'dock';
  dock.appendChild(composer());
  main.appendChild(dock);

  const body = main.querySelector('[data-body]');
  const paint = d => {
    const t = d.tasks;
    const due = t.overdue.concat(t.dueToday);
    const cal = d.calendar;
    const parts = [];
    // NOW — what is time-sensitive today.
    parts.push(`<section class="card sec">${sectionHead('Now', 'calendar')}${cal.items && cal.items.length ? cal.items.slice(0, 6).map(eventRow).join('') : (cal.status === 'ok' ? '<div class="quiet">Nothing else on the calendar today.</div>' : statusNote(cal))}
      ${due.length ? due.slice(0, 4).map(c => captureCard(c, { compact: true })).join('') : ''}</section>`);
    // FOLLOW UP — what you said you'd do, and who is waiting on you.
    if (t.open.length) parts.push(`<section class="sec">${sectionHead('Follow up', 'check')}${t.open.slice(0, 5).map(c => captureCard(c, { compact: true })).join('')}</section>`);
    if (d.email.status !== 'ok' || d.email.items.length) parts.push(`<section class="card sec">${sectionHead('Waiting on you', 'mail', d.email.unread ? `<span class="count">${d.email.unread} unread</span>` : '')}${d.email.items && d.email.items.length ? d.email.items.slice(0, 5).map(mailRow).join('') : statusNote(d.email)}</section>`);
    // DREAMS & GOALS — only when something is worth a glance.
    const dr = d.dreams;
    const dreamRows = (dr ? dr.items.map(x => dreamRow(x, x.line)) : []).concat(d.goals.map(c => captureCard(c, { compact: true })));
    if (dr && dr.needsChoice) dreamRows.unshift(`<a class="row-item" href="#/inbox">${icon('bolt')}<div class="grow"><div class="ri-title">${dr.needsChoice} capture${dr.needsChoice > 1 ? 's' : ''} waiting for you to pick a dream</div></div>${icon('chevron')}</a>`);
    if (dr && ['stale', 'disconnected'].includes(dr.freshness.state)) dreamRows.push(`<div class="status-note">Dream Board: ${esc(freshLine(dr.freshness))}</div>`);
    if (dreamRows.length) parts.push(`<section class="card sec">${sectionHead('Dreams & goals', 'sparkle')}${dreamRows.join('')}</section>`);
    // RECENTLY CAPTURED — what still needs a decision or a home.
    if ((d.recentInbox || []).length) parts.push(`<section class="sec">${sectionHead('Recently captured', 'inbox')}${d.recentInbox.map(c => captureCard(c, { compact: true })).join('')}</section>`);
    if (d.revisit.length) parts.push(`<section class="sec">${sectionHead('Worth revisiting', 'history')}${d.revisit.map(c => captureCard(c)).join('')}</section>`);
    else if (d.recentIdeas.length) parts.push(`<section class="sec">${sectionHead('Recent ideas', 'sparkle')}${d.recentIdeas.map(c => captureCard(c, { compact: true })).join('')}</section>`);
    if (d.files.items && d.files.items.length) parts.push(`<section class="card sec">${sectionHead('Recently changed files', 'folder')}${d.files.items.slice(0, 4).map(fileRow).join('')}</section>`);
    if (d.counts.inbox) parts.push(`<a class="card inbox-nudge" href="#/inbox">${icon('inbox')}<span>${d.counts.inbox} capture${d.counts.inbox > 1 ? 's' : ''} in your Inbox</span>${icon('chevron')}</a>`);
    parts.push(`<button class="btn wide ghost mt" data-ask>${icon('sparkle')} Ask Assistant</button>`);
    body.innerHTML = parts.join('');
    body.querySelector('[data-ask]').onclick = () => go('#/assistant');
  };
  const cached = cacheGet('today');
  if (cached) paint(cached);
  try {
    const d = await api('today');
    cacheSet('today', d);
    if (main.isConnected) paint(d);
  } catch (e) {
    if (!cached) body.innerHTML = `<div class="card quiet">${esc(e.offline ? 'You’re offline. Captures still work — they’ll sync later.' : e.message)}</div>`;
    else if (e.offline) toast('Offline — showing what you saw last.');
  }
  const refresh = () => api('today').then(d => { cacheSet('today', d); if (main.isConnected) paint(d); }).catch(() => {});
  document.addEventListener('asst:captured', refresh);
  return () => document.removeEventListener('asst:captured', refresh);
}
