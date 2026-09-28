/**
 * Console panel + statistics overlay.
 *
 * The console accepts JavaScript with `app`, `scene`, `assets`, `renderer`, `ctx`
 * and `entity` in scope, so the editor is scriptable — a console that only prints
 * is a log viewer, not a console.
 */

import { h } from './widgets.js';
import { formatBytes, formatCount, formatTime, throttle } from '../core/utils.js';

const LEVEL_CLASS = { log: '', info: 'is-info', warn: 'is-warn', error: 'is-error', debug: 'is-debug' };

export class ConsolePanel {
  constructor(app, { bodyEl, formEl, inputEl, filterEl }) {
    this.app = app;
    this.body = bodyEl;
    this.form = formEl;
    this.input = inputEl;
    this.filter = 'all';
    this.history = [];
    this.historyIndex = -1;
    this.max = 400;

    filterEl?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-level]');
      if (!btn) return;
      this.filter = btn.dataset.level;
      [...filterEl.querySelectorAll('.seg-btn')].forEach((b) => b.classList.toggle('is-active', b === btn));
      this.render();
    });

    this.form?.addEventListener('submit', (e) => {
      e.preventDefault();
      this.submit();
    });
    this.input?.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (this.historyIndex < this.history.length - 1) {
          this.historyIndex++;
          this.input.value = this.history[this.historyIndex];
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (this.historyIndex > 0) {
          this.historyIndex--;
          this.input.value = this.history[this.historyIndex];
        } else {
          this.historyIndex = -1;
          this.input.value = '';
        }
      }
    });

    app.log.on('record', () => this.scheduleRender());
    app.log.on('clear', () => this.render());
  }

  scheduleRender() {
    if (this._pending) return;
    this._pending = true;
    requestAnimationFrame(() => {
      this._pending = false;
      this.render();
    });
  }

  submit() {
    const code = this.input.value.trim();
    if (!code) return;
    this.history.unshift(code);
    this.history = this.history.slice(0, 60);
    this.historyIndex = -1;
    this.input.value = '';
    const user = { level: 'log', channel: 'console', text: `› ${code}`, t: performance.now() };
    this.app.log.records.push(user);
    this.render();
    try {
      // The console runs in the page realm: full access to the engine internals.
      // eslint-disable-next-line no-new-func
      const fn = new Function('app', 'scene', 'assets', 'renderer', 'ctx', 'entity', 'util', `"use strict";return (async () => { ${code} })();`);
      const result = fn(this.app, this.app.scene, this.app.assets, this.app.renderer, this.app.ctx, this.app.scene.selection[0] || null, this.app.util);
      if (result && typeof result.then === 'function') {
        result.then((v) => this._report(v)).catch((e) => this.app.log.error(e));
      } else {
        this._report(result);
      }
    } catch (e) {
      this.app.log.error(e);
    }
  }

  _report(value) {
    if (value === undefined) return;
    this.app.log.info(typeof value === 'string' ? value : safeStringify(value));
  }

  render() {
    const records = this.app.log.tail(this.max, this.filter === 'all' ? null : this.filter);
    const atBottom = this.body.scrollHeight - this.body.scrollTop - this.body.clientHeight < 40;
    this.body.textContent = '';
    if (!records.length) {
      this.body.appendChild(h('div', { class: 'console-empty', text: 'No messages. Errors from the GL layer, the loaders and the console itself appear here.' }));
      return;
    }
    for (const r of records) {
      const row = h('div', { class: `console-row ${LEVEL_CLASS[r.level] || ''}` }, [
        h('span', { class: 'console-chan', text: r.channel }),
        h('span', { class: 'console-text', text: r.text })
      ]);
      if (r.level === 'error' || r.level === 'warn') row.addEventListener('click', () => this.app.showModal({ title: `${r.channel} · ${r.level}`, body: r.text }));
      this.body.appendChild(row);
    }
    if (atBottom) this.body.scrollTop = this.body.scrollHeight;
  }

  clear() { this.app.log.clear(); }
}

/* ---------------------------------------------------------------- stats */

export class StatsPanel {
  constructor(app, el) {
    this.app = app;
    this.el = el;
    this.visible = false;
    this.graph = h('canvas', { class: 'stats-graph', width: 168, height: 34 });
    this.rows = h('div', { class: 'stats-rows' });
    this.frameTimes = new Float32Array(84);
    this.idx = 0;
    this.update = throttle(() => this.render(), 6);
  }

