/**
 * Application: wires the engine, the editor panels, the command registry and the
 * frame loop together. Everything the user can do is a registered command, so the
 * top bar, the rail, the palette, the context menus and the keyboard all funnel
 * through one dispatch table.
 */

import { GLContext } from '../gl/context.js';
import { featureMap } from '../gl/capabilities.js';
import { Renderer, DEBUG_VIEWS } from '../render/renderer.js';
import { AssetStore } from '../scene/assets.js';
import { Scene } from '../scene/scene.js';
import { Entity } from '../scene/entity.js';
import { createComponent, COMPONENT_SCHEMA, LAYER_DEFS, migrateComponent } from '../scene/components.js';
import { Material, MATERIAL_PRESETS } from '../scene/material.js';
import { primitiveGeometry, PRIMITIVES } from '../scene/primitives.js';
import { CommandRegistry, normalizeCombo, comboFromEvent } from '../core/commands.js';
import { History } from '../core/history.js';
import { storage } from '../core/storage.js';
import { log } from '../core/logger.js';
import * as util from '../core/utils.js';

const { formatBytes, uid } = util;
import { clamp, vec3, aabb } from '../core/math.js';
import { Gizmo, GIZMO_MODE } from './gizmo.js';
import { Viewport } from './viewport.js';
import { HierarchyPanel } from './hierarchy.js';
import { Inspector } from './inspector.js';
import { AssetsPanel } from './assets.js';
import { ConsolePanel, StatsPanel } from './console.js';
import { Palette, ModalHost, ContextMenu, Tooltip, buildShortcutSheet } from './overlays.js';
import { buildDemoScene } from '../scenes/demo.js';
import { writeOBJ } from '../loaders/obj.js';

const AUTOSAVE_INTERVAL = 20000;
const AUTOSAVE_KEY = 'autosave';

export class App {
  constructor({ canvas, log: logger = log } = {}) {
    this.util = util;
    this.log = logger;
    this.canvas = canvas;

    this.ctx = new GLContext(canvas, { log: this.log, antialias: true });
    this.renderer = new Renderer(this.ctx, this.log);
    this.renderer.assets = this.assets = new AssetStore(this.ctx, this.log);
    this.scene = new Scene('Untitled');

    this.commands = new CommandRegistry(this);
    this.history = new History({
      snapshot: () => this.snapshot(),
      restore: (state) => this.restore(state)
    });

    this.scene.setMeshResolver((id) => this.assets.get(id)?.gpu || null);

    this.gizmo = new Gizmo(this);
    this.viewport = new Viewport(this, canvas);
    this.hierarchy = new HierarchyPanel(this, document.getElementById('hierarchyTree'));
    this.inspector = new Inspector(this, document.getElementById('inspectorBody'), document.getElementById('inspectorTitle'));
    this.assetsPanel = new AssetsPanel(this, {
      gridEl: document.getElementById('assetGrid'),
      foldersEl: document.getElementById('assetFolders'),
      countEl: document.getElementById('assetCount'),
      dropEl: document.getElementById('assetDrop'),
      typeFilterEl: document.getElementById('assetTypeFilter')
    });
    this.console = new ConsolePanel(this, {
      bodyEl: document.getElementById('consoleBody'),
      formEl: document.getElementById('consoleForm'),
      inputEl: document.getElementById('consoleInput'),
      filterEl: document.getElementById('consoleFilter')
    });
    this.stats = new StatsPanel(this, document.getElementById('statsPanel'));
    this.palette = new Palette(this, {
      scrimEl: document.getElementById('paletteScrim'),
      inputEl: document.getElementById('paletteInput'),
      listEl: document.getElementById('paletteList')
    });
    this.modals = new ModalHost(this, {
      scrimEl: document.getElementById('modalScrim'),
      modalEl: document.getElementById('modal')
    });
    this.ctxMenu = new ContextMenu(this, document.getElementById('ctxMenu'));
    this.tooltip = new Tooltip(document.getElementById('tooltip'));

    this.running = false;
    this.presentMode = false;
    this._needsRender = true;
    this._lastTime = performance.now();
    this._accum = 0;
    this._transformSnapshot = null;
    this.projectId = null;
    this.serverOnline = false;

    this._wireScene();
    this._registerCommands();
    this._bindGlobalEvents();
    this._bindUI();
    this._initLayout();
  }

  /* ------------------------------------------------------------ bootstrap */

  async start({ demo = true } = {}) {
    this.log.info(`Lumen Studio — ${this.ctx.caps.isWebGL2 ? 'WebGL 2.0 / GLSL ES 3.00' : 'WebGL 1.0 / GLSL ES 1.00'}`);
    this.log.info(`adapter: ${this.ctx.caps.renderer}`);
    this.log.info(`tier: ${this.ctx.caps.tier.name} (score ${this.ctx.caps.tier.score})`);
    this.renderer.assets = this.assets;
    this.applySceneSettings();

    this.seedAssets();
    if (demo) buildDemoScene(this);
    else this.scene = Scene.fromJSON(storage.get(AUTOSAVE_KEY) || this.scene.toJSON());
    // The scene may have replaced the environment wholesale (sky, exposure, fog) —
    // push it into the renderer before the first frame, or the IBL is built from
    // the defaults and the picture does not match the document.
    this.scene.setMeshResolver((id) => this.assets.get(id)?.gpu || null);
    this.applySceneSettings();

    this.history.reset();
    this.refreshAll();
    this.serverOnline = await storage.ping();
    storage.connectEvents();
    this.updateStatus();
    this.running = true;
    this._lastTime = performance.now();
    requestAnimationFrame((t) => this._frame(t));
    setInterval(() => this.autosave(), AUTOSAVE_INTERVAL);
    this.log.info('editor ready — press ⌘K for the command palette, ? for shortcuts');
  }

  seedAssets() {
    // A small starter library: the project is usable the moment it opens.
    // The default material is a dark, glossy floor on purpose — it is the surface
    // every new primitive lands on, and a mid-grey one makes a whole scene look
    // washed out before the user has touched anything.
    const car = this.assets.createMaterial('Showroom Floor', {
      diffuse: [0.035, 0.038, 0.045, 1], metalness: 0.6, roughness: 0.14
    });
    const paint = this.assets.createMaterial('Car Paint', {
      diffuse: [0.09, 0.14, 0.2, 1], metalness: 0.85, roughness: 0.32
    });
    const glass = this.assets.createMaterial('Glass', {
      diffuse: [0.06, 0.09, 0.12, 1], metalness: 0, roughness: 0.06, opacity: 0.34, blend: 'normal', cull: 'none', specular: 1
    });
    const rubber = this.assets.createMaterial('Tyre', {
      diffuse: [0.05, 0.05, 0.06, 1], roughness: 0.85, specular: 0.25
    });
    const chrome = this.assets.createMaterial('Chrome', {
      diffuse: [0.92, 0.93, 0.95, 1], metalness: 1, roughness: 0.08
    });
    const plastic = this.assets.createMaterial('Plastic', {
      diffuse: [0.12, 0.12, 0.14, 1], roughness: 0.45
    });
    const neon = this.assets.createMaterial('Neon Emissive', {
      diffuse: [0.02, 0.02, 0.03, 1], emissive: [0.0, 0.75, 1.0], emissiveIntensity: 8, roughness: 0.3
    });
    this.assets.createProceduralTexture('Checker', 'checker', 256);
    this.assets.createProceduralTexture('Grid', 'grid', 256);
    this.assets.createProceduralTexture('Bump', 'normalBump', 256);
    this.assets.createProceduralTexture('Roughness', 'mrRough', 256);
    this.assets.createMaterial();
    this.defaults = { car, paint, glass, rubber, chrome, plastic, neon };
    this.assets.createModel('Box', primitiveGeometry('box'), { primitive: 'box' });
    this.assets.createModel('Sphere', primitiveGeometry('sphere', { segments: 32, rings: 20 }), { primitive: 'sphere' });
    this.assets.createModel('Cylinder', primitiveGeometry('cylinder', { segments: 24 }), { primitive: 'cylinder' });
  }

