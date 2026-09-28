/**
 * Small shared utilities: event emitter, timing helpers, ids, formatting.
 * Deliberately dependency-free — this is the bottom of the module graph.
 */

let _idCounter = 0;
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Monotonic, collision-resistant within a session. Mirrors PlayCanvas' `guid`-ish ids. */
export function uid(prefix = '') {
  _idCounter = (_idCounter + 1) % 0xfffffff;
  const t = Date.now().toString(36);
  const n = _idCounter.toString(36).padStart(5, '0');
  let r = '';
  for (let i = 0; i < 4; i++) r += ALPHABET[(Math.random() * 36) | 0];
  return `${prefix}${t}${n}${r}`;
}

export class Emitter {
  constructor() { this._map = new Map(); }
  on(type, fn, ctx = this) {
    let set = this._map.get(type);
    if (!set) this._map.set(type, (set = new Set()));
    set.add({ fn, ctx });
    return () => this.off(type, fn, ctx);
  }
  once(type, fn, ctx = this) {
    const off = this.on(type, (...a) => { off(); fn.apply(ctx, a); });
    return off;
  }
  off(type, fn, ctx) {
    const set = this._map.get(type);
    if (!set) return;
    for (const e of set) if (e.fn === fn && (ctx === undefined || e.ctx === ctx)) set.delete(e);
    if (!set.size) this._map.delete(type);
  }
  emit(type, ...args) {
    const set = this._map.get(type);
    if (!set) return 0;
    let n = 0;
    for (const e of [...set]) { e.fn.apply(e.ctx, args); n++; }
    return n;
  }
  removeAll(type) { if (type) this._map.delete(type); else this._map.clear(); }
}

export function throttle(fn, ms) {
  let last = 0, pending = null, timer = 0;
  return function throttled(...args) {
    const now = performance.now();
    pending = args;
    if (now - last >= ms) { last = now; fn.apply(this, pending); pending = null; return; }
    if (!timer) {
      timer = setTimeout(() => {
        timer = 0; last = performance.now();
        if (pending) { fn.apply(this, pending); pending = null; }
      }, ms - (now - last));
    }
  };
}

export function debounce(fn, ms) {
  let t = 0;
  const wrapped = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  wrapped.cancel = () => clearTimeout(t);
  wrapped.flush = (...args) => { clearTimeout(t); fn(...args); };
  return wrapped;
}

/** Frame-rate independent smoothing: moves `a` toward `b`, rate = fraction per 60fps frame. */
export const dampFactor = (rate, dt) => 1 - Math.pow(1 - Math.min(rate, 0.999), dt * 60);

export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

export function formatCount(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}G`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

export function formatTime(ms) {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${ms.toFixed(2)} ms`;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function deepClone(value) {
  if (value === null || typeof value !== 'object') return value;
  if (ArrayBuffer.isView(value)) return new value.constructor(value);
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (Array.isArray(value)) return value.map(deepClone);
  const out = {};
  for (const k in value) out[k] = deepClone(value[k]);
  return out;
}

/** Structural equality good enough for JSON-shaped data (undo snapshots, change detection). */
export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== 'object') return Math.abs(a - b) < 1e-9;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}

export function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

export function kebab(s) { return s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase(); }

export function nextPaint() {
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}

export function readFileAsText(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = () => rej(fr.error);
    fr.readAsText(file);
  });
}

export function readFileAsDataURL(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(file);
  });
}

export function readFileAsArrayBuffer(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = () => rej(fr.error);
    fr.readAsArrayBuffer(file);
  });
}

export function pickFile(accept, multiple = false) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    document.body.appendChild(input);
    let settled = false;
    const finish = (files) => { if (settled) return; settled = true; input.remove(); resolve(files); };
    input.addEventListener('change', () => finish([...input.files]));
    // `cancel` is not universally supported; the focus fallback keeps the promise from leaking.
    input.addEventListener('cancel', () => finish([]));
    window.addEventListener('focus', () => setTimeout(() => finish(input.files ? [...input.files] : []), 400), { once: true });
    input.click();
  });
}

/** Async iterator over files in a DataTransfer (drag & drop of folders is not supported everywhere). */
export function filesFromDataTransfer(dt) {
  if (dt.items && dt.items.length && dt.items[0].webkitGetAsEntry) {
    const out = [];
    const walk = (entry) => {
      if (!entry) return;
      if (entry.isFile) {
        entry.file((f) => out.push(f), () => {});
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const readBatch = () => reader.readEntries((entries) => {
          if (!entries.length) return;
          entries.forEach(walk);
          readBatch();
        }, () => {});
        readBatch();
      }
    };
    for (const it of dt.items) {
      const entry = it.webkitGetAsEntry();
      if (entry) walk(entry);
    }
    if (out.length) return Promise.resolve(out);
  }
  return Promise.resolve([...(dt.files || [])]);
}
