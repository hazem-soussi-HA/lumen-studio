/**
 * Widget kit.
 *
 * Every control is a plain DOM component with an `el` root, a `value` accessor
 * and an `onChange` callback. They are deliberately imperative and framework-free:
 * the inspector rebuilds from the schema on demand, so a component lifecycle
 * (mount → update → dispose) is all that is needed — no virtual DOM, no diffing.
 *
 * Numeric fields support drag-to-scrub (with axis-aware modifiers), arrow-key
 * nudging, expression entry ("2*pi"), and unit suffixes. That is the difference
 * between a demo inspector and a usable one.
 */

import { clamp, color as ColorUtil, rad, deg } from '../core/math.js';

export function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k in el && k !== 'list' && typeof v !== 'object') { try { el[k] = v; } catch { el.setAttribute(k, v); } }
    else el.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return el;
}

export const svg = (paths, { viewBox = '0 0 16 16', cls = 'ico' } = {}) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', viewBox);
  el.setAttribute('class', cls);
  for (const d of [].concat(paths)) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    el.appendChild(p);
  }
  return el;
};

/* ------------------------------------------------------------- row/field -- */

export class Field {
  constructor({ label, hint, onChange, getValue } = {}) {
    this.onChange = onChange;
    // Optional accessor back to the model. `refresh()` uses it to re-read the
    // authoritative value; without one, the field re-renders from its own value.
    this.getValue = getValue || null;
    this.labelEl = h('span', { class: 'f-label', text: label });
    this.hintEl = hint ? h('span', { class: 'f-hint', text: hint }) : null;
    this.body = h('div', { class: 'f-body' });
    this.el = h('div', { class: 'field' }, [
      h('div', { class: 'f-head' }, [this.labelEl, this.hintEl].filter(Boolean)),
      this.body
    ]);
    if (hint) this.el.title = hint;
  }

  setValue() { /* subclasses override */ }

  /**
   * Re-render from the model. Every subclass's `setValue(v)` *assigns* its value,
   * so calling it with no argument would wipe the field to `null`/`undefined` —
   * which is how an entity's mesh and material references used to disappear from
   * the inspector on the first refresh.
   */
  refresh() { this.setValue(this.getValue ? this.getValue() : this.value); }
}

/* ------------------------------------------------------------- number --- */

export class NumberField extends Field {
  constructor(opts) {
    super(opts);
    this.opts = { min: -Infinity, max: Infinity, step: 0.01, precision: 4, ...opts };
    this.input = h('input', { class: 'num-input', type: 'text', spellcheck: false });
    this.input.addEventListener('change', () => this._commitText());
    this.input.addEventListener('keydown', (e) => this._onKey(e));
    this.input.addEventListener('blur', () => this.setValue());
    this.fill = h('i', { class: 'num-fill' });
    this.track = h('div', { class: 'num-track' }, [this.fill]);
    this.body.appendChild(this.track);
    this.body.appendChild(this.input);
    this._installDrag();
    this._value = this.opts.value ?? 0;
  }

  setValue(value) {
    if (value !== undefined) this._value = value;
    const v = this._value;
    this.input.value = this.opts.unit
      ? `${formatNumber(v, this.opts.precision)}${this.opts.unit}`
      : formatNumber(v, this.opts.precision);
    const { min, max } = this.opts;
    if (Number.isFinite(min) && Number.isFinite(max) && max > min) {
      const t = clamp((v - min) / (max - min), 0, 1);
      this.fill.style.transform = `scaleX(${t})`;
    } else {
      this.fill.style.transform = '';
    }
  }

  get value() { return this._value; }

  _emit(v, live = true) {
    const { min, max } = this.opts;
    const nv = clamp(v, min, max);
    if (nv === this._value && live) return;
    this._value = nv;
    this.setValue();
    this.onChange?.(nv, { live, final: !live });
  }

