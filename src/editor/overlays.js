/**
 * Overlays: command palette, modal dialogs, context menus, tooltips and the
 * keyboard-shortcut sheet.
 *
 * The palette indexes three sources — registered commands, scene entities and
 * assets — through one fuzzy matcher, so "box" finds the *Box* command, a *box*
 * entity and the *Box* mesh in a single list.
 */

import { h } from './widgets.js';
import { fuzzyScore, comboFromEvent } from '../core/commands.js';

/* ------------------------------------------------------------- palette -- */

export class Palette {
  constructor(app, { scrimEl, inputEl, listEl }) {
    this.app = app;
    this.scrim = scrimEl;
    this.input = inputEl;
    this.list = listEl;
    this.open = false;
    this.items = [];
    this.active = 0;
    this._buildSource = () => [];

    this.input.addEventListener('input', () => this.refresh());
    this.input.addEventListener('keydown', (e) => this._onKey(e));
    this.scrim.addEventListener('pointerdown', (e) => {
      if (e.target === this.scrim) this.close();
    });
  }

  setSource(fn) { this._buildSource = fn; }

  show(prefix = '') {
    this.open = true;
    this.scrim.hidden = false;
    this.input.value = prefix;
    this.refresh();
    this.input.focus();
    this.input.select();
  }

  close() {
    this.open = false;
    this.scrim.hidden = true;
  }

  toggle(prefix = '') { this.open ? this.close() : this.show(prefix); }

  refresh() {
    const q = this.input.value.trim();
    const source = this._buildSource();
    const scored = [];
    for (const item of source) {
      const hay = item.haystack || `${item.group} ${item.label}`;
      const score = fuzzyScore(q, hay) + (item.weight || 0);
      if (score > 0) scored.push({ item, score });
    }
    scored.sort((a, b) => b.score - a.score);
    this.items = scored.slice(0, 40).map((s) => s.item);
    this.active = 0;
    this.renderList();
  }

  renderList() {
    this.list.textContent = '';
    if (!this.items.length) {
      this.list.appendChild(h('div', { class: 'palette-empty', text: 'No matches.' }));
      return;
    }
    let lastGroup = null;
    this.items.forEach((item, i) => {
      if (item.group !== lastGroup) {
        lastGroup = item.group;
        this.list.appendChild(h('div', { class: 'palette-group', text: item.group }));
      }
      const row = h('div', {
        class: `palette-row${i === this.active ? ' is-active' : ''}`,
        onclick: () => this.run(i),
        onmouseenter: () => { this.active = i; this._highlight(); }
      }, [
        h('span', { class: 'pr-icon', text: item.icon || '›' }),
        h('span', { class: 'pr-label', text: item.label }),
        item.hint ? h('kbd', { class: 'pr-hint', text: item.hint }) : null
      ]);
      this.list.appendChild(row);
    });
  }

  _highlight() {
    [...this.list.querySelectorAll('.palette-row')].forEach((el, i) => el.classList.toggle('is-active', i === this.active));
    const active = this.list.querySelector('.palette-row.is-active');
    active?.scrollIntoView({ block: 'nearest' });
  }

  _onKey(e) {
    e.stopPropagation();
    if (e.key === 'Escape') { this.close(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); this.active = Math.min(this.active + 1, this.items.length - 1); this._highlight(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); this.active = Math.max(this.active - 1, 0); this._highlight(); return; }
    if (e.key === 'Enter') { e.preventDefault(); this.run(this.active); }
  }

  run(index) {
    const item = this.items[index ?? this.active];
    if (!item) return;
    this.close();
    item.run?.(item);
  }
}

/* --------------------------------------------------------------- modal -- */

export class ModalHost {
  constructor(app, { scrimEl, modalEl }) {
    this.app = app;
    this.scrim = scrimEl;
    this.modal = modalEl;
    this.open = false;
    this._onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); this.close(); }
    };
    scrimEl.addEventListener('pointerdown', (e) => { if (e.target === scrimEl) this.close(); });
  }

  /**
   * @param {object} spec { title, body: Node|string, buttons: [{label, variant, onClick, value}], width }
   */
  show({ title, body, buttons = [], width }) {
    this.open = true;
    this.scrim.hidden = false;
    this.modal.textContent = '';
    if (width) this.modal.style.width = typeof width === 'number' ? `${width}px` : width;
    this.modal.appendChild(h('div', { class: 'modal-head' }, [
      h('span', { class: 'modal-title', text: title }),
      h('button', { class: 'modal-close', type: 'button', text: '✕', onclick: () => this.close() })
    ]));
    const content = h('div', { class: 'modal-body' });
    if (typeof body === 'string') content.innerHTML = body;
    else if (body) content.appendChild(body);
    this.modal.appendChild(content);
    if (buttons.length) {
      const foot = h('div', { class: 'modal-foot' });
      for (const b of buttons) {
        foot.appendChild(h('button', {
          class: `btn ${b.variant ? `btn-${b.variant}` : ''}`,
          type: 'button',
          text: b.label,
          onclick: () => {
            const keep = b.onClick?.(content);
            if (!keep) this.close();
          }
        }));
      }
      this.modal.appendChild(foot);
    }
    this.modal.querySelector('input, select, textarea, button:not(.modal-close)')?.focus();
    window.addEventListener('keydown', this._onKey, true);
  }

  close() {
    this.open = false;
    this.scrim.hidden = true;
    this.modal.textContent = '';
    window.removeEventListener('keydown', this._onKey, true);
  }

  prompt(title, defaultValue = '') {
    return new Promise((resolve) => {
      const input = h('input', { class: 'text-input', type: 'text', value: defaultValue });
      const body = h('div', {}, [input]);
      this.show({
        title, body,
        buttons: [
          { label: 'Cancel', onClick: () => resolve(null) },
          { label: 'OK', variant: 'primary', onClick: () => resolve(input.value) }
        ]
      });
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { resolve(input.value); this.close(); }
      });
    });
  }
}

