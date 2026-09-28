/**
 * Hierarchy panel — the scene graph as an editable tree.
 *
 * Supports multi-select (click / ctrl-click / shift-range), drag & drop
 * reparenting with cycle prevention, inline rename, visibility toggles and a
 * type filter. Expansion state survives rebuilds, which matters because the tree
 * rebuilds on every structural change.
 */

import { h } from './widgets.js';
import { debounce } from '../core/utils.js';
import { componentOrder, defaultTags } from '../scene/components.js';

const TYPE_ICON = {
  render: '▣', camera: '🎥', light: '☀', volume: '☁', collision: '◈', script: '⌘'
};

export class HierarchyPanel {
  constructor(app, root) {
    this.app = app;
    this.root = root;
    this.expanded = new Set(['root']);
    this.filter = '';
    this.collapsedByFilter = false;
    this._lastClickedId = null;

    this.root.addEventListener('contextmenu', (e) => {
      const row = e.target.closest('.tree-row');
      if (row) {
        e.preventDefault();
        const entity = this.app.scene.find(row.dataset.id);
        if (entity) {
          if (!this.app.scene.selection.includes(entity)) this.app.scene.select(entity);
          this.app.showContextMenu(e.clientX, e.clientY, this._contextItems(entity));
        }
      }
    });

    this._onFilter = debounce(() => this.render(), 120);
    document.querySelector('[data-filter="hierarchy"]')?.addEventListener('input', (e) => {
      this.filter = e.target.value.trim().toLowerCase();
      this._onFilter();
    });
  }

  render() {
    const scene = this.app.scene;
    const scroll = this.root.scrollTop;
    this.root.textContent = '';

    const filter = this.filter;
    const matches = (e) => !filter
      || e.name.toLowerCase().includes(filter)
      || e.id.toLowerCase().includes(filter)
      || e.tags.some((t) => t.toLowerCase().includes(filter))
      || Object.keys(e.components).some((c) => c.includes(filter));

    const buildChildren = (parent) => {
      const kids = parent.children.filter((e) => e.enabled || e.hasComponent('render') || filter);
      for (const child of kids) {
        if (filter && !matches(child)) {
          // A filtered-out parent still shows its matching descendants, flattened.
          const deep = child.family().slice(1).filter(matches);
          if (deep.length) {
            for (const d of deep) this.root.appendChild(this._row(d, 1, true));
          }
          continue;
        }
        const hasKids = child.children.length > 0;
        const open = filter ? true : this.expanded.has(child.id);
        this.root.appendChild(this._row(child, 0, false, hasKids, open));
        if (hasKids && open) buildChildren(child);
      }
    };

    this.root.appendChild(this._row(scene.root, 0, false, true, true));
    buildChildren(scene.root);
    this.root.scrollTop = scroll;
  }

