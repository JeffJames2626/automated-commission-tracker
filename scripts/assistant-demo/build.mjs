// Builds a standalone, click-through demo of the assistant from the real
// front-end files plus demo-api.js (sample data, no server, no Google).
//
//   node scripts/assistant-demo/build.mjs <outDir>
//
// The output is a static folder: index.html (page body only — the artifact
// host adds <html>/<head>), the app's JS/CSS and the demo API.

import fs from 'node:fs';
import path from 'node:path';

const out = path.resolve(process.argv[2] || 'assistant-demo-dist');
const src = path.resolve('assistant');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'views'), { recursive: true });
fs.mkdirSync(path.join(out, 'icons'), { recursive: true });

const js = ['app.js', 'api.js', 'ui.js', 'state.js', 'outbox.js', 'capture.js', 'views/common.js', 'views/today.js', 'views/inbox.js', 'views/item.js', 'views/chat.js', 'views/search.js', 'views/more.js', 'views/dreams.js'];
js.forEach(f => fs.copyFileSync(path.join(src, f), path.join(out, f)));
// Demo only: suggest the Dream Board questions the sample data can answer.
const chat = path.join(out, 'views/chat.js');
fs.writeFileSync(chat, fs.readFileSync(chat, 'utf8').replace("  'Catch me up',\n", "  'Catch me up',\n  'What did I originally want for the lake house vs now?',\n  'Show progress on my biggest dreams',\n"));
fs.copyFileSync(path.join(src, 'icons/icon.svg'), path.join(out, 'icons/icon.svg'));
fs.copyFileSync(path.resolve('scripts/assistant-demo/demo-api.js'), path.join(out, 'demo-api.js'));

// CSS: also honour an explicit light/dark choice from the host page.
let css = fs.readFileSync(path.join(src, 'app.css'), 'utf8');
const m = css.match(/@media \(prefers-color-scheme: light\) \{\n  :root \{([\s\S]*?)\n  \}\n\}/);
if (!m) throw new Error('light token block not found in app.css');
css = css.replace(m[0], `@media (prefers-color-scheme: light) {\n  :root:not([data-theme="dark"]) {${m[1]}\n  }\n}\n:root[data-theme="light"] {${m[1]}\n}`);
css += `
/* demo only */
.demo-strip { position: relative; z-index: 2; display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 6px 12px; padding: 8px 16px; font-size: 13px; color: var(--text-2); background: var(--surface-2); border-bottom: 1px solid var(--line); text-align: center; }
.demo-strip button { color: var(--accent); font-weight: 600; font-size: 13px; }
.main { padding-top: 14px; }
`;
fs.writeFileSync(path.join(out, 'app.css'), css);

fs.writeFileSync(path.join(out, 'index.html'), `<title>Personal Assistant</title>
<meta name="theme-color" content="#0b0b10">
<link rel="stylesheet" href="app.css">
<div class="demo-strip" role="note"><span><b>Demo</b> — sample notes, email, calendar and Sheets. Nothing here is real or connected.</span><button type="button" onclick="window.__asstDemoReset && window.__asstDemoReset()">Reset demo</button></div>
<div class="app">
  <nav class="rail" id="rail" aria-label="Main"></nav>
  <main class="main" id="main" tabindex="-1"></main>
  <aside class="context" id="context" aria-label="Sources and context"></aside>
</div>
<button class="fab" id="fab" aria-label="Capture" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></button>
<nav class="tabbar" id="tabbar" aria-label="Main"></nav>
<button class="net-pill" id="net" hidden></button>
<div class="toasts" id="toasts" aria-live="polite"></div>
<script src="demo-api.js"></script>
<script type="module" src="app.js"></script>
`);
console.log('demo written to ' + out);
