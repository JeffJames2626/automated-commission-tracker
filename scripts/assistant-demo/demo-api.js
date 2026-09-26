// In-browser stand-in for /api/assistant, used only by the standalone demo
// (scripts/assistant-demo/build.mjs). It answers the same routes with the
// same response shapes as lib/assistant/router.mjs, over sample data kept in
// this browser's localStorage. Nothing here talks to Google or Claude: the
// assistant's answers are scripted for the sample questions and fall back to
// search for anything else.
(function () {
  'use strict';
  const KEY = 'asst-demo-v2';
  const H = 3600e3, D = 24 * H;
  const now = () => Date.now();
  const iso = t => new Date(t).toISOString();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let seq = 0;
  const id = p => p + '_demo' + Date.now().toString(36) + (seq++).toString(36);

  // ---------------- vocabulary (mirrors lib/assistant/kinds.mjs) ----------------
  const KINDS = {
    idea: { label: 'Idea', emoji: '💡' }, business_idea: { label: 'Business idea', emoji: '🚀' }, product_idea: { label: 'Product idea', emoji: '🧩' },
    task: { label: 'Task', emoji: '✅' }, reminder: { label: 'Reminder', emoji: '⏰' }, goal: { label: 'Goal', emoji: '🎯' }, dream: { label: 'Dream', emoji: '✨' },
    note: { label: 'Note', emoji: '📝' }, person: { label: 'Person', emoji: '👤' }, decision: { label: 'Decision', emoji: '⚖️' }, purchase: { label: 'Purchase', emoji: '🛒' },
    property: { label: 'Property', emoji: '🏡' }, travel: { label: 'Travel idea', emoji: '✈️' }, website: { label: 'Website', emoji: '🔗' }, photo: { label: 'Photo', emoji: '📷' },
    document: { label: 'Document', emoji: '📄' }, voice_note: { label: 'Voice note', emoji: '🎙️' }, thought: { label: 'Random thought', emoji: '💭' }, question: { label: 'Question asked', emoji: '❓' }, journal: { label: 'Journal entry', emoji: '📓' },
  };
  const STATUSES = { inbox: 'Inbox', thinking: 'Thinking', maybe: 'Maybe', active: 'Active', built: 'Built', archived: 'Archived', filed: 'Filed' };
  const PROJECTS = [
    ['ALP', 'business', '🌱', ['Automated Lawn & Pest', 'Automated Lawn and Pest']], ['GemMasters', 'business', '💎', ['Gem Masters']],
    ['Personal', 'area', '🙂', []], ['Dream Board', 'topic', '✨', ['dreamboard']], ['Pricing App', 'project', '🧮', ['pricing tool']],
    ['Sales Tracker', 'project', '📈', ['sales app', 'commission tracker']], ['House', 'area', '🏠', ['home']], ['Travel', 'topic', '✈️', ['trips']],
    ['Investments', 'topic', '📊', ['investing']], ['Future Businesses', 'topic', '🚀', ['new business']],
  ];

  // ---------------- Google sample data (always relative to "now") ----------------
  function today0() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function at(day, h, m = 0) { return today0() + day * D + h * H + m * 60e3; }
  function nextWeekday(wd) { const d = new Date(today0()); let add = (wd - d.getDay() + 7) % 7; if (add === 0) add = 7; return add; }

  function google() {
    const threads = [
      { id: 'demo-t1', title: 'Irrigation plan for the Hendersons', from: 'Josh Carter', email: 'josh@example.com', ago: 20 * H, unread: true, count: 2,
        body: 'I walked the property. I think we replace the controller and convert the back beds to drip. Estimate attached — can you approve by Friday?' },
      { id: 'demo-t2', title: 'Commission question', from: 'Zach Miller', email: 'zach@example.com', ago: 5 * H, unread: true, count: 1,
        body: 'Quick one: does the 8% on new mowing contracts apply to the Dawson account I closed last week?' },
      { id: 'demo-t3', title: 'Re: October schedule', from: 'Ashtin Lee', email: 'ashtin@example.com', ago: 28 * H, unread: false, count: 4,
        body: 'I moved the aeration crew to Tuesdays in October. Let me know if that breaks anything on your side.' },
      { id: 'demo-t4', title: '2027 irrigation pricing', from: 'Ashtin Lee', email: 'ashtin@example.com', ago: 3 * D, unread: false, count: 3,
        body: 'Updated the Pricing Matrix — irrigation hourly is $135 now. The old PDF still says $125, I will retire it.' },
    ].map(t => ({
      provider: 'google_gmail', kind: 'email_thread', recordId: t.id, title: t.title, snippet: t.body, url: 'https://mail.google.com/mail/#all/' + t.id,
      date: iso(now() - t.ago), body: t.body,
      meta: { from: t.from, fromEmail: t.email, lastFrom: t.from, lastFromEmail: t.email, lastFromMe: false, messageCount: t.count, unread: t.unread },
    }));
    const thu = nextWeekday(4);
    const ev = (rid, title, day, h, m, dur, loc, people) => ({
      provider: 'google_calendar', kind: 'event', recordId: 'primary/' + rid, title, snippet: loc || '', url: 'https://calendar.google.com/', date: iso(at(day, h, m)),
      meta: { start: iso(at(day, h, m)), end: iso(at(day, h, m) + dur * 60e3), allDay: false, location: loc || '', calendar: 'Jeff',
        attendees: (people || []).map(p => ({ name: p[0], email: p[1], self: false })).concat([{ name: 'Jeff', email: 'jeff@example.com', self: true }]), attendeeCount: (people || []).length + 1 },
    });
    const events = [
      ev('e1', 'Crew huddle', 0, 7, 30, 30, 'Shop'),
      ev('e2', 'Irrigation walk — Henderson', 0, 14, 0, 60, '41 Oak Ridge Dr', [['Josh Carter', 'josh@example.com']]),
      ev('e3', 'Sales review with Zach', 1, 9, 0, 60, '', [['Zach Miller', 'zach@example.com']]),
      ev('e4', 'Jon — first ride-along', 1, 13, 0, 180, 'Tuesday mowing route', [['Jon Pratt', 'jon@example.com']]),
      ev('e5', 'Commercial client review — Brookside HOA', thu, 10, 0, 60, 'Brookside clubhouse', [['Ashtin Lee', 'ashtin@example.com']]),
      ev('e6', 'Dentist', thu, 15, 30, 45, 'Dr. Patel'),
    ];
    const files = [
      { provider: 'google_sheets', kind: 'spreadsheet', recordId: 'demo-sheet-pricing', title: 'Pricing Matrix 2026', snippet: 'Mowing · Irrigation · Aeration', url: 'https://docs.google.com/spreadsheets/', date: iso(now() - 3 * D), meta: { mimeType: 'sheet', modifiedTime: iso(now() - 3 * D), lastModifiedBy: 'Ashtin Lee', owner: 'Jeff' } },
      { provider: 'google_sheets', kind: 'spreadsheet', recordId: 'demo-sheet-roster', title: 'Employee Roster', snippet: 'Active · Seasonal · Former', url: 'https://docs.google.com/spreadsheets/', date: iso(now() - 12 * D), meta: { mimeType: 'sheet', modifiedTime: iso(now() - 12 * D), lastModifiedBy: 'Ashtin Lee', owner: 'Jeff' } },
      { provider: 'google_drive', kind: 'document', recordId: 'demo-doc-onboarding', title: 'Jon — onboarding plan', snippet: '', url: 'https://docs.google.com/document/', date: iso(now() - 2 * D), meta: { mimeType: 'doc', modifiedTime: iso(now() - 2 * D), lastModifiedBy: 'Jeff', owner: 'Jeff' } },
      { provider: 'google_drive', kind: 'pdf', recordId: 'demo-pdf-irrigation', title: 'Irrigation Service Pricing (2025).pdf', snippet: '', url: 'https://drive.google.com/', date: iso(now() - 570 * D), meta: { mimeType: 'pdf', modifiedTime: iso(now() - 570 * D), owner: 'Jeff' } },
    ];
    const contacts = [['c1', 'Josh Carter', 'josh@example.com', 'Irrigation lead'], ['c2', 'Zach Miller', 'zach@example.com', 'Sales'], ['c3', 'Ashtin Lee', 'ashtin@example.com', 'Office manager'], ['c4', 'Jon Pratt', 'jon@example.com', 'New tech']]
      .map(c => ({ provider: 'google_contacts', kind: 'contact', recordId: 'people/' + c[0], title: c[1], snippet: c[3] + ' · ' + c[2], url: 'https://contacts.google.com/', date: null, meta: { emails: [c[2]], company: 'ALP', jobTitle: c[3] } }));
    return { threads, events, files, contacts };
  }

  // ---------------- persisted sample notes ----------------
  function seed() {
    const s = { v: 2, seededAt: now(), projects: [], captures: [], memories: [], people: [], conversations: [], messages: [], actions: [], attachments: {}, disabled: [], disconnected: false, dreams: [], ops: [], boardOffline: false };
    PROJECTS.forEach(([name, kind, emoji, aliases]) => s.projects.push({ id: id('prj'), name, kind, emoji, aliases, description: null, status: 'active', created_at: iso(now() - 60 * D) }));
    const P = n => s.projects.find(p => p.name === n).id;
    const people = [['Josh Carter', 'Irrigation lead', 'josh@example.com'], ['Zach Miller', 'Sales', 'zach@example.com'], ['Ashtin Lee', 'Office manager', 'ashtin@example.com'], ['Jon Pratt', 'New tech', 'jon@example.com']];
    people.forEach(([n, r, e]) => s.people.push({ id: id('per'), display_name: n, role: r, aliases: [n.split(' ')[0]], identities: [{ provider: 'email', provider_id: e }], notes: null }));
    const who = n => s.people.find(p => p.display_name.startsWith(n)).id;
    const cap = (o) => {
      const c = Object.assign({ id: id('cap'), kind: 'note', status: 'inbox', title: '', raw_text: '', summary: null, next_action: null, source_type: 'text', url: null, project_id: null,
        details: {}, ai: { how: 'ai', confidence: 0.9 }, classification_state: 'done', due_at: null, completed_at: null, tags: [], people: [], attachments: [] }, o);
      c.captured_at = c.captured_at || iso(now() - (o.ago || 1) * D); c.updated_at = o.touched ? iso(now() - o.touched * D) : c.captured_at;
      delete c.ago; delete c.touched;
      s.captures.push(c); return c;
    };
    cap({ kind: 'idea', status: 'thinking', project_id: P('ALP'), ago: 6, title: 'Customer portal for ALP clients', raw_text: 'Build a customer portal where ALP clients can see their services and photos.', summary: 'A client-facing portal showing each customer their scheduled and completed services, with before/after photos from the crew.', next_action: 'Sketch the three screens a customer would see first.', tags: ['software', 'customers'] });
    cap({ kind: 'product_idea', status: 'inbox', project_id: P('Sales Tracker'), ago: 2, source_type: 'voice', title: 'Employee “player cards” in the sales app',
      raw_text: 'I had an idea. On the sales app, I think when you open an employee we should show their truck, picture, KPIs, and maybe make it kind of like a video game player card. Save that under the sales tracker.',
      summary: 'When opening an employee in the Sales Tracker, show a game-style player card: photo, assigned truck and headline KPIs.', next_action: 'List the 4–5 KPIs worth showing on the card.', tags: ['sales', 'ui'] });
    cap({ kind: 'business_idea', project_id: P('Future Businesses'), ago: 9, title: 'Gutter cleaning as a fall add-on', raw_text: 'New business idea: offer gutter cleaning as an add-on for fall leaf clean-up customers.', summary: 'Sell gutter cleaning to existing fall clean-up customers as a bundled add-on.' });
    const lakeCap = cap({ kind: 'dream', status: 'filed', project_id: P('Dream Board'), ago: 30, title: 'Lake house in north Georgia', raw_text: 'Save this for the dream board: lake house on Lake Burton, dock, room for the whole family at Thanksgiving.' });
    cap({ kind: 'property', project_id: P('Investments'), ago: 4, title: 'Look into 12 acres off Hwy 9', raw_text: 'Look into buying this property — 12 acres off Hwy 9, listed at $410k, creek on the back side.', next_action: 'Ask the listing agent about road frontage and perc test.' });
    cap({ kind: 'task', project_id: P('ALP'), ago: 1, title: 'Send the Henderson irrigation estimate', raw_text: 'Need to send the Henderson irrigation estimate today by 5', due_at: iso(at(0, 17)), people: [who('Josh')] });
    cap({ kind: 'reminder', project_id: P('ALP'), ago: 1, title: 'Call Josh about the controller', raw_text: 'Remind me tomorrow to call Josh about the controller swap', due_at: iso(at(1, 9)), people: [who('Josh')] });
    cap({ kind: 'goal', status: 'active', project_id: P('ALP'), ago: 45, touched: 30, title: '$1.2M recurring revenue by end of 2027', raw_text: 'Goal: get ALP to $1.2M in recurring revenue by the end of 2027.' });
    cap({ kind: 'decision', status: 'active', project_id: P('ALP'), ago: 12, title: 'Zach: 8% on new mowing contracts', raw_text: 'We decided Zach gets 8% commission on new mowing contracts, starting this month.', people: [who('Zach')], tags: ['commission'] });
    cap({ kind: 'note', project_id: P('ALP'), ago: 8, title: 'Raise service-call minimum to $95', raw_text: 'Raise the irrigation service-call minimum to $95 — we lose money on short calls.', tags: ['pricing'] });
    cap({ kind: 'idea', status: 'thinking', project_id: P('Pricing App'), ago: 50, touched: 40, title: 'Revamp the sprinkler pricing app', raw_text: 'Revamp sprinkler pricing app so estimators can price zones and heads on site.', summary: 'Let estimators price irrigation by zone and head count on site, from their phone.', tags: ['pricing', 'software'] });
    cap({ kind: 'purchase', status: 'maybe', project_id: P('ALP'), ago: 15, title: 'New 60" zero-turn mower', raw_text: 'Buy a new 60 inch zero-turn before spring — the old one is at 2,100 hours.' });
    cap({ kind: 'travel', status: 'maybe', project_id: P('Travel'), ago: 20, title: 'Anniversary trip to Charleston', raw_text: 'Travel idea: anniversary trip to Charleston in April.' });
    cap({ kind: 'idea', project_id: P('ALP'), ago: 18, title: 'Monthly photo report for commercial clients', raw_text: 'Idea: send commercial clients a monthly report with photos of the work and what is coming next month.', tags: ['commercial', 'reporting'] });
    cap({ kind: 'idea', project_id: P('ALP'), ago: 33, title: 'Commercial client reporting dashboard', raw_text: 'What if commercial clients had a dashboard with service history, photos and upcoming work — better reporting for HOAs.', tags: ['commercial', 'reporting'] });
    const mem = (kind, statement, project, ago) => s.memories.push({ id: id('mem'), kind, statement, subject_type: project ? 'project' : null, subject_id: project ? P(project) : null, source_type: 'capture', source_id: null, status: 'active', created_at: iso(now() - ago * D) });
    mem('decision', 'Zach gets 8% commission on new mowing contracts (decided this month)', 'ALP', 12);
    mem('fact', 'Irrigation service-call minimum is $95', 'ALP', 8);
    mem('preference', 'Prefers a text over a call for crew updates', null, 25);
    mem('goal', 'Reach $1.2M recurring revenue by end of 2027', 'ALP', 45);
    s.memories[0].source_id = s.captures.find(c => c.kind === 'decision').id;
    mem('fact', 'Lake house budget is $2M', 'Dream Board', 60);
    s.memories[s.memories.length - 1].source_type = 'user';
    // Dream Board's goals, as its last sync published them.
    const goal = (id_, title, status, category, fields, extra = {}) => s.dreams.push(Object.assign({ id: id_, title, status, category, fields, aliases: [], milestones: [], notes: [], changes: [],
      words: [], created_at: iso(now() - 90 * D), updated_at: iso(now() - 2 * D) }, extra));
    goal('g-lake', 'Lake House', 'in_progress', 'Home', { target_amount: 1800000, saved_amount: 240000, target_date: '2029-06' }, {
      milestones: [{ id: 'm1', title: 'Pick the lake', done: true, done_at: iso(now() - 5 * D) }, { id: 'm2', title: 'Save the down payment', done: false }],
      words: [lakeCap.id],
      changes: [
        { kind: 'created', text: 'added to Dream Board', at: iso(now() - 30 * D), by: 'capture' },
        { kind: 'updated', text: 'target amount $1.2M → $1.8M', at: iso(now() - 21 * D), by: 'dream_board' },
        { kind: 'milestone_completed', text: 'milestone completed: Pick the lake', at: iso(now() - 5 * D), by: 'dream_board', progress: true },
      ] });
    goal('g-fit', 'Fitness', 'in_progress', 'Health', { target_date: '2026-12' }, { updated_at: iso(now() - 52 * D), changes: [{ kind: 'created', text: 'added to Dream Board', at: iso(now() - 120 * D), by: 'dream_board' }] });
    goal('g-beach', 'Beach House', 'dreaming', 'Home', { target_amount: 650000 });
    goal('g-bronco', 'Vintage Bronco', 'planned', 'Fun', { target_amount: 85000, saved_amount: 30000 });
    s.ops.push({ id: 'op_seed', kind: 'create_goal', capture_id: lakeCap.id, status: 'applied', target: 'g-lake', title: 'Lake House', created_at: lakeCap.captured_at, done_at: lakeCap.captured_at,
      trace: ['captured', 'routed', 'queued', 'sent', 'acknowledged'].map(st => ({ stage: st, at: lakeCap.captured_at })) });
    return s;
  }

  let S;
  function load() { try { S = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { S = null; } if (!S || S.v !== 2) { S = seed(); save(); } }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(S)); }
    catch { try { const lite = Object.assign({}, S, { attachments: {} }); localStorage.setItem(KEY, JSON.stringify(lite)); } catch { /* storage unavailable: demo still runs in memory */ } }
  }
  load();
  window.__asstAttachmentUrl = aid => { const a = S.attachments[aid]; return a ? 'data:' + a.mime + ';base64,' + a.data : null; };

  // ---------------- shaping records like the server does ----------------
  const proj = pid => S.projects.find(p => p.id === pid) || null;
  function listItem(c) {
    const p = proj(c.project_id);
    return { id: c.id, kind: c.kind, status: c.status, title: c.title, summary: c.summary, next_action: c.next_action, source_type: c.source_type, url: c.url, project_id: c.project_id,
      classification_state: c.classification_state, due_at: c.due_at, completed_at: c.completed_at, captured_at: c.captured_at, updated_at: c.updated_at,
      raw_preview: (c.raw_text || '').slice(0, 280), details: c.details, project_name: p ? p.name : null, project_emoji: p ? p.emoji : null, attachment_count: (c.attachments || []).length,
      route_status: (liveOp(c.id) || {}).status || null };
  }
  function fullItem(c) {
    return Object.assign(listItem(c), { raw_text: c.raw_text, ai: c.ai,
      attachments: (c.attachments || []).map(aid => Object.assign({ id: aid }, S.attachments[aid] ? { kind: S.attachments[aid].kind, mime: S.attachments[aid].mime, name: S.attachments[aid].name, transcript: S.attachments[aid].transcript } : { kind: 'file', mime: 'application/octet-stream', name: 'attachment' })),
      people: (c.people || []).map(pid => S.people.find(p => p.id === pid)).filter(Boolean).map(p => ({ id: p.id, display_name: p.display_name })),
      tags: (c.tags || []).map(t => ({ id: 'tag_' + t, name: t })), sources: [] });
  }
  const words = t => String(t || '').toLowerCase().replace(/[^a-z0-9$\s]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !/^(the|and|for|what|did|about|with|have|has|you|your|are|was|this|that|find|show|me|my|all|any|how|much|who|when|where|tell)$/.test(w));
  function matchScore(text, q) { const ws = words(q); if (!ws.length) return 0; const t = String(text || '').toLowerCase(); return ws.filter(w => t.includes(w.replace(/s$/, ''))).length; }
  function counts() {
    const c = S.captures.filter(x => x.kind !== 'question');
    return { inbox: c.filter(x => x.status === 'inbox').length, open_tasks: c.filter(x => ['task', 'reminder'].includes(x.kind) && !x.completed_at).length, total: c.length };
  }
  function projectsOut() {
    return S.projects.map(p => {
      const cs = S.captures.filter(c => c.project_id === p.id && c.kind !== 'question');
      return Object.assign({}, p, { capture_count: cs.length, last_capture_at: cs.map(c => c.captured_at).sort().pop() || null });
    }).sort((a, b) => String(b.last_capture_at || '').localeCompare(String(a.last_capture_at || '')));
  }

  // ---------------- rule-based filing (mirrors the server's offline classifier) ----------------
  const RULES = [
    ['reminder', /\bremind me\b|\breminder\b|\bdon'?t forget\b/i], ['business_idea', /\bbusiness idea\b|\bnew business\b/i],
    ['product_idea', /\bproduct idea\b|\bapp idea\b|\bfeature idea\b/i], ['dream', /\bdream ?board\b|\bdream\b|\bbucket list\b/i],
    ['goal', /\bmy goal\b|\bgoal\b/i], ['property', /\bproperty\b|\bacres?\b|\breal estate\b/i], ['travel', /\btrip\b|\btravel\b|\bvacation\b/i],
    ['purchase', /\bbuy\b|\bpurchase\b/i], ['decision', /\bwe decided\b|\bdecided to\b/i],
    ['task', /\bneed to\b|\bhave to\b|\bfollow up\b|\bcall\b|\bemail\b|\bschedule\b|\blook into\b/i],
    ['idea', /\bidea\b|\bwhat if\b|\bwe (could|should)\b|^(build|create|launch|design|offer)\b/i],
  ];
  function detectIntent(t) {
    t = String(t || '').trim();
    if (/^(remember|remind|note|idea|new idea|business idea|save|add|capture|todo|i had an idea|i need to|need to|buy|look into|dream|goal|someday)\b/i.test(t)) return 'capture';
    if (/\?\s*$/.test(t)) return 'question';
    if (/^(what|what's|whats|when|where|who|why|how|which|is|are|do|does|did|can|could|should|find|show|search|list|summari[sz]e|catch me up|tell me|give me|pull up|any)\b/i.test(t) && t.length < 300) return 'question';
    return 'capture';
  }
  function dueFrom(t) {
    const hm = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
    const hour = hm ? (+hm[1] % 12) + (/pm/i.test(hm[3]) ? 12 : 0) : null;
    const mk = (day, h) => iso(at(day, hour ?? h, hm && hm[2] ? +hm[2] : 0));
    if (/\btonight\b/i.test(t)) return mk(0, 19);
    if (/\btoday\b/i.test(t)) return mk(0, Math.min(23, new Date().getHours() + 2));
    if (/\btomorrow\b/i.test(t)) return mk(1, 9);
    const wd = t.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
    if (wd) return mk(nextWeekday(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].indexOf(wd[1].toLowerCase())), 9);
    return hm ? mk(0, hour) : null;
  }
  function classify(c) {
    const t = c.raw_text || '';
    let kind = null;
    for (const [k, re] of RULES) if (re.test(t)) { kind = k; break; }
    if (!kind) kind = c.source_type === 'photo' ? 'photo' : c.source_type === 'file' ? 'document' : c.url && t.replace(c.url, '').trim().length < 20 ? 'website' : c.source_type === 'voice' ? 'voice_note' : t.length < 140 ? 'thought' : 'note';
    const low = ' ' + t.toLowerCase().replace(/[^a-z0-9&']+/g, ' ') + ' ';
    const hit = S.projects.map(p => ({ p, n: [p.name].concat(p.aliases || []).map(x => x.toLowerCase().replace(/[^a-z0-9&']+/g, ' ').trim()).filter(x => low.includes(' ' + x + ' ')).sort((a, b) => b.length - a.length)[0] })).filter(x => x.n).sort((a, b) => b.n.length - a.n.length)[0];
    let title = t.replace(/^(remember( this)?( idea)?( for [\w &]+)?|remind me( to)?|new (business )?idea[:,]?|idea[:,]|note[:,]|save (this )?(for|to|under) [\w ]+[:,]?)\s*/i, '').replace(/\s+/g, ' ').trim() || (c.url ? c.url.replace(/^https?:\/\/(www\.)?/, '') : 'Untitled capture');
    title = title[0].toUpperCase() + title.slice(1);
    if (title.length > 80) title = title.slice(0, 77).replace(/\s+\S*$/, '') + '…';
    Object.assign(c, { kind, title, project_id: hit ? hit.p.id : null, due_at: ['task', 'reminder'].includes(kind) ? dueFrom(t) : null, classification_state: 'done', ai: { how: 'ai', confidence: 0.72 } });
    const ppl = S.people.filter(p => new RegExp('\\b' + p.display_name.split(' ')[0] + '\\b', 'i').test(t)).map(p => p.id);
    c.people = ppl;
    c.tags = [...new Set((t.match(/#[\w-]{2,30}/g) || []).map(x => x.slice(1)))];
  }

  // ---------------- sources (the citation registry) ----------------
  const LABEL = { dreamboard: 'Dream Board', notes: 'My notes', memory: 'Memory', google_gmail: 'Email', google_calendar: 'Calendar', google_drive: 'Drive', google_sheets: 'Sheets', google_contacts: 'Contacts' };
  function Registry() { this.list = []; }
  Registry.prototype.add = function (it, evidence) {
    let s = this.list.find(x => x.provider === it.provider && x.recordId === it.recordId);
    if (!s) { s = { id: 'S' + (this.list.length + 1), provider: it.provider, label: LABEL[it.provider] || it.provider, kind: it.kind, recordId: it.recordId, title: it.title, url: it.url || null, date: it.date || null, snippet: it.snippet || '', evidence: [], cited: false }; this.list.push(s); }
    if (evidence && !s.evidence.includes(evidence)) s.evidence.push(evidence);
    return s.id;
  };
  Registry.prototype.cite = function (text) { const ids = new Set((text.match(/\[S\d+\]/g) || []).map(x => x.slice(1, -1))); this.list.forEach(s => { s.cited = ids.has(s.id); }); return this.list; };
  const noteSrc = c => ({ provider: 'notes', kind: c.kind, recordId: c.id, title: c.title, url: '#/item/' + c.id, date: c.captured_at, snippet: c.summary || c.raw_text });
  const memSrc = m => ({ provider: 'memory', kind: m.kind, recordId: m.id, title: m.statement, url: '#/memory', date: m.created_at });
  const fmtT = t => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const fmtD = t => new Date(t).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });

  // ---------------- scripted assistant ----------------
  async function answer(q, emit) {
    const G = google(), reg = new Registry(), trace = [], actions = [], created = [];
    const low = q.toLowerCase();
    const step = async (tool, input, count, status) => { emit({ type: 'status', text: status }); await sleep(420 + Math.random() * 300); trace.push({ tool, input, count, ms: 300 }); };
    const T = rid => G.threads.find(t => t.recordId === rid), E = rid => G.events.find(e => e.recordId === rid), F = rid => G.files.find(f => f.recordId === rid);
    let text;

    if (/\b(send|email|reply|text|message)\b.*\b(zach|josh|ashtin|jon)\b/.test(low)) {
      const name = (low.match(/\b(zach|josh|ashtin|jon)\b/) || [])[1];
      const person = S.people.find(p => p.display_name.toLowerCase().startsWith(name));
      await step('find_people', { name }, 1, 'Looking up ' + person.display_name.split(' ')[0]);
      const email = person.identities[0].provider_id;
      const a = { id: id('act'), kind: 'send_email', summary: 'Email ' + person.display_name + ' — draft ready for your review', status: 'proposed',
        payload: { to: email, subject: name === 'zach' ? 'Re: Commission question' : 'Quick follow-up', body: name === 'zach' ? 'Hi Zach — yes, the 8% applies to Dawson since it closed after we set the new rate. — Jeff' : 'Hi ' + person.display_name.split(' ')[0] + ' — following up on this. — Jeff' } };
      S.actions.push(a); actions.push(a);
      trace.push({ tool: 'propose_action', input: { kind: 'send_email', to: email }, count: 1, ms: 5 });
      text = 'I drafted the email to **' + person.display_name + '** — review it below. Nothing is sent until you confirm, and then Gmail opens with it ready for you to press Send.';
    } else if (/^remember\b|\bremember that\b/.test(low)) {
      const st = q.replace(/^.*?remember( that)?\s*/i, '').replace(/[.]$/, '');
      const m = { id: id('mem'), kind: /decid/.test(low) ? 'decision' : 'fact', statement: st[0].toUpperCase() + st.slice(1), subject_type: null, subject_id: null, source_type: 'conversation', source_id: null, status: 'active', created_at: iso(now()) };
      S.memories.unshift(m); created.push({ type: 'memory', id: m.id, title: m.statement });
      trace.push({ tool: 'remember', input: { statement: m.statement }, count: 1, ms: 5 });
      text = 'Got it — I’ll remember that: “' + m.statement + '”.';
    } else if (/josh|irrigation|drip|controller|henderson/.test(low)) {
      await step('find_people', { name: 'Josh' }, 2, 'Looking up Josh');
      reg.add(G.contacts[0]);
      await step('search_gmail', { query: 'from:josh@example.com irrigation' }, 1, 'Searching Gmail: from:josh@example.com irrigation');
      await step('read_email_thread', { thread_id: 'demo-t1' }, 1, 'Reading an email thread');
      const t = reg.add(T('demo-t1'), T('demo-t1').body);
      await step('calendar_events', { start: iso(at(0, 0)), end: iso(at(7, 0)), query: 'Henderson' }, 1, 'Checking your calendar for “Henderson”');
      const e = reg.add(E('primary/e2'), 'Irrigation walk — Henderson · 41 Oak Ridge Dr · with Josh Carter');
      await step('search_my_notes', { query: 'Henderson irrigation' }, 2, 'Searching your notes for “Henderson irrigation”');
      const task = S.captures.find(c => /henderson/i.test(c.title) && c.kind === 'task');
      const n = task ? reg.add(noteSrc(task), task.raw_text) : null;
      text = 'Josh walked the Henderson property and recommends **replacing the controller and converting the back beds to drip** [' + t + ']. He attached an estimate and asked you to approve it by Friday [' + t + '].\n\n' +
        '- You’re walking the property with him today at ' + fmtT(E('primary/e2').meta.start) + ' [' + e + ']' + (n ? '\n- You also noted you need to send the Henderson estimate today [' + n + ']' : '');
    } else if (/zach|commission/.test(low)) {
      await step('search_my_notes', { query: 'Zach commission' }, 2, 'Searching your notes for “Zach commission”');
      const m = reg.add(memSrc(S.memories.find(x => /Zach/.test(x.statement)) || S.memories[0]), 'Zach gets 8% commission on new mowing contracts');
      const dec = S.captures.find(c => c.kind === 'decision'); const d = dec ? reg.add(noteSrc(dec), dec.raw_text) : null;
      await step('search_gmail', { query: 'from:zach@example.com' }, 1, 'Searching Gmail: from:zach@example.com');
      const t = reg.add(T('demo-t2'), T('demo-t2').body);
      text = 'You decided Zach gets **8% commission on new mowing contracts** [' + m + ']' + (d ? '[' + d + ']' : '') + '.\n\nHe emailed ' + Math.round((now() - Date.parse(T('demo-t2').date)) / H) + ' hours ago asking whether that applies to the **Dawson** account he closed last week [' + t + '] — it’s still unanswered. Want me to draft a reply?';
    } else if (/pric|mowing|acre|per hour|hourly|\$/.test(low)) {
      await step('search_drive', { query: 'pricing', type: 'sheet' }, 2, 'Searching Drive for “pricing”');
      await step('inspect_spreadsheet', { spreadsheet: 'demo-sheet-pricing' }, 1, 'Inspecting a spreadsheet');
      await step('read_sheet_range', { spreadsheet: 'demo-sheet-pricing', range: "'Mowing'!A1:C8" }, 6, "Reading 'Mowing'!A1:C8");
      const mow = reg.add({ provider: 'google_sheets', kind: 'sheet_range', recordId: 'pricing!Mowing', title: "Pricing Matrix 2026 → 'Mowing'!A1:C8", url: F('demo-sheet-pricing').url, date: F('demo-sheet-pricing').date }, 'Mowing | Under 1/2 acre | $45 // Mowing | 1/2 – 1 acre | $65 // Mowing | Over 1 acre | $135 per acre');
      await step('read_sheet_range', { spreadsheet: 'demo-sheet-pricing', range: "'Irrigation'!A1:B6" }, 3, "Reading 'Irrigation'!A1:B6");
      const irr = reg.add({ provider: 'google_sheets', kind: 'sheet_range', recordId: 'pricing!Irrigation', title: "Pricing Matrix 2026 → 'Irrigation'!A1:B6", url: F('demo-sheet-pricing').url, date: F('demo-sheet-pricing').date }, 'Service call | $95 minimum // Hourly | $135/hr');
      await step('read_drive_file', { file_id: 'demo-pdf-irrigation' }, 1, 'Reading a document');
      const pdf = reg.add(F('demo-pdf-irrigation'), 'Irrigation labor: $125 per hour, 1-hour minimum.');
      text = 'From the **Pricing Matrix 2026** sheet, Mowing tab [' + mow + ']:\n- Under ½ acre: **$45** per visit\n- ½–1 acre: **$65**\n- Over 1 acre: **$135 per acre**\n\n' +
        '**Heads-up — two different irrigation rates:**\n- Pricing Matrix 2026, Irrigation tab: **$135/hr**, $95 service-call minimum [' + irr + ']\n- Older “Irrigation Service Pricing (2025).pdf”: **$125/hr** [' + pdf + ']\n\nThe sheet was updated ' + Math.round((now() - Date.parse(F('demo-sheet-pricing').date)) / D) + ' days ago and the PDF in 2025, so $135/hr is most likely current.';
    } else if (/tomorrow|working on|supposed to|to ?do/.test(low)) {
      await step('calendar_events', { start: iso(at(1, 0)), end: iso(at(2, 0)) }, 2, 'Checking your calendar');
      const e3 = reg.add(E('primary/e3')), e4 = reg.add(E('primary/e4'));
      await step('list_my_items', { kinds: ['task', 'reminder'], due_from: iso(at(1, 0)), due_to: iso(at(2, 0)), open_only: true }, 1, 'Checking your list');
      const rem = S.captures.filter(c => c.due_at && Date.parse(c.due_at) >= at(1, 0) && Date.parse(c.due_at) < at(2, 0) && !c.completed_at);
      const goal = S.captures.find(c => c.kind === 'goal');
      const g = goal ? reg.add(noteSrc(goal)) : null;
      text = '**Tomorrow, ' + fmtD(at(1, 0)) + '**\n- ' + fmtT(E('primary/e3').meta.start) + ' — Sales review with Zach [' + e3 + ']\n- ' + fmtT(E('primary/e4').meta.start) + ' — Jon’s first ride-along on the Tuesday route [' + e4 + ']\n' +
        rem.map(c => '- ' + c.title + ' (' + fmtT(c.due_at) + ') [' + reg.add(noteSrc(c)) + ']').join('\n') +
        (g ? '\n\nWorth keeping in view: your active goal of $1.2M recurring revenue by end of 2027 [' + g + '] — it hasn’t been touched in a month.' : '');
    } else if (/thursday|appointment|meeting|calendar|schedule/.test(low)) {
      await step('calendar_events', { start: iso(at(nextWeekday(4), 0)), end: iso(at(nextWeekday(4) + 1, 0)) }, 2, 'Checking your calendar');
      const a = reg.add(E('primary/e5')), b = reg.add(E('primary/e6'));
      text = '**' + fmtD(E('primary/e5').meta.start) + '**\n- ' + fmtT(E('primary/e5').meta.start) + ' — Commercial client review, Brookside HOA, with Ashtin [' + a + ']\n- ' + fmtT(E('primary/e6').meta.start) + ' — Dentist, Dr. Patel [' + b + ']\n\nFor the Brookside review, you have two related ideas about commercial client reporting you could bring up.';
    } else if (/email|inbox|unread|dealt with|waiting|reply/.test(low)) {
      await step('search_gmail', { query: 'in:inbox newer_than:3d -category:promotions' }, 3, 'Searching Gmail: in:inbox newer_than:3d');
      const lines = G.threads.slice(0, 3).map(t => '- **' + t.meta.from + '** — ' + t.title + ': ' + t.body.split('. ')[0] + ' [' + reg.add(t, t.body) + ']');
      text = 'Three threads look like they’re waiting on you:\n' + lines.join('\n') + '\n\nThe first two are unread. Nothing here looks urgent beyond Josh wanting an answer by Friday.';
    } else if (/onboard|jon\b/.test(low)) {
      await step('search_drive', { query: 'Jon onboarding', type: 'doc' }, 1, 'Searching Drive for “Jon onboarding”');
      await step('read_drive_file', { file_id: 'demo-doc-onboarding' }, 1, 'Reading a document');
      const d = reg.add(F('demo-doc-onboarding'), 'Day 1: truck walkaround, safety, uniforms. Day 2: ride along on the Tuesday mowing route. Day 3: first solo stops with Josh checking in.');
      const e = reg.add(E('primary/e4'));
      text = 'That’s **“Jon — onboarding plan”** in Drive [' + d + ']:\n1. Day 1: truck walkaround, safety, uniforms\n2. Day 2: ride-along on the Tuesday mowing route\n3. Day 3: first solo stops with Josh checking in\n\nHis first ride-along is on your calendar tomorrow [' + e + '].';
    } else if (/lake house|lake/.test(low)) {
      await step('get_dream', { dream: 'lake house' }, 3, 'Opening lake house');
      const g = S.dreams.find(x => x.id === 'g-lake'), w = S.captures.find(c => c.id === g.words[0]);
      const sg = reg.add(dreamSrc(g), 'target amount $1.8M · saved $240,000 · milestones 1/2'), sw = reg.add(noteSrc(w), w.raw_text);
      const sm = reg.add({ provider: 'memory', kind: 'fact', recordId: S.memories.find(m => /lake house budget/i.test(m.statement)).id, title: 'Lake house budget is $2M', url: '#/memory' });
      text = '**Lake House** is in progress in Dream Board [' + sg + ']:\n- Target: originally **$1.2M**, raised to **$1.8M** three weeks ago [' + sg + ']\n- Saved so far: $240,000; “Pick the lake” was completed this week [' + sg + ']\n\nWhen you first saved it you said: “lake house on Lake Burton, dock, room for the whole family at Thanksgiving” [' + sw + '].\n\nOne thing doesn’t line up: you once told me the budget was **$2M** [' + sm + ']. Dream Board is the record, so the current target is $1.8M.';
    } else if (/dream/.test(low)) {
      await step('list_dreams', { sort: 'amount' }, S.dreams.length, 'Checking Dream Board');
      text = 'Your dreams in Dream Board, biggest first:\n' + S.dreams.slice().sort((a, b) => (b.fields.target_amount || 0) - (a.fields.target_amount || 0)).map(g => '- **' + g.title + '** — ' + g.status.replace('_', ' ') + (g.fields.target_amount ? ', target ' + money(g.fields.target_amount, 'target_amount') : '') + (lastProgress(g) ? ', progress this week' : now() - Date.parse(lastChange(g)) > 45 * D ? ', no update in ' + Math.floor((now() - Date.parse(lastChange(g))) / D) + ' days' : '') + ' [' + reg.add(dreamSrc(g)) + ']').join('\n');
    } else if (/unfinished|never acted|biggest|goals?|revisit/.test(low)) {
      await step('list_my_items', { kinds: ['idea', 'business_idea', 'product_idea', 'goal'], statuses: ['thinking', 'active', 'maybe'], order: 'oldest' }, 4, 'Checking your list');
      const cs = S.captures.filter(c => ['idea', 'business_idea', 'product_idea', 'goal'].includes(c.kind) && ['thinking', 'active', 'maybe'].includes(c.status)).sort((a, b) => a.updated_at.localeCompare(b.updated_at));
      text = 'Ideas and goals you’ve kept open the longest:\n' + cs.map(c => '- **' + c.title + '** — ' + STATUSES[c.status].toLowerCase() + ', last touched ' + Math.round((now() - Date.parse(c.updated_at)) / D) + ' days ago [' + reg.add(noteSrc(c), c.summary || c.raw_text) + ']').join('\n') +
        '\n\nThe two commercial-reporting ideas overlap — they may be one project.';
    } else if (/idea|sales|alp/.test(low)) {
      await step('search_my_notes', { query: 'ALP sales ideas', kinds: ['idea', 'business_idea', 'product_idea'] }, 4, 'Searching your notes for “ALP sales ideas”');
      const cs = S.captures.filter(c => /idea/.test(c.kind)).sort((a, b) => b.captured_at.localeCompare(a.captured_at)).slice(0, 5);
      text = 'Your recent ideas:\n' + cs.map(c => '- **' + c.title + '**' + (proj(c.project_id) ? ' (' + proj(c.project_id).name + ')' : '') + ' [' + reg.add(noteSrc(c), c.summary || c.raw_text) + ']').join('\n') +
        '\n\nThe player-card idea and the customer portal both came in this week.';
    } else {
      await step('search_my_notes', { query: q }, 0, 'Searching your notes');
      const r = search(q);
      const lines = [];
      r.groups.forEach(g => g.items.slice(0, 3).forEach(it => { if (it.provider === 'project' || it.provider === 'person') return; lines.push('- ' + it.title + ' [' + reg.add(it, it.snippet) + '] — ' + (LABEL[it.provider] || it.provider)); }));
      text = lines.length ? 'Here’s what I found across your notes and connected accounts:\n' + lines.slice(0, 8).join('\n') : 'I searched your notes, email, calendar and Drive and didn’t find anything about that. Try different words, or capture it so I can remember it next time.';
      text += '\n\n*This demo has scripted answers for the suggested questions; anything else falls back to search.*';
    }
    const sources = reg.cite(text);
    return { content: text, sources, trace, actions, created, model: 'Claude (demo — scripted answer)' };
  }

  // ---------------- universal search ----------------
  function search(q) {
    const G = google();
    const byScore = (arr, f) => arr.map(x => [x, matchScore(f(x), q)]).filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]).map(x => x[0]);
    const caps = byScore(S.captures.filter(c => c.kind !== 'question'), c => [c.title, c.raw_text, c.summary, (c.tags || []).join(' ')].join(' '));
    const ci = c => ({ provider: 'notes', kind: c.kind, recordId: c.id, title: c.title, url: '#/item/' + c.id, date: c.captured_at, snippet: c.summary || c.raw_text,
      meta: { kind: c.kind, kindLabel: KINDS[c.kind].label, status: c.status, project: proj(c.project_id) ? proj(c.project_id).name : null, emoji: KINDS[c.kind].emoji } });
    const IDEA = ['idea', 'business_idea', 'product_idea', 'dream', 'goal'], TASK = ['task', 'reminder'];
    const off = svc => S.disconnected ? 'not_connected' : S.disabled.includes(svc) ? 'disabled' : 'ok';
    const grp = (key, label, items, svc) => ({ key, label, status: svc ? off(svc) : 'ok', items: svc && off(svc) !== 'ok' ? [] : items.slice(0, 6) });
    const files = byScore(G.files, f => f.title + ' ' + f.snippet);
    return { query: q, groups: [
      grp('ideas', 'Ideas', caps.filter(c => IDEA.includes(c.kind)).map(ci)),
      Object.assign(grp('dreams', 'Dream Board', byScore(S.dreams, g => [g.title, g.category, g.aliases.join(' ')].join(' ')).map(g => Object.assign(dreamSrc(g), { snippet: [g.status, g.category].filter(Boolean).join(' · ') }))), { freshness: boardFresh() }),
      grp('tasks', 'Tasks & reminders', caps.filter(c => TASK.includes(c.kind)).map(ci)),
      grp('notes', 'Notes', caps.filter(c => !IDEA.includes(c.kind) && !TASK.includes(c.kind)).map(ci)),
      grp('memory', 'Memory', byScore(S.memories.filter(m => m.status === 'active'), m => m.statement).map(m => ({ provider: 'memory', kind: m.kind, recordId: m.id, title: m.statement, url: '#/memory', date: m.created_at, snippet: m.kind }))),
      grp('projects', 'Projects', projectsOut().filter(p => matchScore(p.name + ' ' + (p.aliases || []).join(' '), q)).map(p => ({ provider: 'project', kind: p.kind, recordId: p.id, title: p.emoji + ' ' + p.name, url: '#/project/' + p.id, snippet: p.capture_count + (p.capture_count === 1 ? ' item' : ' items'), date: p.last_capture_at }))),
      grp('people', 'People', S.people.filter(p => !p.merged_into && matchScore(p.display_name + ' ' + p.role, q)).map(p => ({ provider: 'person', kind: 'person', recordId: p.id, title: p.display_name, url: '#/person/' + p.id, snippet: p.role }))),
      grp('email', 'Email', byScore(G.threads, t => t.title + ' ' + t.body + ' ' + t.meta.from), 'gmail'),
      grp('sheets', 'Sheets', files.filter(f => f.provider === 'google_sheets'), 'sheets'),
      grp('drive', 'Drive & Docs', files.filter(f => f.provider === 'google_drive'), 'drive'),
      grp('calendar', 'Calendar', byScore(G.events, e => e.title + ' ' + e.meta.location + ' ' + e.meta.attendees.map(a => a.name).join(' ')), 'calendar'),
      grp('contacts', 'Contacts', byScore(G.contacts, c => c.title + ' ' + c.snippet), 'contacts'),
    ] };
  }

  // ---------------- Today / Catch me up ----------------
  function todayData() {
    const G = google(), t0 = at(0, 0), t1 = at(1, 0);
    const open = S.captures.filter(c => ['task', 'reminder'].includes(c.kind) && !c.completed_at && !['archived', 'built'].includes(c.status));
    const on = svc => !S.disconnected && !S.disabled.includes(svc);
    const ideas = S.captures.filter(c => ['idea', 'business_idea', 'product_idea', 'dream'].includes(c.kind));
    return {
      now: iso(now()), heading: fmtD(now()),
      calendar: on('calendar') ? { status: 'ok', items: G.events.filter(e => Date.parse(e.meta.end) > now() && Date.parse(e.meta.start) < at(2, 0)) } : { status: S.disconnected ? 'not_connected' : 'disabled', items: [] },
      email: on('gmail') ? { status: 'ok', items: G.threads.slice(0, 3), unread: G.threads.filter(t => t.meta.unread).length } : { status: S.disconnected ? 'not_connected' : 'disabled', items: [] },
      files: on('drive') ? { status: 'ok', items: G.files.filter(f => Date.parse(f.date) > now() - 4 * D) } : { status: 'disabled', items: [] },
      tasks: {
        dueToday: open.filter(c => c.due_at && Date.parse(c.due_at) >= t0 && Date.parse(c.due_at) < t1).map(listItem),
        overdue: open.filter(c => c.due_at && Date.parse(c.due_at) < t0).map(listItem),
        open: open.filter(c => !c.due_at).slice(0, 5).map(listItem),
      },
      revisit: ideas.filter(c => ['thinking', 'active', 'maybe'].includes(c.status) && Date.parse(c.updated_at) < now() - 21 * D).slice(0, 3).map(listItem),
      goals: S.captures.filter(c => c.kind === 'goal' && !['archived', 'built'].includes(c.status)).map(listItem),
      recentIdeas: ideas.slice().sort((a, b) => b.captured_at.localeCompare(a.captured_at)).slice(0, 3).map(listItem),
      recentInbox: S.captures.filter(c => c.status === 'inbox' && c.kind !== 'question').sort((a, b) => b.captured_at.localeCompare(a.captured_at)).slice(0, 4).map(listItem),
      dreams: { freshness: boardFresh(), needsChoice: S.ops.filter(o => o.status === 'needs_choice').length, items: [
        ...S.dreams.filter(g => g.changes.some(c => c.progress && Date.parse(c.at) > now() - 30 * D)).map(g => ({ id: g.id, title: g.title, line: g.changes.filter(c => c.progress).length + ' milestone completed this month' })),
        ...S.dreams.filter(g => g.status === 'in_progress' && now() - Date.parse(lastChange(g)) > 45 * D).slice(0, 1).map(g => ({ id: g.id, title: g.title, line: 'no update in ' + Math.floor((now() - Date.parse(lastChange(g))) / D) + ' days' })),
      ] },
      counts: counts(),
    };
  }
  function catchUp() {
    const d = todayData(), reg = new Registry();
    const lines = [];
    const since = now() - 3 * D;
    const caps = S.captures.filter(c => c.kind !== 'question' && Date.parse(c.captured_at) > since);
    const sent = S.ops.filter(o => o.status === 'applied' && Date.parse(o.done_at) > since);
    const prog = S.dreams.filter(g => g.changes.some(c => c.progress && Date.parse(c.at) > now() - 7 * D));
    const bits = ['- ' + caps.length + ' captured' + (caps.length ? ': ' + Object.entries(caps.reduce((m, c) => { m[KINDS[c.kind].label.toLowerCase()] = (m[KINDS[c.kind].label.toLowerCase()] || 0) + 1; return m; }, {})).map(([k, n]) => n + ' ' + k + (n > 1 ? 's' : '')).join(', ') : '')];
    sent.forEach(o => { const g = S.dreams.find(x => x.id === o.target); if (g) bits.push('- You added ' + (o.kind === 'create_goal' ? '“' + g.title + '” to Dream Board' : 'a capture to “' + g.title + '”') + ' [' + reg.add(dreamSrc(g)) + ']'); });
    prog.forEach(g => bits.push('- ' + g.title + ': ' + g.changes.filter(c => c.progress).map(c => c.text).join('; ') + ' [' + reg.add(dreamSrc(g)) + ']'));
    lines.push('**What happened**\n' + bits.join('\n'));
    if (d.calendar.items.length) lines.push('**Next up**\n' + d.calendar.items.slice(0, 3).map(e => '- ' + fmtT(e.meta.start) + ' — ' + e.title + ' [' + reg.add(e) + ']').join('\n'));
    const due = d.tasks.overdue.concat(d.tasks.dueToday);
    if (due.length) lines.push('**Due today**\n' + due.map(c => '- ' + c.title + ' [' + reg.add(noteSrc(c)) + ']').join('\n'));
    if (d.email.items.length) lines.push('**Waiting on you**\n' + d.email.items.slice(0, 2).map(t => '- ' + t.meta.from + ': ' + t.title + ' [' + reg.add(t, t.body) + ']').join('\n') + '\n- Nothing else pressing in email.');
    if (d.revisit.length) lines.push('**Worth a look when you have a minute**\n' + d.revisit.map(c => '- ' + c.title + ' [' + reg.add(noteSrc(c)) + ']').join('\n'));
    const text = lines.join('\n\n') || 'Nothing pressing today.';
    return { text, since: iso(since), sources: reg.cite(text), ai: true };
  }

  // ---------------- Dream Board (mirrors lib/assistant/apps/*) ----------------
  // The demo "board" is a PC that is on: it applies queued work ~2s later.
  const BOARD_RE = /\b(dream\s?board|vision\s?board)\b/i;
  const ATTACH_RE = /\b(?:add|put|attach|save|stick|file|pin)\b[^.?!\n]{0,40}?\b(?:to|on|in|under|with|for)\s+(?:my|the|our)\s+([a-z0-9'&][a-z0-9' &\-]{0,58}?)\s+(?:dream|goal)s?\b/i;
  const STOPW = new Set(['my', 'the', 'a', 'an', 'our', 'dream', 'dreams', 'board', 'goal', 'goals', 'this', 'that', 'to', 'of', 'for', 'in', 'on', 'and']);
  const toks = t => String(t || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w && !STOPW.has(w));
  const titleCase = t => String(t).split(/\s+/).map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
  const LIVE = ['routing', 'needs_choice', 'waiting', 'queued'];
  const liveOp = cid => (S.ops || []).filter(o => o.capture_id === cid && LIVE.includes(o.status)).pop() || null;
  const dreamSrc = g => ({ provider: 'dreamboard', kind: 'goal', recordId: g.id, title: g.title, url: '#/dream/' + g.id, date: iso(now()) });
  const money = (v, k) => (typeof v === 'number' && /amount/.test(k) ? '$' + (v >= 1e6 ? +(v / 1e6).toFixed(2) + 'M' : v.toLocaleString('en-US')) : v);
  const boardFresh = () => (S.boardOffline ? { state: 'stale', lastSeenAt: S.boardSeen || iso(now() - 3 * H), historySince: iso(now() - 120 * D) } : { state: 'live', lastSeenAt: iso(now()), historySince: iso(now() - 120 * D) });
  function wordsTitle(t) {
    const filler = /^(also|and|oh|plus|so|ok|okay)[,\s]+/i;
    let x = t.replace(filler, '').replace(/^\s*(please\s+)?((save|add|put|pin)\s+)?((this|that|it)\s+)?((for|to|on|in)\s+)?((my|the)\s+)?(dream\s?board|vision\s?board)\s*[:,.;!—–-]*\s*/i, '').replace(/\b(dream\s?board|vision\s?board)\b[.:,;!—–-]*/ig, '').trim().replace(filler, '');
    x = x.replace(/^(someday|one day|eventually)[,\s]*/i, '').replace(/^(i|we)\s+(really\s+)?(want|wanna|would like|'d like|hope|dream)\s+(to\s+(own|have|buy|get|build|see|visit|take)\s+|of\s+)?/i, '').replace(/^(a|an|the|my|our)\s+/i, '');
    x = x.split(/\s+(?:with|that|where|so|which|and|because|like)\s+|[,.;!?—–(]|\s-\s/)[0].trim();
    const w = x.split(/\s+/).filter(Boolean).slice(0, 6);
    return w.length ? w.map((v, i) => (i === 0 || !/^(a|an|the|of|for|and|or|to|in|on|at|with|by)$/i.test(v) ? v[0].toUpperCase() + v.slice(1) : v.toLowerCase())).join(' ') : 'New Dream';
  }
  function match(phrase) {
    const p = toks(phrase);
    const scored = S.dreams.map(g => {
      let best = 0;
      [g.title].concat(g.aliases).forEach(n => { const t = toks(n); const exact = t.length === p.length && t.every(w => p.includes(w)); best = Math.max(best, exact ? 3 : t.every(w => p.includes(w)) ? 2 : p.every(w => t.includes(w)) ? 1.5 : p.filter(w => t.includes(w)).length / Math.max(p.length, t.length)); });
      return { g, s: best };
    }).filter(x => x.s > 0).sort((a, b) => b.s - a.s);
    const exact = scored.filter(x => x.s === 3), strong = scored.filter(x => x.s >= 2), sup = scored.filter(x => x.s >= 1.5);
    const hit = exact.length === 1 ? exact[0] : !exact.length && strong.length === 1 && sup.length === 1 ? strong[0] : null;
    return { hit: hit && hit.g, candidates: scored.slice(0, 4).map(x => x.g) };
  }
  const trace = (o, st) => o.trace.push({ stage: st, at: iso(now()) });
  function route(c, hasPhoto) {
    const t = c.raw_text || '';
    const m = t.match(ATTACH_RE);
    if (!m && !BOARD_RE.test(t)) return null;
    const o = { id: id('op'), capture_id: c.id, status: 'routing', created_at: iso(now()), trace: [] };
    trace(o, 'captured'); trace(o, 'routed');
    if (m) {
      const r = match(m[1]);
      o.kind = 'attach';
      if (r.hit) Object.assign(o, { status: 'queued', target: r.hit.id, goal_title: r.hit.title });
      else Object.assign(o, { status: 'needs_choice', suggested: titleCase(m[1]), candidates: r.candidates });
    } else if (hasPhoto && !/\b(someday|one day|i want|i'd love|dream of|bucket list)\b/i.test(t)) Object.assign(o, { kind: 'add_item', status: 'queued', title: 'Unsorted item' });
    else {
      const title = wordsTitle(t), r = match(title);
      o.kind = 'create_goal'; o.title = title;
      if (r.hit || r.candidates.some(g => toks(g.title).join(' ') === toks(title).join(' '))) Object.assign(o, { status: 'needs_choice', suggested: title, candidates: r.candidates });
      else o.status = 'queued';
    }
    trace(o, o.status);
    if (o.status === 'queued') c.status = 'filed';
    S.ops.push(o);
    return o;
  }
  function tick() {
    if (S.boardOffline) return;
    S.boardSeen = iso(now());
    for (const o of S.ops.filter(x => x.status === 'queued' && now() - Date.parse(x.queued_at || x.created_at) > 2000)) {
      const c = S.captures.find(x => x.id === o.capture_id);
      trace(o, 'sent');
      let g = S.dreams.find(x => x.id === o.target);
      if (o.kind === 'create_goal') {
        g = { id: 'g-' + o.id.slice(-8), title: o.title, status: 'dreaming', category: null, fields: {}, aliases: [], milestones: [], notes: [], words: [], changes: [{ kind: 'created', text: 'added to Dream Board', at: iso(now()), by: 'capture' }], created_at: iso(now()), updated_at: iso(now()) };
        S.dreams.push(g); o.target = g.id;
      }
      if (g && c) { g.words.push(c.id); if (o.kind !== 'create_goal') g.changes.push({ kind: 'note_added', text: (c.attachments || []).length ? 'photo added' : 'note added', at: iso(now()), by: 'capture' }); g.updated_at = iso(now()); }
      o.status = 'applied'; o.done_at = iso(now()); trace(o, 'acknowledged');
    }
    save();
  }
  function opOut(o) {
    return { id: o.id, kind: o.kind, status: o.status, reason: o.reason || null, target: o.target ? { id: o.target, title: (S.dreams.find(g => g.id === o.target) || {}).title || o.goal_title } : null,
      title: o.title || null, suggestedTitle: o.suggested || null, candidates: (o.candidates || []).map(g => ({ kind: 'goal', id: g.id, title: g.title, status: g.status })),
      attempts: o.status === 'applied' ? 1 : 0, result: o.status === 'applied' && o.target ? { type: 'goal', id: o.target } : null, trace: o.trace };
  }
  function routingFor(cid) {
    const os = S.ops.filter(o => o.capture_id === cid);
    return os.length ? { app: 'dreamboard', freshness: boardFresh(), current: opOut(os[os.length - 1]) } : null;
  }
  function dreamOut(g) {
    return { id: g.id, title: g.title, status: g.status, aliases: g.aliases, gone: null,
      current: { description: '', category: g.category, fields: g.fields, milestones: g.milestones, notes: [] },
      asOf: boardFresh().lastSeenAt, freshness: boardFresh(), historySince: boardFresh().historySince, link: null, changes: g.changes,
      words: g.words.map(cid => S.captures.find(c => c.id === cid)).filter(Boolean).map(c => ({ id: c.id, title: c.title, text: c.raw_text, capturedAt: c.captured_at, attachments: (c.attachments || []).length, by: 'owner' })),
      pending: S.ops.filter(o => o.target === g.id && LIVE.includes(o.status)).map(opOut) };
  }
  const lastChange = g => g.changes.map(c => c.at).sort().pop() || g.updated_at;
  const lastProgress = g => g.changes.filter(c => c.progress).map(c => c.at).sort().pop() || null;

  // ---------------- routing ----------------
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const notFound = () => json({ error: 'Not found' }, 404);
  const cap = list => list.map(([key, label, value]) => ({ key, label, value }));
  const GCAPS = {
    gmail: cap([['search', 'Search', 'yes'], ['read', 'Read', 'yes'], ['draft', 'Draft', 'future'], ['send', 'Send', 'no']]),
    calendar: cap([['search', 'Search', 'yes'], ['read', 'Read', 'yes'], ['create_event', 'Create events', 'future']]),
    drive: cap([['search', 'Search', 'yes'], ['read', 'Read', 'yes']]),
    sheets: cap([['search', 'Search', 'yes'], ['read', 'Read', 'yes'], ['edit', 'Edit', 'no']]),
    contacts: cap([['search', 'Search', 'yes'], ['read', 'Read', 'yes']]),
  };
  const SERVICES = {
    gmail: ['Gmail', 'mail', ['Search your email', 'Read threads and list attachments', 'Summarize conversations and find what is waiting on you'], ['Send, delete, archive or label email', 'Change settings'], ['https://www.googleapis.com/auth/gmail.readonly']],
    calendar: ['Calendar', 'calendar', ['See your calendars and events', 'Understand today, tomorrow and this week'], ['Create, change or delete events', 'Respond to invitations'], ['https://www.googleapis.com/auth/calendar.events.readonly', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly']],
    drive: ['Drive & Docs', 'folder', ['Search files by name and content', 'Read Google Docs, text files and PDFs'], ['Create, edit, move, share or delete files'], ['https://www.googleapis.com/auth/drive.readonly']],
    sheets: ['Sheets', 'table', ['List tabs, headers and tables', 'Read cell values and formulas'], ['Edit any cell, tab or spreadsheet'], ['https://www.googleapis.com/auth/spreadsheets.readonly']],
    contacts: ['Contacts', 'person', ['Look up names, emails, companies and phone numbers'], ['Add, edit or delete contacts'], ['https://www.googleapis.com/auth/contacts.readonly']],
  };

  async function handle(method, r, q, body) {
    tick();
    const find = cid => S.captures.find(c => c.id === cid);
    switch (method + ' ' + r) {
      case 'GET bootstrap': case 'GET me':
        return json({ user: { id: 'usr_demo', email: 'jeff@example.com', name: 'Jeff', picture: '', tz: Intl.DateTimeFormat().resolvedOptions().timeZone }, ai: true, counts: counts(), projects: projectsOut(),
          kinds: KINDS, statuses: STATUSES, projectKinds: ['business', 'project', 'topic', 'area'], memoryKinds: ['fact', 'preference', 'decision', 'goal', 'plan', 'relationship'], google: S.disconnected ? null : { email: 'jeff@example.com', status: 'connected' } });
      case 'POST settings': case 'POST auth/signout': case 'POST auth/signout-all': return json({ ok: true });
      case 'POST capture': {
        const dup = S.captures.find(c => c.client_ref && c.client_ref === body.client_ref);
        if (dup) return json({ capture: fullItem(dup), duplicate: true, intent: dup.kind === 'question' ? 'question' : 'capture' });
        const text = String(body.text || '');
        const url = (text.match(/https?:\/\/[^\s<>"]+/) || [null])[0];
        const c = { id: id('cap'), client_ref: body.client_ref, kind: 'note', status: 'inbox', title: '', raw_text: text, summary: null, next_action: null, source_type: body.source_type || 'text', url,
          details: {}, ai: {}, classification_state: 'pending', due_at: null, completed_at: null, captured_at: body.captured_at || iso(now()), updated_at: iso(now()), tags: [], people: [], attachments: [] };
        (body.attachments || []).forEach(a => { const aid = id('att'); S.attachments[aid] = { kind: /^image/.test(a.mime) ? 'image' : /^audio/.test(a.mime) ? 'audio' : 'file', mime: a.mime, name: a.name, data: a.data, transcript: a.transcript || null }; c.attachments.push(aid); });
        await sleep(350);
        if (body.journal) {
          Object.assign(c, { kind: 'journal', classification_state: 'done', title: text.slice(0, 80) || 'Journal entry', status: 'inbox' });
          S.captures.unshift(c); save();
          return json({ capture: fullItem(c), duplicate: false, intent: 'journal' }, 201);
        }
        const routed = BOARD_RE.test(text) || ATTACH_RE.test(text);
        const intent = body.force_capture || routed ? 'capture' : detectIntent(text);
        if (intent === 'question') Object.assign(c, { kind: 'question', status: 'archived', title: text.slice(0, 80), classification_state: 'done' });
        else classify(c);
        const op = routed ? route(c, (body.attachments || []).some(a => /^image/.test(a.mime))) : null;
        S.captures.unshift(c); save();
        return json({ capture: fullItem(c), duplicate: false, intent, routing: op ? routingFor(c.id) : null }, 201);
      }
      case 'POST reprocess': return json({ processed: 0 });
      case 'GET inbox': {
        let cs = S.captures.filter(c => c.kind !== 'question' && (q.kind === 'journal' || c.kind !== 'journal'));
        if (q.status === 'open') cs = cs.filter(c => !['archived', 'built'].includes(c.status)); else if (q.status) cs = cs.filter(c => c.status === q.status);
        if (q.kind) cs = cs.filter(c => c.kind === q.kind);
        if (q.project) cs = cs.filter(c => c.project_id === q.project);
        if (q.open_tasks === '1') cs = cs.filter(c => ['task', 'reminder'].includes(c.kind) && !c.completed_at);
        cs.sort((a, b) => b.captured_at.localeCompare(a.captured_at));
        return json({ items: cs.slice(0, 100).map(listItem), next: null });
      }
      case 'GET item': {
        const c = find(q.id); if (!c) return notFound();
        const kw = words([c.title, c.raw_text].join(' ')).filter(w => w.length > 4);
        const related = S.captures.filter(x => x.id !== c.id && x.kind !== 'question' && kw.filter(w => (x.title + ' ' + x.raw_text + ' ' + (x.tags || []).join(' ')).toLowerCase().includes(w)).length >= 2).slice(0, 5).map(listItem);
        return json({ item: fullItem(c), related, routing: routingFor(c.id) });
      }
      case 'PATCH item': {
        const c = find(body.id); if (!c) return notFound();
        ['kind', 'status', 'title', 'summary', 'next_action', 'project_id', 'due_at', 'completed_at'].forEach(k => { if (k in body) c[k] = body[k]; });
        if (typeof body.raw_text === 'string') { c.details.raw_history = (c.details.raw_history || []).concat([{ text: c.raw_text, replaced_at: iso(now()) }]); c.raw_text = body.raw_text; }
        if (Array.isArray(body.tags)) c.tags = body.tags;
        if ('kind' in body || 'project_id' in body || 'title' in body) c.classification_state = 'manual';
        c.updated_at = iso(now()); save();
        return json({ item: fullItem(c) });
      }
      case 'GET dreams': return json({ app: { app: 'dreamboard', status: 'connected', freshness: boardFresh() }, goals: S.dreams.map(g => ({ id: g.id, title: g.title, status: g.status, category: g.category, fields: g.fields, lastUpdateAt: lastChange(g), lastProgressAt: lastProgress(g) })) });
      case 'GET dream': { const g = S.dreams.find(x => x.id === q.id); return g ? json({ dream: dreamOut(g) }) : notFound(); }
      case 'POST route': {
        const c = find(body.capture_id); if (!c) return notFound();
        let o = liveOp(c.id);
        if (o && o.status === 'queued') return json({ error: 'This was already sent to Dream Board.' }, 409);
        if (!o) { o = { id: id('op'), capture_id: c.id, kind: 'create_goal', status: 'needs_choice', created_at: iso(now()), trace: [] }; trace(o, 'captured'); trace(o, 'routed'); S.ops.push(o); }
        const ch = body.choice;
        if (ch === 'keep') { o.status = 'cancelled'; o.reason = 'kept_here'; c.status = 'inbox'; }
        else if (ch && ch.goal) { const g = S.dreams.find(x => x.id === ch.goal); if (!g) return json({ error: 'That dream is no longer available — pick another.' }, 400); Object.assign(o, { kind: 'attach', target: g.id, goal_title: g.title, status: 'queued', queued_at: iso(now()) }); c.status = 'filed'; }
        else if (ch === 'new' || ch === 'item') { Object.assign(o, { kind: ch === 'new' ? 'create_goal' : 'add_item', title: ch === 'new' ? (body.title || o.suggested || wordsTitle(c.raw_text)) : 'Unsorted item', status: 'queued', queued_at: iso(now()) }); c.status = 'filed'; }
        trace(o, o.status); save();
        return json({ routing: routingFor(c.id), item: fullItem(c) });
      }
      case 'POST apps/pair': return json({ code: 'DEMO-7K4Q', expiresInMinutes: 10 });
      case 'POST apps/disconnect': case 'POST apps/forget': case 'POST apps/base-url': return json({ ok: true });
      case 'DELETE item': { const n = S.captures.length; S.captures = S.captures.filter(c => c.id !== q.id); save(); return json({ deleted: S.captures.length < n }); }
      case 'GET projects': return json({ projects: projectsOut() });
      case 'POST projects': { const p = { id: id('prj'), name: body.name, kind: body.kind || 'project', emoji: body.emoji || '📁', aliases: body.aliases || [], description: body.description || null, status: 'active' }; S.projects.push(p); save(); return json({ project: p }, 201); }
      case 'GET project': {
        const p = S.projects.find(x => x.id === q.id); if (!p) return notFound();
        const items = S.captures.filter(c => c.project_id === p.id && c.kind !== 'question').sort((a, b) => b.captured_at.localeCompare(a.captured_at)).map(listItem);
        const G = google();
        const external = p.name === 'ALP' ? [G.threads[0], G.files[0]].map(x => ({ provider: x.provider, title: x.title, url: x.url, occurred_at: x.date })) : [];
        return json({ project: p, items, memories: S.memories.filter(m => m.subject_id === p.id && m.status === 'active'), external });
      }
      case 'PATCH project': { const p = S.projects.find(x => x.id === body.id); if (!p) return notFound(); ['name', 'kind', 'emoji', 'description', 'aliases'].forEach(k => { if (k in body) p[k] = body[k]; }); save(); return json({ project: p }); }
      case 'DELETE project': { S.projects = S.projects.filter(p => p.id !== q.id); S.captures.forEach(c => { if (c.project_id === q.id) c.project_id = null; }); save(); return json({ deleted: true }); }
      case 'GET people': return json({ people: S.people.filter(p => !p.merged_into).map(p => ({ id: p.id, display_name: p.display_name, role: p.role, aliases: p.aliases, emails: p.identities.map(i => i.provider_id).join(', '), mention_count: S.captures.filter(c => (c.people || []).includes(p.id)).length })) });
      case 'GET person': {
        const p = S.people.find(x => x.id === q.id); if (!p) return notFound();
        const email = p.identities[0] && p.identities[0].provider_id, G = google();
        return json({ person: p, items: S.captures.filter(c => (c.people || []).includes(p.id)).map(listItem),
          emails: { status: 'ok', items: G.threads.filter(t => t.meta.fromEmail === email) }, meetings: { status: 'ok', items: G.events.filter(e => e.meta.attendees.some(a => a.email === email)) } });
      }
      case 'PATCH person': {
        const p = S.people.find(x => x.id === body.id); if (!p) return notFound();
        if (body.display_name) p.display_name = body.display_name; if ('role' in body) p.role = body.role; if (Array.isArray(body.aliases)) p.aliases = body.aliases;
        if (Array.isArray(body.emails)) body.emails.forEach(e => { if (!p.identities.some(i => i.provider_id === e.toLowerCase())) p.identities.push({ provider: 'email', provider_id: e.toLowerCase() }); });
        save(); return json({ person: p });
      }
      case 'POST people/merge': {
        const a = S.people.find(x => x.id === body.from), b = S.people.find(x => x.id === body.into); if (!a || !b) return json({ error: 'Could not merge those people.' }, 400);
        b.identities = b.identities.concat(a.identities); b.aliases = [...new Set(b.aliases.concat([a.display_name], a.aliases))]; a.merged_into = b.id;
        S.captures.forEach(c => { c.people = [...new Set((c.people || []).map(x => x === a.id ? b.id : x))]; }); save(); return json({ person: b });
      }
      case 'GET memory': return json({ memories: S.memories.filter(m => m.status === 'active').map(m => Object.assign({}, m, { project_name: proj(m.subject_id) ? proj(m.subject_id).name : null })) });
      case 'POST memory': { const m = { id: id('mem'), kind: body.kind || 'fact', statement: body.statement, subject_type: null, subject_id: null, source_type: 'user', source_id: null, status: 'active', created_at: iso(now()) }; S.memories.unshift(m); save(); return json({ memory: m }, 201); }
      case 'PATCH memory': { const m = S.memories.find(x => x.id === body.id); if (!m) return notFound(); const n = Object.assign({}, m, { id: id('mem'), statement: body.statement, created_at: iso(now()), source_type: 'user_edit', source_id: m.id }); m.status = 'superseded'; S.memories.unshift(n); save(); return json({ memory: n }); }
      case 'DELETE memory': { const m = S.memories.find(x => x.id === q.id); if (m) m.status = 'archived'; save(); return json({ archived: !!m }); }
      case 'GET search': await sleep(450); return json(search(q.q || ''));
      case 'GET conversations': return json({ conversations: S.conversations.slice().sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map(c => Object.assign({}, c, { last: (S.messages.filter(m => m.conversation_id === c.id).pop() || {}).content || '' })) });
      case 'GET conversation': { const c = S.conversations.find(x => x.id === q.id); if (!c) return notFound(); return json({ conversation: Object.assign({}, c, { messages: S.messages.filter(m => m.conversation_id === c.id) }) }); }
      case 'DELETE conversation': S.conversations = S.conversations.filter(c => c.id !== q.id); save(); return json({ deleted: true });
      case 'GET message': { const m = S.messages.find(x => x.id === q.id); return m ? json({ message: m }) : notFound(); }
      case 'POST chat': {
        const question = String(body.message || '').trim();
        let conv = body.conversation_id && S.conversations.find(c => c.id === body.conversation_id);
        if (!conv) { conv = { id: id('cnv'), title: question.slice(0, 70), created_at: iso(now()), updated_at: iso(now()) }; S.conversations.push(conv); }
        const enc = new TextEncoder();
        const stream = new ReadableStream({
          async start(ctrl) {
            const emit = e => ctrl.enqueue(enc.encode(JSON.stringify(e) + '\n'));
            emit({ type: 'conversation', id: conv.id });
            const um = { id: id('msg'), conversation_id: conv.id, role: 'user', content: question, sources: [], trace: [], actions: [], created_at: iso(now()) };
            S.messages.push(um); emit({ type: 'user_message', message: um });
            emit({ type: 'status', text: 'Thinking' }); await sleep(500);
            const a = await answer(question, emit);
            emit({ type: 'status', text: 'Putting it together' }); await sleep(400);
            const m = Object.assign({ id: id('msg'), conversation_id: conv.id, role: 'assistant', created_at: iso(now()) }, a);
            S.messages.push(m); conv.updated_at = iso(now()); save();
            emit({ type: 'message', message: m });
            ctrl.close();
          },
        });
        return new Response(stream, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
      }
      case 'POST journal': {
        const j = find(body.capture_id); if (!j) return notFound();
        const title = 'Journal · ' + new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        let conv = S.conversations.find(x => x.title === title);
        if (!conv) { conv = { id: id('cnv'), title, created_at: iso(now()), updated_at: iso(now()) }; S.conversations.push(conv); }
        const enc = new TextEncoder();
        return new Response(new ReadableStream({ async start(ctrl) {
          const emit = e => ctrl.enqueue(enc.encode(JSON.stringify(e) + '\n'));
          emit({ type: 'conversation', id: conv.id });
          if (j.journal_msg) { emit({ type: 'message', message: S.messages.find(m => m.id === j.journal_msg) }); return ctrl.close(); }
          S.messages.push({ id: id('msg'), conversation_id: conv.id, role: 'user', content: j.raw_text, sources: [], trace: [], actions: [], created_at: iso(now()) });
          emit({ type: 'status', text: 'Going through what you said' }); await sleep(700);
          // Demo stand-in for the AI: one item per actionable sentence, answers to questions.
          const lines = [], created = [], answers = [];
          let sources = [], trace = [];
          for (const sent of String(j.raw_text || '').split(/(?<=[.!?])\s+|\n+/).map(x => x.trim()).filter(Boolean)) {
            if (/\?$/.test(sent)) { const a = await answer(sent, emit); answers.push(a.content.replace(/\n\n\*This demo[\s\S]*$/, '')); sources = sources.concat(a.sources); trace = trace.concat(a.trace); continue; }
            if (!/\b(remind|need to|have to|gotta|call|email|text|buy|pick up|schedule|idea|dream\s?board|add this to|remember)\b/i.test(sent)) continue;
            const c = { id: id('cap'), kind: 'note', status: 'inbox', title: '', raw_text: sent, summary: null, next_action: null, source_type: 'journal', url: null, details: {}, ai: { how: 'ai' }, classification_state: 'pending',
              due_at: null, completed_at: null, captured_at: iso(now()), updated_at: iso(now()), tags: [], people: [], attachments: [] };
            classify(c);
            const op = route(c, false);
            const tidy = sent.replace(/^(also|and|oh|plus|so)[,\s]+/i, '').replace(/^remind me\s+(?:(?:today|tonight|tomorrow|on \w+)\s+)?(?:at [\d:]+\s*(?:am|pm)?\s+)?to\s+/i, '').replace(/^(i )?(need|have|got) to\s+/i, '').replace(/[.!]+$/, '');
            c.title = op ? (op.title || op.goal_title || 'Dream Board item') : tidy.charAt(0).toUpperCase() + tidy.slice(1);
            S.captures.unshift(c);
            created.push({ type: 'capture', id: c.id, title: c.title, kind: c.kind });
            lines.push('✓ ' + (op ? 'Dream Board: ' + (op.status === 'needs_choice' ? 'which dream? (open it to choose)' : op.kind === 'create_goal' ? 'new dream “' + c.title + '”' : 'added to “' + c.title + '”') : KINDS[c.kind].label + ': ' + c.title + (c.due_at ? ' — ' + fmtD(c.due_at) : '')));
          }
          emit({ type: 'status', text: 'Putting it together' }); await sleep(400);
          const content = lines.length || answers.length ? lines.concat(answers).join('\n\n') : 'Noted.';
          const m = { id: id('msg'), conversation_id: conv.id, role: 'assistant', content, sources, trace, actions: [], created, model: 'Claude (demo — rule-based stand-in)', created_at: iso(now()) };
          S.messages.push(m); j.journal_msg = m.id; conv.updated_at = iso(now()); save();
          emit({ type: 'message', message: m });
          ctrl.close();
        } }), { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
      }
      case 'POST action': {
        const a = S.actions.find(x => x.id === body.id); if (!a) return notFound();
        if (a.status !== 'proposed') return json({ error: 'This action was already decided.' }, 409);
        if (body.decision !== 'confirm') { a.status = 'cancelled'; save(); return json({ action: a }); }
        a.status = 'confirmed';
        S.messages.forEach(m => (m.actions || []).forEach(x => { if (x.id === a.id) x.status = 'confirmed'; }));
        save();
        return json({ action: a, result: { note: 'In the real app this opens Gmail with the message filled in — nothing is sent until you press Send. (Demo: nothing was opened.)' } });
      }
      case 'GET today': await sleep(250); return json(todayData());
      case 'POST catchup': await sleep(900); return json(catchUp());
      case 'GET connections': return json({
        apps: [{ key: 'dreamboard', label: 'Dream Board', status: 'connected', instanceLabel: 'Jeff’s PC', baseUrl: '', lastError: null, freshness: boardFresh(), records: S.dreams.length,
          queue: S.ops.filter(o => LIVE.includes(o.status)).reduce((m, o) => { m[o.status] = (m[o.status] || 0) + 1; return m; }, {}),
          capabilities: cap([['search', 'Search', 'yes'], ['read', 'Read', 'yes'], ['create', 'Add dreams', 'yes'], ['attach', 'Attach captures', 'yes'], ['events', 'Receive progress', 'yes'], ['milestone', 'Add milestones', 'confirm'], ['update', 'Change goals', 'confirm'], ['delete', 'Delete or merge', 'no']]) }],
        planned: ['ALP Sales Tracker', 'Pricing App', 'EOS / Traction', 'GemMasters', 'Service Autopilot', 'RingCentral'].map(l => ({ id: l, label: l })),
        google: S.disconnected ? null : { email: 'jeff@example.com', status: 'connected', lastUsedAt: iso(now() - 60e3) },
        services: Object.entries(SERVICES).map(([k, v]) => ({ key: k, label: v[0], icon: v[1], state: S.disconnected ? 'not_connected' : S.disabled.includes(k) ? 'disabled' : 'connected', capabilities: GCAPS[k], can: v[2], cannot: v[3], scopes: v[4], note: k === 'sheets' ? 'Finding a spreadsheet by meaning uses Drive search; with Drive off, paste a Sheet link.' : null })),
      });
      case 'POST connections/service': S.disabled = body.enabled ? S.disabled.filter(x => x !== body.service) : S.disabled.concat([body.service]); save(); return json({ ok: true });
      case 'POST connections/disconnect': S.disconnected = true; save(); return json({ ok: true, revokedAtGoogle: true });
      default: return notFound();
    }
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (!/\/api\/assistant(\/|$)/.test(url.pathname)) return realFetch(input, init);
    const q = Object.fromEntries(url.searchParams.entries());
    const r = q.r || (url.pathname.match(/\/api\/assistant\/(.+)$/) || [])[1] || '';
    let body = {};
    try { body = init.body ? JSON.parse(init.body) : {}; } catch { body = {}; }
    await sleep(120);
    return handle((init.method || 'GET').toUpperCase(), r, q, body);
  };

  // The real app's "Connect" buttons go to Google; in the demo they reconnect the sample account.
  document.addEventListener('click', e => {
    const a = e.target.closest && e.target.closest('a[href*="/api/assistant/auth/start"]');
    if (!a) return;
    e.preventDefault();
    S.disconnected = false; S.disabled = []; save();
    location.hash = '#/connections?connected=1';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  }, true);

  window.__asstDemoReset = () => { try { localStorage.removeItem(KEY); localStorage.removeItem('asst:boot'); localStorage.removeItem('asst:today'); } catch { /* ignore */ } location.hash = '#/today'; location.reload(); };
})();
