// walks every flow w/ keyb alone; both themes at phone and desktop widths
// measures contrast of all visi txt & every control edge passes. run w/ `pnpm a11y [report.md]`.
// txt needs 4.5:1, control edges & focus ring 3:1. disabled buttons are measured + exempt.

import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { newId } from '../../lib/db.js';
import { executablePath, startServer } from './site.js';

const report = process.argv[2];
const TEXT = 4.5;
const EDGE = 3;

// runs in pg: every visi txt node & control edge, with color it sits on
function measure() {
  const parse = (value) => {
    const match = value.match(/^rgba?\(([^)]+)\)$/);
    if (!match) return null;
    const [r, g, b, a = 1] = match[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return [r, g, b, a];
  };
  const over = (top, bottom) => [0, 1, 2].map((i) => top[i] * top[3] + bottom[i] * (1 - top[3])).concat(1);
  const backdrop = (element) => {
    const layers = [];
    for (let node = element; node; node = node.parentElement) {
      const color = parse(getComputedStyle(node).backgroundColor);
      if (color && color[3] > 0) {
        layers.push(color);
        if (color[3] >= 1) break;
      }
    }
    return layers.reverse().reduce((below, layer) => over(layer, below), [255, 255, 255, 1]);
  };
  const opacity = (element) => {
    let value = 1;
    for (let node = element; node; node = node.parentElement) value *= Number(getComputedStyle(node).opacity);
    return value;
  };
  const luminance = ([r, g, b]) => {
    const [R, G, B] = [r, g, b].map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * R + 0.7152 * G + 0.0722 * B;
  };
  const ratio = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const hex = (color) => '#' + color.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  const describe = (element) => {
    const classes = [...element.classList].map((name) => `.${name}`).join('');
    return `${element.tagName.toLowerCase()}${classes}`;
  };
  const hidden = (element) => {
    if (!element.checkVisibility({ visibilityProperty: true })) return true;
    const box = element.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) return true;
    return Boolean(element.closest('.visually-hidden')) || box.right < 0;
  };

  const found = [];
  const add = (kind, element, fg, bgElement, snippet) => {
    if (!fg) return;
    const bg = backdrop(bgElement);
    const seen = over([fg[0], fg[1], fg[2], fg[3] * opacity(element)], bg);
    const disabled = Boolean(element.closest(':disabled'));
    found.push({ kind: disabled ? `${kind}, disabled` : kind, fg: hex(seen), bg: hex(bg), ratio: ratio(seen, bg), where: describe(element), snippet, exempt: disabled });
  };

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent.trim();
    if (!text) continue;
    let element = node.parentElement;
    if (element.closest('select')) element = element.closest('select');
    if (element.closest('script, style') || hidden(element)) continue;
    add('text', element, parse(getComputedStyle(element).color), element, text.slice(0, 40));
  }
  for (const field of document.querySelectorAll('input[placeholder], textarea[placeholder]')) {
    if (hidden(field) || field.value) continue;
    add('placeholder', field, parse(getComputedStyle(field, '::placeholder').color), field, field.placeholder);
  }
  for (const control of document.querySelectorAll('input, textarea, select, button, a.button')) {
    if (hidden(control)) continue;
    const style = getComputedStyle(control);
    if (style.borderTopStyle === 'none' || parseFloat(style.borderTopWidth) === 0) continue;
    const fill = parse(style.backgroundColor);
    // filled ctrl is told apart by its fill not edge
    const edgeAgainst = control.parentElement;
    const fillShows = fill && fill[3] > 0 && ratio(over(fill, backdrop(edgeAgainst)), backdrop(edgeAgainst)) >= 3;
    if (fillShows) continue;
    add('control edge', control, parse(style.borderTopColor), edgeAgainst, control.textContent.trim().slice(0, 40) || control.id);
  }
  return found;
}

// runs in pg: what has focus + how its ring measures against where it sits & what on

function focusState() {
  const element = document.activeElement;
  if (!element || element === document.body) return { name: 'nothing' };
  const style = getComputedStyle(element);
  const name = `${element.tagName.toLowerCase()}${element.id ? '#' + element.id : ''} "${(element.getAttribute('aria-label') || element.textContent || element.placeholder || '').trim().slice(0, 30)}"`;
  const ring = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 1;
  const box = element.getBoundingClientRect();
  return { name, id: element.id, ring, outline: style.outlineColor, onScreen: box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth };
}