  /* ------------------------------------------------------------- wiring */

  _wireScene() {
    this.scene.on('selection', (sel) => {
      this.hierarchy.render();
      this.inspector.showEntity(sel[0] || null);
      if (!sel.length) this.inspector.render();
      this.inspector.update();
      this.updateStatus();
      this.requestRender();
    });
    this.scene.on('change', () => {
      this.renderer.invalidatePicking();
      this.updateStatus();
    });
    this.assets.on('change', () => {
      this.renderer.invalidatePicking();
      this.assetsPanel.render();
    });
    this.assets.on('task', () => this.assetsPanel.renderTasks());
    this.ctx.on('contextlost', (e) => this._onContextLost(e));
    this.ctx.on('contextrestored', (e) => this._onContextRestored(e));
    this.ctx.on('resize', () => {
      this.renderer.resize(this.ctx.width, this.ctx.height);
      this.requestRender();
    });
  }

  _bindGlobalEvents() {
    window.addEventListener('keydown', (e) => this._onKeyDown(e), false);
    window.addEventListener('keyup', (e) => this.viewport.keys.delete(e.key.toLowerCase()), false);
    window.addEventListener('blur', () => this.viewport.keys.clear());
    window.addEventListener('resize', () => {
      this.viewport.markResized();
      this._applyViewportSize();
    });
    window.addEventListener('beforeunload', (e) => {
      if (this.scene.dirty) {
        this.autosave();
        e.preventDefault();
        e.returnValue = '';
      }
    });
    // Global file drop.
    const overlay = document.getElementById('dropOverlay');
    window.addEventListener('dragover', (e) => { e.preventDefault(); });
    window.addEventListener('drop', async (e) => {
      e.preventDefault();
      if (overlay) overlay.hidden = true;
      const { filesFromDataTransfer } = await import('../core/utils.js');
      const files = await filesFromDataTransfer(e.dataTransfer);
      if (files.length) this.importFiles(files);
    });
    window.addEventListener('dragenter', (e) => {
      if ([...(e.dataTransfer?.types || [])].includes('Files') && overlay) overlay.hidden = false;
    });
    window.addEventListener('dragleave', (e) => {
      if (e.relatedTarget === null && overlay) overlay.hidden = true;
    });
  }

  _bindUI() {
    document.addEventListener('click', (e) => {
      const el = e.target.closest('[data-cmd]');
      if (!el) return;
      e.preventDefault();
      this.commands.run(el.dataset.cmd);
    });
    document.getElementById('sceneName')?.addEventListener('change', (e) => {
      this.scene.name = e.target.value.trim() || 'Untitled';
      this.markDirty('Rename scene');
    });
    document.querySelectorAll('.rail-btn[data-tool]').forEach((btn) => {
      btn.addEventListener('click', () => this.setTool(btn.dataset.tool));
    });
    this.canvas.addEventListener('keydown', (e) => e.stopPropagation());
  }

  _initLayout() {
    const state = storage.get('layout', { left: 280, right: 320, bottom: 240, dock: 380, assets: true, console: true });
    this.layout = state;
    this._applyLayout(state);
    document.querySelectorAll('.splitter').forEach((sp) => this._initSplitter(sp));
    // Element-level resize observer: the canvas box changes on splitter drags,
    // panel toggles and window resizes alike, and none of those are guaranteed to
    // come with a window `resize` event. It also fires once on observe, which is
    // what corrects the very first measure, taken before the grid is resolved.
    if (typeof ResizeObserver === 'function') {
      this._resizeObserver = new ResizeObserver(() => this._applyViewportSize());
      this._resizeObserver.observe(this.canvas);
    }
    this._applyViewportSize();
  }

  _applyLayout(state) {
    const root = document.documentElement;
    root.style.setProperty('--left-w', `${state.left}px`);
    root.style.setProperty('--right-w', `${state.right}px`);
    root.style.setProperty('--bottom-h', `${state.bottom}px`);
    root.style.setProperty('--console-w', `${state.dock}px`);
    document.getElementById('panelAssets')?.classList.toggle('is-hidden', !state.assets);
    document.getElementById('panelConsole')?.classList.toggle('is-hidden', !state.console);
    document.querySelector('.app')?.classList.toggle('is-console-collapsed', !state.console);
    document.getElementById('splitter-bottom')?.classList.toggle('is-hidden', !state.assets && !state.console);
    this._applyViewportSize();
  }

  _initSplitter(sp) {
    const dir = sp.dataset.split;
    sp.addEventListener('pointerdown', (e) => {
      sp.setPointerCapture(e.pointerId);
      const start = { x: e.clientX, y: e.clientY, ...this.layout };
      const move = (ev) => {
        if (dir === 'left') this.layout.left = clamp(start.left + (ev.clientX - start.x), 180, 520);
        if (dir === 'right') this.layout.right = clamp(start.right - (ev.clientX - start.x), 220, 560);
        if (dir === 'bottom') this.layout.bottom = clamp(start.bottom - (ev.clientY - start.y), 120, window.innerHeight - 200);
        if (dir === 'dock') this.layout.dock = clamp(start.dock - (ev.clientX - start.x), 220, window.innerWidth - 500);
        this._applyLayout(this.layout);
      };
      const up = () => {
        sp.removeEventListener('pointermove', move);
        sp.removeEventListener('pointerup', up);
        storage.set('layout', this.layout);
      };
      sp.addEventListener('pointermove', move);
      sp.addEventListener('pointerup', up);
    });
    sp.addEventListener('dblclick', () => {
      if (dir === 'left') this.layout.left = 280;
      if (dir === 'right') this.layout.right = 320;
      if (dir === 'bottom') this.layout.bottom = 240;
      if (dir === 'dock') this.layout.dock = 380;
      this._applyLayout(this.layout);
      storage.set('layout', this.layout);
    });
  }

  _applyViewportSize() {
    this.viewport.markResized();
    this.viewport.syncSize();
    this._syncBackingStore();
  }

  /**
   * The canvas box is decided by the editor layout — grid columns, splitters and
   * collapsible panels — so a window `resize` event is never enough: dragging a
   * splitter changes the element box without resizing the window. Everything
   * downstream (render targets, the id buffer, bloom chain) is sized in device
   * pixels from this box, so it has to be re-synced whenever it changes, or the
   * frame is rendered at the stale size and stretched to fit.
   */
  _syncBackingStore() {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;   // not laid out yet
    if (this.ctx.cssWidth === rect.width && this.ctx.cssHeight === rect.height) return false;
    this.ctx.resize(rect.width, rect.height);
    this.renderer.resize(this.ctx.width, this.ctx.height);
    this._needsRender = true;
    return true;
  }

