import { getApp, freshness } from '../repo/apps.mjs';
import { listGoals, eventsSince, goalIdOf } from '../repo/mirror.mjs';
import { recentOps, queueSummary } from '../repo/ops.mjs';
import { describeChange, fmtAmount, isProgress } from './records.mjs';
import { APP } from './routing.mjs';
import { KINDS } from '../kinds.mjs';

// Plain summaries (no AI) of what happened, for Today and Catch Me Up. Every
// line keeps the ids it came from so the briefing can cite it.

const DAY = 86400000;
const ACTIVE = new Set(['in_progress', 'active', 'doing', 'planned', 'planning']);

// Today's DREAMS & GOALS: only what is worth a glance — recent progress, one
// focused goal that has gone quiet, a capture waiting for "which dream?".
export async function dreamHighlights(db, userId, now = Date.now()) {
  const app = await getApp(db, userId, APP);
  if (!app || !app.history_since) return null;
  const goals = await listGoals(db, userId, APP);
  const month = new Date(now - 30 * DAY).toISOString();
  const ev = await db.query(`SELECT record_id, changes FROM asst_events WHERE user_id = $1 AND app = $2 AND progress AND occurred_at >= $3`, [userId, APP, month]);
  const byGoal = new Map();
  ev.forEach(e => (e.changes || []).forEach(c => {
    if (!isProgress(c)) return;          // an edit in the same save never hides the progress
    const x = byGoal.get(e.record_id) || { milestones: 0, other: [] };
    if (c.kind === 'milestone_completed') x.milestones++; else x.other.push(describeChange(c, fmtAmount));
    byGoal.set(e.record_id, x);
  }));
  const items = [];
  for (const g of goals) {
    const x = byGoal.get(goalIdOf(g));
    if (!x) continue;
    const bits = [];
    if (x.milestones) bits.push(x.milestones + (x.milestones === 1 ? ' milestone' : ' milestones') + ' completed this month');
    bits.push(...x.other.slice(-1));
    items.push({ id: goalIdOf(g), title: g.title, line: bits.join(' · ') });
  }
  // One quiet, focused goal at most — and only when the assistant has known
  // the board long enough to say it has been quiet.
  const known = new Date(app.history_since).getTime();
  const quiet = goals.filter(g => ACTIVE.has(g.status))
    .map(g => ({ g, last: Math.max(g.last_update_at ? new Date(g.last_update_at).getTime() : 0, known) }))
    .filter(x => now - x.last > 45 * DAY).sort((a, b) => a.last - b.last)[0];
  if (quiet) items.push({ id: goalIdOf(quiet.g), title: quiet.g.title, line: `no update in ${Math.floor((now - quiet.last) / DAY)} days` });
  return { items: items.slice(0, 4), needsChoice: (await queueSummary(db, userId, APP)).needs_choice || 0, freshness: freshness(app, now) };
}

// Everything that changed since a moment, grouped the way a person would tell
// it: what was captured, what went to Dream Board, what moved in Dream Board.
export async function changesSince(db, userId, sinceIso) {
  const [caps, events, ops, waiting] = await Promise.all([
    db.query(`SELECT c.id, c.kind, c.status, c.title, c.captured_at, c.project_id, p.name AS project_name,
        (SELECT count(*)::int FROM asst_attachments a WHERE a.capture_id = c.id AND a.kind = 'image') AS photos
      FROM asst_captures c LEFT JOIN asst_projects p ON p.id = c.project_id
      WHERE c.user_id = $1 AND (c.captured_at >= $2 OR c.created_at >= $2) AND c.kind <> 'question' ORDER BY c.captured_at`, [userId, sinceIso]),
    eventsSince(db, userId, APP, sinceIso),
    recentOps(db, userId, sinceIso),
    queueSummary(db, userId, APP),
  ]);
  const byKind = {};
  caps.forEach(c => { byKind[c.kind] = (byKind[c.kind] || 0) + 1; });
  const projects = {};
  caps.filter(c => c.project_name && c.status !== 'filed').forEach(c => { (projects[c.project_id] = projects[c.project_id] || { id: c.project_id, name: c.project_name, items: [] }).items.push(c); });
  const photosOf = new Map(caps.map(c => [c.id, c.photos]));

  // Our own work, told once (its echo in Dream Board's snapshots is folded in).
  const sent = ops.filter(o => o.status === 'applied' && o.done_at >= new Date(sinceIso) && (o.capture_id || o.action_id)).map(o => ({
    kind: o.kind, captureId: o.capture_id, title: (o.payload && (o.payload.title || o.payload.goal_title)) || o.capture_title,
    goalId: (o.result && o.result.created && o.result.created.goal) || o.target_id, photos: photosOf.get(o.capture_id) || 0,
    confirmed: o.action_id ? o.action_summary : null,
  }));

  const dreams = new Map();
  for (const e of events) {
    const own = (e.changes || []).filter(c => !c.op_id);
    if (!own.length) continue;
    const d = dreams.get(e.record_id) || { id: e.record_id, title: e.title, changes: [], progress: false };
    d.title = e.title;
    own.forEach(c => d.changes.push({ text: describeChange(c, fmtAmount), at: c.at || e.occurred_at, progress: !!e.progress }));
    d.progress = d.progress || e.progress;
    dreams.set(e.record_id, d);
  }
  return {
    since: sinceIso,
    captures: { total: caps.length, byKind: Object.entries(byKind).map(([k, n]) => ({ kind: k, label: KINDS[k] ? KINDS[k].label : k, n })), items: caps },
    projects: Object.values(projects).filter(p => p.items.length >= 2).sort((a, b) => b.items.length - a.items.length),
    sent, waiting, dreams: [...dreams.values()],
  };
}
