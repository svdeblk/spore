// walks flow in browser; both themes at phone & desktop widths
// saves a scrnshot of each step; run w/ `pnpm walkthrough [screens-dir]`; pass needs chromium
// set CHROMIUM_PATH if playwright x find one

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { executablePath, startServer } from './site.js';

const out = path.resolve(process.argv[2] ?? 'walkthrough-screens');
fs.mkdirSync(out, { recursive: true });

const expectText = (page, text) => page.getByText(text, { exact: false }).first().waitFor({ timeout: 5000 });

async function walk(browser, theme, width) {
  const site = await startServer();
  const context = await browser.newContext({ viewport: { width, height: 900 }, acceptDownloads: true });
  await context.addInitScript((chosen) => localStorage.setItem('theme', chosen), theme);
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (err) => problems.push(`page error: ${err.message}`));
  // a 401 from /api/me = a signed-out page learning it's signed out; only script errors and 5xx count
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) problems.push(`console: ${message.text()}`);
  });
  page.on('response', (response) => { if (response.status() >= 500) problems.push(`${response.status()} from ${response.url()}`); });
  page.on('requestfailed', (request) => problems.push(`request failed: ${request.method()} ${request.url()} ${request.failure()?.errorText}`));
  const sure = (name) => page.getByRole('alertdialog').getByRole('button', { name, exact: true }).click();

  let step = 0;
  page.on('close', () => {});
  walk.page = page;
  walk.problems = problems;
  const shot = async (name) => {
    step += 1;
    await page.screenshot({ path: path.join(out, `${theme}-${width}-${String(step).padStart(2, '0')}-${name}.png`), fullPage: true });
  };

  await page.goto(site.origin + '/');
  await expectText(page, 'welcome to the');
  await shot('signed-out-feed');

  await page.getByRole('link', { name: 'sign in' }).first().click();
  await page.getByLabel('email').fill('walker@example.com');
  await page.getByRole('button', { name: 'email me a link' }).click();
  await expectText(page, 'a link is on its way');
  await shot('link-sent');

  const link = site.lastLink();
  await page.goto(link);
  await expectText(page, 'sign in as');
  await shot('continue');
  await page.getByRole('button', { name: 'continue' }).click();
  await page.getByLabel('handle').waitFor();
  await page.getByLabel('handle').fill('Walker!');
  await shot('handle');
  await page.getByRole('button', { name: 'keep it' }).click();
  await page.getByPlaceholder('release some matter...').waitFor();

  await page.getByPlaceholder('release some matter...').fill('first *matter* from the walkthrough.');
  await page.getByLabel('who sees it').selectOption('public');
  await page.getByRole('button', { name: 'matter', exact: true }).click();
  await expectText(page, 'from the walkthrough');
  await shot('public-post');

  await page.getByPlaceholder('release some matter...').fill('this one stays with me.');
  await page.getByLabel('who sees it').selectOption('private');
  await page.getByRole('button', { name: 'matter', exact: true }).click();
  await page.getByPlaceholder('release some matter...').and(page.locator(':placeholder-shown')).waitFor();
  await shot('private-post');

  await page.locator('article', { hasText: 'welcome to the' }).getByRole('link', { name: 'view germinations' }).click();
  await page.getByPlaceholder('germinate...').fill('hello alice.');
  await page.getByRole('button', { name: 'germinate', exact: true }).click();
  await expectText(page, 'hello alice.');
  await expectText(page, '1 germination');
  await shot('thread-with-germination');

  await page.getByRole('link', { name: '← burrow' }).click();
  await page.locator('.matter-body').getByRole('link', { name: '@alice' }).first().click();
  await page.waitForURL(/\/@alice$/);
  await page.getByRole('heading', { name: '@alice' }).waitFor();
  await shot('internal-link-to-profile');
  await page.getByRole('button', { name: 'bond', exact: true }).click();
  await page.getByRole('button', { name: 'unbond' }).waitFor();
  await page.getByRole('button', { name: 'fuse', exact: true }).click();
  await page.getByRole('button', { name: 'cancel fuse request' }).waitFor();
  await shot('profile-bonded-fuse-requested');

  await page.getByRole('link', { name: '@walker' }).first().click();
  await expectText(page, 'this one stays with me.');
  await shot('own-spore-with-private');
  await page.locator('article', { hasText: 'this one stays with me.' }).getByRole('button', { name: 'rot' }).click();
  await shot('confirm-rot');
  await sure('rot');
  await page.locator('article', { hasText: 'this one stays with me.' }).waitFor({ state: 'detached' });
  await shot('after-rot');

  // decay sends matter to the archive and back; decompose sends it to the bin, which is emptied here
  await page.getByRole('navigation', { name: 'main' }).getByRole('link', { name: 'feed' }).click();
  for (const text of ['this one decays.', 'this one decomposes.']) {
    await page.getByPlaceholder('release some matter...').fill(text);
    await page.getByRole('button', { name: 'matter', exact: true }).click();
    await expectText(page, text);
    await page.getByPlaceholder('release some matter...').and(page.locator(':placeholder-shown')).waitFor();
  }
  await page.getByRole('navigation', { name: 'main' }).getByRole('link', { name: '@walker' }).click();
  await page.locator('article', { hasText: 'this one decays.' }).getByRole('button', { name: 'decay' }).click();
  await page.locator('article', { hasText: 'this one decays.' }).waitFor({ state: 'detached' });
  await page.locator('article', { hasText: 'this one decomposes.' }).getByRole('button', { name: 'decompose' }).click();
  await page.locator('article', { hasText: 'this one decomposes.' }).waitFor({ state: 'detached' });
  await page.getByRole('link', { name: 'decayed', exact: true }).click();
  await expectText(page, 'this one decays.');
  await shot('decayed');
  await page.getByRole('button', { name: 'restore' }).click();
  await expectText(page, 'nothing decayed.');
  await page.getByRole('link', { name: 'decomposing', exact: true }).click();
  await expectText(page, 'this one decomposes.');
  await expectText(page, 'rots ');
  await page.getByLabel('decomposing matter rots after').selectOption('7');
  await page.getByRole('button', { name: 'save', exact: true }).click();
  await expectText(page, 'saved.');
  await shot('decomposing');
  await page.getByRole('button', { name: 'rot everything here' }).click();
  await sure('rot everything');
  await expectText(page, 'nothing decomposing.');
  await page.getByRole('navigation', { name: 'main' }).getByRole('link', { name: '@walker' }).click();
  await expectText(page, 'this one decays.');

  // a puffball on the profile, then a morel shared to the feed as a card
  await page.getByLabel('puffball', { exact: true }).fill('out in the woods this week');
  await page.getByRole('button', { name: 'set puffball' }).click();
  await page.getByRole('button', { name: 'take it down' }).waitFor();
  await shot('puffball');
  await page.getByRole('navigation', { name: 'main' }).getByRole('link', { name: 'feed' }).click();
  await page.getByRole('link', { name: 'write a morel' }).click();
  await page.getByLabel('title', { exact: true }).fill('on moss');
  await page.getByLabel('the morel', { exact: true }).fill('a long *thought* about moss.\n\nand then some more of it.');
  await page.getByLabel('share to the feed as a card').check();
  await shot('morel-form');
  await page.getByRole('button', { name: 'release morel' }).click();
  await page.getByRole('heading', { name: 'on moss' }).waitFor();
  await expectText(page, 'and then some more of it.');
  await page.getByRole('button', { name: 'take the card back' }).click();
  await page.getByRole('button', { name: 'share to the feed', exact: true }).click();
  await page.getByRole('button', { name: 'take the card back' }).waitFor();
  await shot('morel');
  await page.getByRole('link', { name: '← burrow' }).click();
  await page.locator('article', { hasText: 'on moss' }).getByRole('link', { name: 'read morel' }).waitFor();
  await shot('morel-card');
  await page.locator('article', { hasText: 'on moss' }).getByRole('link', { name: 'read morel' }).click();
  await page.getByRole('heading', { name: 'on moss' }).waitFor();
  await page.getByRole('navigation', { name: 'main' }).getByRole('link', { name: '@walker' }).click();
  await page.getByRole('button', { name: 'take it down' }).waitFor();
  if (await page.getByLabel('puffball', { exact: true }).inputValue() !== 'out in the woods this week') problems.push('the puffball was not kept');

  await page.getByRole('navigation', { name: 'main' }).getByRole('link', { name: 'soil' }).click();
  await page.getByRole('heading', { name: 'who sees what' }).waitFor();
  await shot('soil');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'render spore print' }).click()]);
  const print = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
  if (download.suggestedFilename() !== 'spore-print-walker.json') problems.push(`export named ${download.suggestedFilename()}`);
  if (print.matter.length !== 4) problems.push(`export holds ${print.matter.length} matter, expected 4`);

  await page.getByLabel(/type your handle/).fill('walker');
  await page.getByRole('button', { name: 'delete everything' }).click();
  await page.waitForURL(site.origin + '/');
  await page.getByRole('link', { name: 'sign in' }).first().waitFor();
  await shot('account-deleted');
  if (site.db.prepare("SELECT count(*) FROM users WHERE handle = 'walker'").pluck().get() !== 0) problems.push('the account survived deletion');

  await context.close();
  await site.close();
  return problems;
}

const browser = await chromium.launch({ executablePath });
let failed = false;
for (const theme of ['dark', 'light']) {
  for (const width of [1280, 375]) {
    try {
      const problems = await walk(browser, theme, width).catch(async (err) => {
        await walk.page?.screenshot({ path: path.join(out, `${theme}-${width}-FAILED.png`), fullPage: true }).catch(() => {});
        err.message += ` | seen: ${walk.problems?.join('; ') || 'no browser errors'}`;
        throw err;
      });
      console.log(`${theme} ${width}: ${problems.length ? problems.join('; ') : 'every flow passed'}`);
      failed ||= problems.length > 0;
    } catch (err) {
      console.log(`${theme} ${width}: failed: ${err.message.split('\n').slice(0, 3).join(' | ')}`);
      failed = true;
    }
  }
}
await browser.close();
console.log(`screenshots in ${out}`);
process.exit(failed ? 1 : 0);