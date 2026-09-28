/**
 * Command registry — the single dispatch point for every UI action.
 *
 * The top bar, the rail, the hierarchy context menu, the command palette
 * (`Ctrl/Cmd-K`), keyboard shortcuts and the console all resolve to an id in
 * this registry, so a feature can never drift between two entry points.
 */

import { Emitter } from './utils.js';

export class CommandRegistry extends Emitter {
  constructor(app) {
    super();
    this.app = app;
    /** @type {Map<string, Command>} */
    this.map = new Map();
  }

  /**
   * @param {string} id dotted id, e.g. `hierarchy.duplicate`
   * @param {object} def { title, category, run, keys?, when?, icon? }
   */
  register(id, def) {
    if (this.map.has(id)) throw new Error(`command already registered: ${id}`);
    const cmd = {
      id,
      title: def.title || id,
      category: def.category || 'General',
      keys: def.keys || null,
      run: def.run,
      when: def.when || null,
      hidden: !!def.hidden,
      order: def.order ?? 100
    };
    this.map.set(id, cmd);
    return cmd;
  }

  registerAll(defs) { for (const [id, d] of Object.entries(defs)) this.register(id, d); return this; }

  has(id) { return this.map.has(id); }
  get(id) { return this.map.get(id) || null; }
  list() { return [...this.map.values()].filter((c) => !c.hidden); }
  enabled(id) {
    const c = this.map.get(id);
    if (!c) return false;
    return c.when ? !!c.when(this.app) : true;
  }

  /** @returns {Promise<any>} the command result. */
  async run(id, ...args) {
    const c = this.map.get(id);
    if (!c) { console.warn(`[commands] unknown id "${id}"`); return undefined; }
    if (c.when && !c.when(this.app)) return undefined;
    this.emit('run', c, args);
    return c.run(this.app, ...args);
  }

  /** Attach keybindings from a spec: { 'Ctrl+Z': 'edit.undo', … }. */
  bindKeys(spec) {
    this._keys = spec;
    return this;
  }

  keyMap() { return this._keys || {}; }
}

/** Normalised, platform-aware binding string: "Ctrl+Shift+Z" / "Cmd+K". */
export function normalizeCombo(combo) {
  return combo
    .split('+')
    .map((part) => {
      const p = part.trim();
      if (/^cmd$/i.test(p) || /^meta$/i.test(p)) return 'meta';
      if (/^ctrl$/i.test(p) || /^control$/i.test(p)) return 'ctrl';
      if (/^shift$/i.test(p)) return 'shift';
      if (/^alt$/i.test(p) || /^option$/i.test(p)) return 'alt';
      return p.length === 1 ? p.toLowerCase() : p.toLowerCase();
    })
    .join('+');
}

export function comboFromEvent(e) {
  const parts = [];
  if (e.ctrlKey) parts.push('ctrl');
  if (e.metaKey) parts.push('meta');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  let k = e.key;
  if (k === ' ') k = 'space';
  else if (k.length === 1) k = k.toLowerCase();
  else k = k.toLowerCase();
  if (['control', 'meta', 'alt', 'shift'].includes(k)) return null;
  parts.push(k);
  return parts.join('+');
}

/** Subsequence fuzzy match with contiguity + word-start bonuses. */
export function fuzzyScore(needle, haystack) {
  if (!needle) return 0.0001;
  const n = needle.toLowerCase(), h = haystack.toLowerCase();
  if (n === h) return 1000;
  const idx = h.indexOf(n);
  if (idx === 0) return 900 - h.length * 0.1;
  if (idx > 0) return 700 - idx * 2 - h.length * 0.1;
  let hi = 0, score = 0, streak = 0;
  for (let ni = 0; ni < n.length; ni++) {
    const c = n[ni];
    let found = -1;
    for (; hi < h.length; hi++) {
      if (h[hi] === c) { found = hi; break; }
    }
    if (found < 0) return 0;
    streak = found === hi - 1 || ni === 0 ? streak + 1 : 0;
    score += 10 + streak * 6 + (found === 0 || /[\s\-_./]/.test(h[found - 1] || ' ') ? 12 : 0);
    hi = found + 1;
  }
  return score - h.length * 0.05;
}
