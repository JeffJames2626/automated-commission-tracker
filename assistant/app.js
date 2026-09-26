import { api, onSignedOut, authUrl, TZ } from './api.js';
import { esc, icon, closeAllSheets, cacheGet, cacheSet, toast } from './ui.js';
import { state } from './state.js';
import * as outbox from './outbox.js';
import { openCaptureSheet } from './capture.js';

// App shell: boot, hash router, bottom tabs (phone) / rail + context panel
// (desktop), offline indicator, share-target intake.

const TABS = [
  { key: 'today', label: 'Today', icon: 'today', href: '#/today' },
  { key: 'inbox', label: 'Inbox', icon: 'inbox', href: '#/inbox' },
  { key: 'assistant', label: 'Assistant', icon: 'sparkle', href: '#/assistant' },
  { key: 'dreams', label: 'Dreams', icon: 'star', href: '#/dreams' },
  { key: 'search', label: 'Search', icon: 'search', href: '#/search' },
  { key: 'more', label: 'More', icon: 'more', href: '#/more' },
];
const TAB_OF = { item: 'inbox', dream: 'dreams', project: 'more', projects: 'more', people: 'more', person: 'more', memory: 'more', connections: 'more', review: 'more', about: 'more', link: 'more' };

const ROUTES = {
  today: () => import('./views/today.js').then(m => m.render),
  inbox: () => import('./views/inbox.js').then(m => m.render),
  item: () => import('./views/item.js').then(m => m.render),
  dream: () => import('./views/dreams.js').then(m => m.render),
  dreams: () => import('./views/dreams.js').then(m => m.renderList),
  assistant: () => import('./views/chat.js').then(m => m.render),
  search: () => import('./views/search.js').then(m => m.render),
  more: () => import('./views/more.js').then(m => m.renderMore),
  projects: () => import('./views/more.js').then(m => m.renderProjects),
  project: () => import('./views/more.js').then(m => m.renderProject),
  people: () => import('./views/more.js').then(m => m.renderPeople),
  person: () => import('./views/more.js').then(m => m.renderPerson),
  memory: () => import('./views/more.js').then(m => m.renderMemory),
  connections: () => import('./views/more.js').then(m => m.renderConnections),
  review: () => import('./views/beta.js').then(m => m.renderReview),
  about: () => import('./views/beta.js').then(m => m.renderAbout),
  link: () => import('./views/link.js').then(m => m.renderLink),
};

const main = document.getElementById('main');
const ctxEl = document.getElementById('context');
let cleanup = null, routeSeq = 0;

function shell() {
  const nav = TABS.map(t => `<a href="${t.href}" data-tab="${t.key}">${icon(t.icon)}<span>${t.label}</span></a>`).join('');
  document.getElementById('tabbar').innerHTML = nav;
  document.getElementById('rail').innerHTML = `<div class="brand"><img src="icons/icon.svg" alt="" width="28" height="28"><span>Assistant</span></div>
    <button class="btn primary wide rail-capture" data-capture>${icon('plus')} Capture</button>${nav}
    <div class="grow"></div><a href="#/connections" class="rail-foot">${icon('link')}<span>Connections</span></a>`;
  document.querySelectorAll('[data-capture], #fab').forEach(b => b.onclick = () => openCaptureSheet());
}