  /* ------------------------------------------------------------- frame */

  _frame(now) {
    if (!this.running) return;
    requestAnimationFrame((t) => this._frame(t));

    const dt = Math.min((now - this._lastTime) / 1000, 0.1);
    this._lastTime = now;

    this.viewport.fps(dt);
    this.stats.sample(dt * 1000);
    this.viewport.stepFocusTween(dt);
    // Always sync: the orbit state (target/distance/yaw/pitch) is authoritative and
    // the matrices have to follow it even when no key is held.
    this.viewport.updateCamera(dt);
    if (this.viewport.syncSize()) this._needsRender = true;
    // Poll the element box as a safety net for layout changes that fire no event
    // at all (CSS transitions, web fonts reflowing, restored scroll positions).
    this._syncBackingStore();

    // The editor is event driven: it renders when something changed, and keeps a
    // low-rate heartbeat so lights/animations and the stats overlay stay live.
    const interactive = this.viewport.mode !== null || this.gizmo.drag;
    this._accum += dt;
    if (this._needsRender || interactive || this._accum > 0.25) {
      this._accum = 0;
      this._needsRender = false;
      this.renderNow();
    }

    this.stats.update();
    this.viewport.drawAxisWidget();
    this._updateStatusBar();
  }

  renderNow() {
    this.renderer.render(this.scene, this.viewport.camera, {
      dt: 1 / 60,
      assets: this.assets,
      selection: this.scene.selection,
      hover: this.scene.hover,
      helpers: [...this.scene.lights, ...this.scene.cameras],
      gizmos: { draw: (batch, camera) => this.gizmo.draw(batch, camera, this.renderer, this.viewport.height) }
    });
  }

  requestRender() { this._needsRender = true; }

  /* ------------------------------------------------------- scene editing */

  snapshot() { return this.scene.toJSON(); }

  restore(state) {
    const selIds = this.scene.selection.map((e) => e.id);
    this.scene = Scene.fromJSON(state);
    this.scene.setMeshResolver((id) => this.assets.get(id)?.gpu || null);
    this.scene.removeAll();
    this.scene.on('selection', (sel) => {
      this.hierarchy.render();
      this.inspector.showEntity(sel[0] || null);
      this.inspector.render();
      this.updateStatus();
      this.requestRender();
    });
    this.scene.on('change', () => { this.renderer.invalidatePicking(); });
    this._restoring = true;
    this.scene.setSelection(selIds.map((id) => this.scene.find(id)).filter(Boolean));
    this._restoring = false;
    this.renderer.invalidatePicking();
    this.refreshAll();
  }

  markDirty(label = 'Edit', { coalesce = null, live = false, skipIfSame = true } = {}) {
    this.scene.touch(label);
    this.history.push(label, { coalesce: live ? coalesce : null, skipIfSame });
    if (live) this.inspector.update();
    this.updateStatus();
    this.requestRender();
  }

  beginTransform() {
    this._transformSnapshot = this.snapshot();
  }

  endTransform(result) {
    if (!this._transformSnapshot) return;
    this.scene.touch('Transform');
    this.history.push(result?.label ? `Transform (${result.label})` : 'Transform', {
      state: this.snapshot(),
      skipIfSame: false
    });
    this._transformSnapshot = null;
    this.inspector.render();
    this.updateStatus();
  }

  isDragging() { return !!this.gizmo.drag || this.viewport.mode !== null; }

  select(entity, additive = false) {
    if (!entity) { this.scene.clearSelection(); return; }
    this.scene.select(entity, { additive });
  }

  selectAt(entity, additive = false) {
    if (!entity) {
      if (!additive) this.scene.clearSelection();
      return;
    }
    this.scene.select(entity, { additive });
    this.hierarchy.render();
  }

  /**
   * Renderables worth framing: geometry the user can actually see. A volume's
   * bounds mesh is a ray-marching proxy (it exists to bound the fog, not to be
   * looked at) and fully transparent materials draw nothing, so including either
   * would frame an empty box several times larger than the visible content.
   */
  _framingTargets() {
    return this.scene.renderables.filter((e) => {
      if (e.components.volume) return false;
      const mat = this.assets.get(e.components.render?.material)?.material;
      return !mat || (mat.opacity !== 0 && mat.blend !== 'none');
    });
  }

  focusSelection() {
    const sel = this.scene.selection;
    if (!sel.length) {
      const all = this._framingTargets();
      if (all.length) this.viewport.focusBox(Entity.unionBounds(all));
      return;
    }
    this.viewport.focusBox(Entity.unionBounds(sel));
  }

  addEntity(type, data = {}) {
    const parent = this.scene.selection.find((e) => e.isContainer) || this.scene.root;
    const entity = new Entity({
      name: this.scene.uniqueName(data.name || type),
      position: data.position || [0, 0, 0],
      rotation: data.rotation || [0, 0, 0],
      scale: data.scale || [1, 1, 1]
    });
    if (type === 'group') {
      entity.isContainer = true;
    } else {
      entity.addComponent(type, migrateComponent(type, data.component || createComponent(type)));
    }
    this.scene.add(entity, parent);
    this.scene.select(entity);
    this.markDirty(`Add ${type}`);
    this.hierarchy.render();
    this.inspector.render();
    return entity;
  }

  addPrimitive(kind) {
    const geoAsset = this._ensureModel(kind);
    const matAsset = this.assets.byType('material')[0];
    const render = migrateComponent('render', {
      mesh: geoAsset.id,
      material: matAsset?.id || null
    });
    return this.addEntity('render', {
      name: PRIMITIVES[kind]?.label || kind,
      component: render
    });
  }

  _ensureModel(kind) {
    const existing = this.assets.byType('model').find((a) => a.primitive === kind);
    if (existing) return existing;
    return this.assets.createModel(PRIMITIVES[kind]?.label || kind, primitiveGeometry(kind), { primitive: kind });
  }

  addEntityWithAsset(asset) {
    if (asset.type === 'model') {
      const mat = this.assets.byType('material')[0];
      return this.addEntity('render', {
        name: asset.name,
        component: migrateComponent('render', { mesh: asset.id, material: mat?.id || null })
      });
    }
    if (asset.type === 'material') {
      const e = this.addPrimitive('box');
      e.components.render.material = asset.id;
      this.markDirty(`Assign ${asset.name}`);
      this.inspector.render();
      return e;
    }
    this.log.warn(`"${asset.name}" (${asset.type}) cannot become an entity directly`);
    return null;
  }

  addEntityWithMesh(meshAssetId, name) {
    const mat = this.assets.byType('material')[0];
    return this.addEntity('render', {
      name: name || 'Model',
      component: migrateComponent('render', { mesh: meshAssetId, material: mat?.id || null })
    });
  }

  duplicateSelection() {
    const sel = this.scene.selection;
    if (!sel.length) return;
    const created = [];
    for (const e of sel) {
      const copy = e.clone();
      copy.name = this.scene.uniqueName(e.name.replace(/ copy$/, ''));
      e.parent ? e.parent.addChild(copy) : this.scene.root.addChild(copy);
      created.push(copy);
    }
    this.scene.setSelection(created);
    this.markDirty(`Duplicate ${sel.length} entity${sel.length > 1 ? 'ies' : ''}`);
    this.hierarchy.render();
    this.inspector.render();
  }

