// Records a connected app publishes, and the changes the assistant derives
// from them. Apps send CURRENT snapshots only; the assistant compares each new
// snapshot with the one it holds and writes one event row per new version.
// Presentation (position, size, rotation, crop, stacking) never enters a
// snapshot, so it can never become an event.
//
// Wire format: docs/assistant/CONNECTED-APPS.md#record.

const ID_RE = /^[A-Za-z0-9_:.\-]{1,120}$/;
const FIELD_RE = /^[a-z][a-z0-9_]{0,40}$/;

const str = (v, n) => (typeof v === 'string' ? v.replace(/\u0000/g, '').slice(0, n) : null);
const iso = v => (typeof v === 'string' && !isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
const idOf = v => (typeof v === 'string' && ID_RE.test(v) ? v : null);

// Validate and clip one published record. Returns null when it can't be used.
// Everything is bounded so one record can never be larger than ~40 KB.
export function normalizeRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = raw.type === 'goal' ? 'goal' : null;
  const id = idOf(raw.id);
  const seq = Number(raw.seq);
  if (!type || !id || !Number.isSafeInteger(seq) || seq < 0) return null;
  if (raw.deleted === true) return { type, id, seq, deleted: true };
  const fields = {}, fieldTimes = {};
  if (raw.fields && typeof raw.fields === 'object') {
    for (const [k, v] of Object.entries(raw.fields).slice(0, 30)) {
      if (!FIELD_RE.test(k)) continue;
      if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) fields[k] = v;
      else if (typeof v === 'string') fields[k] = v.slice(0, 300);
    }
  }
  if (raw.field_times && typeof raw.field_times === 'object') {
    for (const [k, v] of Object.entries(raw.field_times).slice(0, 40)) if (FIELD_RE.test(k) && iso(v)) fieldTimes[k] = iso(v);
  }
  let budget = 20000;                       // total characters of notes kept
  const notes = (Array.isArray(raw.notes) ? raw.notes : []).slice(-50).map(n => {
    const text = str(n && n.text, Math.min(1000, Math.max(0, budget))) || '';
    budget -= text.length;
    return idOf(n && n.id) ? { id: n.id, text, created_at: iso(n.created_at) } : null;
  }).filter(Boolean);
  const milestones = (Array.isArray(raw.milestones) ? raw.milestones : []).slice(0, 100).map(m => idOf(m && m.id)
    ? { id: m.id, title: str(m.title, 300) || '', done: m.done === true, done_at: iso(m.done_at), created_at: iso(m.created_at) } : null).filter(Boolean);
  const images = (Array.isArray(raw.images) ? raw.images : []).slice(0, 200).map(i => idOf(i && i.id) ? { id: i.id, created_at: iso(i.created_at) } : null).filter(Boolean);
  const named = o => (o && typeof o === 'object' && str(o.name, 80) ? { id: idOf(o.id), name: str(o.name, 80) } : null);
  return {
    type, id, seq, deleted: false,
    title: str(raw.title, 300) || '(untitled)',
    description: str(raw.description, 4000) || '',
    status: str(raw.status, 40) ? raw.status.toLowerCase().slice(0, 40) : null,
    category: named(raw.category),
    board: named(raw.board),
    fields, field_times: fieldTimes, milestones, notes, images,
    created_at: iso(raw.created_at), updated_at: iso(raw.updated_at),
  };
}

export function searchTextOf(rec, aliases = []) {
  if (!rec || rec.deleted) return aliases.join(' ');
  return [rec.description, rec.category && rec.category.name, rec.status,
    ...rec.milestones.map(m => m.title), ...rec.notes.map(n => n.text), ...aliases].filter(Boolean).join('\n').slice(0, 30000);
}

// Order of goal statuses, for "forward progress". Unknown statuses never
// count as progress (they still count as an update).
const STATUS_RANK = { someday: 0, dreaming: 0, idea: 0, dream: 0, planned: 1, planning: 1, in_progress: 2, active: 2, doing: 2, achieved: 3, done: 3, completed: 3 };
const ACHIEVED = new Set(['achieved', 'done', 'completed']);

const clipText = s => (typeof s === 'string' && s.length > 200 ? s.slice(0, 199) + '…' : s);

