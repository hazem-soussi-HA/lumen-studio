/**
 * Screenshot helper: boot the editor in headless Chrome, wait until the first
 * real frame is on screen, and write a PNG of the 3D viewport.
 *
 *   node tools/shot.mjs [port] [out.png]
 *
 * The same launch flags the smoke test uses, including --enable-unsafe-swiftshader,
 * which is what lets a machine with no GPU fall back to a software rasteriser
 * instead of failing to create a WebGL context at all.
 */

import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || 8241);
const OUT = process.argv[3] || 'test/output/viewport.png';

/** Reuse whatever Chrome the smoke test downloaded into ./chrome. */
function findChrome() {
  const base = join(ROOT, 'chrome');
  if (existsSync(base)) {
    for (const dir of readdirSync(base)) {
      for (const candidate of [
        join(base, dir, 'chrome-linux64', 'chrome'),
        join(base, dir, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
        join(base, dir, 'chrome-win64', 'chrome.exe')
      ]) if (existsSync(candidate)) return candidate;
    }
  }
  console.error('No Chrome in ./chrome — run:  npx @puppeteer/browsers install chrome@stable');
  process.exit(1);
}

const server = spawn(process.execPath, [join(ROOT, 'server/server.js'), '--port', String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  defaultViewport: { width: 1400, height: 900 }
});

try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('PAGEERROR', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.error('CONSOLE', m.text()); });
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.LUMEN && window.LUMEN.ready', { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 1600));
  await (await page.$('#viewport')).screenshot({ path: OUT });
  const info = await page.evaluate(() => {
    const s = window.LUMEN.stats();
    return `${s.drawCalls} draws / ${s.triangles} tris, mean luma ${window.LUMEN.frameLuma().toFixed(1)}`;
  });
  console.log(`wrote ${OUT} — ${info}`);
} finally {
  await browser.close();
  server.kill();
}
