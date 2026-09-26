// Pre-push checks for the assistant (npm run check:assistant): every source
// file parses, the function entry loads, the build stamp runs, and no secret
// or debug-only route ships. Tests run separately (npm run test:assistant).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const files = ['lib/assistant', 'assistant', 'api'].flatMap(d => walk(path.join(root, d))).filter(f => /\.(m?js)$/.test(f));
let bad = 0;
const fail = m => { console.error('✗ ' + m); bad++; };

for (const f of files) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
  catch (e) { fail('syntax: ' + path.relative(root, f) + '\n' + String(e.stderr || e.message).split('\n').slice(0, 4).join('\n')); }
}
console.log(`✓ ${files.length} files parse`);

// The deployed function must load with no environment at all.
try {
  execFileSync(process.execPath, ['-e', "import('./api/assistant.mjs').then(m => { if (typeof m.default !== 'function') process.exit(1); })"], { cwd: root, stdio: 'pipe', env: { PATH: process.env.PATH } });
  console.log('✓ api/assistant.mjs loads');
} catch (e) { fail('api/assistant.mjs does not load: ' + String(e.stderr || e.message).slice(0, 300)); }

// Shipped files (what .vercelignore doesn't exclude) must hold no secrets
// and no debug-only routes.
const ignored = fs.readFileSync(path.join(root, '.vercelignore'), 'utf8').split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));
const shipped = walk(root).map(f => '/' + path.relative(root, f)).filter(f => !f.startsWith('/node_modules/') && !f.startsWith('/.git/') && !ignored.some(i => f === i || f.startsWith(i + '/')));
const SECRET = /(sk-ant-[A-Za-z0-9_-]{10,}|ya29\.[A-Za-z0-9_-]{10,}|GOCSPX-[A-Za-z0-9_-]{10,}|postgres(ql)?:\/\/[^\s'"]+:[^\s'"@]+@|dbc_[A-Za-z0-9_-]{43}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
for (const f of shipped.filter(f => /\.(m?js|html|json|css|md|webmanifest)$/.test(f))) {
  const s = fs.readFileSync(path.join(root, f), 'utf8');
  if (SECRET.test(s)) fail('possible secret in shipped file ' + f);
  if (/\/assistant\/|\/api\/assistant|lib\/assistant/.test(f) && /__dev\/|__asstDemoReset|demo-api/.test(s)) fail('debug/demo code in shipped file ' + f);
}
console.log(`✓ ${shipped.length} shipped files checked for secrets and debug routes`);

// The build step writes the stamp without failing (then restore the empty one).
const stampFile = path.join(root, 'lib/assistant/build-info.mjs');
const before = fs.readFileSync(stampFile, 'utf8');
try {
  execFileSync(process.execPath, [path.join(root, 'scripts/assistant-build-info.mjs')], { stdio: 'pipe' });
  if (!/builtAt/.test(fs.readFileSync(stampFile, 'utf8'))) fail('build stamp not written');
  else console.log('✓ build step (vercel-build) runs');
} catch (e) { fail('build step failed: ' + e.message); }
finally { fs.writeFileSync(stampFile, before); }

if (bad) { console.error(`\n${bad} problem(s)`); process.exit(1); }
console.log('\nAll checks passed.');