  toggle(force) {
    this.visible = force === undefined ? !this.visible : !!force;
    this.el.hidden = !this.visible;
    if (this.visible) this.render();
    return this.visible;
  }

  sample(dt) {
    this.frameTimes[this.idx % this.frameTimes.length] = dt;
    this.idx++;
  }

  render() {
    if (!this.visible) return;
    const s = this.app.renderer.stats;
    const v = this.app.viewport;
    const caps = this.app.ctx.caps;
    this.el.textContent = '';
    this.el.appendChild(h('div', { class: 'stats-head' }, [
      h('span', { text: 'PERFORMANCE' }),
      h('span', { class: 'stats-backend', text: caps.isWebGL2 ? 'WebGL 2 · ES 3.00' : 'WebGL 1 · ES 1.00' })
    ]));
    this.el.appendChild(this.graph);
    this.el.appendChild(this.rows);

    const n = Math.min(this.idx, this.frameTimes.length);
    let sum = 0, max = 0;
    const start = this.idx > this.frameTimes.length ? this.idx % this.frameTimes.length : 0;
    for (let i = 0; i < n; i++) {
      const t = this.frameTimes[(start + i) % this.frameTimes.length];
      sum += t;
      max = Math.max(max, t);
    }
    const avg = n ? sum / n : 0;

    const fps = avg > 0 ? 1000 / avg : 0;
    const rows = [
      ['FPS', fps.toFixed(1), fps > 55 ? 'good' : fps > 28 ? 'warn' : 'bad'],
      ['Frame', formatTime(avg), ''],
      ['Worst', formatTime(max), max > 33 ? 'bad' : ''],
      ['CPU draw calls', String(s.drawCalls), ''],
      ['Triangles', formatCount(s.triangles), ''],
      ['Visible / culled', `${s.visible} / ${s.culled}`, ''],
      ['GPU frame', s.gpuTime ? formatTime(s.gpuTime) : 'n/a', ''],
      ['Programs', String(s.programs), ''],
      ['Lights', String(s.lights), ''],
      ['GPU objects', String(s.resources.total), ''],
      ['— textures', String(s.resources.textures), ''],
      ['— buffers', String(s.resources.buffers), ''],
      ['— meshes', String(s.resources.meshes), ''],
      ['— fbos', String(s.resources.framebuffers), ''],
      ['IBL build', formatTime(s.ibl.lastBuildMs || 0), ''],
      ['Shadows', `${s.shadows.cascades}×${s.shadows.resolution}`, s.shadows.enabled ? 'good' : 'warn'],
      ['DPR', v.camera.aspect.toFixed(3), '']
    ];
    this.rows.textContent = '';
    for (const [k, val, cls] of rows) {
      this.rows.appendChild(h('div', { class: `stat-row ${cls}` }, [
        h('span', { class: 'stat-k', text: k }),
        h('span', { class: 'stat-v', text: val })
      ]));
    }

    // Frame-time graph: 16.7 ms line, filled bars for the rest.
    const g = this.graph.getContext('2d');
    const w = this.graph.width, hgt = this.graph.height;
    g.clearRect(0, 0, w, hgt);
    g.fillStyle = 'rgba(255,255,255,0.05)';
    g.fillRect(0, 0, w, hgt);
    const scale = hgt / 40;
    g.fillStyle = 'rgba(94,234,212,0.75)';
    for (let i = 0; i < this.frameTimes.length; i++) {
      const t = this.frameTimes[(start + i) % this.frameTimes.length];
      const bh = Math.min(hgt, t * scale);
      g.fillRect(i * (w / this.frameTimes.length), hgt - bh, Math.max(1, w / this.frameTimes.length - 1), bh);
    }
    g.fillStyle = 'rgba(255,120,120,0.8)';
    g.fillRect(0, hgt - 16.7 * scale, w, 1);
  }
}

/* -------------------------------------------------------------- helpers */

function safeStringify(v) {
  if (typeof v === 'object' && v !== null) {
    try { return JSON.stringify(v, replacer, 1); } catch { return String(v); }
  }
  return String(v);
}

function replacer(_k, v) {
  if (v instanceof Float32Array || v instanceof Uint32Array || v instanceof Uint16Array) return `[${Array.from(v.slice(0, 12))}${v.length > 12 ? '…' : ''}]`;
  if (v && typeof v === 'object' && v.handle) return `[GL ${v.kind || 'object'}]`;
  return v;
}

export { formatBytes };
