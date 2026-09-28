/**
 * Undo/redo.
 *
 * The editor is a *document* editor, so history stores full JSON snapshots of
 * the serialised scene rather than inverse commands. That is trivially correct
 * for arbitrary property edits (including those coming from importers or the
 * console) and cheap at editor scale. Drags coalesce: consecutive commits with
 * the same coalesce key inside `coalesceMs` replace the previous "after" state.
 */

import { Emitter } from './utils.js';

const DEFAULT_LIMIT = 200;

export class History extends Emitter {
  /**
   * @param {object} opts
   * @param {() => any} opts.snapshot  produce the current document state
   * @param {(state:any) => void} opts.restore  apply a state to the document
   */
  constructor({ snapshot, restore, coalesceMs = 600, limit = DEFAULT_LIMIT }) {
    super();
    this._snapshot = snapshot;
    this._restore = restore;
    this.coalesceMs = coalesceMs;
    this.limit = limit;
    this.stack = [];
    this.index = -1;      // index of the last applied entry
    this._pending = null;  // coalesce bookkeeping
    this._baseline = null;
  }

  get canUndo() { return this.index >= 0; }
  get canRedo() { return this.index < this.stack.length - 1; }
  get undoLabel() { return this.canUndo ? this.stack[this.index].label : null; }
  get redoLabel() { return this.canRedo ? this.stack[this.index + 1].label : null; }

  /** Establish the clean baseline (called after a document load). */
  reset() {
    this.stack.length = 0;
    this.index = -1;
    this._baseline = this._snapshot();
    this._pending = null;
    this.emit('change', this);
  }

  /**
   * Record a change. `state` defaults to "snapshot the document right now".
   * @param {string} label human readable, shown in the Edit menu
   * @param {object} [opts] { coalesce?: string, state?: any, skipIfSame?: boolean }
   */
  push(label, { coalesce = null, state = null, skipIfSame = true } = {}) {
    const after = state ?? this._snapshot();

    if (skipIfSame && this.index >= 0) {
      const prev = this.stack[this.index];
      if (prev.after && JSON.stringify(prev.after) === JSON.stringify(after)) return false;
    }

    // Drop any redo branch, then append.
    if (this.index < this.stack.length - 1) this.stack.length = this.index + 1;

    const now = performance.now();
    const mergeable = coalesce
      && this._pending
      && this._pending.coalesce === coalesce
      && now - this._pending.time < this.coalesceMs
      && this.index >= 0
      && this.stack[this.index].coalesce === coalesce;

    if (mergeable) {
      this.stack[this.index].after = after;
      this.stack[this.index].time = now;
      this._pending = { coalesce, time: now };
      this.emit('change', this);
      return true;
    }

    const before = this.index >= 0 ? this.stack[this.index].after : this._baseline;
    this.stack.push({ label, before, after, coalesce, time: now });
    if (this.stack.length > this.limit) this.stack.shift();
    this.index = this.stack.length - 1;
    this._pending = coalesce ? { coalesce, time: now } : null;
    this.emit('change', this);
    return true;
  }

  /** Close an open coalesce window so the next edit starts a new undo step. */
  seal() { this._pending = null; }

  undo() {
    if (!this.canUndo) return false;
    const entry = this.stack[this.index];
    this._restore(entry.before);
    this.index--;
    this._pending = null;
    this.emit('change', this, 'undo', entry);
    return true;
  }

  redo() {
    if (!this.canRedo) return false;
    const entry = this.stack[this.index + 1];
    this._restore(entry.after);
    this.index++;
    this._pending = null;
    this.emit('change', this, 'redo', entry);
    return true;
  }

  clear() { this.reset(); }

  /** For the History panel: newest first, with the current position marked. */
  entries() {
    return this.stack.map((e, i) => ({
      label: e.label,
      state: i === this.index ? 'current' : i < this.index ? 'past' : 'future',
      time: e.time
    })).reverse();
  }
}