  deleteSelection() {
    const sel = this.scene.selection;
    if (!sel.length) return;
    for (const e of sel) this.scene.remove(e);
    this.scene.clearSelection();
    this.markDirty(`Delete ${sel.length} entity${sel.length > 1 ? 'ies' : ''}`);
    this.hierarchy.render();
    this.inspector.render();
    this.requestRender();
  }

  groupSelection() {
    const sel = this.scene.selection;
    if (!sel.length) return;
    const parent = sel[0].parent || this.scene.root;
    const group = new Entity({ name: this.scene.uniqueName('Group') });
    parent.addChild(group);
    for (const e of sel) {
      if (e === group) continue;
      group.addChild(e);
    }
    this.scene.select(group);
    this.markDirty('Group selection');
    this.hierarchy.render();
    this.inspector.render();
  }

  reparent(entity, newParent) {
    if (!entity || !newParent || entity === newParent) return;
    if (entity.isDescendantOf(newParent)) {
      this.log.warn('invalid reparent: cycle');
      return;
    }
    newParent.addChild(entity);
    this.markDirty(`Move ${entity.name}`);
    this.hierarchy.render();
  }

  /* ------------------------------------------------------------ settings */

  applySceneSettings() {
    const s = this.scene.settings;
    const r = this.renderer.settings;
    Object.assign(r, {
      exposure: s.render.exposure,
      toneMapping: s.render.toneMapping,
      bloom: s.render.bloom && this.ctx.caps.tier.budget.bloom,
      bloomStrength: s.render.bloomStrength,
      ssao: s.render.ssao && !!this.ctx.caps.limits.depthTexture,
      fxaa: s.render.fxaa,
      grain: s.render.grain,
      vignette: s.render.vignette,
      contrast: s.render.contrast,
      saturation: s.render.saturation,
      fog: s.render.fog,
      fogColor: s.render.fogColor,
      fogDensity: s.render.fogDensity,
      ambient: s.render.ambient,
      ambientIntensity: s.render.ambientIntensity,
      grid: s.render.grid,
      gridCell: s.render.gridCell,
      gridOpacity: s.render.gridOpacity
    });
    if (this.ibl) this.ibl.setSky(s.sky);
    else this.renderer.ibl.setSky(s.sky);
    this.renderer.invalidatePicking();
  }

  setSkyPreset(name) {
    const presets = {
      noon: { zenith: [0.16, 0.34, 0.68], horizon: [0.68, 0.78, 0.9], ground: [0.2, 0.2, 0.22], sunIntensity: 12, turbidity: 1, exposure: 1, iblIntensity: 1 },
      sunset: { zenith: [0.13, 0.18, 0.42], horizon: [0.95, 0.5, 0.28], ground: [0.16, 0.13, 0.12], sunIntensity: 8, turbidity: 2.4, exposure: 1.1, iblIntensity: 1.1 },
      overcast: { zenith: [0.55, 0.58, 0.63], horizon: [0.7, 0.72, 0.75], ground: [0.3, 0.3, 0.32], sunIntensity: 2.4, turbidity: 3.2, exposure: 1, iblIntensity: 1.2 },
      night: { zenith: [0.01, 0.015, 0.04], horizon: [0.03, 0.04, 0.07], ground: [0.01, 0.01, 0.02], sunIntensity: 0.35, turbidity: 1, exposure: 1.4, iblIntensity: 0.6 }
    };
    const p = presets[name];
    if (!p) return;
    Object.assign(this.scene.settings.sky, p);
    this.applySceneSettings();
    this.markDirty(`Sky preset: ${name}`);
    this.inspector.render();
  }

  setTool(tool) {
    if (tool === 'select') {
      this.gizmo.setVisible(false);
    } else {
      this.gizmo.setMode(tool);
      this.gizmo.setVisible(true);
    }
    document.querySelectorAll('.rail-btn[data-tool]').forEach((b) => b.classList.toggle('is-active', b.dataset.tool === tool));
    this.canvas.style.cursor = tool === 'select' ? 'default' : 'grab';
    this.requestRender();
  }

  /* ------------------------------------------------------------ commands */

