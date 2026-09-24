// Small UI toolkit: escaping, icons, markdown-lite, sheets, toasts, dates.
// Everything user- or Google-supplied goes through esc() before it touches
// innerHTML.

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const P = {
  today: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z"/>',
  sparkle: '<path d="M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z"/><path d="M19 3v4M21 5h-4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.5"/>',
  clip: '<path d="m21 11-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  paste: '<rect x="8" y="3" width="8" height="4" rx="1"/><path d="M16 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2"/>',
  send: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  back: '<path d="m15 6-6 6 6 6"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  note: '<path d="M6 3h9l5 5v13H6z"/><path d="M14 3v6h6M9 13h7M9 17h5"/>',
  brain: '<path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 3 3h1V4z"/><path d="M15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-3 3h-1V4z"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
  folderOpen: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v1H7l-4 9z"/><path d="M7 10h14l-3 9H3"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/>',
  play: '<path d="M7 4v16l13-8z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  logout: '<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 16l4-4-4-4M14 12H4"/>',
};

export function icon(name, cls = '') {
  return `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
}

// Where a piece of information came from — the chip shown on every source.
export const PROVIDER = {
  notes: { icon: 'note', label: 'My notes' },
  memory: { icon: 'brain', label: 'Memory' },
  google_gmail: { icon: 'mail', label: 'Email' },
  google_calendar: { icon: 'calendar', label: 'Calendar' },
  google_drive: { icon: 'folder', label: 'Drive' },
  google_sheets: { icon: 'table', label: 'Sheets' },
  google_contacts: { icon: 'person', label: 'Contacts' },
  project: { icon: 'folderOpen', label: 'Project' },
  person: { icon: 'person', label: 'Person' },
};

// ---- dates ----
export function ago(d) {
  const t = Date.parse(d);
  if (isNaN(t)) return '';
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 86400 * 7) return Math.floor(s / 86400) + 'd ago';
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}
export function when(d, opts = {}) {
  const t = Date.parse(d);
  if (isNaN(t)) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(d))) return new Date(d + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  return new Date(t).toLocaleString(undefined, Object.assign({ weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }, opts));
}
export function timeOnly(d) {
  const t = Date.parse(d);
  return isNaN(t) ? '' : new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
export function sameDay(a, b) { return new Date(a).toDateString() === new Date(b).toDateString(); }

// ---- markdown-lite for assistant answers ----
// Escapes first, then adds a handful of safe constructs: **bold**, *italic*,
// `code`, bullets, numbered lists, links (http/https only) and [S#] citations.
export function md(text, { cite } = {}) {
  const lines = esc(text).split('\n');
  const out = [];
  let list = null;
  const inline = s => s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>')
    .replace(/(https?:\/\/[^\s<)]+[^\s<).,!?:;'"])/g, u => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u.replace(/^https?:\/\/(www\.)?/, '').slice(0, 48)}</a>`)
    .replace(/\[(S\d+)\]/g, (m, id) => cite ? cite(id) : '');
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of lines) {
    const l = raw.trimEnd();
    let m;
    if ((m = l.match(/^\s*[-•*]\s+(.*)$/))) { if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul'; } out.push('<li>' + inline(m[1]) + '</li>'); continue; }
    if ((m = l.match(/^\s*\d+[.)]\s+(.*)$/))) { if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol'; } out.push('<li>' + inline(m[1]) + '</li>'); continue; }
    close();
    if (!l.trim()) { out.push(''); continue; }
    if ((m = l.match(/^#{1,4}\s+(.*)$/))) { out.push('<h4>' + inline(m[1]) + '</h4>'); continue; }
    out.push('<p>' + inline(l) + '</p>');
  }
  close();
  return out.join('');
}

// ---- toasts ----
export function toast(msg, { action, onAction, ms = 3800, tone = '' } = {}) {
  const host = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = 'toast ' + tone;
  el.setAttribute('role', 'status');
  el.innerHTML = `<span>${esc(msg)}</span>` + (action ? `<button class="toast-btn">${esc(action)}</button>` : '');
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add('in'));
  const kill = () => { el.classList.remove('in'); setTimeout(() => el.remove(), 250); };
  if (action) el.querySelector('button').onclick = () => { kill(); onAction && onAction(); };
  setTimeout(kill, ms);
}

// ---- bottom sheet ----
let sheetStack = [];
export function sheet(html, { onClose, tall = false, label = 'Dialog' } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'sheet-wrap';
  wrap.innerHTML = `<div class="sheet-backdrop"></div><section class="sheet ${tall ? 'tall' : ''}" role="dialog" aria-modal="true" aria-label="${esc(label)}"><div class="sheet-grip"></div><div class="sheet-body">${html}</div></section>`;
  document.body.appendChild(wrap);
  const prevFocus = document.activeElement;
  requestAnimationFrame(() => wrap.classList.add('in'));
  const close = () => {
    if (!wrap.isConnected) return;
    wrap.classList.remove('in');
    sheetStack = sheetStack.filter(s => s !== api);
    setTimeout(() => wrap.remove(), 260);
    onClose && onClose();
    if (prevFocus && prevFocus.focus) prevFocus.focus();
  };
  wrap.querySelector('.sheet-backdrop').onclick = close;
  const api = { el: wrap.querySelector('.sheet-body'), close };
  sheetStack.push(api);
  setTimeout(() => { const f = wrap.querySelector('[autofocus], input, textarea, button'); if (f) f.focus({ preventScroll: true }); }, 60);
  return api;
}
document.addEventListener('keydown', e => { if (e.key === 'Escape' && sheetStack.length) sheetStack[sheetStack.length - 1].close(); });
export function closeAllSheets() { [...sheetStack].forEach(s => s.close()); }

export function confirmSheet(title, body, { ok = 'Confirm', danger = false } = {}) {
  return new Promise(resolve => {
    let done = false;
    const s = sheet(`<h3 class="sheet-title">${esc(title)}</h3><p class="muted">${esc(body)}</p>
      <div class="row gap end mt"><button class="btn ghost" data-no>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-yes>${esc(ok)}</button></div>`,
      { onClose: () => { if (!done) resolve(false); } });
    s.el.querySelector('[data-no]').onclick = () => { done = true; resolve(false); s.close(); };
    s.el.querySelector('[data-yes]').onclick = () => { done = true; resolve(true); s.close(); };
  });
}

export function skeleton(n = 3) {
  return Array.from({ length: n }, () => '<div class="card skel"><div class="skel-line w60"></div><div class="skel-line w90"></div><div class="skel-line w40"></div></div>').join('');
}

export function emptyState(title, body, iconName = 'sparkle') {
  return `<div class="empty">${icon(iconName, 'big')}<h3>${esc(title)}</h3><p>${esc(body)}</p></div>`;
}

// Session-local cache for offline reads (per viewer, best effort).
export function cacheGet(k) { try { return JSON.parse(localStorage.getItem('asst:' + k) || 'null'); } catch { return null; } }
export function cacheSet(k, v) { try { localStorage.setItem('asst:' + k, JSON.stringify(v)); } catch { /* storage full or blocked */ } }