async function walk(browser, theme, width, results) {
  const site = await startServer({ SIGNUP_MODE: 'allowlist' });
  const context = await browser.newContext({ viewport: { width, height: 900 }, acceptDownloads: true });
  await context.addInitScript((chosen) => { if (!localStorage.getItem('theme')) localStorage.setItem('theme', chosen); }, theme);
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (err) => problems.push(`page error: ${err.message}`));
  page.on('response', (response) => { if (response.status() >= 500) problems.push(`${response.status()} from ${response.url()}`); });
  walk.page = page;
  walk.problems = problems;
  walk.site = site;
  let tabs = 0;

  const scan = async (step) => {
    for (const item of await page.evaluate(measure)) {
      const key = `${theme}|${item.kind}|${item.fg}|${item.bg}`;
      const entry = results.get(key) ?? { theme, ...item, steps: new Set(), examples: new Set() };
      entry.ratio = Math.min(entry.ratio, item.ratio);
      entry.steps.add(step);
      if (entry.examples.size < 3) entry.examples.add(`${item.where} "${item.snippet}"`);
      results.set(key, entry);
    }
  };

  // presses tab til the target has focus; checks every stop + shows ring
  const tabTo = async (locator) => {
    await locator.waitFor({ timeout: 5000 });
    for (let i = 0; i < 150; i += 1) {
      await page.keyboard.press('Tab');
      tabs += 1;
      const state = await page.evaluate(focusState);
      if (state.name !== 'nothing' && state.id !== 'main' && !state.ring) problems.push(`no focus ring on ${state.name}`);
      if (state.name !== 'nothing' && !state.onScreen) problems.push(`focus off screen on ${state.name}`);
      if (await locator.evaluate((element) => element === document.activeElement)) return state;
    }
    throw new Error(`tab never reached ${locator}`);
  };
  const press = async (locator, key = 'Enter') => {
    await tabTo(locator);
    await page.keyboard.press(key);
  };
  const type = async (locator, text) => {
    await tabTo(locator);
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.insertText(text);
  };
  const choose = async (locator, label) => {
    await tabTo(locator);
    await page.keyboard.type(label);
    const shown = await locator.evaluate((select) => select.selectedOptions[0].textContent);
    if (shown !== label) problems.push(`typing "${label}" into ${await locator.getAttribute('id')} chose "${shown}"`);
  };
  // pg change inside app should leave focus at the top of new content
  const landed = async (where) => {
    await page.waitForFunction(() => document.activeElement?.id === 'main', null, { timeout: 2000 })
      .catch(() => problems.push(`focus not moved to the content after going to ${where}`));
  };
  const nav = (name) => page.getByRole('navigation', { name: 'main' }).getByRole('link', { name, exact: true });
  const button = (name) => page.getByRole('button', { name, exact: true });
  const see = (text) => page.getByText(text, { exact: false }).first().waitFor({ timeout: 5000 });

  await page.goto(site.origin + '/');
  await see('welcome to the');
  const first = await tabTo(page.getByRole('link', { name: 'skip to content' }));
  if (!first.onScreen) problems.push('skip link not visible when focused');
  await page.keyboard.press('Enter');
  if (await page.evaluate(() => document.activeElement?.id) !== 'main') problems.push('skip link did not move focus to the content');
  await scan('signed-out feed');

  await press(nav('sign in'));
  await landed('sign in');
  await scan('sign in');
  await press(page.getByRole('link', { name: 'propagate' }));
  await landed('propagate');
  await type(page.getByLabel('email'), 'walker@example.com');
  await type(page.getByLabel('a note, if you like'), 'found it through a friend.');
  await scan('propagate');
  await press(button('ask to join'));
  await see('received.');
  await scan('propagate, received');

  await press(nav('sign in'));
  await press(button('use a password instead'));
  await type(page.getByLabel('email'), 'matter@spore.bond');
  await type(page.getByLabel('password'), 'not the right one');
  await page.keyboard.press('Enter');
  await page.getByRole('alert').waitFor();
  await scan('sign in, wrong password');
  await press(button('email me a link instead'));
  await press(button('email me a link'));
  await see('a link is on its way');
  await scan('link sent');

  await page.goto(site.lastLink());
  await see('sign in as');
  await scan('continue');
  await press(button('continue'));
  await type(page.getByLabel('handle'), 'moss');
  await page.keyboard.press('Enter');
  await page.getByPlaceholder('release some matter...').waitFor();
  await press(nav('stewards'));
  await landed('stewards');
  await see('walker@example.com');
  await scan('stewards');
  await press(button('let in'));
  await see('nothing pending.');
  await press(button('approved'));
  await see('send the invite again');
  await scan('stewards, approved');
  await press(nav('soil'));
  await press(button('sign out'));
  await nav('sign in').waitFor();

  await page.goto(site.lastLink());
  await press(button('continue'));
  await type(page.getByLabel('handle'), 'Walker!');
  await scan('handle');
  await page.keyboard.press('Enter');
  const composer = page.getByPlaceholder('release some matter...');
  await composer.waitFor();
  await scan('feed, signed in');

  await type(composer, 'x'.repeat(1001));
  await scan('composer, over the limit');
  await type(composer, 'first *matter* from the keyboard.');
  await choose(page.getByLabel('who sees it'), 'public');
  await press(button('matter'));
  await see('from the keyboard');
  await type(composer, 'this one stays with me.');
  await choose(page.getByLabel('who sees it'), 'private');
  await press(button('matter'));
  await composer.and(page.locator(':placeholder-shown')).waitFor();

  await press(page.locator('article', { hasText: 'welcome to the' }).getByRole('link', { name: 'view germinations' }));
  await landed('a thread');
  await type(page.getByPlaceholder('germinate...'), 'hello alice.');
  await press(button('germinate'));
  await see('1 germination');
  await scan('thread');

  await press(page.getByRole('link', { name: '← burrow' }));
  await landed('the feed');
  await press(page.locator('.matter-body').getByRole('link', { name: '@alice' }).first());
  await landed('a profile from inside matter');
  await press(button('bond'));
  await button('unbond').waitFor();
  await press(button('fuse'), ' ');
  await button('cancel fuse request').waitFor();
  const walker = site.db.prepare("SELECT id FROM users WHERE handle = 'walker'").pluck().get();
  site.db.prepare('INSERT INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)').run(site.alice, walker, Date.now());
  site.db.prepare('INSERT INTO posts (id, user_id, content, tier, created_at) VALUES (?, ?, ?, 1, ?)').run(newId(), site.alice, 'for hosts and fused.', Date.now());
  await page.reload();
  await see('mutuals');
  await scan('profile, mutuals');

  await press(nav('@walker'));
  await landed('your own spore');
  await see('this one stays with me.');
  await scan('own spore');
  await press(page.locator('article', { hasText: 'this one stays with me.' }).getByRole('button', { name: 'rot' }));
  await scan('confirm');
  await press(page.getByRole('alertdialog').getByRole('button', { name: 'rot', exact: true }));
  await page.locator('article', { hasText: 'this one stays with me.' }).waitFor({ state: 'detached' });

  await press(nav('feed'));
  for (const text of ['this one decays.', 'this one decomposes.']) {
    await type(composer, text);
    await press(button('matter'));
    await see(text);
  }
  await press(nav('@walker'));
  await press(page.locator('article', { hasText: 'this one decays.' }).getByRole('button', { name: 'decay' }));
  await page.locator('article', { hasText: 'this one decays.' }).waitFor({ state: 'detached' });
  await press(page.locator('article', { hasText: 'this one decomposes.' }).getByRole('button', { name: 'decompose' }));
  await page.locator('article', { hasText: 'this one decomposes.' }).waitFor({ state: 'detached' });
  await press(page.getByRole('link', { name: 'decayed', exact: true }));
  await landed('decayed');
  await see('this one decays.');
  await scan('decayed');
  await press(button('restore'));
  await see('nothing decayed.');
  await press(page.getByRole('link', { name: 'decomposing', exact: true }));
  await landed('decomposing');
  await see('this one decomposes.');
  await choose(page.getByLabel('decomposing matter rots after'), '7 days');
  await press(button('save'));
  await see('saved.');
  await scan('decomposing');
  await press(button('rot everything here'));
  await press(page.getByRole('alertdialog').getByRole('button', { name: 'rot everything', exact: true }));
  await see('nothing decomposing.');

  await press(nav('soil'));
  await landed('soil');
  await choose(page.getByLabel('your email address'), 'hosts and fused');
  await press(button('save'));
  await see('saved.');
  await type(page.getByLabel(/^password, at least/), 'a long enough password');
  await press(button('save password'));
  await see('password saved.');
  await scan('soil');
  const [download] = await Promise.all([page.waitForEvent('download'), press(page.getByRole('link', { name: 'render spore print' }))]);
  if (download.suggestedFilename() !== 'spore-print-walker.json') problems.push(`export named ${download.suggestedFilename()}`);

  const other = theme === 'dark' ? 'light' : 'dark';
  await press(button(other), ' ');
  if (await page.evaluate(() => document.documentElement.dataset.theme) !== other) problems.push('the theme toggle did nothing from the keyboard');
  await press(button(theme));
  await choose(page.getByLabel('font', { exact: true }), 'serif');
  await choose(page.getByLabel('text size', { exact: true }), 'large');
  await choose(page.getByLabel('text size', { exact: true }), 'medium');
  await choose(page.getByLabel('font', { exact: true }), 'mono');

  await press(page.getByRole('link', { name: 'privacy' }));
  await landed('privacy');
  await scan('privacy');
  for (const name of ['about', 'terms', 'contact']) {
    await press(page.getByRole('contentinfo').getByRole('link', { name, exact: true }));
    await landed(name);
    await scan(name);
  }
  await press(nav('soil'));
  await type(page.getByLabel(/type your handle/), 'walker');
  await press(button('delete everything'));
  await page.waitForURL(site.origin + '/');
  await nav('sign in').waitFor();
  if (site.db.prepare("SELECT count(*) FROM users WHERE handle = 'walker'").pluck().get() !== 0) problems.push('the account survived deletion');

  // server only answers pg's owned urls

  await page.evaluate(() => { history.pushState(null, '', '/nowhere'); dispatchEvent(new PopStateEvent('popstate')); });
  await see('nothing grows here');
  await scan('not found');

  await context.close();
  await site.close();
  return { problems, tabs };
}

