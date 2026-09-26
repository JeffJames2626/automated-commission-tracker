// Renders assistant/icons/icon.svg to the PNG sizes iOS and Android need,
// using the pre-installed Chromium. Run: node scripts/assistant-icons.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require('/opt/node22/lib/node_modules/playwright'); }
const dir = path.resolve('assistant/icons');
const svg = fs.readFileSync(path.join(dir, 'icon.svg'), 'utf8');
const browser = await pw.chromium.launch();
for (const size of [180, 192, 512]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<html><body style="margin:0;background:#ee4f9a">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: path.join(dir, `icon-${size}.png`), omitBackground: false });
  await page.close();
}
await browser.close();
console.log('icons written');