  _commitText() {
    const raw = this.input.value.replace(/[^\d.eE+\-*/() ]/g, '').trim();
    if (!raw) { this.setValue(); return; }
    let v = NaN;
    try {
      // Tiny arithmetic evaluator so "1/4" and "2*3" work like a DCC tool.
      v = /^[\d\s+\-*/().eE]+$/.test(raw) ? Function(`"use strict";return (${raw})`)() : parseFloat(raw);
    } catch { v = NaN; }
    if (!Number.isFinite(v)) { this.setValue(); this.input.classList.add('is-invalid'); setTimeout(() => this.input.classList.remove('is-invalid'), 600); return; }
    this._emit(v, false);
  }

  _onKey(e) {
    if (e.key === 'Enter') { this._commitText(); this.input.blur(); return; }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const dir = e.key === 'ArrowUp' ? 1 : -1;
    const scale = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
    this._emit(this._value + dir * this.opts.step * scale, false);
  }

  /** Drag horizontally to scrub — the standard numeric-widget interaction. */
  _installDrag() {
    const input = this.input;
    let startX = 0, startValue = 0, dragging = false, moved = false;
    input.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      dragging = true;
      moved = false;
      startX = e.clientX;
      startValue = this._value;
      input.setPointerCapture(e.pointerId);
      input.classList.add('is-dragging');
      e.preventDefault();
    });
    input.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      if (Math.abs(dx) > 2) moved = true;
      const speed = e.shiftKey ? 0.1 : e.ctrlKey || e.metaKey ? 10 : 1;
      const range = Number.isFinite(this.opts.max) && Number.isFinite(this.opts.min)
        ? (this.opts.max - this.opts.min) : 100;
      this._emit(startValue + (dx / 220) * range * this.opts.step * 4 * speed, true);
    });
    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      input.classList.remove('is-dragging');
      try { input.releasePointerCapture(e.pointerId); } catch { /* released */ }
      if (!moved) { input.focus(); input.select(); }
      else this.onChange?.(this._value, { live: false, final: true });
    };
    input.addEventListener('pointerup', end);
    input.addEventListener('pointercancel', end);
  }
}

/* -------------------------------------------------------------- vector -- */

export class Vec3Field extends Field {
  constructor(opts) {
    super(opts);
    this.opts = opts;
    this.value = opts.value ? [...opts.value] : [0, 0, 0];
    this.axes = ['X', 'Y', 'Z'];
    this.inputs = this.axes.map((axis, i) => {
      const f = new NumberField({
        label: axis,
        className: `axis-${axis.toLowerCase()}`,
        ...opts,
        value: this.value[i],
        min: i === 0 ? (opts.minX ?? opts.min) : i === 1 ? (opts.minY ?? opts.min) : (opts.minZ ?? opts.min),
        max: i === 0 ? (opts.maxX ?? opts.max) : i === 1 ? (opts.maxY ?? opts.max) : (opts.maxZ ?? opts.max),
        onChange: (v, meta) => {
          this.value[i] = v;
          this.onChange?.([...this.value], meta);
        }
      });
      f.el.classList.add('vec-axis', `axis-${axis.toLowerCase()}`);
      return f;
    });
    this.body.classList.add('vec3');
    for (const f of this.inputs) this.body.appendChild(f.el);
  }

  setValue(v) {
    if (v) this.value = [...v];
    this.inputs.forEach((f, i) => f.setValue(this.value[i]));
  }
}

/* --------------------------------------------------------------- color -- */

export class ColorField extends Field {
  constructor(opts) {
    super(opts);
    this.value = opts.value ? [...opts.value] : [1, 1, 1, 1];
    this.swatch = h('div', { class: 'color-swatch' });
    this.hex = h('input', { class: 'color-hex', type: 'text', spellcheck: false, maxlength: 9 });
    this.hex.addEventListener('change', () => this._fromHex());
    this.alphaRow = h('div', { class: 'color-alpha' });
    this.alpha = new NumberField({
      label: 'A', min: 0, max: 1, step: 0.01, value: this.value[3], unit: '',
      onChange: (v, meta) => { this.value[3] = v; this._emit(meta); }
    });
    this.alphaRow.appendChild(this.alpha.el);
    this.picker = h('div', { class: 'color-picker', hidden: true });
    this.body.appendChild(h('div', { class: 'color-main' }, [this.swatch, this.hex, this.pickerBtn = h('button', { class: 'color-btn', type: 'button', text: '▾' })]));
    this.body.appendChild(this.alphaRow);
    this.body.appendChild(this.picker);
    this._buildPicker();
    this.swatch.addEventListener('click', () => this._togglePicker());
    this.pickerBtn.addEventListener('click', () => this._togglePicker());
    document.addEventListener('pointerdown', (e) => {
      if (this.picker.hidden) return;
      if (this.picker.contains(e.target) || this.swatch.contains(e.target) || this.pickerBtn.contains(e.target)) return;
      this.picker.hidden = true;
    });
    this.setValue();
  }

