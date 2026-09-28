/**
 * Persistence: localStorage-first (offline capable, instant), server-mirrored
 * when the REST API is present, plus the optional Server-Sent Events channel
 * used to keep other tabs in sync.
 */

import { Emitter } from './utils.js';

const NS = 'lumen.studio.v1';

export class Storage extends Emitter {
  constructor() {
    super();
    this.available = probe();
    this.serverOnline = false;
    this.projectId = null;
    this._es = null;
  }

  /* ---------------------------------------------------------- local keys -- */

  key(k) { return `${NS}.${k}`; }

  get(k, fallback = null) {
    if (!this.available) return fallback;
    try {
      const raw = localStorage.getItem(this.key(k));
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) {
      console.warn('[storage] read failed', k, e);
      return fallback;
    }
  }

  set(k, value) {
    if (!this.available) return false;
    try {
      localStorage.setItem(this.key(k), JSON.stringify(value));
      this.emit('change', k, value);
      return true;
    } catch (e) {
      // QuotaExceeded is common with big embedded textures — surface it once.
      console.warn('[storage] write failed', k, e);
      this.emit('error', e);
      return false;
    }
  }

  remove(k) {
    if (!this.available) return;
    try { localStorage.removeItem(this.key(k)); } catch { /* ignore */ }
  }

  clearAll() {
    if (!this.available) return;
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(NS)) keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
  }

  usage() {
    if (!this.available) return 0;
    let bytes = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(NS)) bytes += k.length + (localStorage.getItem(k)?.length || 0);
    }
    return bytes * 2; // UTF-16 code units
  }

  /* -------------------------------------------------------------- server -- */

  async ping() {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 1500);
      const r = await fetch('./api/health', { signal: ctl.signal });
      clearTimeout(t);
      this.serverOnline = r.ok;
    } catch { this.serverOnline = false; }
    this.emit('server', this.serverOnline);
    return this.serverOnline;
  }

  async saveRemote(id, doc) {
    const res = await fetch(`./api/projects/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(doc)
    });
    if (!res.ok) throw new Error(`save failed: ${res.status}`);
    this.serverOnline = true;
    this.projectId = id;
    this.emit('server', true);
    return res.json();
  }

  async loadRemote(id) {
    const res = await fetch(`./api/projects/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`load failed: ${res.status}`);
    return res.json();
  }

  async listRemote() {
    if (!this.serverOnline) return [];
    const res = await fetch('./api/projects');
    if (!res.ok) return [];
    return (await res.json()).items || [];
  }

  async deleteRemote(id) {
    if (!this.serverOnline) return false;
    const res = await fetch(`./api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return res.ok;
  }

  /** Subscribe to cross-tab events from the server (project:saved / project:deleted). */
  connectEvents() {
    if (this._es || typeof EventSource === 'undefined') return null;
    try {
      this._es = new EventSource('./api/events');
      this._es.addEventListener('project:saved', (e) => {
        const data = JSON.parse(e.data);
        if (data.id !== this.projectId) this.emit('remote:saved', data);
      });
      this._es.addEventListener('open', () => { this.serverOnline = true; this.emit('server', true); });
      this._es.addEventListener('error', () => { /* EventSource retries on its own */ });
      return this._es;
    } catch {
      return null;
    }
  }

  disconnectEvents() { this._es?.close(); this._es = null; }
}

function probe() {
  try {
    const k = `${NS}.__probe`;
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return true;
  } catch { return false; }
}

export const storage = new Storage();
