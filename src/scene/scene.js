/**
 * Scene — the document being edited.
 *
 * Holds the root entity, environment/render settings, the sky configuration and
 * the selection. Serialisation is the undo/redo unit and the file format on disk,
 * so it is deliberately boring JSON: version, name, settings, entities, and
 * *references* to assets by id (assets live in the asset store, not the scene).
 */

import { Emitter, uid } from '../core/utils.js';
import { Entity } from './entity.js';
import { migrateComponent } from './components.js';
import { SKY_DEFAULTS } from '../gl/shaders/sky.js';

export const SCENE_FORMAT = 'lumen.scene';
export const SCENE_VERSION = 1;

export class Scene extends Emitter {
  constructor(name = 'Untitled') {
    super();
    this.name = name;
    this.id = uid().slice(0, 10);
    this.root = new Entity({ name: 'Root', id: 'root' });
    this.selection = [];
    this.hover = null;
    this.settings = {
      sky: { ...SKY_DEFAULTS },
      render: {
        exposure: 1.0,
        toneMapping: 5,   // ACES
        bloom: true,
        bloomStrength: 0.05,
        ssao: false,
        fxaa: true,
        grain: 0.012,
        vignette: 0.32,
        contrast: 1.02,
        saturation: 1.0,
        fog: true,
        fogColor: [0.4, 0.48, 0.6],
        fogDensity: 0.0055,
        ambient: [0.1, 0.12, 0.16],
        ambientIntensity: 1.0,
        grid: true,
        gridCell: 1,
        gridOpacity: 0.7
      }
    };
    this.dirty = false;
    this.root.meshResolver = (assetId) => this.meshResolver?.(assetId) || null;
  }

  /**
   * Entities store asset *ids*; bounds, gizmo framing and export need the GPU
   * objects. The app injects the lookup so the scene stays serialisation-only.
   */
  setMeshResolver(fn) {
    this.meshResolver = fn;
    this.root.meshResolver = fn;
    this.root._dirtyChildren();
  }

  /* ---------------------------------------------------------- traversal */

  get entities() { return this.root.family(); }

  find(id) { return this.root.findById(id); }
  findByName(name) { return this.root.findByName(name); }
  findByTag(tag) { return this.root.findByTag(tag); }

  get renderables() { return this.root.findAll((e) => e.hasComponent('render')); }
  get lights() { return this.root.findAll((e) => e.hasComponent('light')); }
  get cameras() { return this.root.findAll((e) => e.hasComponent('camera')); }

  /* ---------------------------------------------------------- selection */

  select(entity, { additive = false } = {}) {
    if (!entity) { this.clearSelection(); return; }
    if (additive) {
      const i = this.selection.indexOf(entity);
      if (i >= 0) this.selection.splice(i, 1);
      else this.selection.push(entity);
    } else {
      this.selection = [entity];
    }
    this.emit('selection', this.selection);
  }

  setSelection(entities) {
    this.selection = [...entities];
    this.emit('selection', this.selection);
  }

  clearSelection() {
    if (!this.selection.length) return;
    this.selection = [];
    this.emit('selection', this.selection);
  }

  setHover(entity) {
    if (this.hover === entity) return;
    this.hover = entity;
    this.emit('hover', entity);
  }

  /* ------------------------------------------------------------ editing */

  add(entity, parent = this.root) {
    parent.addChild(entity);
    this.touch('add');
    return entity;
  }

  remove(entity) {
    if (entity === this.root) return false;
    entity.removeFromParent();
    this.selection = this.selection.filter((e) => e !== entity);
    this.touch('remove');
    return true;
  }

  /** Unique name for a new sibling, matching the "Box", "Box (1)" convention. */
  uniqueName(base, parent = this.root) {
    const taken = new Set(parent.children.map((c) => c.name));
    if (!taken.has(base)) return base;
    let i = 1;
    while (taken.has(`${base} (${i})`)) i++;
    return `${base} (${i})`;
  }

  touch(reason = 'change') {
    this.dirty = true;
    this.emit('change', reason);
  }

  /* --------------------------------------------------------- serialising */

  toJSON() {
    return {
      format: SCENE_FORMAT,
      version: SCENE_VERSION,
      id: this.id,
      name: this.name,
      settings: this.settings,
      entities: this.root.children.map((c) => c.toJSON())
    };
  }

  static fromJSON(json) {
    const scene = new Scene(json.name || 'Untitled');
    scene.id = json.id || scene.id;
    if (json.settings) {
      scene.settings = {
        sky: { ...SKY_DEFAULTS, ...(json.settings.sky || {}) },
        render: { ...scene.settings.render, ...(json.settings.render || {}) }
      };
    }
    scene.root = new Entity({ name: 'Root', id: 'root' });
    scene.root.meshResolver = (assetId) => scene.meshResolver?.(assetId) || null;
    for (const e of json.entities || []) scene.root.addChild(Entity.fromJSON(e));
    // Fill in any component keys added since the file was written.
    for (const entity of scene.entities) {
      for (const [type, data] of Object.entries(entity.components)) {
        entity.components[type] = migrateComponent(type, data);
      }
    }
    scene.dirty = false;
    return scene;
  }

  clone() { return Scene.fromJSON(this.toJSON()); }

  /** Human-readable summary for the status bar / documents list. */
  summary() {
    let renderables = 0, lights = 0, cameras = 0, meshes = 0, tris = 0;
    for (const e of this.entities) {
      if (e.components.render) { renderables++; if (e.components.render.mesh) meshes++; }
      if (e.components.light) lights++;
      if (e.components.camera) cameras++;
    }
    return { renderables, lights, cameras, meshes, tris, entities: this.entities.length };
  }
}
