import crypto from 'node:crypto';

// An in-memory Dream Board SERVER that follows the connector contract in
// docs/assistant/CONNECTED-APPS.md, the way the real one must:
//   - one server sequence (seq) bumped by every change; an epoch that changes
//     when history is rewound (restore from backup)
//   - ops deduplicated by op_id; every entity an op creates gets an id derived
//     from the op_id, so a replay can never create a second copy
//   - each op applied all-or-nothing
// plus switches to make it fail in the ways a real PC does.

const hash = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 10);

export function fakeDreamBoard(app, { instanceId = 'board-real', label = 'Jeff’s PC' } = {}) {
  const s = {
    seq: 0, epoch: 'e1', token: null, since: 0, resync: false,
    goals: new Map(), items: new Map(), applied: new Map(), unreported: [], files: [],
    offline: false, dropResults: false, reject: null, calls: 0, lastResponse: null,
  };
  const now = () => new Date().toISOString();
  const bump = g => { s.seq++; g.seq = s.seq; g.updated_at = now(); return g; };

  const goal = (id, title, extra = {}) => bump(Object.assign({
    id, title, description: '', status: 'dreaming', category: null, fields: {}, field_times: {},
    milestones: [], notes: [], images: [], created_at: now(), deleted: false,
  }, extra));
  const wire = g => (g.deleted ? { type: 'goal', id: g.id, seq: g.seq, deleted: true } : Object.assign({ type: 'goal' }, JSON.parse(JSON.stringify(g))));

  // ---- the owner using Dream Board directly ----
  const board = {
    addGoal(title, extra = {}) { const id = extra.id || 'g-' + hash(title + Math.random()); s.goals.set(id, goal(id, title, extra)); return id; },
    edit(id, patch) {
      const g = s.goals.get(id);
      for (const [k, v] of Object.entries(patch)) {
        if (['title', 'status', 'description'].includes(k)) g[k] = v; else g.fields[k] = v;
        g.field_times[k] = now();
      }
      bump(g);
    },
    completeMilestone(id, title) {
      const g = s.goals.get(id);
      let m = g.milestones.find(x => x.title === title);
      if (!m) { m = { id: 'm-' + hash(id + title), title, created_at: now() }; g.milestones.push(m); }
      Object.assign(m, { done: true, done_at: now() });
      bump(g);
    },
    delete(id) { const g = s.goals.get(id); g.deleted = true; bump(g); },
    // Restore from a backup: history rewinds and the epoch changes.
    restore(snapshot) {
      s.goals = new Map([...snapshot.goals].map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
      s.seq = snapshot.seq; s.epoch = 'e' + (Number(s.epoch.slice(1)) + 1);
    },
    snapshot() { return { seq: s.seq, goals: new Map([...s.goals].map(([k, v]) => [k, JSON.parse(JSON.stringify(v))])) }; },
    goal: id => s.goals.get(id),
    byTitle: t => [...s.goals.values()].find(g => g.title === t && !g.deleted),
    live: () => [...s.goals.values()].filter(g => !g.deleted),
  };

  async function fetchFile(a) {
    const r = await app.call('GET', 'apps/v1/files', { query: Object.fromEntries(new URL('http://x/' + a.path).searchParams), headers: auth(), cookies: {} });
    if (r.status !== 200) throw new Error('file ' + r.status);
    const got = crypto.createHash('sha256').update(r.binary).digest('hex');
    if (got !== a.sha256) throw new Error('sha mismatch');
    s.files.push(a.id);
    return a.id;
  }

  // Apply one op the way the real server must: dedupe, derive ids, all or nothing.
  async function apply(op) {
    if (s.applied.has(op.op_id)) return s.applied.get(op.op_id);
    if (s.reject) return { op_id: op.op_id, status: 'rejected', reason: s.reject };
    const idFor = what => what + '-' + op.op_id;
    const images = [];
    for (const a of op.attachments || []) { await fetchFile(a); images.push({ id: idFor('img-' + a.id), created_at: now() }); }
    const note = op.note ? [{ id: idFor('note'), text: op.note, created_at: now() }] : [];
    let res;
    if (op.kind === 'create_goal') {
      const id = idFor('goal');
      s.goals.set(id, goal(id, op.title, { notes: note, images }));
      res = { record: { type: 'goal', id }, created: { goal: id, notes: note.map(n => n.id), images: images.map(i => i.id) } };
    } else if (op.kind === 'add_item') {
      const id = idFor('item');
      s.items.set(id, { id, note: op.note, images });
      s.seq++;
      res = { record: { type: 'item', id }, created: { item: id, images: images.map(i => i.id) } };
    } else {
      const g = s.goals.get(op.goal_id);
      if (!g || g.deleted) return { op_id: op.op_id, status: 'rejected', reason: g ? 'target_deleted' : 'target_missing' };
      if (op.kind === 'attach') {
        g.notes.push(...note); g.images.push(...images);
        res = { record: { type: 'goal', id: g.id }, created: { notes: note.map(n => n.id), images: images.map(i => i.id) } };
      } else if (op.kind === 'update_goal') {
        for (const [k, v] of Object.entries(op.expect || {})) {
          const cur = ['title', 'status'].includes(k) ? g[k] : (g.fields[k] ?? null);
          if (cur !== v) return { op_id: op.op_id, status: 'rejected', reason: 'conflict' };
        }
        for (const [k, v] of Object.entries(op.set)) { if (['title', 'status'].includes(k)) g[k] = v; else g.fields[k] = v; g.field_times[k] = now(); }
        res = { record: { type: 'goal', id: g.id }, created: {} };
      } else if (op.kind === 'add_milestone') {
        const id = idFor('ms');
        g.milestones.push({ id, title: op.milestone.title, done: false, created_at: now() });
        res = { record: { type: 'goal', id: g.id }, created: { milestones: [id] } };
      } else return { op_id: op.op_id, status: 'rejected', reason: 'unsupported' };
      bump(g);
    }
    const out = Object.assign({ op_id: op.op_id, status: 'applied', seq: s.seq }, res);
    s.applied.set(op.op_id, out);
    return out;
  }

  const auth = () => ({ authorization: 'Bearer ' + s.token });

  // One poll. Returns the assistant's response.
  async function sync({ extra = {} } = {}) {
    if (s.offline) return null;
    s.calls++;
    const results = s.unreported.splice(0);
    let body;
    if (s.resync) {
      const start = s.seq;
      const all = [...s.goals.values()].filter(g => !g.deleted);
      body = { records: all.map(wire), backfill: { start_seq: start, done: true, ids: all.map(g => g.id) } };
    } else {
      body = { records: [...s.goals.values()].filter(g => g.seq > s.since).sort((a, b) => a.seq - b.seq).slice(0, 100).map(wire) };
    }
    const r = await app.call('POST', 'apps/v1/sync', { body: Object.assign({ instance_id: instanceId, epoch: s.epoch, seq: s.seq, results }, body, extra), headers: auth(), cookies: {} });
    s.lastResponse = r;
    if (r.status !== 200) { s.unreported.unshift(...results); return r; }
    s.resync = r.json.resync;
    s.since = r.json.since;
    for (const op of r.json.ops) {
      const res = await apply(op);
      if (!s.dropResults) s.unreported.push(res);
    }
    return r;
  }

  async function syncUntilIdle(max = 8) {
    let r;
    for (let i = 0; i < max; i++) {
      r = await sync();
      if (!r || r.status !== 200) return r;
      if (!r.json.resync && !r.json.ops.length && !s.unreported.length && r.json.since >= s.seq) return r;
    }
    return r;
  }

  async function pair(code) {
    const r = await app.call('POST', 'apps/v1/pair', { body: { app: 'dreamboard', code, instance_id: instanceId, instance_label: label, link_template: '/?goal={id}' }, cookies: {} });
    if (r.status === 200) { s.token = r.json.token; s.resync = true; s.since = 0; }
    return r;
  }

  return { s, board, pair, sync, syncUntilIdle, apply, auth };
}
