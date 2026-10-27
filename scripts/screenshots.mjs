#!/usr/bin/env node
// Regenerates the README images in docs/images: the header (light/dark), the
// social preview card and the app screenshots, using headless Chrome over the
// DevTools protocol. No npm dependencies (Node >= 22 for the built-in WebSocket).
//
//   cargo build --release
//   mermdraw icons add logos devicon        # once, so L2 screenshots show real icons
//   node scripts/screenshots.mjs
//
// Env: CHROME (path to Chrome/Chromium), MERMDRAW_BIN (default target/release/mermdraw).

import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'images');
const BIN = process.env.MERMDRAW_BIN || join(ROOT, 'target', 'release', 'mermdraw');
const CHROME = process.env.CHROME || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find(existsSync);
const APP_PORT = 7811;
const DEBUG_PORT = 9341;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!CHROME) throw new Error('Chrome not found; set CHROME=/path/to/chrome');
if (!existsSync(BIN)) throw new Error(`${BIN} not found; run cargo build --release`);

// ---------------------------------------------------------------- processes
const work = mkdtempSync(join(tmpdir(), 'mermdraw-shots-'));
cpSync(join(ROOT, 'examples'), join(work, 'docs'), { recursive: true });
const procs = [
  spawn(BIN, [join(work, 'docs'), '--no-open', '--port', String(APP_PORT)], { stdio: 'ignore' }),
  spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${join(work, 'chrome')}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--force-color-profile=srgb', 'about:blank',
  ], { stdio: 'ignore' }),
];
const cleanup = () => {
  for (const p of procs) p.kill();
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Chrome may still be flushing its profile; the OS cleans the temp dir eventually.
  }
};
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

