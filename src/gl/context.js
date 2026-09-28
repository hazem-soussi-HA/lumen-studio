/**
 * GLContext — owner of the WebGLRenderingContext, the capability report, the
 * GPU resource registry and a redundant-state-elimination cache.
 *
 * Context loss is treated as a first-class event (it is the single most common
 * real-world WebGL failure: driver resets, GPU process crashes, tab backgrounding
 * on mobile, and hardware block-lists). Every GPU object registers a `_createGL`
 * closure; on `webglcontextlost` we drop all GL names, on `webglcontextrestored`
 * we re-probe capabilities and replay every closure. CPU-side data is never lost.
 */

import { createContext, probeCapabilities } from './capabilities.js';
import { Emitter } from '../core/utils.js';

let RES_ID = 0;

export class GLContext extends Emitter {
  constructor(canvas, opts = {}) {
    super();
    this.canvas = canvas;
    this.opts = opts;
    this.lost = false;
    this.restoreCount = 0;
    this.resources = new Set();
    this.width = 1;
    this.height = 1;
    this.cssWidth = 0;
    this.cssHeight = 0;
    this.dpr = 1;
    this._pendingResize = true;
    this._state = defaultState();
    this._timerPool = [];
    this._activeTimers = 0;

    const { gl, label, errors } = createContext(canvas, opts);
    if (!gl) {
      const err = new Error('WebGL context could not be created');
      err.attempts = errors;
      throw err;
    }
    this.gl = gl;
    this.createLabel = label;
    this.contextErrors = errors;
    this.caps = probeCapabilities(gl);
    this.log = opts.log || console;

    this._installLossHandlers();
    this._installProbes();
  }

  get isGL2() { return this.caps?.isWebGL2; }
  get ext() { return this.caps?.extensions || {}; }

  _installLossHandlers() {
    const onLost = (e) => {
      // Preventing the default is what makes a restore event possible at all.
      e.preventDefault();
      this.lost = true;
      this._state = defaultState();
      for (const r of this.resources) {
        try { r._onContextLost?.(); } catch (err) { this.log.warn?.('[gl] lost hook failed', err); }
      }
      this.emit('contextlost', { resources: this.resources.size });
    };
    const onRestored = () => {
      this.restoreCount++;
      this.caps = probeCapabilities(this.gl);
      this._state = defaultState();
      let ok = 0, fail = 0;
      for (const r of this.resources) {
        try { r._onContextRestored?.(); ok++; } catch (err) { fail++; this.log.warn?.('[gl] restore failed', r.constructor.name, err); }
      }
      this.lost = false;
      this._pendingResize = true;
      this.emit('contextrestored', { restored: ok, failed: fail, attempt: this.restoreCount });
    };
    this.canvas.addEventListener('webglcontextlost', onLost, false);
    this.canvas.addEventListener('webglcontextrestored', onRestored, false);
  }

  /**
   * Out-of-band error checking. WebGL reports errors through flags rather than
   * exceptions; sampling them per frame turns silent failures into log lines.
   */
  _installProbes() {
    this._probesEnabled = true;
    this.debug = { errors: [], checks: 0, draws: 0, calls: 0 };
    this._origDrawElements = this.gl.drawElements.bind(this.gl);
    this._origDrawArrays = this.gl.drawArrays.bind(this.gl);
    this._origDrawElementsInstanced = this.gl.drawElementsInstanced?.bind(this.gl);
  }

  checkErrors(where = '') {
    if (!this._probesEnabled || this.lost) return null;
    const gl = this.gl;
    let err;
    let first = null;
    while ((err = gl.getError()) !== gl.NO_ERROR) {
      const name = Object.keys(gl).find((k) => typeof gl[k] === 'number' && gl[k] === err) || String(err);
      const rec = { error: name, where, t: performance.now() };
      this.debug.errors.push(rec);
      if (this.debug.errors.length > 64) this.debug.errors.shift();
      if (!first) first = rec;
      if (this.debug.errors.length > 8) break; // the context is likely wedged
    }
    this.debug.checks++;
    return first;
  }

  /* ------------------------------------------------------- registry ----- */

