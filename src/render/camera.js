/**
 * Runtime camera: matrices, ray reconstruction and screen projection.
 *
 * A camera here is a *view*, not an entity: the editor's viewport camera and any
 * camera entity in the scene both resolve to this object. Projection is
 * right-handed with a [0,1] depth range (OpenGL), and `screenRay` unprojects a
 * pixel through the inverse view-projection so picking and gizmos share exactly
 * the same maths as the rasteriser.
 */

import { mat4, vec3, frustum, quat } from '../core/math.js';

export class Camera {
  constructor(opts = {}) {
    this.entity = opts.entity || null;
    this.data = opts.data || {};
    this.aspect = opts.aspect ?? 16 / 9;
    this.near = this.data.near ?? 0.1;
    this.far = this.data.far ?? 1000;
    this.fov = this.data.fov ?? 50;
    this.orthoHeight = this.data.orthoHeight ?? 5;
    this.projectionType = this.data.projection || 'perspective';
    this.position = vec3.create(...(opts.position || [0, 0, 5]));
    this.rotation = quat.create();
    this.view = mat4.create();
    this.proj = mat4.create();
    this.viewProj = mat4.create();
    this.invViewProj = mat4.create();
    this.invView = mat4.create();
    this.frustum = frustum.create();
    this.right = vec3.create(1, 0, 0);
    this.up = vec3.create(0, 1, 0);
    this.forward = vec3.create(0, 0, -1);
    this.aspect = opts.aspect ?? 16 / 9;
    this.clearColor = this.data.clearColor || [0.05, 0.055, 0.07, 1];
    this.clearColorMode = this.data.clearColorMode || 'sky';
    this.layers = this.data.layers || [0, 1];
    this.priority = this.data.priority || 0;
    this.frustumCulling = this.data.frustumCulling !== false;
    this.orthoZoom = 1;
    this._sync();
  }

  static fromEntity(entity) {
    return new Camera({ entity, data: entity.components.camera || {} });
  }

  /** Rebuild every derived matrix. Call once per frame per camera. */
  update(entityMatrix = null) {
    if (entityMatrix) {
      mat4.getTranslation(this.position, entityMatrix);
      quat.fromMat4Basis(this.rotation, entityMatrix);
    }
    this._sync();
    return this;
  }

  _sync() {
    // `rotation` is the camera's *world* rotation, so the view is the inverse of
    // the camera's world matrix. Using the world matrix directly (T·R) points the
    // camera the wrong way: the translation has to be applied in view space, i.e.
    // after the rotation, and with the opposite sign.
    const world = mat4.fromRTS(_worldM, this.rotation, this.position, _one);
    mat4.invert(this.view, world);
    // Keep the basis vectors in sync with the matrices: panning and the fly
    // camera read them, and a stale `right`/`up` silently pans along world axes.
    mat4.getXAxis(this.right, world);
    mat4.getYAxis(this.up, world);
    // The camera looks down its local -Z.
    vec3.set(this.forward, -world[8], -world[9], -world[10]);
    if (this.projectionType === 'orthographic') {
      const h = this.orthoHeight / Math.max(this.orthoZoom, 1e-4);
      const w = h * this.aspect;
      mat4.ortho(this.proj, w, h, this.near, this.far);
    } else {
      mat4.perspective(this.proj, (this.fov * Math.PI) / 180, this.aspect, this.near, this.far);
    }
    mat4.multiply(this.viewProj, this.proj, this.view);
    mat4.invert(this.invViewProj, this.viewProj);
    mat4.invert(this.invView, this.view);
    frustum.fromMatrix(this.frustum, this.viewProj);
    return this;
  }

  setAspect(a) {
    if (Math.abs(a - this.aspect) < 1e-6) return this;
    this.aspect = a;
    return this._sync();
  }

  get isPerspective() { return this.projectionType === 'perspective'; }

  /** Effective far distance used for cascade splits / fog. */
  get effectiveFar() { return this.far; }

  /** Pixel (CSS or device) → world-space ray. `x`/`y` are from the top-left. */
  screenRay(x, y, width, height) {
    const ndcX = (x / width) * 2 - 1;
    const ndcY = 1 - (y / height) * 2;
    const near = this.unproject(ndcX, ndcY, 0);
    const far = this.unproject(ndcX, ndcY, 1);
    const dir = vec3.sub(vec3.create(), far, near);
    vec3.normalize(dir, dir);
    return { origin: near, direction: dir };
  }

  unproject(ndcX, ndcY, depth) {
    const v = [ndcX, ndcY, depth * 2 - 1, 1];
    const m = this.invViewProj;
    const x = m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * v[3];
    const y = m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * v[3];
    const z = m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * v[3];
    const w = m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3] || 1;
    return vec3.create(x / w, y / w, z / w);
  }

  /** World point → pixel coordinates (top-left origin), plus a w for behind-camera tests. */
  worldToScreen(p, width, height, out = { x: 0, y: 0, z: 0, visible: false }) {
    const m = this.viewProj;
    const x = p[0], y = p[1], z = p[2];
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
    const cz = m[2] * x + m[6] * y + m[10] * z + m[14];
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (cw <= 1e-6) { out.visible = false; out.z = cw; return out; }
    out.x = (cx / cw * 0.5 + 0.5) * width;
    out.y = (1 - (cy / cw * 0.5 + 0.5)) * height;
    out.z = cz / cw;
    out.visible = true;
    return out;
  }

  /** Distance from the camera to a world point. */
  distanceTo(p) { return vec3.dist(this.position, p); }

  /** Frame a bounding sphere: returns the required distance for a given FOV. */
  distanceToFit(radius, fovOverride = null) {
    const fov = ((fovOverride ?? this.fov) * Math.PI) / 180;
    if (this.projectionType === 'orthographic') return radius / Math.max(this.orthoHeight, 1e-4) * 2;
    return radius / Math.sin(fov * 0.5);
  }
}

const _worldM = mat4.create();
const _one = [1, 1, 1];
