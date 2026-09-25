// Browser end-to-end test against the local dev server (real router, PGlite,
// demo Google data). Uses the pre-installed Chromium via Playwright.
//
//   node tests/assistant/e2e.browser.mjs [screenshotDir]
//
// Covers: mobile navigation, capture, capture→question routing, offline
// capture with the outbox and later sync, idea card edits, assistant answer
// with sources, universal search, connections, and the desktop layout.

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require('/opt/node22/lib/node_modules/playwright'); }

const PORT = 8900 + Math.floor(Math.random() * 90);
const BASE = `http://localhost:${PORT}`;
const shots = process.argv[2] || null;
if (shots) fs.mkdirSync(shots, { recursive: true });

const server = spawn(process.execPath, ['scripts/assistant-dev.mjs'], { env: Object.assign({}, process.env, { PORT: String(PORT), ANTHROPIC_API_KEY: '' }), stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res, rej) => { server.stdout.on('data', d => { if (String(d).includes('dev server')) res(); }); server.on('exit', c => rej(new Error('server exited ' + c))); });

const browser = await pw.chromium.launch();
let failures = 0, current = null;
const step = async (name, fn) => {
  try { await fn(); console.log('ok   ' + name); }
  catch (e) {
    failures++; console.log('FAIL ' + name + '\n     ' + String(e.message).split('\n')[0]);
    if (shots && current) await current.screenshot({ path: `${shots}/FAIL-${failures}.png` }).catch(() => {});
  }
};
const shot = async (page, name) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: false }); };