  _registerCommands() {
    const c = this.commands;
    c.registerAll({
      // ---- file
      'file.new': { title: 'New Scene', category: 'File', keys: 'Ctrl+N', run: () => this.newScene() },
      'file.open': { title: 'Open Project…', category: 'File', keys: 'Ctrl+O', run: () => this.openProject() },
      'file.save': { title: 'Save Project', category: 'File', keys: 'Ctrl+S', run: () => this.saveProject() },
      'file.export': { title: 'Export…', category: 'File', run: (app, anchor) => this.showExportMenu(anchor) },
      'file.import': { title: 'Import Models / Textures…', category: 'File', run: () => this.importFiles() },

      // ---- edit
      'edit.undo': { title: 'Undo', category: 'Edit', keys: 'Ctrl+Z', run: () => { this.history.undo(); this.log.info('undo'); } },
      'edit.redo': { title: 'Redo', category: 'Edit', keys: 'Ctrl+Shift+Z', run: () => { this.history.redo(); this.log.info('redo'); } },
      'edit.duplicate': { title: 'Duplicate', category: 'Edit', keys: 'Ctrl+D', run: () => this.duplicateSelection() },
      'edit.delete': { title: 'Delete', category: 'Edit', keys: 'Delete', run: () => this.deleteSelection() },
      'edit.group': { title: 'Group Selection', category: 'Edit', keys: 'Ctrl+G', run: () => this.groupSelection() },
      'edit.selectAll': { title: 'Select All', category: 'Edit', keys: 'Ctrl+A', run: () => this.scene.setSelection(this.scene.renderables) },
      'edit.selectNone': { title: 'Deselect All', category: 'Edit', keys: 'Escape', run: () => this.scene.clearSelection() },
      'edit.freeze': { title: 'Freeze Transform', category: 'Edit', run: () => this.freezeTransforms() },

      // ---- hierarchy
      'hierarchy.add': { title: 'Add Entity…', category: 'Entity', run: (app, anchor) => this.showAddEntityMenu(anchor) },
      'hierarchy.duplicate': { title: 'Duplicate Entity', category: 'Entity', run: () => this.duplicateSelection() },
      'hierarchy.delete': { title: 'Delete Entity', category: 'Entity', run: () => this.deleteSelection() },
      'hierarchy.focus': { title: 'Frame Selection', category: 'Entity', keys: 'F', run: () => this.focusSelection() },
      'hierarchy.rename': {
        title: 'Rename Entity', category: 'Entity', run: async () => {
          const e = this.scene.selection[0];
          if (!e) return;
          const v = await this.modals.prompt('Rename entity', e.name);
          if (v) { e.name = v; this.markDirty('Rename'); this.hierarchy.render(); }
        }
      },

      // ---- view
      'view.play': { title: 'Present (hide UI)', category: 'View', keys: 'F11', run: () => this.togglePresent() },
      'view.screenshot': { title: 'Capture PNG', category: 'View', keys: 'P', run: () => this.viewport.screenshot(`${this.scene.name}.png`) },
      'view.perspective': { title: 'Perspective View', category: 'View', run: () => this.setProjection('perspective') },
      'view.ortho': { title: 'Orthographic View', category: 'View', run: () => this.setProjection('orthographic') },
      'view.grid': { title: 'Toggle Grid', category: 'View', keys: 'G', run: () => this.toggleGrid() },
      'view.zoomFit': { title: 'Zoom to Fit', category: 'View', keys: 'Z', run: () => { const all = this._framingTargets(); if (all.length) this.viewport.focusBox(Entity.unionBounds(all)); } },
      'view.cameraList': { title: 'Switch Camera', category: 'View', run: (app, anchor) => this.showCameraMenu(anchor) },
      'view.presets': { title: 'Camera Preset…', category: 'View', run: (app, anchor) => this.showViewPresetMenu(anchor) },

      // ---- gizmo
      'gizmo.toggle': { title: 'Toggle Gizmo', category: 'Tool', keys: 'X', run: () => { this.gizmo.setVisible(!this.gizmo.visible); this.requestRender(); } },
      'gizmo.space': { title: 'Gizmo Space (World/Local)', category: 'Tool', run: () => { const s = this.gizmo.toggleSpace(); this.setStatus(`gizmo: ${s}`); this.requestRender(); } },
      'gizmo.pivot': { title: 'Pivot: Selection Centre', category: 'Tool', run: () => { this.gizmo.pivotMode = this.gizmo.pivotMode === 'pivot' ? 'center' : 'pivot'; this.setStatus(`pivot: ${this.gizmo.pivotMode}`); this.requestRender(); } },
      'edit.snap': { title: 'Toggle Snapping', category: 'Tool', run: () => { const on = this.gizmo.toggleSnap(); this.setStatus(`snap: ${on ? 'on' : 'off'}`); this.requestRender(); } },
      'edit.snapSettings': { title: 'Snapping Settings…', category: 'Tool', run: () => this.showSnapDialog() },

      // ---- render / debug
      'render.debug': { title: 'Cycle Debug View', category: 'Render', run: () => this.cycleDebugView() },
      'render.debugMenu': { title: 'Debug View…', category: 'Render', run: (app, anchor) => this.showDebugMenu(anchor) },
      'render.toggleShadows': { title: 'Toggle Shadows', category: 'Render', run: () => { const v = !this.renderer.settings.showShadows; this.renderer.setSetting('showShadows', v); this.setStatus(`shadows: ${v ? 'on' : 'off'}`); this.requestRender(); } },
      'render.toggleBloom': { title: 'Toggle Bloom', category: 'Render', run: () => { this.scene.settings.render.bloom = !this.scene.settings.render.bloom; this.applySceneSettings(); this.markDirty('Toggle bloom'); } },
      'render.toggleSsao': { title: 'Toggle SSAO', category: 'Render', run: () => { this.scene.settings.render.ssao = !this.scene.settings.render.ssao; this.applySceneSettings(); this.markDirty('Toggle SSAO'); } },
      'render.toggleFxaa': { title: 'Toggle FXAA', category: 'Render', run: () => { this.scene.settings.render.fxaa = !this.scene.settings.render.fxaa; this.applySceneSettings(); this.markDirty('Toggle FXAA'); } },
      'render.exposureUp': { title: 'Exposure +', category: 'Render', run: () => this.bumpExposure(0.1) },
      'render.exposureDown': { title: 'Exposure −', category: 'Render', run: () => this.bumpExposure(-0.1) },
      'render.resetView': { title: 'Reset Post Processing', category: 'Render', run: () => { Object.assign(this.scene.settings.render, { exposure: 1, bloomStrength: 0.05, contrast: 1, saturation: 1, vignette: 0.32, grain: 0.012 }); this.applySceneSettings(); this.markDirty('Reset post'); this.inspector.render(); } },
      'render.shadowResolution': { title: 'Shadow Map Size…', category: 'Render', run: (app, anchor) => this.showShadowResMenu(anchor) },

      // ---- assets
      'assets.import': { title: 'Import Files…', category: 'Assets', run: () => this.importFiles() },
      'assets.newMaterial': { title: 'New Material…', category: 'Assets', run: (app, anchor) => this.showNewMaterialMenu(anchor) },
      'assets.newTexture': { title: 'New Procedural Texture…', category: 'Assets', run: (app, anchor) => this.assetsPanel.showProceduralMenu({ clientX: anchor?.x ?? 400, clientY: anchor?.y ?? 400 }) },
      'assets.newVolume': { title: 'New Volume', category: 'Assets', run: () => { this.assetsPanel.createVolume(); this.assetsPanel.render(); } },
      'assets.newModel': { title: 'New Primitive Model…', category: 'Assets', run: (app, anchor) => this.showPrimitiveModelMenu(anchor) },
      'assets.delete': { title: 'Delete Selected Asset', category: 'Assets', run: () => { const a = this.assets.get(this.assets.selected); if (a) { this.assets.deleteAsset(a.id); this.assetsPanel.render(); } } },

      // ---- editor
      'stats.toggle': { title: 'Statistics', category: 'Editor', run: () => this.stats.toggle() },
      'editor.capabilities': { title: 'Adapter & Capabilities Report', category: 'Editor', run: () => this.showCapabilities() },
      'editor.loseContext': { title: 'Simulate Context Loss', category: 'Editor', run: () => this.simulateContextLoss() },
      'help.shortcuts': { title: 'Keyboard Shortcuts', category: 'Help', keys: '?', run: () => this.showShortcuts() },
      'help.docs': { title: 'About Lumen Studio', category: 'Help', run: () => this.showAbout() },
      'console.clear': { title: 'Clear Console', category: 'Editor', run: () => this.console.clear() },
      'console.focus': { title: 'Focus Console', category: 'Editor', run: () => document.getElementById('consoleInput')?.focus() }
    });

    c.bindKeys({
      'ctrl+z': 'edit.undo',
      'ctrl+shift+z': 'edit.redo',
      'ctrl+y': 'edit.redo',
      'ctrl+d': 'edit.duplicate',
      'ctrl+g': 'edit.group',
      'ctrl+a': 'edit.selectAll',
      'ctrl+s': 'file.save',
      'ctrl+o': 'file.open',
      'ctrl+e': 'file.export',
      'ctrl+n': 'file.new',
      'ctrl+k': '__palette',
      'delete': 'edit.delete',
      'escape': 'edit.selectNone',
      'f11': 'view.play',
      'f': 'hierarchy.focus',
      'g': 'view.grid',
      'x': 'gizmo.space',
      'z': 'view.zoomFit',
      'p': 'view.screenshot',
      '?': 'help.shortcuts',
      'q': '__tool:select',
      'w': '__tool:move',
      'e': '__tool:rotate',
      'r': '__tool:scale',
      '1': '__view:front',
      '2': '__view:right',
      '3': '__view:top',
      '4': '__view:back',
      '5': '__view:bottom',
      '6': '__view:iso',
      '0': '__debug'
    });
  }

  _onKeyDown(e) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
    if (this.palette.open || this.modals.open) return;

    this.viewport.keys.add(e.key.toLowerCase());

    const combo = comboFromEvent(e);
    if (!combo) return;
    const map = this.commands.keyMap();
    const target = map[normalizeCombo(combo)];
    if (target) {
      e.preventDefault();
      if (target === '__palette') this.palette.toggle();
      else if (target.startsWith('__tool:')) this.setTool(target.slice(7));
      else if (target.startsWith('__view:')) { this.viewport.setView(target.slice(7)); this.setStatus(target.slice(7)); }
      else if (target === '__debug') this.cycleDebugView();
      else this.commands.run(target);
      return;
    }
    // Bare number keys cycle the debug views (1..9) when nothing else matched.
    if (/^[0-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey) {
      const n = Number(e.key);
      const view = DEBUG_VIEWS.find((v) => v.key === e.key);
      if (view) { this.setDebugView(view.id); e.preventDefault(); return; }
      void n;
    }
  }

