import { api, authUrl } from '../api.js';
import { esc, icon, when, ago, skeleton, emptyState, toast, sheet, confirmSheet } from '../ui.js';
import { state, go } from '../state.js';
import { captureCard, sourceRow, sectionHead, statusNote } from './common.js';
import { dreamRow, freshLine } from './dreams.js';

// More: projects, people, memory, connections and account. Deliberately
// small — this is not a settings maze.

export async function renderMore(main) {
  const u = state.boot.user;
  main.innerHTML = `
    <header class="page-h"><h1>More</h1></header>
    <div class="me card">${u.picture ? `<img src="${esc(u.picture)}" alt="" referrerpolicy="no-referrer">` : `<div class="avatar big">${esc((u.name || u.email)[0])}</div>`}<div><div class="ri-title">${esc(u.name || '')}</div><div class="ri-sub">${esc(u.email)}</div></div></div>
    <nav class="menu card">
      <a href="#/projects">${icon('folderOpen')}<span>Projects & topics</span>${icon('chevron')}</a>
      <a href="#/people">${icon('person')}<span>People</span>${icon('chevron')}</a>
      <a href="#/memory">${icon('brain')}<span>Memory</span>${icon('chevron')}</a>
      <a href="#/connections">${icon('link')}<span>Connections</span>${icon('chevron')}</a>
    </nav>
    <nav class="menu card">
      <button data-report>${icon('note')}<span>Report a problem / Idea</span>${icon('chevron')}</button>
      <a href="#/review">${icon('history')}<span>Capture review</span>${icon('chevron')}</a>
      <a href="/api/assistant?r=export" download>${icon('folder')}<span>Export my data</span>${icon('chevron')}</a>
      <a href="#/about">${icon('shield')}<span>About this build</span>${icon('chevron')}</a>
    </nav>
    <section class="card sec"><div class="sec-h">${icon('today')}<span>Appearance</span></div>
      <div class="theme-seg" role="radiogroup" aria-label="Theme">${['system', 'light', 'dark'].map(t => `<button data-theme-pick="${t}" role="radio">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div></section>
    <nav class="menu card">
      <button data-install>${icon('plus')}<span>Add to Home Screen</span>${icon('chevron')}</button>
      <button data-privacy>${icon('shield')}<span>Privacy & permissions</span>${icon('chevron')}</button>
    </nav>
    <nav class="menu card">
      <button data-signout>${icon('logout')}<span>Sign out</span></button>
      <button data-signout-all class="danger-text">${icon('logout')}<span>Sign out on every device</span></button>
    </nav>
    <p class="muted small center">${state.boot.ai ? 'AI assistant is on.' : 'AI is not configured — capture and search still work.'}</p>`;
  // Theme: System (follow the device), Light or Dark — remembered on this device.
  const paintTheme = () => {
    let cur = 'system';
    try { cur = localStorage.getItem('asst:theme') || 'system'; } catch { /* storage blocked */ }
    main.querySelectorAll('[data-theme-pick]').forEach(b => { const on = b.dataset.themePick === cur; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
  };
  main.querySelectorAll('[data-theme-pick]').forEach(b => b.onclick = () => {
    const t = b.dataset.themePick;
    try { if (t === 'system') localStorage.removeItem('asst:theme'); else localStorage.setItem('asst:theme', t); } catch { /* this visit only */ }
    if (t === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
    paintTheme();
  });
  paintTheme();
  main.querySelector('[data-signout]').onclick = async () => { await api('auth/signout', { method: 'POST' }).catch(() => {}); location.hash = '#/signin'; location.reload(); };
  main.querySelector('[data-signout-all]').onclick = async () => {
    if (!(await confirmSheet('Sign out everywhere?', 'Every phone and browser signed in to your assistant will need to sign in again.', { ok: 'Sign out everywhere', danger: true }))) return;
    await api('auth/signout-all', { method: 'POST' }).catch(() => {});
    location.hash = '#/signin'; location.reload();
  };
  main.querySelector('[data-install]').onclick = installHelp;
  main.querySelector('[data-report]').onclick = () => import('./beta.js').then(m => m.feedbackSheet());
  main.querySelector('[data-privacy]').onclick = () => sheet(`<h3 class="sheet-title">${icon('shield')} Privacy & permissions</h3>
    <ul class="bullets">
      <li>Google access is <b>read-only</b>. The assistant cannot send, edit, move or delete anything in Google.</li>
      <li>When you ask for something like “email Zach”, it prepares a draft card. Nothing happens until you confirm, and even then Gmail opens for you to press Send.</li>
      <li>Your Google tokens are encrypted on the server and never sent to this page.</li>
      <li>Your email and files stay in Google. Only what a question needs is read, when you ask it; the app keeps just titles and links of things it cited.</li>
      <li>You can switch any service off or disconnect Google entirely in Connections.</li>
    </ul>`, { label: 'Privacy' });
}

export function installHelp() {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  sheet(`<h3 class="sheet-title">Add to Home Screen</h3>
    ${ios ? `<ol class="bullets"><li>Tap the <b>Share</b> button in Safari.</li><li>Choose <b>Add to Home Screen</b>.</li><li>Open it from the icon — it runs full screen like an app.</li></ol>
      <p class="muted small">Sharing into the assistant from other apps: create an iOS Shortcut that opens<br><code>${esc(location.origin)}/assistant/?text=[Shortcut Input]</code><br>and turn on “Show in Share Sheet”.</p>`
      : `<ol class="bullets"><li>Open the browser menu.</li><li>Choose <b>Install app</b> or <b>Add to Home screen</b>.</li><li>Once installed, “Share → Assistant” sends links, text and photos straight into your Inbox.</li></ol>`}`, { label: 'Install' });
}

// ---------------- projects ----------------
export async function renderProjects(main) {
  main.innerHTML = `<header class="page-h"><button class="icon-btn" data-back aria-label="Back">${icon('back')}</button><h1>Projects</h1><div class="page-h-actions"><button class="icon-btn" data-add aria-label="New project">${icon('plus')}</button></div></header><div data-l>${skeleton(4)}</div>`;
  main.querySelector('[data-back]').onclick = () => go('#/more');
  const load = async () => {
    const r = await api('projects');
    state.boot.projects = r.projects;
    const groups = { business: 'Businesses', project: 'Projects', topic: 'Topics', area: 'Areas of life' };
    main.querySelector('[data-l]').innerHTML = Object.entries(groups).map(([k, label]) => {
      const ps = r.projects.filter(p => p.kind === k && p.status !== 'archived');
      return ps.length ? `<section class="sec">${sectionHead(label)}<div class="grid2">${ps.map(p => `<a class="card proj" href="#/project/${esc(p.id)}"><div class="proj-emoji">${esc(p.emoji || '📁')}</div><div class="ri-title">${esc(p.name)}</div><div class="ri-sub">${p.capture_count} item${p.capture_count === 1 ? '' : 's'}${p.last_capture_at ? ' · ' + esc(ago(p.last_capture_at)) : ''}</div></a>`).join('')}</div></section>` : '';
    }).join('') || emptyState('No projects yet', 'Create one, or just mention it when you capture.', 'folderOpen');
  };
  main.querySelector('[data-add]').onclick = () => projectForm(null, load);
  await load();
}

function projectForm(p, done) {
  const kinds = state.boot.projectKinds;
  const s = sheet(`<h3 class="sheet-title">${p ? 'Edit project' : 'New project'}</h3>
    <form class="form" data-f>
      <div class="row gap"><input name="emoji" class="emoji-in" maxlength="4" value="${esc(p ? p.emoji || '' : '')}" placeholder="📁" aria-label="Emoji"><input name="name" required value="${esc(p ? p.name : '')}" placeholder="Name" autofocus></div>
      <select name="kind">${kinds.map(k => `<option ${p && p.kind === k ? 'selected' : ''}>${k}</option>`).join('')}</select>
      <input name="aliases" value="${esc(p ? (p.aliases || []).join(', ') : '')}" placeholder="Also known as (comma separated)">
      <textarea name="description" rows="3" placeholder="What is it? (helps the assistant file things)">${esc(p ? p.description || '' : '')}</textarea>
      <div class="row gap end">${p ? '<button type="button" class="btn ghost danger-text" data-del>Delete</button><span class="grow"></span>' : ''}<button class="btn primary">${p ? 'Save' : 'Create'}</button></div>
    </form>`, { label: 'Project' });
  const f = s.el.querySelector('[data-f]');
  f.onsubmit = async e => {
    e.preventDefault();
    const b = Object.fromEntries(new FormData(f));
    b.aliases = b.aliases.split(',').map(x => x.trim()).filter(Boolean);
    try { await api(p ? 'project' : 'projects', { method: p ? 'PATCH' : 'POST', body: p ? Object.assign({ id: p.id }, b) : b }); s.close(); done && done(); }
    catch (err) { toast(err.message); }
  };
  const del = s.el.querySelector('[data-del]');
  if (del) del.onclick = async () => {
    if (!(await confirmSheet('Delete “' + p.name + '”?', 'Its captures stay in your Inbox — only the grouping is removed.', { ok: 'Delete', danger: true }))) return;
    await api('project', { method: 'DELETE', query: { id: p.id } }); s.close(); go('#/projects');
  };
}

export async function renderProject(main, params, id) {
  main.innerHTML = `<header class="page-h"><button class="icon-btn" data-back aria-label="Back">${icon('back')}</button></header>${skeleton(3)}`;
  main.querySelector('[data-back]').onclick = () => go('#/projects');
  let r;
  try { r = await api('project', { query: { id } }); } catch (e) { main.innerHTML += `<div class="card quiet">${esc(e.message)}</div>`; return; }
  const p = r.project;
  const byKind = { ideas: [], tasks: [], other: [] };
  r.items.forEach(c => (['idea', 'business_idea', 'product_idea', 'dream'].includes(c.kind) ? byKind.ideas : ['task', 'reminder'].includes(c.kind) ? byKind.tasks : byKind.other).push(c));
  main.innerHTML = `
    <header class="page-h"><button class="icon-btn" data-back aria-label="Back">${icon('back')}</button><div class="grow"></div>
      <button class="icon-btn" data-edit aria-label="Edit">${icon('note')}</button></header>
    <div class="proj-head"><div class="proj-emoji big">${esc(p.emoji || '📁')}</div><div><div class="eyebrow">${esc(p.kind)}</div><h1>${esc(p.name)}</h1>${p.description ? `<p class="muted">${esc(p.description)}</p>` : ''}</div></div>
    <button class="hero-btn" data-ask>${icon('sparkle')}<span><b>Ask about ${esc(p.name)}</b><small>Everything related — notes, email, files</small></span>${icon('chevron')}</button>
    ${r.memories.length ? `<section class="card sec">${sectionHead('What you’ve decided', 'brain')}${r.memories.map(m => `<div class="row-item"><div class="grow"><div class="ri-title">${esc(m.statement)}</div><div class="ri-sub">${esc(m.kind)} · ${esc(ago(m.created_at))}</div></div></div>`).join('')}</section>` : ''}
    ${(r.dreams || []).length ? `<section class="card sec">${sectionHead('In Dream Board', 'sparkle')}${r.dreams.map(g => dreamRow(g)).join('')}</section>` : ''}
    ${(r.people || []).length ? `<section class="sec">${sectionHead('People', 'person')}<div class="chips wrap">${r.people.map(x => `<a class="chip" href="#/person/${esc(x.id)}">${esc(x.display_name)}</a>`).join('')}</div></section>` : ''}
    ${byKind.ideas.length ? `<section class="sec">${sectionHead('Ideas', 'sparkle')}${byKind.ideas.map(c => captureCard(c)).join('')}</section>` : ''}
    ${byKind.tasks.length ? `<section class="sec">${sectionHead('Tasks', 'check')}${byKind.tasks.map(c => captureCard(c, { compact: true })).join('')}</section>` : ''}
    ${byKind.other.length ? `<section class="sec">${sectionHead('Notes & more', 'note')}${byKind.other.map(c => captureCard(c)).join('')}</section>` : ''}
    ${r.external.length ? `<section class="card sec">${sectionHead('Linked emails & files', 'link')}${r.external.map(e => sourceRow({ provider: e.provider, title: e.title, url: e.url, date: e.occurred_at }, { showId: false })).join('')}</section>` : ''}
    ${!r.items.length ? emptyState('Nothing here yet', 'Mention “' + p.name + '” when you capture and it will be filed here.', 'folderOpen') : ''}`;
  main.querySelector('[data-back]').onclick = () => go('#/projects');
  main.querySelector('[data-edit]').onclick = () => projectForm(p, () => renderProject(main, params, id));
  main.querySelector('[data-ask]').onclick = () => go('#/assistant', { ask: 'Show me everything related to ' + p.name + ' — ideas, decisions, emails and files.' });
}

// ---------------- people ----------------
export async function renderPeople(main) {
  main.innerHTML = `<header class="page-h"><button class="icon-btn" data-back aria-label="Back">${icon('back')}</button><h1>People</h1></header><div data-l>${skeleton(4)}</div>`;
  main.querySelector('[data-back]').onclick = () => go('#/more');
  const r = await api('people');
  main.querySelector('[data-l]').innerHTML = r.people.length ? `<div class="card">${r.people.map(p => `<a class="row-item" href="#/person/${esc(p.id)}"><div class="avatar">${esc(p.display_name[0])}</div><div class="grow"><div class="ri-title">${esc(p.display_name)}</div><div class="ri-sub">${esc([p.role, p.emails].filter(Boolean).join(' · '))}</div></div><span class="count">${p.mention_count}</span></a>`).join('')}</div>`
    : emptyState('No people yet', 'People you mention in captures appear here automatically.', 'person');
}

export async function renderPerson(main, params, id) {
  main.innerHTML = `<header class="page-h"><button class="icon-btn" data-back aria-label="Back">${icon('back')}</button></header>${skeleton(3)}`;
  main.querySelector('[data-back]').onclick = () => go('#/people');
  let r;
  try { r = await api('person', { query: { id } }); } catch (e) { main.innerHTML += `<div class="card quiet">${esc(e.message)}</div>`; return; }
  const p = r.person;
  const emails = p.identities.filter(i => i.provider === 'email').map(i => i.provider_id);
  main.innerHTML = `
    <header class="page-h"><button class="icon-btn" data-back aria-label="Back">${icon('back')}</button><div class="grow"></div><button class="icon-btn" data-edit aria-label="Edit">${icon('note')}</button></header>
    <div class="proj-head"><div class="avatar huge">${esc(p.display_name[0])}</div><div><h1>${esc(p.display_name)}</h1><p class="muted">${esc([p.role, emails.join(', ')].filter(Boolean).join(' · ') || 'Add an email so the assistant can find their messages and meetings.')}</p></div></div>
    <button class="hero-btn" data-ask>${icon('sparkle')}<span><b>Ask about ${esc(p.display_name.split(' ')[0])}</b><small>Emails, meetings, notes and follow-ups</small></span>${icon('chevron')}</button>
    <section class="card sec">${sectionHead('Upcoming meetings', 'calendar')}${r.meetings.items.length ? r.meetings.items.map(e => `<a class="row-item" href="${esc(e.url || '#')}" target="_blank" rel="noopener"><div class="time">${esc(when(e.meta.start))}</div><div class="grow"><div class="ri-title">${esc(e.title)}</div></div></a>`).join('') : (r.meetings.status === 'ok' ? '<div class="quiet">None in the next 30 days.</div>' : statusNote(r.meetings))}</section>
    <section class="card sec">${sectionHead('Recent emails', 'mail')}${r.emails.items.length ? r.emails.items.map(t => sourceRow({ provider: 'google_gmail', title: t.title, url: t.url, date: t.date }, { showId: false })).join('') : (r.emails.status === 'ok' ? '<div class="quiet">No recent email.</div>' : statusNote(r.emails))}</section>
    <section class="sec">${sectionHead('In your notes', 'note')}${r.items.length ? r.items.map(c => captureCard(c, { compact: true })).join('') : '<div class="quiet">Not mentioned yet.</div>'}</section>`;
  main.querySelector('[data-back]').onclick = () => go('#/people');
  main.querySelector('[data-ask]').onclick = () => go('#/assistant', { ask: 'What’s going on with ' + p.display_name + '? Recent emails, meetings, notes and open follow-ups.' });
  main.querySelector('[data-edit]').onclick = async () => {
    const all = (await api('people')).people.filter(x => x.id !== p.id);
    const s = sheet(`<h3 class="sheet-title">Edit ${esc(p.display_name)}</h3>
      <form class="form" data-f><input name="display_name" value="${esc(p.display_name)}" required><input name="role" value="${esc(p.role || '')}" placeholder="Role / company">
        <input name="emails" value="${esc(emails.join(', '))}" placeholder="Email addresses (comma separated)"><input name="aliases" value="${esc((p.aliases || []).join(', '))}" placeholder="Nicknames (comma separated)">
        <button class="btn primary">Save</button></form>
      ${all.length ? `<div class="sources-h mt">Same person as…</div><p class="muted small">Merging moves notes, emails and nicknames onto one person.</p><select data-merge><option value="">Choose someone to merge into</option>${all.map(x => `<option value="${esc(x.id)}">${esc(x.display_name)}</option>`).join('')}</select>` : ''}`, { label: 'Edit person' });
    s.el.querySelector('[data-f]').onsubmit = async e => {
      e.preventDefault();
      const b = Object.fromEntries(new FormData(e.target));
      await api('person', { method: 'PATCH', body: { id: p.id, display_name: b.display_name, role: b.role, emails: b.emails.split(',').map(x => x.trim()).filter(Boolean), aliases: b.aliases.split(',').map(x => x.trim()).filter(Boolean) } }).catch(err => toast(err.message));
      s.close(); renderPerson(main, params, id);
    };
    const m = s.el.querySelector('[data-merge]');
    if (m) m.onchange = async () => {
      if (!m.value) return;
      const into = all.find(x => x.id === m.value);
      if (!(await confirmSheet('Merge into ' + into.display_name + '?', p.display_name + ' becomes a nickname of ' + into.display_name + '.', { ok: 'Merge' }))) return;
      await api('people/merge', { method: 'POST', body: { from: p.id, into: into.id } });
      s.close(); go('#/person/' + into.id);
    };
  };
}

// ---------------- memory ----------------
export async function renderMemory(main) {
  main.innerHTML = `<header class="page-h"><button class="icon-btn" data-back aria-label="Back">${icon('back')}</button><h1>Memory</h1><div class="page-h-actions"><button class="icon-btn" data-add aria-label="Add">${icon('plus')}</button></div></header>
    <p class="muted">What your assistant knows because you told it — decisions, preferences, goals and facts. Each one links back to where it came from.</p><div data-l>${skeleton(3)}</div>`;
  main.querySelector('[data-back]').onclick = () => go('#/more');
  const load = async () => {
    const r = await api('memory');
    const kinds = state.boot.memoryKinds;
    main.querySelector('[data-l]').innerHTML = r.memories.length ? kinds.map(k => {
      const ms = r.memories.filter(m => m.kind === k);
      return ms.length ? `<section class="card sec">${sectionHead(k[0].toUpperCase() + k.slice(1) + 's', 'brain')}${ms.map(m => `<div class="row-item mem" data-id="${esc(m.id)}"><div class="grow"><div class="ri-title">${esc(m.statement)}</div><div class="ri-sub">${esc([m.project_name, ago(m.created_at), m.origin === 'extracted' ? 'taken from a capture' : m.origin === 'conversation' ? 'you asked me to remember' : m.origin === 'inferred' ? 'my inference' : 'you told me'].filter(Boolean).join(' · '))}</div></div>
        ${m.source_type === 'capture' && m.source_id ? `<a class="icon-btn" href="#/item/${esc(m.source_id)}" aria-label="Source">${icon('link')}</a>` : ''}<button class="icon-btn" data-edit aria-label="Edit">${icon('note')}</button><button class="icon-btn" data-arch aria-label="Forget">${icon('x')}</button></div>`).join('')}</section>` : '';
    }).join('') : emptyState('Nothing remembered yet', 'Say “remember that…” when you capture or chat, and it will be kept here.', 'brain');
    main.querySelectorAll('.mem').forEach(row => {
      const m = r.memories.find(x => x.id === row.dataset.id);
      row.querySelector('[data-arch]').onclick = async () => { if (await confirmSheet('Forget this?', m.statement, { ok: 'Forget' })) { await api('memory', { method: 'DELETE', query: { id: m.id } }); load(); } };
      row.querySelector('[data-edit]').onclick = () => {
        const s = sheet(`<h3 class="sheet-title">Update memory</h3><p class="muted small">The old version is kept in history.</p><form class="form" data-f><textarea name="statement" rows="3">${esc(m.statement)}</textarea><button class="btn primary">Save</button></form>`);
        s.el.querySelector('[data-f]').onsubmit = async e => { e.preventDefault(); await api('memory', { method: 'PATCH', body: { id: m.id, statement: new FormData(e.target).get('statement') } }); s.close(); load(); };
      };
    });
  };
  main.querySelector('[data-add]').onclick = () => {
    const s = sheet(`<h3 class="sheet-title">Remember something</h3><form class="form" data-f><textarea name="statement" rows="3" placeholder="e.g. Service-call minimum is $95 as of 2026" autofocus required></textarea>
      <select name="kind">${state.boot.memoryKinds.map(k => `<option>${k}</option>`).join('')}</select><button class="btn primary">Remember</button></form>`);
    s.el.querySelector('[data-f]').onsubmit = async e => { e.preventDefault(); await api('memory', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); s.close(); load(); };
  };
  await load();
}

// ---------------- connections ----------------
const CAP_MARK = { yes: ['check', 'ok', ''], confirm: ['shield', 'ok', ' (you confirm)'], future: ['clock', 'dim', ' — later'], no: ['x', 'no', ' — off'] };
function capList(caps) {
  return `<div class="abilities">${(caps || []).map(c => { const [ic, cls, note] = CAP_MARK[c.value] || CAP_MARK.no; return `<span class="ability ${cls}">${icon(ic)}${esc(c.label + note)}</span>`; }).join('')}</div>`;
}

function appCard(a) {
  const f = a.freshness || {};
  const q = a.queue || {};
  const waiting = (q.queued || 0) + (q.waiting || 0) + (q.routing || 0);
  const paired = a.status === 'connected' || f.state === 'disconnected' || a.records;
  return `<section class="card sec" data-app="${esc(a.key)}">
    <div class="conn-h"><div class="g-logo" aria-hidden="true">${icon('sparkle')}</div><div class="grow"><div class="ri-title">${esc(a.label)}</div>
      <div class="ri-sub">${esc(freshLine(f))}${a.instanceLabel ? ' · ' + esc(a.instanceLabel) : ''}${a.records ? ' · ' + a.records + ' dreams known' : ''}</div></div>
      ${f.state === 'stale' || f.state === 'disconnected' ? '<span class="pill warn">Check</span>' : ''}</div>
    ${capList(a.capabilities)}
    ${waiting || q.needs_choice ? `<div class="status-note">${waiting ? waiting + ' waiting to reach ' + esc(a.label) : ''}${waiting && q.needs_choice ? ' · ' : ''}${q.needs_choice ? q.needs_choice + ' need you to pick a dream' : ''}</div>` : ''}
    ${a.lastError ? `<div class="status-note">Last problem: ${esc(a.lastError)}</div>` : ''}
    <div data-code></div>
    <label class="field mt"><span>Address you open it at</span><input data-base placeholder="https://your-pc.tailnet.ts.net" value="${esc(a.baseUrl || '')}"></label>
    <div class="row gap wrap mt">
      <button class="btn small primary" data-pair>${a.status === 'connected' ? 'Pair again' : 'Connect'}</button>
      ${a.status === 'connected' ? '<button class="btn small ghost" data-disc>Disconnect</button>' : ''}
      ${paired ? '<button class="btn small ghost danger-text" data-forget>Forget its data</button>' : ''}
    </div>
    <p class="muted small">${esc(a.label)} keeps its own data. The assistant keeps a searchable copy of titles, status, amounts and milestones, and your captures that went there.</p>
  </section>`;
}

function bindApp(el, a, reload) {
  el.querySelector('[data-pair]').onclick = async () => {
    if (a.status === 'connected' && !(await confirmSheet('Pair again?', 'The current connection stops working until you enter the new code in ' + a.label + '.', { ok: 'Make a new code' }))) return;
    const r = await api('apps/pair', { method: 'POST', body: { app: a.key } });
    el.querySelector('[data-code]').innerHTML = `<div class="pair-code"><div class="muted small">Enter this code in ${esc(a.label)} → Settings → Personal Assistant</div><b>${esc(r.code)}</b><div class="muted small">Works once, for ${r.expiresInMinutes} minutes.</div></div>`;
  };
  const disc = el.querySelector('[data-disc]');
  if (disc) disc.onclick = async () => {
    if (!(await confirmSheet('Disconnect ' + a.label + '?', 'It stops syncing. What’s waiting stays queued, and what the assistant knows is kept (marked as out of date).', { ok: 'Disconnect', danger: true }))) return;
    await api('apps/disconnect', { method: 'POST', body: { app: a.key } }); reload();
  };
  const forget = el.querySelector('[data-forget]');
  if (forget) forget.onclick = async () => {
    if (!(await confirmSheet('Forget ' + a.label + ' data?', 'The assistant drops its copy of your dreams and their history, and cancels anything not yet sent. Your captures stay. Nothing in ' + a.label + ' is touched.', { ok: 'Forget', danger: true }))) return;
    await api('apps/forget', { method: 'POST', body: { app: a.key, confirm: 'forget' } }); reload();
  };
  el.querySelector('[data-base]').onchange = async e => {
    try { await api('apps/base-url', { method: 'POST', body: { app: a.key, url: e.target.value } }); toast('Saved.', { tone: 'ok' }); } catch (err) { toast(err.message); }
  };
}

const STATE_LABEL = { connected: 'Connected', not_connected: 'Not connected', not_granted: 'Not connected', disabled: 'Switched off', reconnect: 'Reconnect needed' };

export async function renderConnections(main, params) {
  main.innerHTML = `<header class="page-h"><button class="icon-btn" data-back aria-label="Back">${icon('back')}</button><h1>Connections</h1></header><div data-l>${skeleton(4)}</div>`;
  main.querySelector('[data-back]').onclick = () => go('#/more');
  if (params.get('missing')) toast('Google did not grant: ' + params.get('missing') + '. Tap Connect and leave those boxes ticked.', { ms: 7000 });
  else if (params.get('connected')) toast('Connected.', { tone: 'ok' });
  const load = async () => {
    const r = await api('connections');
    const g = r.google;
    const missing = r.services.filter(s => s.state === 'not_granted' || s.state === 'not_connected').map(s => s.key);
    main.querySelector('[data-l]').innerHTML = `
      <section class="card sec conn-google">
        <div class="conn-h"><div class="g-logo" aria-hidden="true">G</div><div class="grow"><div class="ri-title">Google</div><div class="ri-sub">${g ? esc(g.email) + (g.lastUsedAt ? ' · used ' + esc(ago(g.lastUsedAt)) : '') : 'Not connected'}</div></div>
          ${g && g.status !== 'connected' ? '<span class="pill warn">Reconnect</span>' : ''}</div>
        ${g && g.detail ? `<div class="status-note">${esc(g.detail)}</div>` : ''}
        ${r.services.map(s => `<div class="svc" data-svc="${esc(s.key)}">
          <div class="svc-h">${icon(s.icon)}<div class="grow"><div class="ri-title">${esc(s.label)}</div><div class="ri-sub state-${esc(s.state)}">${esc(STATE_LABEL[s.state] || s.state)}${s.state === 'connected' ? ' · read-only' : ''}</div></div>
            ${s.state === 'connected' || s.state === 'disabled' ? `<label class="switch" aria-label="${esc(s.label)} on/off"><input type="checkbox" data-toggle ${s.state === 'connected' ? 'checked' : ''}><span></span></label>`
              : `<a class="btn small primary" href="${authUrl('connect', [s.key])}">${s.state === 'reconnect' ? 'Reconnect' : 'Connect'}</a>`}</div>
          ${capList(s.capabilities)}
          <details class="svc-perm"><summary>What it can access</summary>
            <div class="perm-cols"><div><div class="perm-h ok">Can</div><ul>${s.can.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div><div><div class="perm-h no">Cannot</div><ul>${s.cannot.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div></div>
            ${s.note ? `<p class="muted small">${esc(s.note)}</p>` : ''}<p class="muted small mono">${s.scopes.map(esc).join('<br>')}</p></details>
        </div>`).join('')}
        ${missing.length > 1 ? `<a class="btn wide primary mt" href="${authUrl('connect', missing)}">Connect all (${missing.length})</a>` : ''}
        ${g ? '<button class="btn wide ghost danger-text mt" data-disconnect>Disconnect Google</button>' : ''}
      </section>
      ${r.apps.map(appCard).join('')}
      <section class="sec">${sectionHead('Coming later', 'bolt')}<div class="card">${r.planned.map(p => `<div class="row-item dim"><div class="grow"><div class="ri-title">${esc(p.label)}</div></div><span class="pill">Planned</span></div>`).join('')}</div></section>`;
    main.querySelectorAll('[data-app]').forEach(el => bindApp(el, r.apps.find(a => a.key === el.dataset.app), load));
    main.querySelectorAll('[data-toggle]').forEach(t => t.onchange = async () => {
      const key = t.closest('[data-svc]').dataset.svc;
      try { await api('connections/service', { method: 'POST', body: { service: key, enabled: t.checked } }); load(); } catch (e) { toast(e.message); t.checked = !t.checked; }
    });
    const d = main.querySelector('[data-disconnect]');
    if (d) d.onclick = async () => {
      if (!(await confirmSheet('Disconnect Google?', 'The assistant loses access to Gmail, Calendar, Drive, Sheets and Contacts, and Google revokes its permission. Your captures are not affected.', { ok: 'Disconnect', danger: true }))) return;
      const res = await api('connections/disconnect', { method: 'POST' });
      toast(res.revokedAtGoogle ? 'Disconnected and revoked at Google.' : 'Disconnected. (Google did not confirm the revoke — you can also remove access at myaccount.google.com.)', { ms: 6000 });
      load();
    };
  };
  try { await load(); } catch (e) { main.querySelector('[data-l]').innerHTML = `<div class="card quiet">${esc(e.message)}</div>`; }
}