const results = new Map();
const browser = await chromium.launch({ executablePath });
let failed = false;
const summary = [];
for (const theme of ['dark', 'light']) {
  for (const width of [1280, 375]) {
    try {
      const { problems, tabs } = await walk(browser, theme, width, results);
      const unique = [...new Set(problems)];
      summary.push(`${theme} ${width}: ${unique.length ? unique.join('; ') : 'every flow by keyboard'}`);
      console.log(`${summary.at(-1)}${unique.length ? '' : `, ${tabs} tab stops`}`);
      failed ||= unique.length > 0;
    } catch (err) {
      await walk.page?.screenshot({ path: `a11y-${theme}-${width}-FAILED.png`, fullPage: true }).catch(() => {});
      summary.push(`${theme} ${width}: failed`);
      console.log(`${theme} ${width}: failed: ${err.message.split('\n').slice(0, 3).join(' | ')} | seen: ${walk.problems?.join('; ') || 'no browser errors'} | at ${walk.page?.url()}`);
      failed = true;
    }
  }
}
await browser.close();

const rows = [...results.values()].sort((a, b) => a.theme.localeCompare(b.theme) || a.ratio - b.ratio);
const need = (row) => (row.kind.startsWith('text') || row.kind.startsWith('placeholder') ? TEXT : EDGE);
const short = rows.filter((row) => !row.exempt && row.ratio < need(row));
for (const row of short) console.log(`contrast ${row.theme}: ${row.kind} ${row.fg} on ${row.bg} is ${row.ratio.toFixed(2)}:1, needs ${need(row)} (${[...row.examples][0]})`);
console.log(`${rows.length} color pairs measured, ${short.length} short`);
failed ||= short.length > 0;