function setActive(tab) {
  document.querySelectorAll('[data-tab]').forEach(a => { const on = a.dataset.tab === tab; a.classList.toggle('on', on); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  document.getElementById('fab').hidden = ['assistant', 'today'].includes(tab) || /^#\/item\//.test(location.hash);
}

function renderContext() {
  if (!ctxEl) return;
  ctxEl.innerHTML = state.context ? state.context() : `<div class="ctx-empty"><div class="ctx-h">Quick capture</div><p class="muted small">Press <kbd>N</kbd> anywhere to capture. <kbd>/</kbd> to search.</p></div>`;
}
document.addEventListener('asst:context', renderContext);

async function route() {
  const seq = ++routeSeq;
  const raw = location.hash.replace(/^#\/?/, '') || 'today';
  const [path, qs] = raw.split('?');
  const [name, id] = path.split('/');
  const params = new URLSearchParams(qs || '');
  if (name === 'signin') return renderSignin(params);
  if (!state.boot) { if (signedOut) toSignin(); return; }
  const loader = ROUTES[name] || ROUTES.today;
  if (cleanup) { try { cleanup(); } catch { /* view already gone */ } cleanup = null; }
  closeAllSheets();
  state.context = null;
  setActive(TAB_OF[name] || name);
  main.scrollTop = 0; window.scrollTo(0, 0);
  main.className = 'main view-' + name;
  const render = await loader();
  if (seq !== routeSeq) return;
  main.innerHTML = '';
  renderContext();
  try { cleanup = (await render(main, params, id ? decodeURIComponent(id) : null)) || null; }
  catch (e) {
    if (e.status === 401) return;
    main.innerHTML = `<div class="card quiet">${esc(e.offline ? 'You’re offline. Captures still work and will sync later.' : 'Could not load this screen: ' + e.message)}</div>`;
  }
}

// Signed out, or not allowed: nothing about what is inside. A person who is
// not on the allow-list sees only that this assistant is private.
const PRIVATE = 'This Personal Assistant is private.';
function renderSignin(params) {
  document.body.classList.add('signed-out');
  const err = params.get('error');
  const next = /^#\/[a-z]+/.test(params.get('next') || '') ? params.get('next') : '';
  main.className = 'main view-signin';
  if (err === PRIVATE) {
    main.innerHTML = `<div class="signin"><img class="signin-logo" src="icons/icon.svg" alt="" width="72" height="72">
      <h1>${esc(PRIVATE)}</h1><a class="muted small" href="${authUrl('signin', [], next)}">Use a different Google account</a></div>`;
    return;
  }
  main.innerHTML = `<div class="signin">
    <img class="signin-logo" src="icons/icon.svg" alt="" width="72" height="72">
    <h1>Personal Assistant</h1>
    <p class="muted">Private. Sign in to continue.</p>
    ${err ? `<div class="card bad-card">${esc(err)}</div>` : ''}
    <a class="btn primary big" href="${authUrl('signin', [], next)}">${gLogo()} Continue with Google</a>
  </div>`;
}

// Signed out: go to sign-in, and come back to the same screen afterwards
// (e.g. a Dream Board link request opened from the board).
let signedOut = false;
function toSignin() {
  const here = location.hash;
  if (here.startsWith('#/signin')) return;
  location.hash = '#/signin' + (/^#\/(link|item|dream|project|person)\b/.test(here) ? '?next=' + encodeURIComponent(here) : '');
}

// A small, quiet marker on anything that is not production (DEV · abc1234).
function envBadge() {
  const b = state.boot && state.boot.build;
  let el = document.getElementById('envbadge');
  if (!b || b.env === 'production') { if (el) el.remove(); return; }
  if (!el) { el = document.createElement('a'); el.id = 'envbadge'; el.className = 'env-badge'; el.href = '#/about'; document.body.appendChild(el); }
  el.textContent = (b.env === 'development' ? 'DEV' : b.env === 'local' ? 'LOCAL' : String(b.env || 'test').toUpperCase()) + (b.sha && b.sha !== 'local' ? ' · ' + b.sha : '');
  el.title = 'About this build';
}

// Anything saved while AI filing was down (or offline) is gone through again.
let lastReprocess = 0;
function reprocessSoon() {
  if (Date.now() - lastReprocess < 60000 || !state.boot || state.boot.offline) return;
  lastReprocess = Date.now();
  setTimeout(() => api('reprocess', { method: 'POST' }).catch(() => {}), 4000);
}
const gLogo = () => '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';

function netPill(items) {
  const el = document.getElementById('net');
  const pending = (items || []).length;
  const failed = (items || []).filter(i => i.error).length;
  const off = !navigator.onLine;
  el.hidden = !off && !pending;
  el.className = 'net-pill' + (failed ? ' bad' : '');
  el.innerHTML = off ? `${icon('clock')} Offline${pending ? ' · ' + pending + ' saved on phone' : ''}` : failed ? `${failed} capture${failed > 1 ? 's' : ''} need attention` : `${icon('refresh')} Syncing ${pending}…`;
  el.onclick = () => { location.hash = '#/inbox'; };
}

// Share target (Android) and ?text= links (iOS Shortcuts) → capture sheet.
function sharedPayload() {
  const p = new URLSearchParams(location.search);
  const text = [p.get('title'), p.get('text'), p.get('url')].filter(Boolean).join('\n').trim();
  if (!text && p.get('capture')) { history.replaceState(null, '', location.pathname + location.hash); return {}; }
  if (!text) return null;
  history.replaceState(null, '', location.pathname + location.hash);
  return { text, sourceType: p.get('url') || /^https?:\/\//.test(text) ? 'link' : 'share' };
}

async function boot() {
  shell();
  onSignedOut(() => { signedOut = true; state.boot = null; cacheSet('boot', null); toSignin(); });
  window.addEventListener('hashchange', route);
  window.addEventListener('online', () => { netPill(); reprocessSoon(); });
  window.addEventListener('offline', () => outbox.all().then(netPill));
  outbox.subscribe(netPill);
  outbox.all().then(netPill);
  const shared = sharedPayload();
  const sp = new URLSearchParams(location.hash.split('?')[1] || '');
  if (location.hash.startsWith('#/signin') && !sp.get('error')) location.hash = sp.get('next') && /^#\/[a-z]+/.test(sp.get('next')) ? sp.get('next') : '#/today';
  try {
    state.boot = await api('bootstrap');
    cacheSet('boot', state.boot);
  } catch (e) {
    if (e.status === 401) { route(); return; }
    // Offline or server trouble: run from the last known state so capture works.
    state.boot = cacheGet('boot');
    if (!state.boot) {
      state.boot = { user: { name: '', email: '' }, projects: [], kinds: {}, statuses: {}, projectKinds: [], memoryKinds: [], ai: false, offline: true };
    }
    toast(e.offline ? 'Offline — captures are saved on this phone.' : 'The server is not answering right now — captures are saved on this phone.', { ms: 5000 });
  }
  document.body.classList.remove('signed-out');
  envBadge();
  reprocessSoon();
  outbox.startAutoFlush();
  if (!location.hash || location.hash === '#/' || location.hash.startsWith('#/signin')) location.hash = '#/today';
  await route();
  if (shared) openCaptureSheet(shared);
  // Keyboard: N to capture, / to search (desktop).
  document.addEventListener('keydown', e => {
    if (e.target.closest('input, textarea, [contenteditable="true"], select') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'n') { e.preventDefault(); openCaptureSheet(); }
    if (e.key === '/') { e.preventDefault(); location.hash = '#/search'; }
  });
  if (state.boot.user && state.boot.user.tz !== TZ) api('settings', { method: 'POST', body: { tz: TZ } }).catch(() => {});
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => {}));
}
boot();
