import { htmlToText, stripQuoted, clip, oneLine } from '../../text.mjs';

// Gmail adapter (read-only). Gmail API v1: users.threads.list / threads.get.
// Returns the assistant's internal SourceItem shape — callers never see raw
// Gmail payloads.

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const META_HEADERS = ['From', 'To', 'Cc', 'Subject', 'Date'];

export function gmailUrl(threadId, accountEmail) {
  const q = accountEmail ? '?authuser=' + encodeURIComponent(accountEmail) : '';
  return 'https://mail.google.com/mail/' + q + '#all/' + encodeURIComponent(threadId);
}

function header(msg, name) {
  const h = ((msg && msg.payload && msg.payload.headers) || []).find(x => x.name && x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

export function parseAddress(v) {
  const s = String(v || '').trim();
  const m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim(), email: m[2].trim().toLowerCase() };
  return { name: '', email: s.toLowerCase() };
}

function parseAddressList(v) {
  return String(v || '').split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(parseAddress).filter(a => a.email);
}

function msgDate(msg) {
  const n = Number(msg && msg.internalDate);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
}

// A thread in metadata format → SourceItem.
export function mapThreadSummary(thread, accountEmail) {
  const msgs = thread.messages || [];
  const first = msgs[0] || {}, last = msgs[msgs.length - 1] || {};
  const from = parseAddress(header(first, 'From'));
  const lastFrom = parseAddress(header(last, 'From'));
  const people = new Map();
  msgs.forEach(m => [header(m, 'From'), header(m, 'To'), header(m, 'Cc')].forEach(v => parseAddressList(v).forEach(a => people.set(a.email, a))));
  const labels = new Set();
  msgs.forEach(m => (m.labelIds || []).forEach(l => labels.add(l)));
  return {
    provider: 'google_gmail',
    kind: 'email_thread',
    recordId: thread.id,
    title: header(first, 'Subject') || '(no subject)',
    snippet: oneLine(last.snippet || thread.snippet || '', 240),
    url: gmailUrl(thread.id, accountEmail),
    date: msgDate(last),
    meta: {
      from: from.name || from.email,
      fromEmail: from.email,
      lastFrom: lastFrom.name || lastFrom.email,
      lastFromEmail: lastFrom.email,
      lastFromMe: !!accountEmail && lastFrom.email === String(accountEmail).toLowerCase(),
      messageCount: msgs.length,
      unread: labels.has('UNREAD'),
      important: labels.has('IMPORTANT'),
      participants: [...people.values()].slice(0, 12),
    },
  };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  });
  await Promise.all(workers);
  return out;
}

// Gmail search syntax is passed through (from:, after:, has:attachment …).
export async function searchThreads(client, { query, max = 10, accountEmail }) {
  const list = await client.paginate(BASE + '/threads', {
    params: { q: query || undefined, includeSpamTrash: false },
    itemsKey: 'threads', maxItems: Math.min(max, 25), pageSizeParam: 'maxResults', pageSize: Math.min(max, 25),
  });
  // Details are fetched per thread; a single failing thread must not sink the
  // search, so it degrades to its id + snippet.
  const items = await mapLimit(list.items, 5, async t => {
    try {
      const full = await client.get(BASE + '/threads/' + encodeURIComponent(t.id), { format: 'metadata', metadataHeaders: META_HEADERS });
      return mapThreadSummary(full, accountEmail);
    } catch {
      return { provider: 'google_gmail', kind: 'email_thread', recordId: t.id, title: '(could not load)', snippet: oneLine(t.snippet, 240), url: gmailUrl(t.id, accountEmail), date: null, meta: { partial: true } };
    }
  });
  return { items, truncated: list.truncated, estimate: list.estimate };
}

function walkParts(part, acc) {
  if (!part) return acc;
  const mime = part.mimeType || '';
  if (part.filename && part.body && (part.body.attachmentId || part.body.size)) {
    acc.attachments.push({ filename: part.filename, mimeType: mime, size: part.body.size || 0, attachmentId: part.body.attachmentId || null });
  } else if (mime === 'text/plain' && part.body && part.body.data) {
    acc.plain.push(Buffer.from(part.body.data, 'base64url').toString('utf8'));
  } else if (mime === 'text/html' && part.body && part.body.data) {
    acc.html.push(Buffer.from(part.body.data, 'base64url').toString('utf8'));
  }
  (part.parts || []).forEach(p => walkParts(p, acc));
  return acc;
}

export function messageBody(msg) {
  const acc = walkParts(msg.payload, { plain: [], html: [], attachments: [] });
  const text = acc.plain.length ? acc.plain.join('\n') : htmlToText(acc.html.join('\n'));
  return { text: stripQuoted(text), attachments: acc.attachments };
}

// Full thread for reading. Long threads are clipped per message and overall
// (the newest messages are kept) so one huge thread cannot flood a prompt.
export async function getThread(client, threadId, { accountEmail, maxCharsPerMessage = 4000, maxChars = 24000 } = {}) {
  const t = await client.get(BASE + '/threads/' + encodeURIComponent(threadId), { format: 'full' });
  const summary = mapThreadSummary(t, accountEmail);
  const msgs = (t.messages || []).map(m => {
    const body = messageBody(m);
    return {
      id: m.id,
      from: header(m, 'From'), to: header(m, 'To'), cc: header(m, 'Cc'),
      date: msgDate(m),
      subject: header(m, 'Subject'),
      text: clip(body.text, maxCharsPerMessage),
      attachments: body.attachments,
      unread: (m.labelIds || []).includes('UNREAD'),
    };
  });
  let budget = maxChars, omitted = 0;
  const kept = [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (budget - m.text.length < 0 && kept.length) { omitted = i + 1; break; }
    budget -= m.text.length;
    kept.unshift(m);
  }
  return Object.assign(summary, { messages: kept, omittedEarlier: omitted });
}

// Mail that plausibly wants the owner's attention — for Today / Catch Me Up.
// Deliberately conservative: unread, recent, not promotions/social.
export async function attentionThreads(client, { accountEmail, days = 3, max = 12 }) {
  const q = `in:inbox newer_than:${days}d -category:promotions -category:social -category:forums -category:updates`;
  const r = await searchThreads(client, { query: q, max, accountEmail });
  const waitingOnMe = r.items.filter(i => i.meta && !i.meta.partial && !i.meta.lastFromMe);
  return { unread: waitingOnMe.filter(i => i.meta.unread), waitingOnMe, truncated: r.truncated };
}
