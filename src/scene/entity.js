/**
 * Scene graph.
 *
 * An entity is a transform plus a bag of named components. Component payloads
 * are plain JSON objects described by a schema (`components.js`), which is what
 * lets the inspector build itself, the serialiser stay trivial and undo/redo work
 * on whole-document snapshots.
 *
 * Local transforms are stored as TRS (translation, quaternion, scale) because
 * Euler angles accumulate gimbal error and drift under repeated edits; the
 * editor converts to degrees only at the UI boundary.
 */

import { quat, vec3, mat3, mat4, aabb, sphere } from '../core/math.js';
import { uid } from '../core/utils.js';

let ENTITY_SEQ = 0;

export class Entity {
  constructor(opts = {}) {
    this.id = opts.id || `${Date.now().toString(36)}${(ENTITY_SEQ++).toString(36)}`;
    this.name = opts.name || 'Entity';
    this.tags = opts.tags || [];
    this.enabled = opts.enabled !== false;
    this._pos = vec3.create(...(opts.position || [0, 0, 0]));
    this._rot = opts.quaternion ? quat.clone(opts.quaternion) : quat.fromEuler(quat.create(), ...(opts.rotation || [0, 0, 0]));
    this._scl = vec3.create(...(opts.scale || [1, 1, 1]));
    this._local = mat4.create();
    this._world = mat4.create();
    this._normalMat = mat3.create();
    this._localDirty = true;
    this._worldDirty = true;
    this._normalDirty = true;
    this._aabb = aabb.create();
    this._sphere = sphere.create();
    this._boundsDirty = true;

    this.parent = null;
    this.children = [];
    this.components = {};      // { camera: {...}, light: {...}, render: {...} }
    this.assetRefs = new Set(); // asset ids this entity depends on
    this._meshResolver = null;  // set by the Scene: assetId -> mesh
  }

  /* ------------------------------------------------------------ transform */

  get position() { return this._pos; }
  set position(v) { vec3.copy(this._pos, v); this._touchLocal(); }

  get scale() { return this._scl; }
  set scale(v) { vec3.copy(this._scl, v); this._touchLocal(); }

  get quaternion() { return this._rot; }
  set quaternion(q) { quat.copy(this._rot, q); this._touchLocal(); }

  /** Euler XYZ in degrees — the editor's representation. */
  get euler() { return quat.toEuler(_euler, this._rot).slice(); }
  set euler(e) { quat.fromEuler(this._rot, e[0], e[1], e[2]); this._touchLocal(); }

  get rotation() { return this.euler; }
  set rotation(r) { this.euler = r; }

  get localMatrix() {
    if (this._localDirty) {
      mat4.fromRTS(this._local, this._rot, this._pos, this._scl);
      this._localDirty = false;
    }
    return this._local;
  }

  get worldMatrix() {
    if (this._worldDirty) {
      if (this.parent) mat4.multiply(this._world, this.parent.worldMatrix, this.localMatrix);
      else mat4.copy(this._world, this.localMatrix);
      this._worldDirty = false;
      this._normalDirty = true;
      this._boundsDirty = true;
    }
    return this._world;
  }

  get normalMatrix() {
    if (this._normalDirty) {
      mat3.normalFromMat4(this._normalMat, this.worldMatrix);
      this._normalDirty = false;
    }
    return this._normalMat;
  }

  _touchLocal() {
    this._localDirty = true;
    this._worldDirty = true;
    this._normalDirty = true;
    this._boundsDirty = true;
    this._dirtyChildren();
  }

  _dirtyChildren() {
    for (const c of this.children) { c._worldDirty = true; c._normalDirty = true; c._boundsDirty = true; c._dirtyChildren(); }
  }

  setPosition(x, y, z) { this._pos[0] = x; this._pos[1] = y; this._pos[2] = z; this._touchLocal(); return this; }
  translateLocal(x, y, z) { vec3.add(this._pos, this._pos, [x, y, z]); this._touchLocal(); return this; }
  translateWorld(x, y, z) { vec3.add(this._pos, this._pos, [x, y, z]); this._touchLocal(); return this; }

  get worldPosition() {
    const m = this.worldMatrix;
    return [m[12], m[13], m[14]];
  }

  setWorldPosition(x, y, z) {
    if (this.parent) {
      const inv = mat4.invert(mat4.create(), this.parent.worldMatrix);
      if (inv) {
        const p = vec3.transformMat4(vec3.create(), [x, y, z], inv);
        this.position = p;
        return this;
      }
    }
    this.position = [x, y, z];
    return this;
  }

  lookAt(target, up = [0, 1, 0]) {
    const from = this.worldPosition;
    const m = mat4.lookAt(mat4.create(), from, target, up);
    mat4.getTranslation(_v3a, m);
    quat.fromMat4Basis(this._rot, m);
    this._pos[0] = _v3a[0]; this._pos[1] = _v3a[1]; this._pos[2] = _v3a[2];
    this._touchLocal();
    return this;
  }

  /* ------------------------------------------------------------ hierarchy */