  register(resource) {
    this.resources.add(resource);
    resource._ctx = this;
    resource._id = ++RES_ID;
    return resource;
  }

  unregister(resource) { this.resources.delete(resource); }

  /* -------------------------------------------------------- sizing ------ */

  /**
   * @param {number} cssW @param {number} cssH
   * @param {object} opts { dpr, maxDpr, allowResize }
   * Backing store is sized in device pixels; CSS size stays in layout units.
   */
  resize(cssW, cssH, { dpr = window.devicePixelRatio || 1, maxDpr = this.caps?.tier?.budget?.maxDPR ?? 2 } = {}) {
    const eff = Math.max(1, Math.min(dpr, maxDpr));
    const w = Math.max(1, Math.round(cssW * eff));
    const h = Math.max(1, Math.round(cssH * eff));
    this.dpr = eff;
    // The CSS size is recorded even when the rounded backing store is unchanged:
    // callers poll `cssWidth` to detect a layout change, and a stale value would
    // make them re-issue the resize forever.
    this.cssWidth = cssW;
    this.cssHeight = cssH;
    if (this.canvas.width === w && this.canvas.height === h && !this._pendingResize) {
      this._pendingResize = false;
      return false;
    }
    this.canvas.width = w;
    this.canvas.height = h;
    this.width = w;
    this.height = h;
    this._pendingResize = false;
    this.emit('resize', { width: w, height: h, cssWidth: cssW, cssHeight: cssH, dpr: eff });
    return true;
  }

  /** Apply the pending framebuffer size (called once per frame, after FBO binds). */
  applyViewport(target = null) {
    const gl = this.gl;
    let w = this.width, h = this.height;
    if (target && target.width !== undefined) { w = target.width; h = target.height; }
    if (this._state.viewportW !== w || this._state.viewportH !== h) {
      gl.viewport(0, 0, w, h);
      this._state.viewportW = w;
      this._state.viewportH = h;
    }
  }

  /* ------------------------------------------- redundant-state cache ---- */

  useProgram(program) {
    if (this._state.program === program) return;
    this.gl.useProgram(program);
    this._state.program = program;
  }

  bindVAO(vao) {
    if (this._state.vao === vao) return;
    this.gl.bindVertexArray(vao);
    this._state.vao = vao;
  }

  /**
   * Lazily (re)create a VAO cached on `owner[prop]`, keyed to the current context
   * epoch. A VAO holds no CPU-side state, so a fresh empty one is enough as long
   * as the caller re-applies its attribute pointers — which every VAO user in this
   * engine does on each draw. Without the epoch check, a context loss leaves a dead
   * handle behind and every later bindVertexArray is an INVALID_OPERATION.
   */
  cachedVAO(owner, prop) {
    if (!owner[prop] || owner[`${prop}Epoch`] !== this.restoreCount) {
      owner[prop] = this.gl.createVertexArray();
      owner[`${prop}Epoch`] = this.restoreCount;
    }
    return owner[prop];
  }