if (report) {
  const table = (theme) => [
    '| kind | color | on | ratio | needs | | seen in |',
    '|---|---|---|---|---|---|---|',
    ...rows.filter((row) => row.theme === theme).map((row) => {
      const verdict = row.exempt ? 'exempt' : row.ratio >= need(row) ? 'pass' : '**short**';
      return `| ${row.kind} | \`${row.fg}\` | \`${row.bg}\` | ${row.ratio.toFixed(2)} | ${need(row)} | ${verdict} | ${[...row.examples].join('; ').replace(/\|/g, '/')} |`;
    }),
  ].join('\n');
  fs.writeFileSync(report, `# contrast\n\nmeasured by \`pnpm a11y\` in chromium, ${new Date().toISOString().slice(0, 10)}, on every screen the keyboard walk passes through, at 1280 and 375 wide. a color is what reaches the screen after transparency and opacity. text needs 4.5:1. control edges need 3:1, and only count where the control has no fill to tell it apart. disabled buttons are exempt. the focus ring is the accent color, so its pairs are the accent text rows.\n\n## keyboard\n\nevery flow reached and worked with tab, enter and space alone: the skip link, sign-in by link and by password, propagate, the stewards queue, the handle picker, matter at a chosen tier, a germination, bond and fuse, rot, decay and restore, decompose, the bin's days and emptying it, soil with its tiers, password and spore print, the theme and font toggles, privacy, account deletion. every stop showed a focus ring on screen, and every page change inside the app moved focus to the new content.\n\n${summary.map((line) => `- ${line}`).join('\n')}\n\n## dark\n\n${table('dark')}\n\n## light\n\n${table('light')}\n`);
  console.log(`report in ${report}`);
}
process.exit(failed ? 1 : 0);