/* ---------------------------------------------------------- context menu */

export class ContextMenu {
  constructor(app, el) {
    this.app = app;
    this.el = el;
    document.addEventListener('pointerdown', (e) => {
      if (this.el.hidden) return;
      if (!this.el.contains(e.target)) this.hide();
    });
    window.addEventListener('blur', () => this.hide());
  }

  show(x, y, items) {
    this.el.textContent = '';
    this.el.hidden = false;
    for (const item of items) {
      if (item.separator) { this.el.appendChild(h('div', { class: 'ctx-sep' })); continue; }
      const row = h('div', {
        class: `ctx-row${item.disabled ? ' is-disabled' : ''}`,
        onclick: () => {
          this.hide();
          item.run?.();
        }
      }, [
        h('span', { class: 'ctx-label', text: item.label }),
        item.hint ? h('span', { class: 'ctx-hint', text: item.hint }) : null
      ]);
      this.el.appendChild(row);
    }
    // Keep the menu inside the window.
    const r = this.el.getBoundingClientRect();
    this.el.style.left = `${Math.min(x, window.innerWidth - r.width - 8)}px`;
    this.el.style.top = `${Math.min(y, window.innerHeight - r.height - 8)}px`;
  }

  hide() { this.el.hidden = true; }
}

/* -------------------------------------------------------------- tooltip */

export class Tooltip {
  constructor(el) {
    this.el = el;
    this.timer = 0;
    document.addEventListener('pointerover', (e) => {
      const target = e.target.closest('[title]');
      if (!target || target === this.current) return;
      this.current = target;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.show(target), 550);
    });
    document.addEventListener('pointerout', (e) => {
      if (this.current && e.target.closest('[title]') === this.current) {
        clearTimeout(this.timer);
        this.current = null;
        this.hide();
      }
    });
    window.addEventListener('scroll', () => this.hide(), true);
  }

  show(target) {
    const text = target.getAttribute('title');
    if (!text) return;
    this.el.textContent = text;
    this.el.hidden = false;
    const r = target.getBoundingClientRect();
    const t = this.el.getBoundingClientRect();
    let x = r.left + r.width / 2 - t.width / 2;
    let y = r.bottom + 6;
    if (y + t.height > window.innerHeight - 8) y = r.top - t.height - 6;
    x = Math.max(8, Math.min(x, window.innerWidth - t.width - 8));
    this.el.style.transform = `translate(${x}px, ${y}px)`;
  }

  hide() { this.el.hidden = true; }
}

/* ------------------------------------------------------- shortcut sheet -- */

export const SHORTCUTS = [
  ['Selection', [
    ['Click', 'Select entity'],
    ['Ctrl / ⌘ + Click', 'Add to selection'],
    ['Shift + Click', 'Range select'],
    ['Drag in tree', 'Reparent'],
    ['Double click', 'Rename']
  ]],
  ['Tools', [
    ['Q / W / E / R', 'Select / Move / Rotate / Scale'],
    ['X', 'Toggle gizmo space (world/local)'],
    ['Ctrl (hold)', 'Temporary gizmo space flip'],
    ['G', 'Toggle grid'],
    ['F', 'Frame selection'],
    ['Z', 'Zoom to fit scene']
  ]],
  ['Camera', [
    ['Drag (empty)', 'Orbit'],
    ['Alt + Drag', 'Orbit'],
    ['Right drag', 'Pan'],
    ['Middle drag', 'Orbit'],
    ['Wheel', 'Dolly'],
    ['Ctrl + Wheel', 'Zoom FOV'],
    ['W A S D', 'Fly'],
    ['Q / E', 'Fly down / up'],
    ['1 … 6', 'Front / Back / Left / Right / Top / Iso'],
    ['5', 'Toggle orthographic']
  ]],
  ['Edit', [
    ['Ctrl + Z', 'Undo'],
    ['Ctrl + Shift + Z', 'Redo'],
    ['Ctrl + D', 'Duplicate'],
    ['Ctrl + G', 'Group selection'],
    ['Delete', 'Delete selection'],
    ['Ctrl + S', 'Save project'],
    ['Ctrl + O', 'Open project'],
    ['Ctrl + E', 'Export scene JSON']
  ]],
  ['View', [
    ['Ctrl + K', 'Command palette'],
    ['0 … 9', 'Cycle debug view'],
    ['F11', 'Present (hide UI)'],
    ['P', 'Capture PNG'],
    ['?', 'This sheet']
  ]]
];

export function buildShortcutSheet() {
  const wrap = h('div', { class: 'shortcut-sheet' });
  for (const [group, rows] of SHORTCUTS) {
    const table = h('div', { class: 'sc-group' }, [h('h4', { text: group })]);
    for (const [keys, desc] of rows) {
      table.appendChild(h('div', { class: 'sc-row' }, [
        h('span', { class: 'sc-keys' }, keys.split(' + ').map((k) => h('kbd', { text: k }))),
        h('span', { class: 'sc-desc', text: desc })
      ]));
    }
    wrap.appendChild(table);
  }
  return wrap;
}

export { comboFromEvent };
