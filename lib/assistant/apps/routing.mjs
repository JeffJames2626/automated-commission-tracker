import { createOp, getOp, transition, stage, pendingCreates, dependents, staleRouting, waitingOnSync, waitingOnFinished, appliedUnlinked,
  liveOpForCapture, setLinked, appendTrace, LIVE } from '../repo/ops.mjs';
import { getApp } from '../repo/apps.mjs';
import { listGoals, ensurePlaceholder, getMirrorRow, goalIdOf, claimChanges } from '../repo/mirror.mjs';
import { getCapture } from '../repo/captures.mjs';
import { link } from '../repo/graph.mjs';
import { isAchieved, ID_RE, str } from './records.mjs';
import { verifyAction, failAction } from './actions.mjs';

// Capture → app routing. Deterministic on purpose: a capture goes to Dream
// Board only when the owner's own words say so ("dream board", "add this to
// my lake house dream"). A dream the AI merely recognises stays in the
// assistant with a one-tap "Send to Dream Board".

export const APP = 'dreamboard';

const BOARD_RE = /\b(dream\s?board|vision\s?board)\b/i;
const ATTACH_RE = /\b(?:add|put|attach|save|stick|file|pin)\b[^.?!\n]{0,40}?\b(?:to|on|in|under|with|for)\s+(?:my|the|our)\s+([a-z0-9'&][a-z0-9' &\-]{0,58}?)\s+(?:dream|goal)s?\b/i;
const WANT_RE = /\b(someday|one day|eventually|i want|i'd love|i would love|i wanna|dream of|dreaming of|bucket list|goal)\b/i;

// The same rule runs on the phone (assistant/capture.js) for the offline label.
export function routeIntent(text, hasPhoto = false) {
  const t = String(text || '');
  const m = t.match(ATTACH_RE);
  if (m) return { app: APP, mode: 'attach', target: m[1].trim() };
  if (!BOARD_RE.test(t)) return null;
  if (hasPhoto) return { app: APP, mode: WANT_RE.test(stripBoardWords(t)) ? 'create' : 'item' };
  return { app: APP, mode: 'create' };
}

function stripBoardWords(t) {
  return String(t || '')
    .replace(/^\s*(please\s+)?((save|add|put|pin)\s+)?((this|that|it)\s+)?((for|to|on|in)\s+)?((my|the)\s+)?(dream\s?board|vision\s?board)\s*[:,.;!—–-]*\s*/i, '')
    .replace(/\b(dream\s?board|vision\s?board)\b[.:,;!—–-]*/ig, '')
    .trim();
}

// "Save this for my Dream Board — someday I want a lake house with a dock"
// → "Lake House". Used when no AI title exists; title_origin says which.
export function dreamTitleFromWords(text) {
  let t = stripBoardWords(text);
  t = t.replace(/^(someday|one day|eventually)[,\s]*/i, '')
    .replace(/^(i|we)\s+(really\s+)?(want|wanna|would like|'d like|hope|plan|dream)\s+(to\s+(own|have|buy|get|build|see|visit|go to|take|live in|live on)\s+|of\s+(owning|having|a|an)?\s*)?/i, '')
    .replace(/^(to\s+)?(own|have|buy|get|build)\s+/i, '')
    .replace(/^(a|an|the|my|our)\s+/i, '');
  t = t.split(/\s+(?:with|that|where|so|which|and|because|like)\s+|[,.;!?—–(]|\s-\s/)[0].trim();
  const words = t.split(/\s+/).filter(Boolean).slice(0, 6);
  if (!words.length) return null;
  return words.map(w => (w.length > 2 || words.indexOf(w) === 0 ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

// ---------------- matching a spoken dream name to a goal ----------------
const STOP = new Set(['my', 'the', 'a', 'an', 'our', 'dream', 'dreams', 'board', 'goal', 'goals', 'this', 'that', 'to', 'of', 'for', 'in', 'on', 'and']);
export const tokens = s => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w && !STOP.has(w));
const compact = s => tokens(s).join('');

// Strong = exactly one live goal is named exactly ("lake house" = "Lake
// House" = "lakehouse"); or, failing that, the phrase contains every word of
// exactly one title and no other live title contains every word of the
// phrase. Anything else is a candidate the owner chooses from. Achieved or
// archived goals are candidates only.
export function matchGoals(phrase, goals) {
  const p = tokens(phrase), pc = compact(phrase);
  if (!p.length) return { strong: [], candidates: [] };
  const scored = goals.map(g => {
    const names = [g.title].concat(g.aliases || []);
    let best = 0;
    for (const n of names) {
      const t = tokens(n);
      if (!t.length) continue;
      const exact = (t.length === p.length && t.every(w => p.includes(w))) || compact(n) === pc;
      const phraseHasTitle = t.every(w => p.includes(w));
      const titleHasPhrase = p.every(w => t.includes(w));
      const overlap = p.filter(w => t.includes(w)).length;
      const s = exact ? 3 : phraseHasTitle ? 2 : titleHasPhrase ? 1.5 : overlap ? overlap / Math.max(p.length, t.length) : 0;
      best = Math.max(best, s);
    }
    return { g, s: best };
  }).filter(x => x.s > 0).sort((a, b) => b.s - a.s);
  const live = scored.filter(x => !x.g.inactive);
  const exact = live.filter(x => x.s === 3);
  const strong = live.filter(x => x.s >= 2);
  const supersets = live.filter(x => x.s >= 1.5);
  const hit = exact.length === 1 ? exact[0] : !exact.length && strong.length === 1 && supersets.length === 1 ? strong[0] : null;
  return { strong: hit ? [hit.g] : [], candidates: scored.slice(0, 4).map(x => x.g) };
}

// Every goal a phrase could name: the mirror's live goals plus creates not
// applied yet — never the op being resolved itself.
async function goalChoices(db, userId, exceptOpId = null) {
  const goals = (await listGoals(db, userId, APP)).map(r => ({
    kind: 'goal', id: goalIdOf(r), title: r.title, aliases: r.aliases || [],
    inactive: isAchieved(r.status) || r.status === 'archived', status: r.status,
  }));
  const pending = (await pendingCreates(db, userId, APP)).filter(o => o.id !== exceptOpId && o.payload && o.payload.title)
    .map(o => ({ kind: 'pending', id: o.id, title: o.payload.title, aliases: [], inactive: false, status: 'waiting' }));
  return goals.concat(pending);
}

// ---------------- routing lifecycle ----------------

// Step 1, right after the capture row is stored — before attachments, link
// previews or AI — so a crash or rate limit later can't lose the routing.
export async function startRouting(db, { userId, capture, hasPhoto }) {
  const intent = routeIntent(capture.raw_text, hasPhoto);
  if (!intent) return null;
  const { op } = await createOp(db, {
    userId, app: APP, kind: intent.mode === 'attach' ? 'attach' : intent.mode === 'item' ? 'add_item' : 'create_goal',
    captureId: capture.id, status: 'routing', payload: { intent },
    trace: [stage('captured', { at: capture.captured_at }), stage('routed', { mode: intent.mode, explicit: true })],
  });
  return op;
}

// The frozen payload the app receives. Only what the app needs: the owner's
// words, when they were said, and image attachment references.
async function buildPayload(db, userId, capture, extra) {
  const c = capture.attachments ? capture : await getCapture(db, userId, capture.id);
  const atts = await db.query(`SELECT id, mime, size, sha256 FROM asst_attachments WHERE user_id = $1 AND capture_id = $2 AND kind = 'image' ORDER BY created_at`, [userId, c.id]);
  return Object.assign({
    capture_id: c.id, note: String(c.raw_text || '').slice(0, 4000), captured_at: new Date(c.captured_at).toISOString(),
    source_type: c.source_type, attachments: atts.map(a => ({ id: a.id, mime: a.mime, size: a.size, sha256: a.sha256 })),
  }, extra);
}

function titleFor(capture, intent) {
  if (intent && intent.target) return { title: titleCase(intent.target), title_origin: 'words' };
  const words = dreamTitleFromWords(capture.raw_text);
  if (capture.ai && capture.ai.how === 'ai' && capture.title && capture.classification_state !== 'manual') return { title: capture.title.slice(0, 80), title_origin: 'ai' };
  if (capture.classification_state === 'manual' && capture.title) return { title: capture.title.slice(0, 80), title_origin: 'owner' };
  return { title: words || String(capture.title || 'New dream').slice(0, 80), title_origin: words ? 'words' : 'ai' };
}
const titleCase = s => String(s).split(/\s+/).map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(' ');

// A capture on its way to the app leaves the inbox ("filed"); one that needs
// the owner again comes back.
const fileCapture = (db, userId, id) => id && db.query(`UPDATE asst_captures SET status = 'filed', updated_at = now()
  WHERE id = $1 AND user_id = $2 AND status IN ('inbox','thinking','maybe','active')`, [id, userId]);
const unfileCapture = (db, userId, id) => id && db.query(`UPDATE asst_captures SET status = 'inbox', updated_at = now()
  WHERE id = $1 AND user_id = $2 AND status = 'filed'`, [id, userId]);

// Step 2: decide what exactly to send. Safe to call repeatedly; only the call
// that moves the op out of 'routing' wins.
export async function resolveRoute(db, { userId, op }) {
  if (!op || op.status !== 'routing') return op;
  const capture = op.capture_id ? await getCapture(db, userId, op.capture_id) : null;
  if (!capture) return transition(db, userId, op.id, ['routing'], 'cancelled', { reason: 'capture_deleted', traceEntry: stage('cancelled', { reason: 'capture_deleted' }) });
  const intent = (op.payload && op.payload.intent) || routeIntent(capture.raw_text, (capture.attachments || []).some(a => a.kind === 'image'));
  const appRow = await getApp(db, userId, APP);
  const ready = !!(appRow && appRow.history_since);
  const choices = await goalChoices(db, userId, op.id);
  const queue = async (payload, extra) => {
    const r = await transition(db, userId, op.id, ['routing'], 'queued', Object.assign({ payload }, extra));
    if (r) await fileCapture(db, userId, capture.id);
    return r;
  };

  if (intent.mode === 'attach') {
    const m = matchGoals(intent.target, choices);
    const hit = m.strong[0];
    if (hit && hit.kind === 'goal') {
      return queue(await buildPayload(db, userId, capture, { goal_id: hit.id, goal_title: hit.title, intent }), { targetId: hit.id, traceEntry: stage('queued', { target: hit.title }) });
    }
    if (hit && hit.kind === 'pending') {
      const payload = await buildPayload(db, userId, capture, { goal_title: hit.title, intent });
      const r = await transition(db, userId, op.id, ['routing'], 'waiting', { payload, dependsOn: hit.id, traceEntry: stage('waiting', { on: 'pending_create', title: hit.title }) });
      if (r) await fileCapture(db, userId, capture.id);
      return r;
    }
    if (!ready) return transition(db, userId, op.id, ['routing'], 'waiting', { payload: { intent }, traceEntry: stage('waiting', { on: 'first_sync' }) });
    return needsChoice(db, userId, op, intent, m.candidates, titleCase(intent.target));
  }

  // A title the owner already chose (or one held while the board synced) wins.
  const { title, title_origin } = op.payload && op.payload.title ? { title: op.payload.title, title_origin: op.payload.title_origin } : titleFor(capture, intent);
  if (intent.mode === 'item') {
    return queue(await buildPayload(db, userId, capture, { title, title_origin, intent }), { traceEntry: stage('queued', { as: 'unsorted item' }) });
  }
  // create_goal: never silently create a second dream with the same name.
  const dup = matchGoals(title, choices);
  if (dup.strong.length || dup.candidates.some(c => tokens(c.title).join(' ') === tokens(title).join(' '))) {
    return needsChoice(db, userId, op, intent, dup.candidates, title);
  }
  if (!ready) {
    return transition(db, userId, op.id, ['routing'], 'waiting', { payload: { intent, title, title_origin }, traceEntry: stage('waiting', { on: 'first_sync' }) });
  }
  return queue(await buildPayload(db, userId, capture, { title, title_origin, intent }), { traceEntry: stage('queued', { title }) });
}

async function needsChoice(db, userId, op, intent, candidates, suggestedTitle) {
  const payload = { intent, suggested_title: suggestedTitle,
    candidates: candidates.slice(0, 4).map(c => ({ kind: c.kind, id: c.id, title: c.title, status: c.status || null })) };
  const r = await transition(db, userId, op.id, ['routing', 'waiting'], 'needs_choice', { payload, dependsOn: '', traceEntry: stage('needs_choice', { candidates: payload.candidates.length }) });
  if (r) await unfileCapture(db, userId, op.capture_id);
  return r;
}

// Ask the owner again, e.g. when the dream an op pointed at is gone.
async function askAgain(db, userId, op, choices) {
  const intent = (op.payload && op.payload.intent) || {};
  const phrase = intent.target || (op.payload && (op.payload.goal_title || op.payload.title)) || '';
  return needsChoice(db, userId, op, intent, matchGoals(phrase, choices).candidates, phrase);
}

// The owner answers "Which dream?" (or taps "Send to Dream Board").
//   choice: { goal: <id> } | { pending: <op id> } | 'new' | 'item' | 'keep'
export async function chooseRoute(db, { userId, captureId, choice, title }) {
  const capture = await getCapture(db, userId, captureId);
  if (!capture) return { error: 'not_found' };
  let op = await liveOpForCapture(db, userId, APP, captureId);
  if (op && !['needs_choice', 'waiting', 'routing'].includes(op.status)) return { error: 'already_sent', op };
  if (!op) {
    if (choice === 'keep') return { op: null };
    op = (await createOp(db, { userId, app: APP, kind: 'create_goal', captureId, status: 'needs_choice', payload: {},
      trace: [stage('captured', { at: capture.captured_at }), stage('routed', { mode: 'owner', explicit: true })] })).op;
  }
  const from = ['needs_choice', 'waiting', 'routing'];
  const done = async r => {
    if (!r) return { error: 'already_sent' };
    if (r.status === 'cancelled') await unfileCapture(db, userId, captureId); else await fileCapture(db, userId, captureId);
    return { op: r };
  };
  if (choice === 'keep') return done(await transition(db, userId, op.id, from, 'cancelled', { reason: 'kept_here', traceEntry: stage('cancelled', { reason: 'kept_here' }) }));
  const intent = Object.assign({}, op.payload && op.payload.intent, { chosen: true });
  if (choice && typeof choice === 'object' && choice.goal) {
    const row = await getMirrorRow(db, userId, APP, 'goal', String(choice.goal));
    if (!row || row.deleted_at || row.missing_at || row.app_seq == null) return { error: 'unknown_goal' };
    const payload = await buildPayload(db, userId, capture, { goal_id: String(choice.goal), goal_title: row.title, intent });
    return done(await transition(db, userId, op.id, from, 'queued', { payload, kind: 'attach', targetId: String(choice.goal), dependsOn: '', traceEntry: stage('queued', { target: row.title, chosen: true }) }));
  }
  if (choice && typeof choice === 'object' && choice.pending) {
    const dep = await getOp(db, userId, String(choice.pending));
    if (!dep || dep.id === op.id || dep.kind !== 'create_goal' || !['waiting', 'queued'].includes(dep.status) || !(dep.payload && dep.payload.title)) return { error: 'unknown_goal' };
    const payload = await buildPayload(db, userId, capture, { goal_title: dep.payload.title, intent });
    return done(await transition(db, userId, op.id, from, 'waiting', { payload, kind: 'attach', targetId: '', dependsOn: dep.id, traceEntry: stage('waiting', { on: 'pending_create', chosen: true }) }));
  }
  if (choice === 'new' || choice === 'item') {
    const t = choice === 'new' ? { title: String(title || (op.payload && op.payload.suggested_title) || titleFor(capture, intent).title).slice(0, 80), title_origin: title ? 'owner' : 'words' } : titleFor(capture, intent);
    const kind = choice === 'new' ? 'create_goal' : 'add_item';
    // Before the board's first sync the assistant can't know whether that
    // dream already exists: hold it, and check the name once it syncs.
    const appRow = await getApp(db, userId, APP);
    if (choice === 'new' && !(appRow && appRow.history_since)) {
      return done(await transition(db, userId, op.id, from, 'waiting', { payload: { intent: { app: APP, mode: 'create', chosen: true }, title: t.title, title_origin: t.title_origin }, kind, targetId: '', dependsOn: '', traceEntry: stage('waiting', { on: 'first_sync', chosen: true }) }));
    }
    const payload = await buildPayload(db, userId, capture, Object.assign({ intent }, t));
    return done(await transition(db, userId, op.id, from, 'queued', { payload, kind, targetId: '', dependsOn: '', traceEntry: stage('queued', { as: choice === 'new' ? 'new dream' : 'unsorted item', chosen: true }) }));
  }
  return { error: 'bad_choice' };
}

const RELATION = { create_goal: 'routed_to', attach: 'attached_to', add_item: 'added_to' };

// A result reported by the app for one op. The app's word is final: an op it
// applied is applied even if the owner cancelled it meanwhile.
export async function handleResult(db, { userId, app, result, epoch }) {
  const op = await getOp(db, userId, String(result.op_id || ''));
  if (!op || op.app !== app) return { ok: false, reason: 'unknown_op' };
  if (result.status === 'applied') {
    const rec = result.record && typeof result.record === 'object' ? result.record : {};
    const recordId = typeof rec.id === 'string' && ID_RE.test(rec.id) ? rec.id : null;
    const clean = {
      record: recordId ? { type: rec.type === 'item' ? 'item' : 'goal', id: recordId } : null,
      created: sanitizeCreated(result.created), seq: Number.isSafeInteger(Number(result.seq)) ? Number(result.seq) : null, epoch,
    };
    let row = op;
    if (op.status !== 'applied') {
      row = await transition(db, userId, op.id, LIVE.concat(['cancelled', 'rejected']), 'applied', {
        result: clean, traceEntry: stage('acknowledged', op.status === 'cancelled' ? { note: 'applied after cancel' } : { record: clean.record && clean.record.type }),
      }) || await getOp(db, userId, op.id);
      // Its effect may already be in a snapshot we read before this result.
      const goal = clean.created.goal || (clean.record && clean.record.type === 'goal' ? clean.record.id : null);
      if (goal) await claimChanges(db, { userId, app, recordId: goal, opId: op.id, created: clean.created, set: (op.payload && op.payload.set) || {} });
    } else if (op.result && op.result.record && clean.record && op.result.record.id !== clean.record.id) {
      await appendTrace(db, op.id, stage('result_conflict', { kept: op.result.record.id }));
    }
    await finishApplied(db, userId, row);
    return { ok: true };
  }
  if (result.status === 'rejected') {
    if (op.status === 'applied') { await appendTrace(db, op.id, stage('result_conflict', { note: 'rejected after applied' })); return { ok: true }; }
    const reason = str(String(result.reason || 'invalid'), 40);
    const r = await transition(db, userId, op.id, LIVE.concat(['cancelled']), 'rejected', { reason, traceEntry: stage('rejected', { reason }) });
    if (!r) return { ok: true };
    if (r.action_id) await failAction(db, userId, r.action_id, reason);
    const choices = await goalChoices(db, userId);
    if (r.capture_id) {
      await unfileCapture(db, userId, r.capture_id);
      // The dream it pointed at is gone: ask again instead of dead-ending.
      if (['target_deleted', 'target_missing'].includes(reason) && r.kind === 'attach') {
        const { op: again } = await createOp(db, { userId, app, kind: 'attach', captureId: r.capture_id, status: 'routing',
          payload: { intent: r.payload && r.payload.intent }, trace: [stage('rerouted', { after: reason })] });
        if (again && again.status === 'routing') await askAgain(db, userId, Object.assign({}, again, { payload: r.payload }), choices);
      }
    }
    for (const d of await dependents(db, userId, r.id)) await askAgain(db, userId, d, choices);
    return { ok: true };
  }
  return { ok: false, reason: 'bad_status' };
}

function sanitizeCreated(c) {
  if (!c || typeof c !== 'object') return {};
  const id = v => (typeof v === 'string' && ID_RE.test(v) ? v : null);
  const list = v => (Array.isArray(v) ? v.map(id).filter(Boolean).slice(0, 50) : []);
  return { goal: id(c.goal), item: id(c.item), notes: list(c.notes), images: list(c.images), milestones: list(c.milestones) };
}

const goalOf = op => {
  const res = op.result || {};
  return (res.created && res.created.goal) || (res.record && res.record.type === 'goal' ? res.record.id : null) || op.target_id;
};

// Idempotent follow-ups after an op is applied; re-run on every repeat of the
// result and by the sync sweep, so a failure half-way is always finished later.
async function finishApplied(db, userId, op) {
  if (!op || op.status !== 'applied') return;
  const goalId = goalOf(op);
  if (goalId) {
    const row = await ensurePlaceholder(db, { userId, app: op.app, type: 'goal', id: goalId, title: op.payload && (op.payload.title || op.payload.goal_title) });
    if (op.capture_id && row) await link(db, userId, { type: 'capture', id: op.capture_id }, { type: 'external', id: row.id }, RELATION[op.kind] || 'routed_to', 'app');
    for (const d of await dependents(db, userId, op.id)) await releaseTo(db, userId, d, goalId);
  }
  if (op.capture_id) {
    await fileCapture(db, userId, op.capture_id);
    // The words now live in the app; keep only what the history view needs.
    await db.query(`UPDATE asst_app_ops SET payload = payload - 'note' WHERE id = $1`, [op.id]);
  }
  if (op.action_id) await verifyAction(db, userId, op);
  await setLinked(db, op.id);
}

const releaseTo = (db, userId, d, goalId) => transition(db, userId, d.id, ['waiting'], 'queued', {
  payload: Object.assign({}, d.payload, { goal_id: goalId }), targetId: goalId, dependsOn: '', traceEntry: stage('queued', { after: 'create applied' }),
});

// Run on every app sync (the app's poll is the assistant's clock): finish
// anything a crash, a rate limit or a change of mind left half-done.
export async function sweep(db, userId, app) {
  for (const op of await staleRouting(db, userId, app)) await resolveRoute(db, { userId, op });
  const appRow = await getApp(db, userId, app);
  if (appRow && appRow.history_since) {
    for (const op of await waitingOnSync(db, userId, app)) {
      const r = await transition(db, userId, op.id, ['waiting'], 'routing', { traceEntry: stage('retry', { after: 'first_sync' }) });
      if (r) await resolveRoute(db, { userId, op: r });
    }
  }
  // Waiting on a create that ended (applied, rejected, kept, re-pointed, deleted).
  for (const w of await waitingOnFinished(db, userId, app)) {
    const goalId = w.dep_status === 'applied' && w.id !== w.depends_on ? goalOf({ result: w.dep_result, target_id: w.dep_target }) : null;
    if (goalId) await releaseTo(db, userId, w, goalId);
    else await askAgain(db, userId, w, await goalChoices(db, userId, w.id));
  }
  for (const op of await appliedUnlinked(db, userId, app)) await finishApplied(db, userId, op);
}