  /* ------------------------------------------------------------- dialogs */

  showContextMenu(x, y, items) { this.ctxMenu.show(x, y, items); }

  showModal(spec) { this.modals.show(spec); }

  async promptText(title, value, onOk) {
    const v = await this.modals.prompt(title, value);
    if (v !== null && v !== undefined) onOk(v);
    return v;
  }

  showAddEntityMenu(anchor) {
    const items = [];
    for (const [kind, def] of Object.entries(PRIMITIVES)) {
      items.push({ label: def.label, icon: def.icon, run: () => this.addPrimitive(kind) });
    }
    items.push({ separator: true });
    items.push({ label: 'Empty Group', run: () => this.addEntity('group') });
    for (const [type, schema] of Object.entries(COMPONENT_SCHEMA)) {
      if (['render', 'camera', 'light', 'volume', 'collision'].includes(type)) {
        items.push({ label: schema.label, icon: schema.icon, run: () => this.addEntity(type) });
      }
    }
    const p = anchor || this._centerOf('#panelHierarchy');
    this.showContextMenu(p.x, p.y, items);
  }

  showNewMaterialMenu(anchor) {
    const p = anchor || this._centerOf('#panelAssets');
    this.showContextMenu(p.x, p.y, [
      ...MATERIAL_PRESETS.map((preset) => ({ label: preset.name, run: () => { this.assetsPanel.createMaterial(preset); this.assetsPanel.render(); } })),
      { separator: true },
      { label: 'Empty Material', run: () => { this.assetsPanel.createMaterial(); this.assetsPanel.render(); } }
    ]);
  }

  showPrimitiveModelMenu(anchor) {
    const p = anchor || this._centerOf('#panelAssets');
    this.showContextMenu(p.x, p.y, Object.entries(PRIMITIVES).map(([kind, def]) => ({
      label: def.label,
      run: () => {
        const a = this._ensureModel(kind);
        this.assetsPanel.render();
        this.log.info(`created model "${a.name}" (${a.triangles} tris)`);
      }
    })));
  }

  showExportMenu(anchor) {
    const p = anchor || this._centerOf('.tb-file');
    this.showContextMenu(p.x + 40, p.y + 26, [
      { label: 'Scene JSON', hint: '.json', run: () => this.exportSceneJSON() },
      { label: 'Selection as OBJ', run: () => this.exportSelectionOBJ() },
      { label: 'Project bundle', hint: '.json', run: () => this.exportProject() },
      { label: 'Screenshot PNG', run: () => this.viewport.screenshot(`${this.scene.name}.png`) },
      { separator: true },
      { label: 'Capabilities report', run: () => this.showCapabilities() }
    ]);
  }

  showCameraMenu(anchor) {
    const cams = this.scene.cameras;
    const p = anchor || this._centerOf('#camSelector');
    this.showContextMenu(p.x, p.y + 26, [
      ...cams.map((c) => ({ label: c.name, hint: 'entity', run: () => this.useCamera(c) })),
      { separator: true },
      { label: 'Editor Camera', run: () => this.useCamera(null) }
    ]);
  }

  showViewPresetMenu(anchor) {
    const p = anchor || this._centerOf('.tb-right');
    this.showContextMenu(p.x, p.y + 26, [
      { label: 'Front', run: () => this.viewport.setView('front') },
      { label: 'Back', run: () => this.viewport.setView('back') },
      { label: 'Left', run: () => this.viewport.setView('left') },
      { label: 'Right', run: () => this.viewport.setView('right') },
      { label: 'Top', run: () => this.viewport.setView('top') },
      { label: 'Isometric', run: () => this.viewport.setView('iso') }
    ]);
  }

  showDebugMenu(anchor) {
    const p = anchor || this._centerOf('#rail');
    this.showContextMenu(p.x + 40, p.y, DEBUG_VIEWS.map((v) => ({
      label: v.name,
      hint: v.key,
      run: () => this.setDebugView(v.id)
    })));
  }

  showShadowResMenu(anchor) {
    const p = anchor || this._centerOf('#rail');
    this.showContextMenu(p.x + 40, p.y, [512, 1024, 2048, 4096].map((r) => ({
      label: `${r} × ${r}`,
      run: () => {
        const sun = this.scene.lights.find((l) => l.components.light?.type === 'directional');
        if (sun) sun.components.light.shadowResolution = r;
        this.renderer.shadows.setResolution(r);
        this.markDirty('Shadow resolution');
        this.inspector.render();
      }
    })));
  }

  showSnapDialog() {
    const s = this.gizmo.snap;
    const mk = (label, key, step, unit) => {
      const input = document.createElement('input');
      input.className = 'text-input';
      input.value = String(s[key]);
      const row = document.createElement('div');
      row.className = 'modal-row';
      row.innerHTML = `<span>${label}</span>`;
      row.appendChild(input);
      return { row, input, apply: () => { s[key] = parseFloat(input.value) || step; } };
    };
    const move = mk('Translate', 'translate', 0.25, 'm');
    const rot = mk('Rotate', 'rotate', 15, '°');
    const scl = mk('Scale', 'scale', 0.1, '×');
    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.checked = s.enabled;
    const toggleRow = document.createElement('div');
    toggleRow.className = 'modal-row';
    toggleRow.innerHTML = '<span>Enabled</span>';
    toggleRow.appendChild(enabled);

    const body = document.createElement('div');
    body.append(toggleRow, move.row, rot.row, scl.row);
    this.showModal({
      title: 'Snapping',
      body,
      buttons: [
        { label: 'Cancel' },
        {
          label: 'Apply', variant: 'primary', onClick: () => {
            s.enabled = enabled.checked;
            move.apply(); rot.apply(); scl.apply();
            this.setStatus(`snap: ${s.enabled ? 'on' : 'off'}`);
            this.requestRender();
          }
        }
      ]
    });
  }

  showShortcuts() {
    this.showModal({ title: 'Keyboard Shortcuts', body: buildShortcutSheet(), width: 720 });
  }

  showAbout() {
    const caps = this.ctx.caps;
    this.showModal({
      title: 'Lumen Studio',
      width: 620,
      body: `
        <p><strong>Lumen Studio</strong> is a browser-native 3D engine and editor built directly on
        WebGL — no engine binary, no wasm, no build step. It prefers <strong>WebGL 2</strong>
        (GLSL ES 3.00) and falls back to <strong>WebGL 1</strong> (GLSL ES 1.00) by transpiling one
        shader source tree into both dialects.</p>
        <div class="kv">
          <div class="kv-row"><span class="kv-k">API</span><span class="kv-v">${caps.version}</span></div>
          <div class="kv-row"><span class="kv-k">GLSL</span><span class="kv-v">${caps.shadingLanguageVersion}</span></div>
          <div class="kv-row"><span class="kv-k">Renderer</span><span class="kv-v">${caps.renderer}</span></div>
          <div class="kv-row"><span class="kv-k">Tier</span><span class="kv-v">${caps.tier.name} (${caps.tier.score})</span></div>
          <div class="kv-row"><span class="kv-k">WebGPU present</span><span class="kv-v">${caps.webgpu ? 'yes (unused — this build is WebGL-only)' : 'no'}</span></div>
        </div>
        <p class="muted">Every design decision traces back to a sentence in the French Wikipedia
        article on WebGL; see <code>docs/WEBGL-ARTICLE-MAP.md</code>.</p>`
    });
  }

