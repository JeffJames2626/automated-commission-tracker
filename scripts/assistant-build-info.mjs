// Stamps the build time (and commit) into lib/assistant/build-info.mjs so the
// app can show exactly what is deployed. Runs as Vercel's build step
// (npm run vercel-build). Never fails the deploy: a missing stamp only means
// the About screen shows no build date.
import { writeFileSync } from 'node:fs';

const e = process.env;
const stamp = {
  builtAt: new Date().toISOString(),
  sha: e.VERCEL_GIT_COMMIT_SHA || '',
  branch: e.VERCEL_GIT_COMMIT_REF || '',
};
try {
  writeFileSync(new URL('../lib/assistant/build-info.mjs', import.meta.url),
    '// Generated at build time by scripts/assistant-build-info.mjs.\nexport default ' + JSON.stringify(stamp) + ';\n');
  console.log('assistant build info:', stamp.builtAt, (stamp.sha || 'no sha').slice(0, 7), stamp.branch || '');
} catch (err) {
  console.warn('assistant build info skipped:', err.message);
}
