/**
 * Entry point.
 *
 * Boot order matters: capabilities are probed *before* the editor is constructed,
 * because the editor's budgets, panel content and default settings all derive from
 * the adapter report. If no context can be created we show a diagnostic instead of
 * a blank canvas — the article's "problèmes de jeunesse" section is a real
 * failure mode, not a hypothetical.
 */

import { App } from './editor/editor.js';
import { log } from './core/logger.js';
import { featureMap } from './gl/capabilities.js';

const boot = document.getElementById('boot');
const bootBar = document.getElementById('bootBar');
const bootMsg = document.getElementById('bootMsg');
const params = new URLSearchParams(location.search);

function progress(pct, message) {
  if (bootBar) bootBar.style.transform = `scaleX(${pct})`;
  if (bootMsg && message) bootMsg.textContent = message;
}

function fatal(message, detail, title = 'Lumen Studio could not start') {
  boot.hidden = true;
  const box = document.getElementById('fatal');
  const msg = document.getElementById('fatalMsg');
  const det = document.getElementById('fatalDetail');
  const h = document.getElementById('fatalTitle');
  if (h) h.textContent = title;
  box.hidden = false;
  msg.textContent = message;
  det.textContent = detail || '';
  log.error(message, detail || '');
}

async function main() {
  const canvas = document.getElementById('glcanvas');
  progress(0.15, 'probing graphics adapter…');

  let app;
  try {
    app = new App({ canvas, log });
  } catch (e) {
    // A throw out of the App constructor is not necessarily a missing context:
    // engine construction (shaders, render targets, asset upload) happens in
    // there too. Only report "no WebGL" when the context really is the cause.
    if (e.attempts) {
      fatal(
        'No WebGL context could be created on this machine.',
        [
          e.message,
          '',
          'Creation attempts:',
          ...e.attempts.map((a) => `  · ${a}`),
          '',
          'This is the failure mode the WebGL article describes as "problèmes de jeunesse":',
          'the browser can run WebGL but refuses to hand over a context (block-listed driver,',
          'GPU process disabled, remote desktop, or a software fallback that failed).'
        ].join('\n'),
        'WebGL unavailable'
      );
    } else {
      fatal(
        'Lumen Studio failed while starting up.',
        `${e.message}\n\n${e.stack || ''}`
      );
    }
    return;
  }

  // Unhide before the first render so the canvas is laid out (a hidden element has
  // a zero-sized client rect, which would make the first frame buffer 1×1).
  document.getElementById('app').hidden = false;

  const caps = app.ctx.caps;
  progress(0.45, `${caps.isWebGL2 ? 'WebGL 2.0' : 'WebGL 1.0'} · ${caps.tier.name} tier`);
  log.info('capability probe complete', {
    version: caps.version,
    glsl: caps.shadingLanguageVersion,
    renderer: caps.renderer,
    tier: caps.tier.name,
    software: caps.software,
    webgpu: caps.webgpu
  });
  const features = featureMap(caps);
  log.info('feature map', features);

  progress(0.6, 'compiling shaders (GLSL ES 1.00 + 3.00)…');
  // Warm the program cache so the first interactive frame is not a 300 ms stall.
  try {
    app.renderer.ibl.build();
    app.renderer.renderMaterialPreview(app.assets.byType('material')[0]?.material, document.createElement('canvas'), { size: 32 });
  } catch (e) {
    log.warn('shader warm-up reported an issue:', e.message);
  }

  progress(0.8, 'building the demo scene…');
  const sceneParam = params.get('scene');
  await app.start({ scene: sceneParam || 'car' });

  if (params.has('capabilities')) app.showCapabilities();
  if (params.has('shortcuts')) app.showShortcuts();

  progress(1, 'ready');
  document.getElementById('app').hidden = false;
  boot.hidden = true;
  app.requestRender();

  // Test hooks: the headless smoke test drives the editor through these.
  window.LUMEN = {
    app,
    ready: true,
    stats: () => app.renderer.stats,
    capabilities: () => caps,
    features: () => features,
    commands: () => app.commands.list().map((c) => c.id),
    run: (id, ...args) => app.commands.run(id, ...args),
    select: (name) => {
      const e = app.scene.findByName(name);
      if (e) app.scene.select(e);
      return !!e;
    },
    screenshotDataURL: () => {
      app.renderNow();
      return canvas.toDataURL('image/png');
    },
    glErrors: () => app.ctx.debug.errors.slice(-10),
    programs: () => app.renderer.programs.map.size,
    sceneSummary: () => app.scene.summary(),
    // Reads the composited frame through a 2D canvas: valid without
    // `preserveDrawingBuffer` as long as it happens in the same task as the draw.
    pixelProbe: () => {
      app.renderNow();
      const c = document.createElement('canvas');
      c.width = 64;
      c.height = 64;
      const g = c.getContext('2d');
      g.drawImage(canvas, 0, 0, 64, 64);
      const d = g.getImageData(32, 32, 1, 1).data;
      return [d[0], d[1], d[2], d[3]];
    },
    /** Average luminance of the whole frame — a much better "did we render" test. */
    frameLuma: () => {
      app.renderNow();
      const c = document.createElement('canvas');
      c.width = 96;
      c.height = 96;
      const g = c.getContext('2d');
      g.drawImage(canvas, 0, 0, 96, 96);
      const d = g.getImageData(0, 0, 96, 96).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      return sum / (d.length / 4);
    }
  };
  window.dispatchEvent(new CustomEvent('lumen:ready'));
}

main().catch((e) => {
  console.error(e);
  fatal('Lumen Studio failed to start.', `${e.message}\n${e.stack || ''}`);
});