async function retry(fn, what) {
  for (let i = 0; i < 100; i++) {
    try {
      return await fn();
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ---------------------------------------------------------------- minimal CDP client
async function connect() {
  const targets = await retry(() => fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).then((r) => r.json()), 'Chrome');
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((ok, fail) => ((ws.onopen = ok), (ws.onerror = fail)));
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.fail(new Error(msg.error.message)) : p.ok(msg.result);
  };
  const send = (method, params = {}) =>
    new Promise((ok, fail) => {
      const id = ++seq;
      pending.set(id, { ok, fail });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  return { send, evaluate };
}

const page = await connect();
await retry(() => fetch(`http://127.0.0.1:${APP_PORT}/api/info`).then((r) => r.json()), 'mermdraw');
const packs = (await (await fetch(`http://127.0.0.1:${APP_PORT}/api/icons`)).json()).packs.map((p) => p.name);
if (!packs.includes('logos')) console.warn('warning: `logos` icon pack not installed; L2 shots will show placeholders');

/** Loads `url` at the given size and theme, runs `setup` (a function source) in the page, saves a PNG. */
async function shoot(file, { url, width = 1600, height = 960, scale = 1.25, dark = false, setup = '' }) {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
  await page.send('Page.navigate', { url });
  await sleep(300);
  await retry(() => page.evaluate('document.readyState === "complete" || Promise.reject()'), url);
  if (setup) await page.evaluate(`(async () => { ${setup} })()`);
  const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, file), Buffer.from(data, 'base64'));
  console.log(`docs/images/${file}`);
}

// Helpers available to app setups.
const APP = (file, d = 1) => `http://127.0.0.1:${APP_PORT}/?file=${file}#d=${d}`;
const prelude = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  for (let i = 0; i < 100 && !(window.mermdraw?.S?.model || window.mermdraw?.S?.kind); i++) await sleep(100);
  await sleep(1200);
  const { canvas, S } = window.mermdraw;
  const flags = await import('/flags.js');
  for (const f of flags.FLAGS) flags.setFlag(f.id, undefined);
  const view = async (v) => { $('[data-view="' + v + '"]').click(); await sleep(900); };
`;

// ---------------------------------------------------------------- header + social card
const header = pathToFileURL(join(OUT, 'header.svg')).href;
await shoot('header-light.png', { url: header, width: 1280, height: 320, scale: 2 });
await shoot('header-dark.png', { url: header, width: 1280, height: 320, scale: 2, setup: `document.documentElement.classList.add('dark')` });
await shoot('social-preview.png', {
  url: header,
  width: 1280,
  height: 640,
  scale: 1,
  setup: `
    const svg = document.documentElement;
    svg.classList.add('dark');
    svg.setAttribute('viewBox', '0 -150 1280 640');
    svg.setAttribute('height', '640');
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    Object.entries({ x: 72, y: 440, class: 'muted', 'font-size': 22, 'font-weight': 600 }).forEach(([k, v]) => t.setAttribute(k, v));
    t.textContent = 'github.com/berttoli/mermdraw';
    svg.appendChild(t);`,
});

// ---------------------------------------------------------------- app screenshots
// `focus(ids)` frames a few nodes at a readable zoom instead of fitting a wide diagram.
const focus = `
  const focus = (ids, max = 1) => {
    const bs = ids.map((id) => canvas.box(id)).filter(Boolean);
    const x1 = Math.min(...bs.map((b) => b.x - b.w / 2)), x2 = Math.max(...bs.map((b) => b.x + b.w / 2));
    const y1 = Math.min(...bs.map((b) => b.y - b.h / 2)), y2 = Math.max(...bs.map((b) => b.y + b.h / 2));
    const r = canvas.svg.getBoundingClientRect();
    const k = Math.min(max, (r.width - 200) / (x2 - x1), (r.height - 160) / (y2 - y1));
    canvas.view = { k, x: r.width / 2 + 50 - ((x1 + x2) / 2) * k, y: r.height / 2 - ((y1 + y2) / 2) * k };
    canvas.autoFit = false;
    canvas.render();
    $('#zoom-label').textContent = Math.round(k * 100) + '%';
  };`;

const hero = `${prelude}${focus}
  await view('canvas');
  canvas.select({ nodes: ['cart'] });
  focus(S.model.nodes.map((n) => n.id), 0.95);
  await sleep(800);`;
await shoot('hero-light.png', { url: APP('it-org/l2-digital-products.md'), height: 860, setup: hero });
await shoot('hero-dark.png', { url: APP('it-org/l2-digital-products.md'), height: 860, dark: true, setup: hero });

await shoot('l1-preview.png', {
  url: APP('it-org/README.md', 2),
  setup: `${prelude}
    await view('preview');
    await sleep(1200);`,
});

await shoot('drilldown.png', {
  url: APP('it-org/README.md', 2),
  dark: true,
  setup: `${prelude}${focus}
    canvas.select({ nodes: ['workplace'] });
    await sleep(200);
    $('#inspector [data-act="follow"]').click();
    for (let i = 0; i < 50 && !S.path.endsWith('l2-workplace-it.md'); i++) await sleep(100);
    await sleep(2500);
    await view('canvas');
    canvas.select({ nodes: ['idp'] });
    canvas.fit();
    await sleep(800);`,
});

await shoot('icon-picker.png', {
  url: APP('it-org/l2-cloud-platform.md'),
  dark: true,
  setup: `${prelude}
    await view('canvas');
    canvas.fit();
    $('#palette [data-shape="icon"]').click();
    await sleep(300);
    $('#icon-q').value = 'cloud';
    $('#icon-q').dispatchEvent(new Event('input'));
    await sleep(2500);`,
});

await shoot('styles.png', {
  url: APP('payments.md'),
  setup: `${prelude}
    flags.setFlag('themes', true);
    await view('split');
    canvas.select({});
    await sleep(300);
    const preset = $('#inspector [data-k="preset"]');
    preset.value = 'mint';
    preset.dispatchEvent(new Event('change'));
    await sleep(300);
    $('#inspector [data-seg="look"] [data-v="handDrawn"]').click();
    await sleep(300);
    $('#inspector [data-seg="curve"] [data-v="step"]').click();
    await sleep(500);
    canvas.fit();
    await sleep(2200);`,
});

await shoot('code-preview.png', {
  url: APP('architecture.md', 2),
  dark: true,
  setup: `${prelude}
    await view('preview');
    await sleep(800);`,
});

await shoot('labs.png', {
  url: APP('it-org/l2-workplace-it.md'),
  dark: true,
  setup: `${prelude}
    await view('canvas');
    canvas.fit();
    flags.setFlag('themes', true);
    $('#labs').click();
    await sleep(500);`,
});

process.exit(0);