  _row(entity, depth, flattened, hasKids = false, open = false) {
    const app = this.app;
    const scene = app.scene;
    const selected = scene.selection.includes(entity);
    const isRoot = entity === scene.root;
    const render = entity.components.render;
    const visible = render ? render.visible !== false : true;
    const primary = primaryComponent(entity);
    const el = h('div', {
      class: `tree-row${selected ? ' is-selected' : ''}${entity.enabled ? '' : ' is-disabled'}`,
      dataset: { id: entity.id },
      draggable: isRoot ? 'false' : 'true',
      style: { paddingLeft: `${6 + depth * 13}px` },
      title: `${entity.name} — ${entity.id}${primary ? ` · ${primary}` : ''}`
    });

    const twisty = h('span', {
      class: `tree-twisty${hasKids ? '' : ' is-empty'}${open ? ' is-open' : ''}`,
      text: hasKids ? '▾' : '',
      onclick: (e) => {
        e.stopPropagation();
        if (!hasKids) return;
        if (this.expanded.has(entity.id)) this.expanded.delete(entity.id);
        else this.expanded.add(entity.id);
        this.render();
      }
    });

    const icon = h('span', { class: 'tree-icon', text: isRoot ? '◆' : (TYPE_ICON[primary] || '◇') });
    const label = h('span', { class: 'tree-label', text: entity.name });
    const tags = entity.tags.length ? h('span', { class: 'tree-tags', text: entity.tags.join(',') }) : null;
    const eye = isRoot ? null : h('button', {
      class: `tree-eye${visible ? '' : ' is-off'}`,
      type: 'button',
      title: 'Toggle visibility',
      text: visible ? '◉' : '○',
      onclick: (e) => {
        e.stopPropagation();
        if (render) {
          render.visible = !render.visible;
          app.markDirty(`Toggle ${entity.name} visibility`);
          app.renderer.invalidatePicking();
        } else {
          entity.enabled = !entity.enabled;
          app.markDirty(`Toggle ${entity.name}`);
        }
        this.render();
        app.requestRender();
      }
    });

    el.append(twisty, icon, label);
    if (tags) el.appendChild(tags);
    if (eye) el.appendChild(eye);

    el.addEventListener('pointerdown', (e) => {
      if (e.button === 2) return;
      if (e.shiftKey && this._lastClickedId) {
        const range = this._entitiesBetween(this._lastClickedId, entity.id);
        scene.setSelection(range);
      } else if (e.ctrlKey || e.metaKey) {
        scene.select(entity, { additive: true });
      } else {
        scene.select(entity);
      }
      this._lastClickedId = entity.id;
    });

    el.addEventListener('dblclick', (e) => {
      if (e.target.closest('.tree-eye')) return;
      this._startRename(el, label, entity);
    });

    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/lumen-entity', entity.id);
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('is-dragging');
    });
    el.addEventListener('dragend', () => el.classList.remove('is-dragging'));
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('is-drop-target');
    });
    el.addEventListener('dragleave', () => el.classList.remove('is-drop-target'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove('is-drop-target');
      const id = e.dataTransfer.getData('text/lumen-entity');
      if (!id) return;
      const dragged = scene.find(id);
      if (!dragged || dragged === entity) return;
      if (dragged.isDescendantOf(entity)) {
        this.app.log.warn('cannot parent an entity inside its own subtree');
        return;
      }
      this.app.reparent(dragged, entity);
    });

    void flattened;
    return el;
  }

  _entitiesBetween(fromId, toId) {
    const all = [];
    const walk = (e) => { all.push(e); e.children.forEach(walk); };
    walk(this.app.scene.root);
    const a = all.findIndex((e) => e.id === fromId);
    const b = all.findIndex((e) => e.id === toId);
    if (a < 0 || b < 0) return [];
    return all.slice(Math.min(a, b), Math.max(a, b) + 1);
  }

  _startRename(row, label, entity) {
    const input = h('input', { class: 'tree-rename', type: 'text', value: entity.name });
    label.replaceWith(input);
    input.focus();
    input.select();
    const finish = (commit) => {
      const v = input.value.trim();
      if (commit && v && v !== entity.name) {
        entity.name = v;
        this.app.markDirty(`Rename to "${v}"`);
      }
      this.render();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }

  _contextItems(entity) {
    const app = this.app;
    return [
      { label: 'Rename', run: () => {
        const row = this.root.querySelector(`[data-id="${entity.id}"] .tree-label`);
        if (row) this._startRename(row.parentElement, row, entity);
      } },
      { label: 'Duplicate', hint: 'Ctrl+D', run: () => app.duplicateSelection() },
      { label: 'Delete', hint: 'Del', run: () => app.deleteSelection() },
      { separator: true },
      { label: 'Group Selection', run: () => app.groupSelection() },
      { label: entity.enabled ? 'Disable' : 'Enable', run: () => {
        entity.enabled = !entity.enabled;
        app.markDirty(`${entity.enabled ? 'Enable' : 'Disable'} ${entity.name}`);
        this.render();
      } },
      { separator: true },
      { label: 'Focus', hint: 'F', run: () => app.focusSelection() },
      { label: 'Move To Root', run: () => app.reparent(entity, app.scene.root) }
    ];
  }
}

function primaryComponent(entity) {
  const keys = Object.keys(entity.components);
  if (!keys.length) return null;
  keys.sort((a, b) => componentOrder(a) - componentOrder(b));
  return keys[0];
}

export { defaultTags };
