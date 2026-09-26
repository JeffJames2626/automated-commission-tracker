import { api } from '../api.js';
import { esc, icon } from '../ui.js';
import { state, go } from '../state.js';

// "Connect Personal Assistant" pressed in Dream Board opens this page. The
// owner is already signed in with Google (sign-in brings them back here), sees
// which board is asking, checks the code matches, and allows or refuses.

export async function renderLink(main, params) {
  const code = String(params.get('code') || '').toUpperCase();
  main.innerHTML = `<header class="page-h"><h1>Connect an app</h1></header><div data-l class="card quiet">Loading…</div>`;
  const box = main.querySelector('[data-l]');
  let r;
  try { r = await api('apps/link', { query: { code } }); }
  catch (e) { box.innerHTML = esc(e.message); return; }
  const l = r.link;
  if (l.status !== 'pending') { box.innerHTML = esc(DONE[l.status] || 'This request was already answered.'); return; }
  const u = state.boot.user;
  box.className = 'card link-card';
  box.innerHTML = `<div class="link-icon">${icon('star')}</div>
    <h2>${esc(r.label)} wants to connect</h2>
    <p class="muted">${l.instanceLabel ? 'From <b>' + esc(l.instanceLabel) + '</b>. ' : ''}It will be linked to your assistant as <b>${esc(u.email)}</b>.</p>
    <div class="pair-code" aria-label="Code">${esc(l.code)}</div>
    <p class="muted small">Check that ${esc(r.label)} shows this same code. If you didn’t just press Connect there, choose Don’t allow.</p>
    <ul class="bullets small"><li>${esc(r.label)} will receive captures you file to it (words and photos).</li><li>Your assistant will see its dreams and goals, read-only.</li><li>Nothing else in your assistant or Google account is shared.</li></ul>
    ${l.replaces ? `<p class="small warn-text">This replaces the connection with ${esc(l.replaces)}.</p>` : ''}
    <div class="row gap mt"><button class="btn ghost" data-no>Don’t allow</button><span class="grow"></span><button class="btn primary" data-yes>Allow</button></div>`;
  const decide = async allow => {
    box.querySelectorAll('button').forEach(b => { b.disabled = true; });
    try {
      await api(allow ? 'apps/link/approve' : 'apps/link/deny', { method: 'POST', body: { code } });
      box.className = 'card quiet';
      box.innerHTML = allow ? `${icon('check')} Connected. Go back to ${esc(r.label)} — it finishes by itself in a few seconds.<div class="mt"><button class="btn ghost" data-go>Open Connections</button></div>` : 'Not connected. You can close this page.';
      const g = box.querySelector('[data-go]');
      if (g) g.onclick = () => go('#/connections');
    } catch (e) { box.innerHTML = esc(e.message); }
  };
  box.querySelector('[data-yes]').onclick = () => decide(true);
  box.querySelector('[data-no]').onclick = () => decide(false);
}

const DONE = { approved: 'Already allowed. Go back to Dream Board.', claimed: 'Already connected.', denied: 'This request was refused.', expired: 'This request expired. Press Connect in Dream Board again.' };
