/**
 * Headless smoke test.
 *
 * Boots the editor in headless Chrome (SwiftShader for WebGL), waits for the
 * `lumen:ready` event, then verifies the parts that only a real GPU pipeline can
 * prove: shader compilation in *both* GLSL dialects, the absence of GL errors,
 * a non-black frame, picking, undo/redo, import, command dispatch and a
 * context-loss/restore cycle. Finally it writes a screenshot for the record.
 *
 *   node test/smoke.mjs [--url http://127.0.0.1:8080] [--keep] [--headed]
 */

import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const PORT = Number(arg('--port', 8177));
const URL_BASE = arg('--url', `http://127.0.0.1:${PORT}`);
const HEADED = args.includes('--headed');

const results = [];
let failures = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  const mark = ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`  ${mark} ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
}

async function main() {
  console.log('\n\x1b[1mLumen Studio — headless smoke test\x1b[0m\n');

  // 1. start the server
  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js'), '--port', String(PORT)], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverOut = '';
  server.stdout.on('data', (d) => { serverOut += d; });
  server.stderr.on('data', (d) => { serverOut += d; });
  await waitForServer();

  // 2. launch the browser
  const browser = await puppeteer.launch({
    executablePath: resolveChrome(),
    headless: !HEADED,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--enable-unsafe-swiftshader',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--window-size=1600,1000',
      '--disable-dev-shm-usage'
    ],
    defaultViewport: { width: 1600, height: 1000, deviceScaleFactor: 1 }
  });

  const page = await browser.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (e) => pageErrors.push(e.message));

  console.log(`  loading ${URL_BASE}`);
  await page.goto(`${URL_BASE}/?verbose`, { waitUntil: 'domcontentloaded', timeout: 60000 });

  let ready = true;
  try {
    await page.waitForFunction('window.LUMEN && window.LUMEN.ready === true', { timeout: 90000 });
  } catch {
    ready = false;
  }

  if (!ready) {
    const fatal = await page.$eval('#fatal', (el) => (el.hidden ? '(fatal panel hidden)' : el.innerText)).catch(() => 'n/a');
    const boot = await page.$eval('#bootMsg', (el) => el.textContent).catch(() => 'n/a');
    check('editor boots', false, `${boot} | ${fatal.split('\n')[0]}`);
    await finish(browser, server);
    return;
  }
  check('editor boots', true);

  // 3. capability report
  const caps = await page.evaluate(() => {
    const c = window.LUMEN.capabilities();
    return {
      isWebGL2: c.isWebGL2, version: c.version, glsl: c.shadingLanguageVersion,
      renderer: c.renderer, tier: c.tier.name, software: c.software,
      maxTextureSize: c.limits.maxTextureSize, instancing: c.limits.instancing,
      depthTexture: c.limits.depthTexture, extensions: c.extensionNames.length
    };
  });
  console.log(`  \x1b[2madapter: ${caps.version} · ${caps.renderer} · tier ${caps.tier}${caps.software ? ' (software)' : ''}\x1b[0m`);
  check('WebGL context created', !!caps.version, caps.version);
  check('capability probe complete', caps.extensions > 0, `${caps.extensions} extensions queried`);

  // 4. the frame graph actually drew something
  await sleep(1200);
  const stats = await page.evaluate(() => window.LUMEN.stats());
  check('draw calls issued', stats.drawCalls > 5, `${stats.drawCalls} draws / ${stats.triangles} tris`);
  check('shaders compiled', stats.programs > 3, `${stats.programs} program variants`);
  check('lights collected', stats.lights >= 3, `${stats.lights} lights`);
  check('shadow cascades', stats.shadows.cascades === 2, `${stats.shadows.cascades}×${stats.shadows.resolution}`);

  const pixel = await page.evaluate(() => window.LUMEN.pixelProbe());
  const luma = await page.evaluate(() => window.LUMEN.frameLuma());
  check('frame is not black', pixel[0] + pixel[1] + pixel[2] > 6 && luma > 4,
    `centre rgba(${pixel.join(',')}), mean luma ${luma.toFixed(1)}`);

  // 4b. material options survive asset creation, and instancing really rasterises
  const mats = await page.evaluate(() => {
    const app = window.LUMEN.app;
    const asset = (name) => app.assets.byType('material').find((m) => m.name === name);
    const floor = app.assets.get(app.scene.findByName('Floor').components.render.material);
    const paint = app.assets.get(app.scene.findByName('Concept Car').components.render.material);
    return {
      floorName: floor?.name, floorAlbedo: floor?.material.diffuse?.[0],
      paintName: paint?.name, paintMetal: paint?.material.metalness,
      distinct: new Set(app.assets.byType('material').map((m) => m.name)).size,
      total: app.assets.byType('material').length
    };
  });
  check('material options applied on create',
    mats.floorName === 'Showroom Floor' && mats.floorAlbedo < 0.2 && mats.paintMetal > 0.5 && mats.distinct > 5,
    `${mats.distinct}/${mats.total} distinct · floor ${mats.floorName} a=${mats.floorAlbedo?.toFixed(3)} · paint metal=${mats.paintMetal}`);

  // 5. no GL errors
  const glErrors = await page.evaluate(() => window.LUMEN.glErrors());
  check('no GL errors', glErrors.length === 0, glErrors.map((e) => e.error).join(', '));

  // 6. picking through the id buffer
  const picked = await page.evaluate(async () => {
    const app = window.LUMEN.app;
    const V = app.viewport, cam = V.camera;
    // The demo surrounds the car with a colonnade, and the turntable covers the
    // middle of the body, so hide the occluders for the duration of the check:
    // the id buffer is a *depth* buffer, it returns whatever is genuinely nearest.
    const hidden = app.scene.entities.filter((e) => /^Colonnade|Turntable$/.test(e.name));
    const wasEnabled = hidden.map((e) => e.enabled);
    hidden.forEach((e) => { e.enabled = false; });
    app.scene.touch('test');
    app.requestRender();

    const target = app.scene.findByName('Concept Car');
    const m = cam.viewProj, w = target.worldPosition;
    const clip = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) clip[i] = m[i] * w[0] + m[4 + i] * w[1] + m[8 + i] * w[2] + m[12 + i];
    const cx = (clip[0] / clip[3] * 0.5 + 0.5) * V.width;
    const cy = (1 - (clip[1] / clip[3] * 0.5 + 0.5)) * V.height;
    const opts = { width: V.width, height: V.height };
    // One id render, then many single-pixel reads off the same buffer.
    const centre = app.renderer.pick(app.scene, cam, cx, cy, { ...opts, force: true });
    // Empty background must stay empty: an id buffer that is never cleared would
    // make every pick succeed and hide the difference between a hit and a miss.
    const corner = app.renderer.pick(app.scene, cam, 2, 2, opts);

    hidden.forEach((e, i) => { e.enabled = wasEnabled[i]; });
    app.scene.touch('test');
    app.requestRender();
    return {
      hit: centre?.name || null, ids: app.renderer._pickingIds.size,
      corner: corner?.name || null, w: app.renderer.pickingTarget.width, dpr: app.ctx.dpr
    };
  });
  // The ray through the body centre meets the glass cabin first, so the id buffer
  // is expected to return a *car* part, not necessarily the body itself.
  check('id-buffer picking works',
    /^Concept Car|Cabin|Nose|Splitter|Wheel/.test(picked.hit || '') && !picked.corner && picked.ids > 10 && picked.w > 1,
    `${picked.hit || 'no hit'} (${picked.ids} ids, id buffer ${picked.w}px, corner: ${picked.corner || 'empty'})`);

  // 6b. instancing: every instance must be drawn *and* picked. A draw that issues
  // an instanced call without binding the instance stream rasterises nothing, and
  // an id pass that draws a single copy picks a phantom at the entity origin.
  const inst = await page.evaluate(() => {
    const app = window.LUMEN.app, V = app.viewport, cam = V.camera, r = app.renderer;
    const e = app.scene.findByName('Colonnade (instanced)');
    if (!e) return { total: 0, hits: 0, n: 0 };
    e.enabled = true;
    const n = e.components.render.instanceCount, spread = e.components.render.instanceSpread;
    const m = cam.viewProj, opts = { width: V.width, height: V.height, force: true };
    r.pick(app.scene, cam, V.width * 0.5, V.height * 0.5, opts);   // one id render
    let total = 0, hits = 0;
    for (let k = 0; k < n; k++) {
      // Reproduce the 'ring' layout the renderer generates for this entity.
      const a = (k / n) * Math.PI * 2;
      const w = [Math.cos(a) * spread, 1.35, Math.sin(a) * spread];
      const c = [0, 0, 0, 0];
      for (let i = 0; i < 4; i++) c[i] = m[i] * w[0] + m[4 + i] * w[1] + m[8 + i] * w[2] + m[12 + i];
      if (c[3] <= 0) continue;
      const x = (c[0] / c[3] * 0.5 + 0.5) * V.width;
      const y = (1 - (c[1] / c[3] * 0.5 + 0.5)) * V.height;
      if (x < 3 || y < 3 || x > V.width - 3 || y > V.height - 3) continue;
      total++;
      if (r.pick(app.scene, cam, x, y, opts) === e) hits++;
    }
    return { total, hits, n };
  });
  check('instanced ring draws and picks', inst.total >= 3 && inst.hits >= Math.ceil(inst.total * 0.5),
    `${inst.hits}/${inst.total} on-screen pillars of ${inst.n} picked as the instanced entity`);

  // 6c. the inspector must survive a refresh: a field whose refresh() wiped its
  // value made every entity look like it had no mesh or material assigned.
  const insp = await page.evaluate(() => {
    const app = window.LUMEN.app;
    app.selectAt(app.scene.findByName('Concept Car'));
    app.inspector.update();                     // the cheap refresh path
    app.inspector.update();
    const refs = app.inspector.fields.filter((f) => f?.constructor?.name === 'AssetRefField');
    return refs.map((f) => f.opts.store.get(f.value)?.name || null);
  });
  check('inspector fields survive refresh',
    insp.length === 2 && insp.every(Boolean) && insp.includes('Car Paint'),
    `mesh/material resolved as ${JSON.stringify(insp)}`);

  // 7. commands: add, move, undo, redo
  const edit = await page.evaluate(async () => {
    const app = window.LUMEN.app;
    const before = app.scene.entities.length;
    app.commands.run('hierarchy.add');
    app.addPrimitive('torus');
    const after = app.scene.entities.length;
    const e = app.scene.selection[0];
    const name = e ? e.name : null;
    if (e) e.position = [3, 2, 1];
    app.markDirty('test move');
    const p1 = e ? [...e.position] : null;
    // Undo/redo rebuilds the document, so the entity must be re-queried by name.
    app.commands.run('edit.undo');
    const p2 = app.scene.findByName(name)?.position || null;
    app.commands.run('edit.redo');
    const p3 = app.scene.findByName(name)?.position || null;
    app.commands.run('edit.undo');
    return { before, after, name, p1, p2: p2 && Array.from(p2), p3: p3 && Array.from(p3) };
  });
  check('entity creation', edit.after === edit.before + 1, `${edit.before} → ${edit.after} entities`);
  check('property edit', edit.p1 && edit.p1[0] === 3, JSON.stringify(edit.p1));
  check('undo restores state', edit.p2 && edit.p2[0] === 0, JSON.stringify(edit.p2));
  check('redo reapplies state', edit.p3 && edit.p3[0] === 3, JSON.stringify(edit.p3));

  // 8. gizmo draw + hit test
  const gizmoTest = await page.evaluate(() => {
    const app = window.LUMEN.app;
    app.setTool('move');
    const e = app.scene.findByName('Concept Car');
    if (e) app.scene.select(e);
    app.viewport.updateCamera(0.016);
    const p = app.gizmo.screenSize(app.viewport.camera, app.viewport.height);
    const f = app.gizmo.frame();
    const cam = app.viewport.camera;
    const tip = [
      f.origin[0] + f.axes[0][0] * p, f.origin[1] + f.axes[0][1] * p, f.origin[2] + f.axes[0][2] * p
    ];
    const s = cam.worldToScreen(tip, app.viewport.width, app.viewport.height, {});
    const handle = app.gizmo.hitTest(cam, s.x, s.y, app.viewport.width, app.viewport.height);
    return { size: p, visible: app.gizmo.visible, handle };
  });
  check('gizmo visible with selection', gizmoTest.visible, `screen size ${gizmoTest.size.toFixed(1)} world units`);
  check('gizmo hit test', !!gizmoTest.handle, `handle "${gizmoTest.handle}"`);

  // 9. importer: OBJ in → model asset out
  const imported = await page.evaluate(async () => {
    const { parseOBJ } = await import('/src/loaders/obj.js');
    const obj = `# test quad
v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
vt 0 0
vt 1 0
vt 1 1
vt 0 1
vn 0 0 1
f 1/1/1 2/2/1 3/3/1
f 1/1/1 3/3/1 4/4/1`;
    const geo = parseOBJ(obj);
    const asset = window.LUMEN.app.assets.createModel('SmokeQuad', geo);
    return { verts: geo.positions.length / 3, tris: geo.indices.length / 3, id: asset.id, triangles: asset.triangles };
  });
  // 4 positions, but the two faces reference different uv sets → 8 unique corners.
  check('OBJ parser', imported.verts >= 4 && imported.tris === 2, `${imported.verts} verts / ${imported.tris} tris`);

  // 9b. id generation. Asset ids are truncated (`uid().slice(0, 10)`), so the
  // leading characters have to be unique on their own — a timestamp-only prefix
  // repeats every millisecond and colliding ids overwrite each other silently in
  // the asset map. Hammer it in one tick, which is the worst case.
  const uidCheck = await page.evaluate(async () => {
    const { uid } = await import('/src/core/utils.js');
    const N = 20000;
    for (const width of [8, 10, 12]) {
      const seen = new Set();
      let dupes = 0;
      for (let i = 0; i < N; i++) {
        const id = uid().slice(0, width);
        if (seen.has(id)) dupes++;
        seen.add(id);
      }
      if (dupes) return { width, dupes, unique: seen.size, N };
    }
    return { width: 0, dupes: 0, unique: N, N };
  });
  check('ids are unique after truncation', uidCheck.dupes === 0,
    uidCheck.dupes ? `${uidCheck.dupes} duplicate ids at slice(0, ${uidCheck.width})` : `${uidCheck.N} ids unique at 8/10/12 chars`);

  // 10. GLSL transpiler: the same source must yield both dialects
  const transpile = await page.evaluate(async () => {
    const { transpile } = await import('/src/gl/program.js');
    const src = `
      attribute vec3 aPosition;
      varying vec2 vUv;
      void main() {
        vUv = aPosition.xy;
        gl_Position = vec4(aPosition, 1.0);
      }`;
    const es3 = transpile(src, { stage: 'vertex', es3: true });
    const es1 = transpile(src, { stage: 'vertex', es3: false });
    return {
      es3Header: es3.split('\n')[0],
      es3In: es3.includes('in vec3 aPosition'),
      es3Out: es3.includes('out vec2 vUv'),
      es1Attr: es1.includes('attribute vec3 aPosition'),
      es1Var: es1.includes('varying vec2 vUv'),
      es1NoIn: !/\bin vec3/.test(es1)
    };
  });
  check('GLSL ES 3.00 transpile', transpile.es3Header === '#version 300 es' && transpile.es3In && transpile.es3Out, transpile.es3Header);
  check('GLSL ES 1.00 transpile', transpile.es1Attr && transpile.es1Var && transpile.es1NoIn, '#version 100 passthrough');

  // 11. debug views
  const views = await page.evaluate(async () => {
    const app = window.LUMEN.app;
    const seen = [];
    for (const v of [1, 2, 5, 7]) {
      app.commands.run('render.debug');
      app.setDebugView(v);
      app.renderNow();
      seen.push(app.renderer.debugView);
    }
    app.setDebugView(0);
    app.renderNow();
    return seen;
  });
  check('debug views render', views.every((v) => v > 0), views.join(','));

  // 12. command palette + command registry
  const cmds = await page.evaluate(() => {
    const ids = window.LUMEN.commands();
    return { count: ids.length, hasUndo: ids.includes('edit.undo'), hasExport: ids.includes('file.export') };
  });
  check('command registry populated', cmds.count > 30 && cmds.hasUndo, `${cmds.count} commands`);

  // 13. context loss / restore
  const ctxCycle = await page.evaluate(async () => {
    const app = window.LUMEN.app;
    const ok = app.ctx.simulateContextLoss();
    await new Promise((r) => setTimeout(r, 2500));
    return { ok, lost: app.ctx.lost, restores: app.ctx.restoreCount, resources: app.ctx.stats().total };
  });
  check('context loss / restore', ctxCycle.ok && !ctxCycle.lost && ctxCycle.restores > 0,
    `${ctxCycle.restores} restore cycle(s), ${ctxCycle.resources} resources live`);

  await sleep(800);
  const afterRestore = await page.evaluate(() => {
    window.LUMEN.app.renderNow();
    return { errors: window.LUMEN.glErrors(), pixel: window.LUMEN.pixelProbe(), luma: window.LUMEN.frameLuma(), programs: window.LUMEN.programs() };
  });
  check('frame after restore', afterRestore.pixel[0] + afterRestore.pixel[1] + afterRestore.pixel[2] > 6 && afterRestore.luma > 4,
    `centre rgba(${afterRestore.pixel.join(',')}), luma ${afterRestore.luma.toFixed(1)}, ${afterRestore.programs} programs`);

  // 14. screenshot for the record
  const shotDir = path.join(ROOT, 'test', 'output');
  fs.mkdirSync(shotDir, { recursive: true });
  // Full-page capture: the editor chrome matters as much as the viewport.
  const shot = path.join(shotDir, 'editor.png');
  await page.screenshot({ path: shot });
  check('screenshot written', fs.existsSync(shot) && fs.statSync(shot).size > 10000,
    `${path.relative(ROOT, shot)} (${Math.round(fs.statSync(shot).size / 1024)} KB)`);
  const viewportShot = path.join(shotDir, 'viewport.png');
  const dataUrl = await page.evaluate(() => window.LUMEN.screenshotDataURL());
  fs.writeFileSync(viewportShot, Buffer.from(dataUrl.split(',')[1], 'base64'));
  check('viewport capture written', fs.existsSync(viewportShot), path.relative(ROOT, viewportShot));

  // 15. page-level errors
  const realErrors = pageErrors.filter((m) => !/ResizeObserver/.test(m));
  check('no uncaught page errors', realErrors.length === 0, realErrors.slice(0, 2).join(' | '));
  // The context-loss test deliberately logs an error; that is the expected noise.
  const realConsole = consoleErrors.filter((m) => !/favicon|Autofill|context lost|context restored/.test(m));
  check('no console errors', realConsole.length === 0, realConsole.slice(0, 2).join(' | '));

  await finish(browser, server, shotDir);
}

async function finish(browser, server, shotDir) {
  if (!args.includes('--keep')) await browser.close();
  server.kill();
  console.log('');
  const total = results.length;
  const pass = total - failures;
  console.log(`  \x1b[1m${pass}/${total} checks passed\x1b[0m${shotDir ? `  ·  screenshot: ${shotDir}` : ''}\n`);
  if (failures) {
    console.log('\x1b[31mfailures:\x1b[0m');
    for (const r of results.filter((x) => !x.ok)) console.log(`  · ${r.name} — ${r.detail}`);
    console.log('');
  }
  process.exit(failures ? 1 : 0);
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${URL_BASE}/api/health`);
      if (res.ok) return;
    } catch { /* retry */ }
    await sleep(150);
  }
  throw new Error('server did not start');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Locate a Chrome build: env override, the local @puppeteer/browsers cache, then PATH. */
function resolveChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cacheRoot = path.join(ROOT, 'chrome');
  if (fs.existsSync(cacheRoot)) {
    for (const dir of fs.readdirSync(cacheRoot)) {
      const bin = path.join(cacheRoot, dir, 'chrome-linux64', 'chrome');
      if (fs.existsSync(bin)) return bin;
    }
  }
  for (const p of ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('no Chrome binary found — run: npx @puppeteer/browsers install chrome@stable');
}

main().catch((e) => {
  console.error('\n\x1b[31mtest harness error:\x1b[0m', e);
  process.exit(2);
});