  addChild(child) {
    if (child === this || child.isDescendantOf(this)) return null;
    child.removeFromParent();
    child.parent = this;
    this.children.push(child);
    this._dirtyChildren();
    return child;
  }

  removeFromParent() {
    if (!this.parent) return this;
    const i = this.parent.children.indexOf(this);
    if (i >= 0) this.parent.children.splice(i, 1);
    this.parent = null;
    return this;
  }

  get root() {
    let e = this;
    while (e.parent) e = e.parent;
    return e;
  }

  isDescendantOf(other) {
    let p = this.parent;
    while (p) { if (p === other) return true; p = p.parent; }
    return false;
  }

  /** Every descendant, depth-first, excluding this entity. */
  descendants(out = []) {
    for (const c of this.children) { out.push(c); c.descendants(out); }
    return out;
  }

  /** This entity + all descendants. */
  family(out = []) {
    out.push(this);
    this.descendants(out);
    return out;
  }

  findById(id) {
    if (this.id === id) return this;
    for (const c of this.children) {
      const r = c.findById(id);
      if (r) return r;
    }
    return null;
  }

  findByName(name) {
    if (this.name === name) return this;
    for (const c of this.children) {
      const r = c.findByName(name);
      if (r) return r;
    }
    return null;
  }

  find(pred) {
    for (const e of this.family()) if (pred(e)) return e;
    return null;
  }

  findAll(pred, out = []) {
    for (const e of this.family()) if (pred(e)) out.push(e);
    return out;
  }

  findByTag(tag) { return this.find((e) => e.tags.includes(tag)); }
  findAllByTag(tag) { return this.findAll((e) => e.tags.includes(tag)); }

  /* ----------------------------------------------------------- components */

  addComponent(type, data = {}) {
    this.components[type] = data;
    this._boundsDirty = true;
    return data;
  }

  removeComponent(type) {
    delete this.components[type];
    this._boundsDirty = true;
  }

  hasComponent(type) { return !!this.components[type]; }

  /** Inherited from the parent, so the scene only has to configure its root. */
  get meshResolver() { return this._meshResolver || this.parent?.meshResolver || null; }
  set meshResolver(fn) { this._meshResolver = fn; }

  /** Resolved GPU mesh for a render component (components store the asset *id*). */
  resolveMesh(renderComponent = this.components.render) {
    if (!renderComponent?.mesh) return null;
    const resolver = this.meshResolver;
    return resolver ? resolver(renderComponent.mesh) : null;
  }

  get(type) { return this.components[type]; }

  get isRenderable() { return !!this.components.render; }
  get isLight() { return !!this.components.light; }
  get isCamera() { return !!this.components.camera; }

  /* --------------------------------------------------------------- bounds */

  /**
   * World-space bounds. Render components contribute their mesh AABB transformed
   * by the world matrix; every other entity contributes only its own origin
   * (a light or camera with no geometry has no extent to speak of).
   */
  get worldAABB() {
    if (!this._boundsDirty) return this._aabb;
    aabb.reset(this._aabb);
    const render = this.components.render;
    const mesh = render ? this.resolveMesh(render) : null;
    if (mesh && mesh.aabb && !aabb.isEmpty(mesh.aabb)) {
      aabb.includeTransformed(this._aabb, mesh.aabb, this.worldMatrix);
    } else {
      const p = this.worldPosition;
      aabb.addPoint(this._aabb, p[0], p[1], p[2]);
    }
    this._boundsDirty = false;
    return this._aabb;
  }

  get worldSphere() {
    sphere.fromAABB(this._sphere, this.worldAABB);
    return this._sphere;
  }

  /** Combined bounds of a list of entities. */
  static unionBounds(entities) {
    const box = aabb.create();
    for (const e of entities) aabb.addAABB(box, e.worldAABB);
    return box;
  }

  /* ---------------------------------------------------------- serialising */

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      tags: this.tags.slice(),
      enabled: this.enabled,
      position: Array.from(this._pos, (v) => round3(v)),
      rotation: this.euler.map((v) => round3(v)),
      scale: Array.from(this._scl, (v) => round3(v)),
      components: JSON.parse(JSON.stringify(this.components)),
      children: this.children.map((c) => c.toJSON())
    };
  }

  static fromJSON(json) {
    const e = new Entity({
      id: json.id,
      name: json.name,
      tags: json.tags,
      enabled: json.enabled,
      position: json.position,
      rotation: json.rotation,
      scale: json.scale
    });
    if (json.components) {
      for (const [k, v] of Object.entries(json.components)) e.components[k] = JSON.parse(JSON.stringify(v));
    }
    for (const c of json.children || []) e.addChild(Entity.fromJSON(c));
    return e;
  }

  clone({ newIds = true, suffix = ' copy' } = {}) {
    const json = this.toJSON();
    if (newIds) {
      const walk = (n) => {
        n.id = uid().slice(0, 14);
        (n.children || []).forEach(walk);
      };
      walk(json);
    }
    json.name = `${json.name}${suffix}`;
    return Entity.fromJSON(json);
  }
}

const _euler = new Float32Array(3);
const _v3a = vec3.create();
const round3 = (v) => Math.round(v * 1e5) / 1e5;