  setValue(v) {
    if (v) this.value = [...v];
    this.swatch.style.background = ColorUtil.toHex(this.value);
    this.hex.value = ColorUtil.toHex(this.value).toUpperCase();
    this.alpha.setValue(this.value[3]);
    this._updatePicker();
  }

  _emit(meta = {}) {
    this.setValue();
    this.onChange?.([...this.value], meta);
  }

  _fromHex() {
    const c = ColorUtil.fromHex(this.hex.value);
    this.value = [c[0], c[1], c[2], this.value[3]];
    this._emit({ final: true });
  }

  _togglePicker() { this.picker.hidden = !this.picker.hidden; this._updatePicker(); }

  _buildPicker() {
    this.hue = h('input', { type: 'range', min: 0, max: 360, step: 1, class: 'cp-hue' });
    this.sat = h('input', { type: 'range', min: 0, max: 100, step: 0.5, class: 'cp-sat' });
    this.val = h('input', { type: 'range', min: 0, max: 100, step: 0.5, class: 'cp-val' });
    const preview = h('div', { class: 'cp-preview' });
    this.hue.addEventListener('input', () => this._fromHsv());
    this.sat.addEventListener('input', () => this._fromHsv());
    this.val.addEventListener('input', () => this._fromHsv());
    this.picker.appendChild(preview);
    this.picker.appendChild(this.hue);
    this.picker.appendChild(this.sat);
    this.picker.appendChild(this.val);
  }

  _fromHsv() {
    const [r, g, b] = ColorUtil.hsvToRgb(+this.hue.value / 360, +this.sat.value / 100, +this.val.value / 100);
    this.value = [r, g, b, this.value[3]];
    this._emit({ live: true });
  }

  _updatePicker() {
    if (this.picker.hidden) return;
    const [h, s, v] = ColorUtil.rgbToHsv(this.value[0], this.value[1], this.value[2]);
    this.hue.value = String(Math.round(h * 360));
    this.sat.value = String(s * 100);
    this.val.value = String(v * 100);
  }
}

/* -------------------------------------------------------------- others -- */

export class BoolField extends Field {
  constructor(opts) {
    super(opts);
    this.value = !!opts.value;
    this.input = h('input', { type: 'checkbox' });
    this.input.checked = this.value;
    this.input.addEventListener('change', () => {
      this.value = this.input.checked;
      this.onChange?.(this.value, { final: true });
    });
    this.body.classList.add('bool');
    this.body.appendChild(this.input);
  }
  setValue(v = this.value) { this.value = !!v; this.input.checked = this.value; }
}

export class SelectField extends Field {
  constructor(opts) {
    super(opts);
    this.value = opts.value;
    this.select = h('select', { class: 'sel-input' });
    for (const o of opts.options) {
      const [value, label] = Array.isArray(o) ? o : [o, String(o)];
      this.select.appendChild(h('option', { value: String(value), text: label }));
    }
    this.select.value = String(opts.value);
    this.select.addEventListener('change', () => {
      const raw = this.select.value;
      const opt = opts.options.find((o) => String(Array.isArray(o) ? o[0] : o) === raw);
      this.value = Array.isArray(opt) ? opt[0] : opt;
      this.onChange?.(this.value, { final: true });
    });
    this.body.appendChild(this.select);
  }
  setValue(v = this.value) {
    this.value = v;
    this.select.value = String(v);
  }
}