try {
  const ctx = await browser.newContext({ ...pw.devices['iPhone 14'], colorScheme: 'dark', timezoneId: 'America/Chicago' });
  const page = current = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (/Content Security Policy|Refused to/i.test(m.text())) errors.push(m.text()); });

  await step('signed-out visitor sees Sign in with Google', async () => {
    await page.goto(BASE + '/assistant/');
    await page.getByText('Sign in with Google').waitFor();
    await shot(page, '00-signin');
  });

  await step('sign in lands on Today with calendar and email', async () => {
    await page.goto(BASE + '/__dev/login');
    await page.getByText('Catch me up').waitFor();
    await page.getByText('Irrigation walk — Henderson').waitFor();
    await page.getByText('Waiting on you').waitFor();
    await shot(page, '01-today');
  });

  await step('bottom tabs navigate between the six screens', async () => {
    for (const [tab, marker] of [['Inbox', 'h1:has-text("Inbox")'], ['Assistant', 'h1:has-text("Assistant")'], ['Dreams', 'h1:has-text("Dream Board")'], ['Search', 'h1:has-text("Search")'], ['More', 'h1:has-text("More")'], ['Today', 'text=Catch me up']]) {
      await page.locator('#tabbar a', { hasText: tab }).click();
      await page.locator(marker).first().waitFor();
      assert.equal(await page.locator('#tabbar a.on').innerText(), tab);
    }
  });

  await step('capture from Today is saved and filed (ALP idea)', async () => {
    await page.locator('.dock textarea').fill('Build a customer portal where ALP clients can see their services and photos.');
    await page.locator('.dock .send').click();
    await page.locator('.toast', { hasText: 'Saved · Idea · ALP' }).waitFor();
    await shot(page, '02-captured');
  });

  await step('a question typed into capture goes to the assistant', async () => {
    await page.locator('.dock textarea').fill('What did Josh say about irrigation?');
    await page.locator('.dock .send').click();
    await page.waitForURL(/#\/assistant/);
    await page.locator('.msg.assistant:not(.pending)').first().waitFor({ timeout: 15000 });
    const txt = await page.locator('.msg.assistant .answer').first().innerText();
    assert.match(txt, /search found/i);
    assert.match(txt, /Irrigation plan for the Hendersons/);
    await shot(page, '03-assistant');
  });

  await step('"Why?" shows evidence and what was searched', async () => {
    await page.locator('[data-why]').first().click();
    await page.getByText('Why I said that').waitFor();
    await shot(page, '04-evidence');
    await page.keyboard.press('Escape');
  });

  await step('offline capture is kept on the phone and syncs when back online', async () => {
    await page.locator('#tabbar a', { hasText: 'Inbox' }).click();
    await page.locator('h1:has-text("Inbox")').waitFor();
    await ctx.setOffline(true);
    await page.locator('#fab').click();
    await page.locator('.sheet textarea').fill('Remind me tomorrow to check the Henderson drip conversion');
    await page.locator('.sheet .send').click();
    await page.locator('.toast', { hasText: 'Saved on this phone' }).waitFor();
    await page.locator('#net', { hasText: 'Offline' }).waitFor();
    await page.locator('.pending-item').waitFor();
    await shot(page, '05-offline');
    await ctx.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.locator('.pending-item').waitFor({ state: 'detached', timeout: 15000 });
    await page.locator('#tabbar a', { hasText: 'Today' }).click();
    await page.locator('#tabbar a', { hasText: 'Inbox' }).click();
    await page.locator('.cap-title', { hasText: 'Henderson drip conversion' }).waitFor();
  });

  await step('idea card: open, change status and project', async () => {
    await page.locator('.cap-title', { hasText: 'customer portal' }).first().click();
    await page.locator('.idea-title').waitFor();
    await page.locator('[data-status="thinking"]').click();
    await page.locator('[data-project]').selectOption({ label: '🧮 Pricing App' });
    await page.locator('.toast', { hasText: 'Moved' }).waitFor();
    await shot(page, '06-idea');
    await page.reload();
    await page.locator('[data-status="thinking"].on').waitFor();
  });

  await step('universal search groups results by source', async () => {
    await page.goto(BASE + '/assistant/#/search?q=pricing');
    await page.locator('.result-group .sec-h', { hasText: 'Sheets' }).waitFor();
    await page.locator('.result', { hasText: 'Pricing Matrix 2026' }).waitFor();
    await shot(page, '07-search');
  });

  await step('connections list each service with what it can and cannot do', async () => {
    await page.goto(BASE + '/assistant/#/connections');
    await page.getByText('owner@example.com').waitFor();
    assert.equal(await page.locator('.svc').count(), 5);
    await page.locator('.svc-perm summary').first().click();
    await page.getByText('Send, delete, archive or label email').waitFor();
    await shot(page, '08-connections');
  });

  await step('Dream Board: a capture that names it is saved, sent and shows where it went', async () => {
    await page.goto(BASE + '/assistant/#/today');
    await page.locator('.dock textarea').fill('Save this for my Dream Board — someday I want a lake house with a dock');
    await page.locator('.dock .send').click();
    await page.locator('.toast', { hasText: 'Dream Board' }).waitFor();
    await shot(page, '09-dream-toast');
    await page.goto(BASE + '/assistant/#/inbox?f=all');
    await page.locator('.cap-title', { hasText: 'lake house' }).first().click();
    await page.locator('.route-block', { hasText: 'Saved to Dream Board · “Lake House”' }).waitFor({ timeout: 15000 });
    await shot(page, '10-dream-item');
    await page.locator('.route-block a', { hasText: 'Open' }).click();
    await page.locator('.idea-title', { hasText: 'Lake House' }).waitFor();
    await page.getByText('someday I want a lake house with a dock').first().waitFor();
    await page.getByText('added to Dream Board').waitFor();
    await shot(page, '11-dream-page');
  });

  await step('Dream Board: "my house dream" asks which one instead of guessing', async () => {
    await page.goto(BASE + '/assistant/#/today');
    await page.locator('.dock textarea').fill('Add this to my house dream: a porch swing');
    await page.locator('.dock .send').click();
    await page.getByText('Which dream?').first().waitFor();
    await shot(page, '12-which-dream');
    await page.locator('.sheet [data-c]', { hasText: 'Beach House' }).click();
    await page.locator('.toast', { hasText: 'Beach House' }).waitFor();
  });

  await step('Dream Board: offline board queues honestly, then catches up', async () => {
    await page.request.get(BASE + '/__dev/dreamboard?offline=1');
    await page.goto(BASE + '/assistant/#/today');
    await page.locator('.dock textarea').fill('Add to my fitness dream: sign up for a 10k');
    await page.locator('.dock .send').click();
    await page.locator('.toast', { hasText: 'Adding to “Fitness”' }).waitFor();
    await page.request.get(BASE + '/__dev/dreamboard?offline=0&milestone=Fitness');
    await page.waitForTimeout(4500);
    await page.reload();
    await page.locator('.sec-h', { hasText: 'Dreams & goals' }).waitFor();
    await page.getByText('1 milestone completed this month').waitFor();
    await shot(page, '13-today-dreams');
  });

  await step('Catch Me Up tells what changed since, including Dream Board', async () => {
    await page.locator('[data-catchup]').click();
    await page.locator('.sheet .eyebrow', { hasText: 'Since' }).waitFor();
    await page.locator('.sheet .answer', { hasText: 'You added “Lake House” to Dream Board' }).waitFor();
    await page.locator('.sheet .answer', { hasText: 'Fitness' }).waitFor();
    await shot(page, '14-catchup');
    await page.keyboard.press('Escape');
  });

  await step('search finds the dream as its own source; Connections shows what Dream Board can do', async () => {
    await page.goto(BASE + '/assistant/#/search?q=lake%20house');
    await page.locator('.result-group .sec-h', { hasText: 'Dream Board' }).waitFor();
    await page.goto(BASE + '/assistant/#/connections');
    const card = page.locator('[data-app="dreamboard"]');
    await card.getByText('Add dreams').waitFor();
    await card.getByText('Delete or merge — off').waitFor();
    await page.locator('.ability', { hasText: 'Send — off' }).waitFor();
    await shot(page, '15-connections-apps');
  });

  await step('no uncaught page errors on mobile', async () => { assert.deepEqual(errors, []); });

  const desk = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', timezoneId: 'America/Chicago' });
  const dp = await desk.newPage();
  await step('desktop: rail, content and context panel', async () => {
    await dp.goto(BASE + '/__dev/login');
    await dp.getByText('Catch me up').waitFor();
    assert.ok(await dp.locator('#rail').isVisible());
    assert.ok(await dp.locator('#context').isVisible());
    assert.ok(!(await dp.locator('#tabbar').isVisible()));
    await shot(dp, '09-desktop-today');
    await dp.goto(BASE + '/assistant/#/assistant');
    await dp.locator('.chat-empty').waitFor();
    await dp.locator('.dock textarea').fill('pricing');
    await dp.locator('.dock textarea').press('Enter');
    await dp.locator('.msg.assistant:not(.pending)').first().waitFor({ timeout: 15000 });
    await dp.locator('#context .ctx-h', { hasText: 'Sources' }).waitFor();
    await shot(dp, '10-desktop-assistant');
  });

  const light = await browser.newContext({ ...pw.devices['iPhone 14'], colorScheme: 'light' });
  const lp = await light.newPage();
  await step('light mode renders', async () => {
    await lp.goto(BASE + '/__dev/login');
    await lp.getByText('Catch me up').waitFor();
    await shot(lp, '11-today-light');
  });
} finally {
  await browser.close();
  server.kill();
}
console.log(failures ? `\n${failures} browser check(s) failed` : '\nall browser checks passed');
process.exit(failures ? 1 : 0);
