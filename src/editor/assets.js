/**
 * Assets panel — folder tree, asset grid with live thumbnails, import queue.
 *
 * Material thumbnails are rendered by the engine itself (a real PBR sphere), so a
 * material card shows exactly what the material looks like in the scene. Texture
 * cards show the decoded image; model and volume cards fall back to an icon with
 * metadata. This is the same idea as the reference editor: the browser *is* the
 * asset viewer.
 */

import { h } from './widgets.js';
import { formatCount, formatBytes, debounce } from '../core/utils.js';
import { PROCEDURAL_KINDS } from '../scene/assets.js';
import { PRIMITIVES } from '../scene/primitives.js';
import { MATERIAL_PRESETS } from '../scene/material.js';

const TYPE_ICON = { material: '◐', texture: '▤', model: '◈', volume: '☁', script: '⌘', folder: '📁' };

export class AssetsPanel {
  constructor(app, { gridEl, foldersEl, countEl, dropEl, typeFilterEl }) {
    this.app = app;
    this.gridEl = gridEl;
    this.foldersEl = foldersEl;
    this.countEl = countEl;
    this.dropEl = dropEl;
    this.typeFilterEl = typeFilterEl;
    this.activeFolder = 'root';
    this.filter = '';
    this.typeFilter = '';
    this.expanded = new Set(['root']);

    this._onFilter = debounce(() => this.renderGrid(), 120);
    document.querySelector('[data-filter="assets"]')?.addEventListener('input', (e) => {
      this.filter = e.target.value.trim().toLowerCase();
      this._onFilter();
    });
    typeFilterEl?.addEventListener('change', (e) => {
      this.typeFilter = e.target.value;
      this.renderGrid();
    });

    this._bindDropTarget();
  }

  /* ---------------------------------------------------------------- drop */

