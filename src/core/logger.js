/**
 * Logging spine. Every subsystem logs through here so the console panel can
 * filter, count and clear, and so a single place decides what reaches the
 * browser devtools (warnings/errors always, chatter only in debug mode).
 */

import { Emitter } from './utils.js';

const LEVELS = { log: 0, info: 1, warn: 2, error: 3, debug: 4 };
const MAX = 500;

export class Logger extends Emitter {
  constructor({ verbose = false, mirror = true } = {}) {
    super();
    this.records = [];
    this.verbose = verbose;
    this.mirror = mirror;
    this.counts = { log: 0, info: 0, warn: 0, error: 0, debug: 0 };
    this.channel = 'app';
  }

  /** Named sub-logger so the UI can show which subsystem produced a message. */
  scoped(channel) {
    const child = new Logger({ verbose: this.verbose, mirror: this.mirror });
    child.channel = channel;
    child.records = this.records;
    child.counts = this.counts;
    child.on('record', (r) => super.emit('record', r));
    return child;
  }

  _write(level, args) {
    const rec = {
      t: performance.now(),
      time: new Date(),
      level,
      channel: this.channel,
      text: args.map(fmt).join(' ')
    };
    this.records.push(rec);
    if (this.records.length > MAX) this.records.shift();
    this.counts[level]++;
    if (this.mirror) {
      const fn = level === 'error' ? console.error : level === 'warn' ? console.warn
        : level === 'debug' ? (this.verbose ? console.debug : () => {}) : console.log;
      fn(`[${rec.channel}]`, rec.text, ...(args.length > 1 ? args.slice(1) : []));
    }
    this.emit('record', rec);
    return rec;
  }

  log(...a) { return this._write('log', a); }
  info(...a) { return this._write('info', a); }
  warn(...a) { return this._write('warn', a); }
  error(...a) { return this._write('error', a); }
  debug(...a) { return this.verbose ? this._write('debug', a) : null; }

  clear() { this.records.length = 0; this.emit('clear'); }
  tail(n = 100, level = null) {
    const f = level && level !== 'all' ? this.records.filter((r) => r.level === level) : this.records;
    return f.slice(-n);
  }
}

function fmt(v) {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return `${v.message}${v.stack ? `\n${v.stack}` : ''}`;
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
}

const search = typeof location !== 'undefined' ? location.search : '';
export const log = new Logger({ verbose: new URLSearchParams(search).has('verbose') });
export const LEVELS_ORDER = LEVELS;