export class TextField extends Field {
  constructor(opts) {
    super(opts);
    this.opts = opts;
    this.input = h('input', { class: 'text-input', type: 'text', spellcheck: false, placeholder: opts.placeholder || '' });
    this.input.value = opts.value ?? '';
    if (opts.readonly) this.input.readOnly = true;
    this.input.addEventListener('change', () => this.onChange?.(this.input.value, { final: true }));
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') this.input.blur();
    });
    this.body.appendChild(this.input);
  }
  setValue(v = this.value) { if (document.activeElement !== this.input) this.input.value = v ?? ''; }
}

export class LayersField extends Field {
  constructor(opts) {
    super(opts);
    this.value = [...(opts.value || [0])];
    this.layerDefs = opts.layers;
    this.boxes = new Map();
    this.body.classList.add('layers');
    this.layerDefs.forEach((def) => {
      const box = h('input', { type: 'checkbox' });
      box.checked = this.value.includes(def.id);
      box.addEventListener('change', () => {
        const next = new Set(this.value);
        if (box.checked) next.add(def.id); else next.delete(def.id);
        this.value = [...next].sort((a, b) => a - b);
        this.onChange?.([...this.value], { final: true });
      });
      this.boxes.set(def.id, box);
      this.body.appendChild(h('label', { class: 'layer-chip', title: `Layer ${def.id}: ${def.name}` }, [
        box, h('span', { text: def.name })
      ]));
    });
  }
  setValue(v = this.value) {
    this.value = [...(v || [0])];
    for (const [id, box] of this.boxes) box.checked = this.value.includes(id);
  }
}

export class AssetRefField extends Field {
  constructor(opts) {
    super(opts);
    this.opts = opts;
    this.value = opts.value ?? null;
    this.preview = h('div', { class: 'asset-ref-preview' });
    this.name = h('div', { class: 'asset-ref-name' });
    this.button = h('button', { class: 'asset-ref-btn', type: 'button', title: 'Assign asset' }, [this.preview, this.name]);
    this.button.addEventListener('click', () => this._openPicker());
    this.clear = h('button', { class: 'asset-ref-clear', type: 'button', title: 'Clear', text: '×' });
    this.clear.addEventListener('click', () => {
      this.value = null;
      this.setValue();
      this.onChange?.(null, { final: true });
    });
    this.body.appendChild(h('div', { class: 'asset-ref' }, [this.button, this.clear]));
    this.setValue();
  }

  setValue(v = this.value) {
    this.value = v ?? null;
    const asset = this.value ? this.opts.store?.get(this.value) : null;
    this.name.textContent = asset?.name || '— none —';
    this.preview.style.background = asset?.type === 'material'
      ? ColorUtil.toHex(asset.material.diffuse)
      : asset?.type === 'texture' ? 'var(--checker)' : 'transparent';
    this.preview.dataset.type = asset?.type || '';
    this.clear.style.display = this.value ? '' : 'none';
  }

  _openPicker() {
    this.opts.onPick?.(this);
  }
}

export class InfoField extends Field {
  constructor(opts) {
    super(opts);
    this.valueEl = h('div', { class: 'info-value', text: opts.text ?? '' });
    this.body.appendChild(this.valueEl);
  }
  setValue(v) { if (v !== undefined) this.valueEl.textContent = v; }
}

export class ButtonRow extends Field {
  constructor({ label, buttons }) {
    super({ label });
    this.body.classList.add('btn-row');
    for (const b of buttons) {
      this.body.appendChild(h('button', {
        class: `btn ${b.variant ? `btn-${b.variant}` : ''}`,
        type: 'button',
        title: b.title || b.label,
        onclick: () => b.onClick?.()
      }, [b.label]));
    }
  }
}

/* --------------------------------------------------------------- utils -- */

export function formatNumber(v, precision = 4) {
  if (!Number.isFinite(v)) return '0';
  if (Number.isInteger(v) && Math.abs(v) < 1e7) return String(v);
  const abs = Math.abs(v);
  if (abs !== 0 && (abs < 1e-4 || abs >= 1e6)) return v.toExponential(2);
  const s = v.toFixed(precision);
  return s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

export function formatVec3(v, precision = 2) {
  return [v[0], v[1], v[2]].map((x) => formatNumber(x, precision)).join(', ');
}

export { rad, deg };