  _bindDropTarget() {
    const target = document.getElementById('panelAssets');
    if (!target) return;
    let depth = 0;
    const over = document.getElementById('dropOverlay');
    target.addEventListener('dragenter', (e) => {
      if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
      e.preventDefault();
      depth++;
      this.dropEl.hidden = false;
      if (over) over.hidden = false;
    });
    target.addEventListener('dragover', (e) => {
      if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    target.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) { this.dropEl.hidden = true; if (over) over.hidden = true; }
    });
    target.addEventListener('drop', async (e) => {
      e.preventDefault();
      depth = 0;
      this.dropEl.hidden = true;
      if (over) over.hidden = true;
      const { filesFromDataTransfer } = await import('../core/utils.js');
      const files = await filesFromDataTransfer(e.dataTransfer);
      if (files.length) this.app.importFiles(files, this.activeFolder === 'root' ? null : this.activeFolder);
    });
  }

  /* -------------------------------------------------------------- render */

  render() {
    this.renderFolders();
    this.renderGrid();
  }

  renderFolders() {
    const store = this.app.assets;
    this.foldersEl.textContent = '';
    const tree = store.folderTree();
    const build = (node, depth) => {
      const el = h('div', {
        class: `folder-row${this.activeFolder === node.id ? ' is-active' : ''}`,
        style: { paddingLeft: `${6 + depth * 12}px` },
        onclick: () => { this.activeFolder = node.id; this.render(); },
        oncontextmenu: (e) => {
          e.preventDefault();
          this.app.showContextMenu(e.clientX, e.clientY, [
            { label: 'New Material', run: () => this.createMaterial() },
            { label: 'New Texture', run: () => this.showProceduralMenu(e) },
            { label: 'New Volume', run: () => this.createVolume() },
            { separator: true },
            { label: 'Rename Folder', disabled: node.id === 'root', run: () => this.app.promptText('Rename folder', node.name, (v) => store.renameFolder(node.id, v)) },
            { label: 'Delete Folder', disabled: node.id === 'root', run: () => { store.deleteFolder(node.id); this.activeFolder = 'root'; this.render(); } }
          ]);
        }
      }, [
        h('span', { class: 'folder-icon', text: '📁' }),
        h('span', { class: 'folder-name', text: node.name }),
        h('span', { class: 'folder-count', text: String(node.assetCount || 0) })
      ]);
      this.foldersEl.appendChild(el);
      for (const child of node.children || []) build(child, depth + 1);
    };
    for (const node of tree) build(node, 0);
  }

  renderGrid() {
    const store = this.app.assets;
    const scroll = this.gridEl.scrollTop;
    this.gridEl.textContent = '';
    const filter = this.filter;
    const list = [...store.assets.values()].filter((a) => {
      if (this.activeFolder !== 'root' && a.folder !== this.activeFolder && !isDescendantFolder(store, a.folder, this.activeFolder)) return false;
      if (this.typeFilter && a.type !== this.typeFilter) return false;
      if (filter && !a.name.toLowerCase().includes(filter)) return false;
      return true;
    });

    for (const asset of list) this.gridEl.appendChild(this._card(asset));
    this.countEl.textContent = String(store.count());
    this.gridEl.scrollTop = scroll;
  }

  _card(asset) {
    const selected = this.app.assets.selected === asset.id;
    const el = h('div', {
      class: `asset-card type-${asset.type}${selected ? ' is-selected' : ''}`,
      dataset: { id: asset.id },
      title: this._tooltip(asset),
      onclick: () => this.select(asset),
      ondblclick: () => this.use(asset),
      oncontextmenu: (e) => {
        e.preventDefault();
        this.select(asset);
        this.app.showContextMenu(e.clientX, e.clientY, this._contextItems(asset));
      },
      draggable: 'true',
      ondragstart: (e) => e.dataTransfer.setData('text/lumen-asset', asset.id)
    });

    const thumb = h('div', { class: 'asset-thumb' }, [h('span', { class: 'asset-icon', text: TYPE_ICON[asset.type] || '◇' })]);
    el.appendChild(thumb);
    el.appendChild(h('div', { class: 'asset-name', text: asset.name }));
    el.appendChild(h('div', { class: 'asset-meta', text: this._meta(asset) }));

    if (asset.type === 'material' && asset.material) {
      thumb.style.background = `linear-gradient(160deg, ${hexOf(asset.material.diffuse)}22, #0d1117)`;
      const canvas = h('canvas', { class: 'asset-preview', width: 96, height: 96 });
      thumb.appendChild(canvas);
      // Thumbnails are rendered lazily: only visible cards cost a draw.
      this._observe(thumb, canvas, asset);
    } else if (asset.type === 'texture' && asset.gpu?.source) {
      const img = h('canvas', { class: 'asset-preview', width: 96, height: 96 });
      thumb.appendChild(img);
      drawImageToCanvas(img, asset.gpu.source);
    }
    return el;
  }

  _observe(thumb, canvas, asset) {
    if (!this._io) {
      this._io = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const a = entry.target._asset;
          // The flag lives on the *element*, not on the asset: the grid is rebuilt
          // whenever the asset store changes (including after a context restore),
          // and a flag on the shared asset object would leave every rebuilt card
          // showing its placeholder glyph forever.
          if (!a || entry.target._thumbDone) continue;
          entry.target._thumbDone = true;
          try {
            this.app.renderer.renderMaterialPreview(a.material, entry.target.querySelector('canvas'), { size: 128 });
            // The rendered sphere is the icon now; leaving the glyph behind it
            // just shows through the corners of the canvas.
            entry.target.querySelector('.asset-icon')?.remove();
          } catch (e) {
            this.app.log.warn('thumbnail failed', e.message);
          }
        }
      }, { root: this.gridEl, rootMargin: '120px' });
    }
    thumb._asset = asset;
    this._io.observe(thumb);
  }

  _meta(asset) {
    switch (asset.type) {
      case 'material': return `${Math.round((asset.material?.metalness ?? 0) * 100)}% m · ${Math.round((asset.material?.roughness ?? 0) * 100)}% r`;
      case 'texture': return asset.width ? `${asset.width}×${asset.height}` : `${asset.size}px`;
      case 'model': return asset.triangles ? `${formatCount(asset.triangles)} tris` : `${asset.vertices || 0} verts`;
      case 'volume': return `${asset.size}³${asset.emulated ? ' (atlas)' : ''}`;
      case 'script': return 'script';
      default: return '';
    }
  }

  _tooltip(asset) {
    const lines = [`${asset.name} — ${asset.type}`];
    if (asset.type === 'material') {
      const m = asset.material;
      lines.push(`diffuse ${hexOf(m.diffuse)}`, `metalness ${m.metalness}`, `roughness ${m.roughness}`, `blend ${m.blend}`);
    }
    if (asset.type === 'model' && asset.gpu) {
      lines.push(`${asset.gpu.vertexCount} vertices · ${asset.gpu.triangleCount} triangles`);
      lines.push(`VRAM ${formatBytes(asset.gpu.vertexBuffer.byteLength + (asset.gpu.indices?.buffer.byteLength || 0))}`);
    }
    if (asset.type === 'texture') lines.push(`RGBA8 · ${asset.srgb === false ? 'linear' : 'sRGB'} · mipmapped`);
    if (asset.type === 'volume') lines.push(asset.emulated ? 'Emulated as a 2D tile atlas (no sampler3D in ES 1.00)' : 'Native TEXTURE_3D');
    return lines.join('\n');
  }

  _contextItems(asset) {
    return [
      { label: 'Rename', run: () => this.app.promptText('Rename asset', asset.name, (v) => { this.app.assets.rename(asset.id, v); this.render(); }) },
      { label: 'Duplicate', run: () => this.duplicate(asset) },
      { separator: true },
      { label: 'Create Entity', run: () => this.app.addEntityWithAsset(asset) },
      { label: 'Assign To Selection', run: () => this.app.assignAssetToSelection(asset) },
      { separator: true },
      { label: 'Export', run: () => this.app.exportAsset(asset) },
      { label: 'Delete', variant: 'danger', run: () => { this.app.assets.deleteAsset(asset.id); this.render(); this.app.renderer.invalidatePicking(); this.app.requestRender(); } }
    ];
  }

  /* ------------------------------------------------------------ actions */

  select(asset) {
    this.app.assets.selected = asset.id;
    this.renderGrid();
    if (asset.type === 'material') this.app.inspector.showAsset(asset);
    else this.app.inspector.showAsset(asset);
  }

  use(asset) {
    this.app.addEntityWithAsset(asset);
  }

  duplicate(asset) {
    if (asset.type !== 'material') return;
    const copy = asset.material.clone();
    const created = this.app.assets.add({ type: 'material', name: copy.name, material: copy });
    this.render();
    this.select(created);
  }

  createMaterial(preset = null) {
    const folder = this.activeFolder === 'root' ? null : this.activeFolder;
    const asset = this.app.assets.createMaterial(preset?.name || 'Material', preset);
    if (folder) asset.folder = folder;
    this.render();
    this.select(asset);
    this.app.log.info(`created material "${asset.name}"`);
  }

  createVolume() {
    const folder = this.activeFolder === 'root' ? null : this.activeFolder;
    const size = 32;
    const asset = this.app.assets.createVolume('Volume', size, (x, y, z) => {
      const d = Math.hypot(x - 0.5, y - 0.5, z - 0.5) * 2;
      const v = Math.max(0, 1 - d);
      return [v * 0.8, v * 0.85, v, v];
    });
    if (folder) asset.folder = folder;
    this.render();
    this.app.log.info(`created 32³ volume (${asset.emulated ? 'atlas fallback' : 'TEXTURE_3D'})`);
  }

  showProceduralMenu(e) {
    const items = PROCEDURAL_KINDS.map((k) => ({
      label: k.label,
      run: () => {
        const folder = this.activeFolder === 'root' ? null : this.activeFolder;
        const asset = this.app.assets.createProceduralTexture(k.label, k.id, 256);
        if (folder) asset.folder = folder;
        this.render();
        this.app.requestRender();
      }
    }));
    this.app.showContextMenu(e.clientX, e.clientY, items);
  }

  renderTasks() {
    // The task strip mirrors the store's queue; the store is the source of truth.
    const tasks = this.app.assets.tasks.slice(0, 6);
    let strip = document.getElementById('assetTasks');
    if (!tasks.length) { strip?.remove(); return; }
    if (!strip) {
      strip = h('div', { class: 'asset-tasks', id: 'assetTasks' });
      this.gridEl.parentElement.appendChild(strip);
    }
    strip.textContent = '';
    strip.appendChild(h('span', { class: 'at-title', text: 'ASSET TASKS' }));
    for (const t of tasks) {
      strip.appendChild(h('div', { class: `at-item is-${t.state}` }, [
        h('span', { class: 'at-name', text: t.name }),
        h('span', { class: 'at-state', text: t.state })
      ]));
    }
  }
}

/* ---------------------------------------------------------------- utils */

function hexOf(c) {
  const b = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  return `#${b(c[0])}${b(c[1])}${b(c[2])}`;
}

function drawImageToCanvas(canvas, source) {
  try {
    if (source instanceof HTMLImageElement || source instanceof HTMLCanvasElement || source instanceof ImageBitmap) {
      const g = canvas.getContext('2d');
      const s = Math.min(source.width, source.height);
      g.drawImage(source, (source.width - s) / 2, (source.height - s) / 2, s, s, 0, 0, canvas.width, canvas.height);
    }
  } catch { /* not drawable yet */ }
}

function isDescendantFolder(store, folderId, ancestorId) {
  let f = store.folders.get(folderId);
  while (f) {
    if (f.id === ancestorId) return true;
    f = store.folders.get(f.parent);
  }
  return false;
}

export { PRIMITIVES, MATERIAL_PRESETS };