  /** The capability report is the article, rendered as a table. */
  showCapabilities() {
    const caps = this.ctx.caps;
    const features = featureMap(caps);
    const rows = Object.entries(features).map(([k, v]) => {
      const cls = v.startsWith('core') ? 'ok' : v.startsWith('emulated') || v.startsWith('fallback') || v.startsWith('parallel') ? 'warn' : 'bad';
      return `<div class="kv-row"><span class="kv-k">${k}</span><span class="kv-v ${cls}">${v}</span></div>`;
    }).join('');
    const exts = caps.extensionNames.map((e) => `<div class="kv-row"><span class="kv-k">${e.name}</span><span class="kv-v ${e.present ? 'ok' : 'bad'}">${e.present ? 'present' : 'absent'}</span></div>`).join('');
    const limits = Object.entries(caps.limits)
      .filter(([, v]) => typeof v !== 'object')
      .map(([k, v]) => `<div class="kv-row"><span class="kv-k">${k}</span><span class="kv-v">${v}</span></div>`).join('');

    this.showModal({
      title: 'WebGL capabilities',
      width: 760,
      body: `
        <h4>Feature map</h4><div class="kv">${rows}</div>
        <h4>Extensions</h4><div class="kv">${exts}</div>
        <h4>Limits</h4><div class="kv">${limits}</div>
        <h4>Context</h4>
        <pre class="cap-json">${JSON.stringify(caps.contextAttributes, null, 2)}</pre>`
    });
  }

  pickAsset(filter, onPick) {
    const list = this.assets.all().filter((a) => !filter || a.type === filter);
    if (!list.length) { this.log.warn(`no ${filter || 'asset'} available`); return; }
    const items = list.map((a) => ({
      label: a.name,
      hint: a.type,
      run: () => onPick(a.id)
    }));
    const p = this._centerOf('#panelInspector');
    this.showContextMenu(p.x, p.y, items);
  }

  assignAssetToSelection(asset) {
    const sel = this.scene.selection;
    if (!sel.length) { this.log.warn('select an entity first'); return; }
    for (const e of sel) {
      if (asset.type === 'material') {
        e.addComponent('render', migrateComponent('render', { mesh: e.components.render?.mesh || this.assets.byType('model')[0]?.id, material: asset.id }));
      } else if (asset.type === 'model') {
        e.addComponent('render', migrateComponent('render', { mesh: asset.id, material: e.components.render?.material || this.assets.byType('material')[0]?.id }));
      } else if (asset.type === 'texture' && e.components.render) {
        const m = this.assets.get(e.components.render.material)?.material;
        if (m) { m.diffuseMap = asset.id; m.touch(); }
      }
    }
    this.markDirty(`Assign ${asset.name}`);
    this.inspector.render();
  }

  _centerOf(selector) {
    const el = document.querySelector(selector);
    if (!el) return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const r = el.getBoundingClientRect();
    return { x: r.left + Math.min(240, r.width / 2), y: r.top + 80 };
  }

  /* ------------------------------------------------------------- project */

  newScene() {
    if (this.scene.dirty) this.autosave();
    this.scene = new Scene('Untitled');
    this._rebindScene();
    this.history.reset();
    this.refreshAll();
    this.setStatus('new scene');
  }

  _rebindScene() {
    this.scene.setMeshResolver((id) => this.assets.get(id)?.gpu || null);
    this.scene.removeAll();
    this.scene.on('selection', (sel) => {
      this.hierarchy.render();
      this.inspector.showEntity(sel[0] || null);
      this.inspector.render();
      this.updateStatus();
      this.requestRender();
    });
    this.scene.on('change', () => { this.renderer.invalidatePicking(); });
  }

  async saveProject() {
    const doc = this.toProject();
    this.projectId = this.projectId || `${(this.scene.name || 'scene').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString(36)}`;
    storage.set('lastProject', { id: this.projectId, name: this.scene.name, at: Date.now() });
    this.setStatus('saved to browser storage');
    if (this.serverOnline) {
      try {
        await storage.saveRemote(this.projectId, doc);
        this.setStatus(`saved · ${this.projectId} (server + localStorage)`);
      } catch (e) {
        this.log.warn('server save failed:', e.message);
        this.setStatus('saved locally (server unavailable)');
      }
    }
    this.scene.dirty = false;
    this.updateStatus();
    this.log.info(`project saved (${formatBytes(JSON.stringify(doc).length)})`);
  }

  async openProject() {
    const remote = await storage.listRemote();
    const local = storage.get('lastProject');
    const body = document.createElement('div');
    if (local) {
      body.appendChild(h('div', { class: 'modal-row' }, [
        h('span', { text: `Last session: ${local.name}` }),
        h('button', {
          class: 'btn btn-primary', type: 'button', text: 'Restore',
          onClick: () => {
            const doc = storage.get(AUTOSAVE_KEY);
            this.scene = Scene.fromJSON(doc);
            this._rebindScene();
            this.assets.fromJSON(storage.get('assets', { assets: [], folders: [] }), { log: this.log });
            this.applySceneSettings();
            this.history.reset();
            this.refreshAll();
            this.modals.close();
            this.setStatus('restored last session');
          }
        })
      ]));
    }
    if (remote.length) {
      body.appendChild(h('h4', { text: 'Server projects' }));
      for (const item of remote) {
        body.appendChild(h('div', { class: 'modal-row' }, [
          h('span', { text: `${item.name || item.id} · ${formatBytes(item.size)} · ${new Date(item.updated).toLocaleString()}` }),
          h('button', {
            class: 'btn', type: 'button', text: 'Load',
            onClick: async () => {
              const doc = await storage.loadRemote(item.id);
              this.loadProject(doc);
              this.modals.close();
            }
          })
        ]));
      }
    } else {
      body.appendChild(h('p', { class: 'muted', text: this.serverOnline ? 'No projects stored on the server yet — save one first.' : 'Server storage unavailable; only the local session can be restored.' }));
    }
    this.showModal({ title: 'Open project', body, width: 620 });
  }

  toProject() {
    return {
      format: 'lumen.project',
      version: 1,
      savedAt: Date.now(),
      scene: this.scene.toJSON(),
      assets: this.assets.toJSON(),
      layout: this.layout
    };
  }

  loadProject(doc) {
    if (!doc) return;
    if (doc.scene) this.scene = Scene.fromJSON(doc.scene);
    else return;
    if (doc.assets) this.assets.fromJSON(doc.assets, { log: this.log });
    if (doc.layout) { this.layout = { ...this.layout, ...doc.layout }; this._applyLayout(this.layout); }
    this._rebindScene();
    this.applySceneSettings();
    this.history.reset();
    this.refreshAll();
    this.setStatus('project loaded');
  }

  exportSceneJSON() {
    const blob = new Blob([JSON.stringify(this.scene.toJSON(), null, 2)], { type: 'application/json' });
    util.downloadBlob(blob, `${this.scene.name || 'scene'}.json`);
    this.setStatus('exported scene JSON');
  }

