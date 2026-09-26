import { getApp, freshness } from '../repo/apps.mjs';
import { getMirrorRow, eventsForRecord, linkedCaptures } from '../repo/mirror.mjs';
import { opsForTarget, opsForCapture, LIVE } from '../repo/ops.mjs';
import { describeChange, fmtAmount, canonicalLink } from './records.mjs';
import { APP } from './routing.mjs';

// One dream as the assistant knows it, for the dream sheet and the AI's
// get_dream tool alike. Kept in clearly separate parts so nothing mixes:
//   current   Dream Board's own values, as of the last sync (Dream Board is
//             the source of truth for these)
//   changes   what changed and when (derived from Dream Board's snapshots);
//             by: dream_board | capture (the owner's capture filed there) |
//             confirmed (a change card the owner confirmed)
//   words     the owner's captures filed to this dream (the assistant is the
//             source of truth for these); by: owner | assistant (saved by the
//             assistant at the owner's request in chat)
//   pending   assistant work not yet applied in Dream Board

export async function dreamView(db, userId, id, { maxChanges = 60 } = {}) {
  const row = await getMirrorRow(db, userId, APP, 'goal', String(id || ''));
  if (!row) return null;
  const appRow = await getApp(db, userId, APP);
  const [events, words, ops] = await Promise.all([
    eventsForRecord(db, userId, APP, id, 200), linkedCaptures(db, userId, row.id), opsForTarget(db, userId, APP, id),
  ]);
  const kindOf = new Map(ops.map(o => [o.id, o.kind]));
  const by = c => (!c.op_id ? 'dream_board' : ['update_goal', 'add_milestone'].includes(kindOf.get(c.op_id)) ? 'confirmed' : 'capture');
  const d = row.data || {};
  const changes = events.flatMap(e => (e.changes || []).map(c => ({
    kind: c.kind, at: c.at || e.occurred_at, text: describeChange(c, fmtAmount), by: by(c), progress: !!e.progress,
  }))).slice(-maxChanges);
  return {
    id, title: row.title, status: row.status, aliases: row.aliases || [],
    gone: row.deleted_at ? 'deleted' : row.missing_at ? 'missing' : null,
    current: { description: d.description || '', category: d.category ? d.category.name : null, fields: d.fields || {}, milestones: d.milestones || [], notes: (d.notes || []).slice(-5) },
    // "As of" is the board's last sync: an untouched dream is still current.
    asOf: (appRow && appRow.last_seen_at) || row.last_seen_at, freshness: freshness(appRow), historySince: appRow && appRow.history_since,
    link: canonicalLink(appRow, id),
    changes,
    words: words.map(c => ({ id: c.id, title: c.title, text: c.raw_text, capturedAt: c.captured_at, relation: c.relation, attachments: c.attachment_count, by: c.source_type === 'assistant' ? 'assistant' : 'owner' })),
    pending: ops.filter(o => LIVE.includes(o.status)).map(opSummary),
  };
}

// What the UI and the AI may know about one routing op.
function opSummary(o) {
  const p = o.payload || {};
  return {
    id: o.id, kind: o.kind, status: o.status, reason: o.reason,
    target: o.target_id ? { id: o.target_id, title: p.goal_title || null } : p.goal_title ? { id: null, title: p.goal_title } : null,
    title: p.title || null, suggestedTitle: p.suggested_title || null, candidates: p.candidates || [],
    attempts: o.attempts, result: o.result && o.result.record ? o.result.record : null,
    trace: (o.trace || []).map(t => ({ stage: t.stage, at: t.at })),
  };
}

export async function routingForCapture(db, userId, captureId) {
  const ops = await opsForCapture(db, userId, captureId);
  if (!ops.length) return null;
  return { app: APP, freshness: freshness(await getApp(db, userId, APP)), current: opSummary(ops[ops.length - 1]) };
}