// Compare the stored snapshot with a newer one. `prev` is the stored data
// (or null the first time), `createdBy` maps entity ids to the op that created
// them (our own writes coming back). Returns { changes, progress, opIds }.
export function diffRecords(prev, next, { createdBy = new Map(), receivedAt = new Date().toISOString() } = {}) {
  const changes = [];
  const at = (field, fallback) => (next && next.field_times && next.field_times[field]) || fallback || receivedAt;
  const opFor = id => createdBy.get(String(id)) || null;
  const push = c => { if (c.op_id == null) delete c.op_id; changes.push(c); };

  if (!prev || prev.placeholder) {
    if (next.deleted) return { changes: [], progress: false, opIds: [] };
    push({ kind: 'created', title: next.title, at: next.created_at || receivedAt, op_id: opFor(next.id) });
    next.milestones.filter(m => m.done).forEach(m => push({ kind: 'milestone_completed', id: m.id, title: m.title, at: m.done_at || receivedAt, op_id: opFor(m.id) }));
    next.images.forEach(i => { const op = opFor(i.id); if (op) push({ kind: 'image_added', id: i.id, at: i.created_at || receivedAt, op_id: op }); });
    next.notes.forEach(n => { const op = opFor(n.id); if (op) push({ kind: 'note_added', id: n.id, text: clipText(n.text), at: n.created_at || receivedAt, op_id: op }); });
  } else if (next.deleted) {
    if (!prev.deleted) push({ kind: 'deleted', title: prev.title, at: receivedAt });
  } else {
    const own = createdBy.get('v:' + next.id + ':' + next.seq) || null;     // a confirmed change of ours
    if (prev.deleted) push({ kind: 'restored', title: next.title, at: receivedAt });
    if (prev.title !== next.title) push({ kind: 'renamed', from: prev.title, to: next.title, at: at('title'), op_id: own });
    if ((prev.status || null) !== (next.status || null)) push({ kind: 'status_changed', from: prev.status || null, to: next.status || null, at: at('status'), op_id: own });
    if ((prev.description || '') !== (next.description || '')) push({ kind: 'updated', field: 'description', from: clipText(prev.description || ''), to: clipText(next.description || ''), at: at('description') });
    const pc = prev.category ? prev.category.name : null, nc = next.category ? next.category.name : null;
    if (pc !== nc) push({ kind: 'updated', field: 'category', from: pc, to: nc, at: at('category') });
    const keys = new Set(Object.keys(prev.fields || {}).concat(Object.keys(next.fields || {})));
    for (const k of keys) {
      const a = prev.fields ? prev.fields[k] : undefined, b = next.fields ? next.fields[k] : undefined;
      if (a !== b && !(a == null && b == null)) push({ kind: 'updated', field: k, from: a ?? null, to: b ?? null, at: at(k), op_id: own });
    }
    const pm = new Map((prev.milestones || []).map(m => [m.id, m]));
    for (const m of next.milestones) {
      const o = pm.get(m.id);
      if (!o) push({ kind: m.done ? 'milestone_completed' : 'milestone_added', id: m.id, title: m.title, at: (m.done && m.done_at) || m.created_at || receivedAt, op_id: opFor(m.id) });
      else if (!o.done && m.done) push({ kind: 'milestone_completed', id: m.id, title: m.title, at: m.done_at || receivedAt });
      else if (o.done && !m.done) push({ kind: 'milestone_reopened', id: m.id, title: m.title, at: receivedAt });
    }
    const nm = new Set(next.milestones.map(m => m.id));
    (prev.milestones || []).filter(m => !nm.has(m.id)).forEach(m => push({ kind: 'milestone_removed', id: m.id, title: m.title, at: receivedAt }));
    const pn = new Set((prev.notes || []).map(n => n.id));
    next.notes.filter(n => !pn.has(n.id)).forEach(n => push({ kind: 'note_added', id: n.id, text: clipText(n.text), at: n.created_at || receivedAt, op_id: opFor(n.id) }));
    const pi = new Set((prev.images || []).map(i => i.id));
    next.images.filter(i => !pi.has(i.id)).forEach(i => push({ kind: 'image_added', id: i.id, at: i.created_at || receivedAt, op_id: opFor(i.id) }));
  }
  const progress = changes.some(c => isProgress(c));
  const opIds = [...new Set(changes.map(c => c.op_id).filter(Boolean))];
  return { changes, progress, opIds };
}

// PROGRESS = moving the goal forward: a milestone completed, the goal
// achieved, a forward status move, or more money saved. Photos, notes,
// renames and focus toggles are updates, not progress.
export function isProgress(c) {
  if (c.kind === 'milestone_completed') return true;
  if (c.kind === 'status_changed') {
    if (ACHIEVED.has(c.to)) return true;
    const a = STATUS_RANK[c.from], b = STATUS_RANK[c.to];
    return a != null && b != null && b > a;
  }
  if (c.kind === 'updated' && c.field === 'saved_amount') return Number(c.to) > Number(c.from);
  return false;
}

export function isAchieved(status) { return ACHIEVED.has(String(status || '')); }

// A human sentence for one change (no AI; used by Catch Me Up and Today).
export function describeChange(c, fmt = v => v) {
  switch (c.kind) {
    case 'created': return 'added to Dream Board';
    case 'renamed': return `renamed from “${c.from}”`;
    case 'status_changed': return `status ${c.from || '—'} → ${c.to || '—'}`;
    case 'updated': return c.field === 'description' ? 'description edited' : `${c.field.replace(/_/g, ' ')} ${fmt(c.from, c.field) ?? '—'} → ${fmt(c.to, c.field) ?? '—'}`;
    case 'milestone_added': return `milestone added: ${c.title}`;
    case 'milestone_completed': return `milestone completed: ${c.title}`;
    case 'milestone_reopened': return `milestone reopened: ${c.title}`;
    case 'milestone_removed': return `milestone removed: ${c.title}`;
    case 'note_added': return 'note added';
    case 'image_added': return 'photo added';
    case 'deleted': return 'deleted in Dream Board';
    case 'restored': return 'restored in Dream Board';
    default: return c.kind;
  }
}

export function fmtAmount(v, field) {
  if (typeof v !== 'number' || !/amount|budget|saved|price|cost/.test(field || '')) return v;
  return '$' + (v >= 1e6 ? +(v / 1e6).toFixed(2) + 'M' : v.toLocaleString('en-US'));
}

// Build the canonical link from the owner-confirmed base URL and the path
// template the app declared at pairing. The origin never comes from the wire.
export function canonicalLink(appRow, recordId) {
  if (!appRow || !appRow.base_url || !recordId) return null;
  const tpl = appRow.link_template && /^\/[^/]/.test(appRow.link_template) && appRow.link_template.includes('{id}') ? appRow.link_template : null;
  if (!tpl) return null;
  try {
    const u = new URL(tpl.replace('{id}', encodeURIComponent(recordId)), appRow.base_url);
    return u.protocol === 'https:' || u.hostname === 'localhost' || u.hostname === '127.0.0.1' ? u.toString() : null;
  } catch { return null; }
}