  exportProject() {
    const blob = new Blob([JSON.stringify(this.toProject(), null, 2)], { type: 'application/json' });
    util.downloadBlob(blob, `${this.scene.name || 'project'}.lumen.json`);
    this.setStatus('exported project bundle');
  }

  exportSelectionOBJ() {
    const sel = this.scene.selection.filter((e) => e.components.render);
    if (!sel.length) { this.log.warn('select at least one renderable entity'); return; }
    const parts = sel.map((e) => {
      const mesh = this.assets.get(e.components.render.mesh)?.gpu;
      return mesh ? writeOBJ(mesh, { name: e.name }) : '';
    });
    const blob = new Blob([parts.join('\n')], { type: 'text/plain' });
    util.downloadBlob(blob, `${this.scene.name || 'selection'}.obj`);
    this.setStatus(`exported ${sel.length} mesh(es) as OBJ`);
  }

  exportAsset(asset) {
    if (asset.type === 'model' && asset.gpu) {
      const blob = new Blob([writeOBJ(asset.gpu, { name: asset.name })], { type: 'text/plain' });
      util.downloadBlob(blob, `${asset.name}.obj`);
      return;
    }
    if (asset.type === 'material') {
      const blob = new Blob([JSON.stringify(asset.material.toJSON(), null, 2)], { type: 'application/json' });
      util.downloadBlob(blob, `${asset.name}.material.json`);
      return;
    }
    if (asset.type === 'texture' && asset.dataUrl) {
      const a = document.createElement('a');
      a.href = asset.dataUrl;
      a.download = `${asset.name}.png`;
      a.click();
      return;
    }
    this.log.warn(`no exporter for ${asset.type} assets`);
  }

  async importFiles(files, folder = null) {
    if (!files || !files.length) return;
    this.setStatus(`importing ${files.length} file(s)…`);
    const created = await this.assets.enqueue(files, { folder });
    this.assetsPanel.render();
    this.assetsPanel.renderTasks();
    this.renderer.invalidatePicking();
    this.requestRender();
    if (created.length) this.log.info(`imported ${created.length} asset(s)`);
    this.setStatus(created.length ? `imported ${created.length} asset(s)` : 'nothing imported');
  }

  autosave() {
    if (!this.scene) return;
    storage.set(AUTOSAVE_KEY, this.scene.toJSON());
    storage.set('assets', this.assets.toJSON({ includePixels: true }));
    this.setStatus('autosaved');
  }

  /* ------------------------------------------------------------- actions */

  cycleDebugView() {
    const next = (this.renderer.debugView + 1) % DEBUG_VIEWS.length;
    this.setDebugView(next);
  }

  setDebugView(id) {
    this.renderer.debugView = id;
    this.setStatus(`view: ${DEBUG_VIEWS[id]?.name || id}`);
    document.getElementById('debugLegend').hidden = id === 0;
    const legend = document.getElementById('debugLegend');
    if (id !== 0) legend.textContent = DEBUG_VIEWS[id].name;
    this.requestRender();
  }

  toggleGrid() {
    this.scene.settings.render.grid = !this.scene.settings.render.grid;
    this.applySceneSettings();
    this.setStatus(`grid: ${this.scene.settings.render.grid ? 'on' : 'off'}`);
    this.inspector.render();
    this.requestRender();
  }

  setProjection(type) {
    this.viewport.setOrtho(type === 'orthographic');
    document.querySelectorAll('#viewMode .seg-btn').forEach((b) => {
      b.classList.toggle('is-active', (b.dataset.cmd === 'view.ortho') === (type === 'orthographic'));
    });
    document.getElementById('navLabel').textContent = type === 'orthographic' ? 'Orthographic' : 'Perspective';
    this.requestRender();
  }

  useCamera(entity) {
    this._activeCamera = entity;
    this.setStatus(entity ? `camera: ${entity.name}` : 'camera: editor');
    this.requestRender();
  }

  bumpExposure(d) {
    this.scene.settings.render.exposure = clamp(this.scene.settings.render.exposure + d, 0.05, 8);
    this.applySceneSettings();
    this.setStatus(`exposure ${this.scene.settings.render.exposure.toFixed(2)}`);
    this.inspector.update();
    this.requestRender();
  }

  freezeTransforms() {
    for (const e of this.scene.selection) {
      e.position = [0, 0, 0];
      e.euler = [0, 0, 0];
      e.scale = [1, 1, 1];
    }
    this.markDirty('Freeze transforms');
    this.inspector.render();
  }

  togglePresent() {
    this.presentMode = !this.presentMode;
    document.getElementById('app').classList.toggle('is-present', this.presentMode);
    this._applyViewportSize();
    this.setStatus(this.presentMode ? 'present mode — press F11 to exit' : 'editor');
  }

  simulateContextLoss() {
    if (this.ctx.simulateContextLoss()) {
      this.log.warn('simulated context loss — the GPU resources will be rebuilt on restore');
    } else {
      this.log.warn('WEBGL_lose_context is not available in this browser');
    }
  }

  _onContextLost(e) {
    this.log.error(`WebGL context lost (${e.resources} GPU objects dropped) — waiting for restore`);
    const badge = document.getElementById('stCtx');
    if (badge) { badge.textContent = 'ctx lost'; badge.classList.add('is-bad'); }
  }

  _onContextRestored(e) {
    this.log.info(`context restored — ${e.restored} objects rebuilt, ${e.failed} failed`);
    this.renderer.ibl.dirty = true;
    this.assetsPanel.render();
    const badge = document.getElementById('stCtx');
    if (badge) { badge.textContent = 'ctx restored'; badge.classList.remove('is-bad'); }
    this._applyViewportSize();
    this.requestRender();
  }

  /* -------------------------------------------------------------- chrome */

  refreshAll() {
    this.hierarchy.render();
    this.inspector.render();
    this.assetsPanel.render();
    this.assetsPanel.renderTasks();
    this.console.render();
    this.updateStatus();
    this.requestRender();
  }

  setStatus(text) {
    const el = document.getElementById('stMsg');
    if (el) el.textContent = text || '';
    this._statusUntil = performance.now() + 4000;
  }

  updateStatus() {
    const el = document.getElementById('stSel');
    const sel = this.scene.selection;
    if (!el) return;
    el.textContent = sel.length === 0
      ? 'no selection'
      : sel.length === 1 ? sel[0].name : `${sel.length} entities`;
  }

  _updateStatusBar() {
    const s = this.renderer.stats;
    const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    set('stFps', `${this.viewport._fps.toFixed(0)} fps`);
    set('stDraw', `${s.drawCalls} draws`);
    set('stTris', `${util.formatCount(s.triangles)} tris`);
    const backend = document.getElementById('stBackend');
    if (backend && !backend.textContent) {
      backend.textContent = this.ctx.caps.isWebGL2 ? 'WebGL 2.0 · ES 3.00' : 'WebGL 1.0 · ES 1.00';
    }
    const server = document.getElementById('stServer');
    if (server) {
      server.textContent = this.serverOnline ? 'server: online' : 'server: offline';
      server.classList.toggle('is-ok', this.serverOnline);
    }
    const msg = document.getElementById('stMsg');
    if (msg && this._statusUntil && performance.now() > this._statusUntil) {
      msg.textContent = this.scene.dirty ? 'unsaved changes' : '';
    }
  }
}

export { LAYER_DEFS, Material, vec3, uid };