  setBlend(mode) {
    if (this._state.blend === mode) return;
    const gl = this.gl;
    this._state.blend = mode;
    if (mode === 'none') { gl.disable(gl.BLEND); return; }
    gl.enable(gl.BLEND);
    if (mode === 'alpha') { gl.blendEquation(gl.FUNC_ADD); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA); }
    else if (mode === 'premultiplied') { gl.blendEquation(gl.FUNC_ADD); gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA); }
    else if (mode === 'additive') { gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.SRC_ALPHA, gl.ONE); }
    else if (mode === 'multiply') { gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA); }
  }

  setDepth(test, write = true, func = 'less') {
    const gl = this.gl;
    const s = this._state;
    if (s.depthTest !== test) { test ? gl.enable(gl.DEPTH_TEST) : gl.disable(gl.DEPTH_TEST); s.depthTest = test; }
    if (test && s.depthWrite !== write) { gl.depthMask(write); s.depthWrite = write; }
    if (test && s.depthFunc !== func) {
      gl.depthFunc(func === 'lequal' ? gl.LEQUAL : func === 'always' ? gl.ALWAYS
        : func === 'equal' ? gl.EQUAL : func === 'greater' ? gl.GREATER : gl.LESS);
      s.depthFunc = func;
    }
  }

  setCull(mode) {
    if (this._state.cull === mode) return;
    const gl = this.gl;
    this._state.cull = mode;
    if (mode === 'none') { gl.disable(gl.CULL_FACE); return; }
    gl.enable(gl.CULL_FACE);
    gl.cullFace(mode === 'front' ? gl.FRONT : gl.BACK);
  }

  setColorMask(r, g, b, a) {
    if (this._state.colorMask === `${r}${g}${b}${a}`) return;
    this.gl.colorMask(r, g, b, a);
    this._state.colorMask = `${r}${g}${b}${a}`;
  }

  setPolygonOffset(enable, factor = 0, units = 0) {
    const gl = this.gl;
    if (this._state.polyOffset === enable) return;
    this._state.polyOffset = enable;
    if (enable) { gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(factor, units); }
    else gl.disable(gl.POLYGON_OFFSET_FILL);
  }

  /** Force the cache to forget everything (after an FBO bind or a context event). */
  invalidateState() { this._state = defaultState(); }

  /* -------------------------------------------------- GPU timing -------- */

  /**
   * EXT_disjoint_timer_query_webgl2 gives real GPU-side cost. Queries are
   * asynchronous and may be *disjoint* (timer reset) — results are then simply
   * dropped, never guessed.
   */
  beginTimer(label) {
    const ext = this.ext.timerQuery;
    if (!ext || this.lost) return null;
    if (this._activeTimers > 4) return null;
    let q = this._timerPool.pop();
    if (!q) q = this.gl.createQuery();
    this.gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    this._activeTimers++;
    return { query: q, ext, label };
  }

  endTimer(handle) {
    if (!handle) return;
    const { query, ext, label } = handle;
    try { this.gl.endQuery(ext.TIME_ELAPSED_EXT); } catch { /* already ended */ }
    this._activeTimers = Math.max(0, this._activeTimers - 1);
    // Resolve later; drain() is called once per frame.
    (this._pendingTimers || (this._pendingTimers = [])).push({ query, ext, label });
  }

  drainTimers() {
    const gl = this.gl;
    const pending = this._pendingTimers;
    if (!pending || !pending.length) return null;
    const out = {};
    const ext = this.ext.timerQuery;
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
    for (const t of pending) {
      if (!disjoint && gl.getQueryParameter(t.query, gl.QUERY_RESULT_AVAILABLE)) {
        out[t.label] = (out[t.label] || 0) + gl.getQueryParameter(t.query, gl.QUERY_RESULT_AVAILABLE) / 1e6;
        gl.deleteQuery(t.query);
      } else if (disjoint) {
        // Data is unrecoverable this frame; recycle without reporting.
        this._timerPool.push(t.query);
      }
    }
    this._pendingTimers = [];
    return out;
  }

  /** Test hook: force a loss/restore cycle (used by the "simulate context loss" command). */
  simulateContextLoss() {
    // `WEBGL_lose_context` returns an object with `loseContext()`/`restoreContext()`.
    const ext = this.caps?.loseContext;
    if (!ext || typeof ext.loseContext !== 'function') return false;
    this.lost = true;
    ext.loseContext();
    setTimeout(() => { try { ext.restoreContext(); } catch { /* the UA restores on its own */ } }, 260);
    return true;
  }

  stats() {
    return {
      draws: this.debug.draws,
      calls: this.debug.calls,
      programs: countBy(this.resources, (r) => r.kind === 'program'),
      buffers: countBy(this.resources, (r) => r.kind === 'buffer'),
      textures: countBy(this.resources, (r) => r.kind === 'texture'),
      framebuffers: countBy(this.resources, (r) => r.kind === 'framebuffer'),
      meshes: countBy(this.resources, (r) => r.kind === 'mesh'),
      total: this.resources.size
    };
  }
}

function countBy(set, pred) {
  let n = 0;
  for (const r of set) if (pred(r)) n++;
  return n;
}

function defaultState() {
  return {
    program: null, vao: null, blend: 'none', depthTest: null, depthWrite: null,
    depthFunc: null, cull: null, colorMask: null, polyOffset: null,
    viewportW: -1, viewportH: -1, framebuffer: undefined
  };
}
