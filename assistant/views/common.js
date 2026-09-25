import { esc, icon, ago, when, PROVIDER, sheet } from '../ui.js';
import { kindEmoji, kindLabel } from '../state.js';

// Pieces shared by several screens: capture cards, source chips, the
// evidence ("why did you say that?") sheet, and status notes for sources.

export function captureCard(c, { compact = false } = {}) {
  const pending = c.classification_state === 'pending';
  const body = c.summary || c.raw_preview || '';
  const due = c.due_at ? `<span class="pill ${Date.parse(c.due_at) < Date.now() && !c.completed_at ? 'warn' : ''}">${icon('clock')}${esc(when(c.due_at))}</span>` : '';
  return `<a class="card cap ${c.completed_at ? 'done' : ''}" href="#/item/${esc(c.id)}">
    <div class="cap-kind" aria-hidden="true">${kindEmoji(c.kind)}</div>
    <div class="cap-main">
      <div class="cap-title">${esc(c.title || 'Untitled')}</div>
      ${!compact && body && body !== c.title ? `<div class="cap-body">${esc(body)}</div>` : ''}
      <div class="cap-meta">
        <span>${esc(kindLabel(c.kind))}</span>
        ${c.project_name ? `<span class="pill">${esc(c.project_emoji || '')} ${esc(c.project_name)}</span>` : ''}
        ${due}
        ${c.attachment_count ? `<span>${icon('clip')}${c.attachment_count}</span>` : ''}
        ${pending ? '<span class="sorting">sorting…</span>' : ''}
        ${c.route_status === 'needs_choice' ? `<span class="pill warn">${icon('sparkle')} Which dream?</span>` : c.route_status ? `<span class="pill">${icon('clock')} Going to Dream Board</span>` : c.status === 'filed' ? `<span class="pill ok">${icon('sparkle')} Dream Board</span>` : ''}
        <span class="grow"></span><span>${esc(ago(c.captured_at))}</span>
      </div>
    </div>
  </a>`;
}

export function providerOf(p) { return PROVIDER[p] || { icon: 'note', label: p }; }

// A citation chip inside an answer: tapping opens that source.
export function citeChip(src) {
  if (!src) return '';
  const pv = providerOf(src.provider);
  return `<button class="cite" data-src="${esc(src.id)}" title="${esc(pv.label + ': ' + src.title)}">${icon(pv.icon)}<span>${esc(src.id.replace('S', ''))}</span></button>`;
}

export function sourceRow(src, { showId = true } = {}) {
  const pv = providerOf(src.provider);
  const internal = src.url && src.url.startsWith('#');
  const href = src.url ? esc(src.url) : null;
  const inner = `${icon(pv.icon, 'src-ic')}<div class="src-main"><div class="src-title">${esc(src.title)}</div>
    <div class="src-meta">${showId && src.id ? `<b>${esc(src.id)}</b> · ` : ''}${esc(src.label || pv.label)}${src.date ? ' · ' + esc(when(src.date, { hour: undefined, minute: undefined })) : ''}</div></div>
    ${href && !internal ? icon('external', 'src-go') : icon('chevron', 'src-go')}`;
  return href
    ? `<a class="src" href="${href}" ${internal ? '' : 'target="_blank" rel="noopener noreferrer"'}>${inner}</a>`
    : `<div class="src">${inner}</div>`;
}

export function sourcesBlock(sources, { title = 'Sources' } = {}) {
  const cited = (sources || []).filter(s => s.cited !== false);
  if (!cited.length) return '';
  return `<div class="sources"><div class="sources-h">${esc(title)}</div>${cited.map(s => sourceRow(s)).join('')}</div>`;
}

// "Why did you say that?" — the cited sources with the exact text the
// assistant saw, plus every search it ran.
export function evidenceSheet(msg) {
  const cited = (msg.sources || []).filter(s => s.cited);
  const other = (msg.sources || []).filter(s => !s.cited);
  const trace = msg.trace || [];
  const traceLine = t => {
    const input = Object.entries(t.input || {}).filter(([, v]) => v !== '' && v != null).map(([k, v]) => k + ': ' + (Array.isArray(v) ? v.join(', ') : v)).join(' · ');
    return `<li><b>${esc(t.tool.replace(/_/g, ' '))}</b> ${input ? '<span class="muted">' + esc(input) + '</span>' : ''} — ${t.error ? '<span class="bad">' + esc(t.error) + '</span>' : esc(String(t.count)) + ' found'}</li>`;
  };
  sheet(`<h3 class="sheet-title">Why I said that</h3>
    ${cited.length ? cited.map(s => `<div class="evidence">${sourceRow(s)}${(s.evidence || []).length ? `<blockquote>${s.evidence.map(e => esc(e)).join('<br><br>')}</blockquote>` : (s.snippet ? `<blockquote>${esc(s.snippet)}</blockquote>` : '')}</div>`).join('')
      : '<p class="muted">This answer did not rely on any connected source.</p>'}
    ${trace.length ? `<div class="sources-h mt">What I searched</div><ul class="trace">${trace.map(traceLine).join('')}</ul>` : ''}
    ${other.length ? `<details class="mt"><summary class="muted">Also looked at ${other.length} other result${other.length > 1 ? 's' : ''}</summary>${other.map(s => sourceRow(s)).join('')}</details>` : ''}
    ${msg.model ? `<p class="muted small mt">Answered by ${esc(msg.model)}.</p>` : '<p class="muted small mt">No AI was used for this answer — these are plain search results.</p>'}`,
  { tall: true, label: 'Evidence' });
}

const STATUS_TEXT = {
  not_connected: 'Not connected',
  not_granted: 'Permission not granted',
  disabled: 'Switched off',
  reconnect: 'Needs reconnecting',
  no_email: 'No email address on file',
  error: 'Unavailable right now',
};

export function statusNote(group, key) {
  const st = group.status;
  if (st === 'ok') return '';
  const connectable = ['not_connected', 'not_granted', 'reconnect'].includes(st);
  return `<div class="status-note">${esc(group.message || STATUS_TEXT[st] || st)}${connectable ? ` · <a href="#/connections">${st === 'reconnect' ? 'Reconnect' : 'Connect'}</a>` : ''}</div>`;
}

export function sectionHead(title, iconName, extra = '') {
  return `<div class="sec-h">${iconName ? icon(iconName) : ''}<span>${esc(title)}</span>${extra}</div>`;
}
