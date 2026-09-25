// Shared app state and navigation.
export const state = {
  boot: null,          // /bootstrap payload: user, projects, kinds, statuses …
  nav: {},             // one-shot parameters for the next view (e.g. a question to ask)
  context: null,       // desktop right-hand panel renderer for the current view
};

export function go(hash, params) {
  state.nav = params || {};
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = hash;
}

export function takeNav() { const n = state.nav; state.nav = {}; return n; }

export function kindLabel(k) { const x = state.boot && state.boot.kinds[k]; return x ? x.label : k; }
export function kindEmoji(k) { const x = state.boot && state.boot.kinds[k]; return x ? x.emoji : '•'; }
