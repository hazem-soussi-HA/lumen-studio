/**
 * Transform gizmo.
 *
 * WebGL has no geometry shader, so gizmo handles are geometry generated every
 * frame and pushed into one unlit batch — three draw calls' worth of arrows,
 * rings and boxes in a single one. Handles are kept at a constant *screen* size
 * (gl.lineWidth is clamped to 1 almost everywhere, and geometry is the only
 * portable way to get a thick, anti-aliased handle).
 *
 * Interaction is screen-space: handles are projected, the mouse picks the nearest
 * within a pixel radius, and the drag is then solved analytically against a plane
 * (translate/scale) or a rotation plane (rotate).
 */

import { mat4, vec3, vec4, quat, plane, ray, clamp, RAD2DEG } from '../core/math.js';

export const GIZMO_MODE = { TRANSLATE: 'move', ROTATE: 'rotate', SCALE: 'scale' };
export const GIZMO_SPACE = { WORLD: 'world', LOCAL: 'local' };

const AXIS_COLOR = {
  x: [0.95, 0.28, 0.32],
  y: [0.42, 0.9, 0.35],
  z: [0.3, 0.55, 0.98],
  xy: [0.35, 0.85, 0.6],
  yz: [0.85, 0.4, 0.9],
  xz: [0.4, 0.75, 0.95],
  xyz: [0.92, 0.92, 0.92],
  hover: [1, 0.85, 0.2]
};
const AXIS_VEC = {
  x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1]
};

export class Gizmo {
  constructor(app) {
    this.app = app;
    this.mode = GIZMO_MODE.TRANSLATE;
    this.space = GIZMO_SPACE.WORLD;
    this.size = 1;              // world size at the reference distance
    this.visible = true;
    this.enabled = true;
    this.snap = { enabled: false, translate: 0.25, rotate: 15, scale: 0.1 };
    this.pivotMode = 'pivot';
    this.hoverHandle = null;
    this.activeHandle = null;
    this.drag = null;
    this._screen = {};
    this._sizeWorld = 1;
  }

  /* ------------------------------------------------------------- helpers */

  get selection() { return this.app.scene.selection; }

  /** World-space pivot and orientation basis of the current selection. */
  frame(out = { origin: vec3.create(), axes: [vec3.create(), vec3.create(), vec3.create()], quat: quat.create(), size: 1 }) {
    const sel = this.selection;
    const m = mat4.create();
    if (!sel.length) return out;
    if (sel.length === 1 || this.pivotMode === 'pivot') {
      if (sel.length === 1) {
        mat4.copy(m, sel[0].worldMatrix);
      } else {
        const p = vec3.create();
        for (const e of sel) vec3.add(p, p, e.worldPosition);
        vec3.scale(p, p, 1 / sel.length);
        const scale = vec3.create();
        const q = quat.create();
        // Average the rotations of the selection (nlerp is enough visually).
        const acc = quat.create();
        let first = true;
        for (const e of sel) {
          quat.fromMat4Basis(q, e.worldMatrix);
          quat.normalize(q, q);
          if (first) { quat.copy(acc, q); first = false; }
          else {
            // Keep the hemisphere consistent before accumulating (nlerp).
            if (acc[0] * q[0] + acc[1] * q[1] + acc[2] * q[2] + acc[3] * q[3] < 0) {
              q[0] = -q[0]; q[1] = -q[1]; q[2] = -q[2]; q[3] = -q[3];
            }
            acc[0] += q[0]; acc[1] += q[1]; acc[2] += q[2]; acc[3] += q[3];
          }
        }
        quat.normalize(acc, acc);
        mat4.fromRTS(m, acc, p, scale.set([1, 1, 1]));
      }
    } else {
      let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (const e of sel) {
        const b = e.worldAABB;
        minX = Math.min(minX, b.min[0]); minY = Math.min(minY, b.min[1]); minZ = Math.min(minZ, b.min[2]);
        maxX = Math.max(maxX, b.max[0]); maxY = Math.max(maxY, b.max[1]); maxZ = Math.max(maxZ, b.max[2]);
      }
      const p = vec3.create([(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2]);
      mat4.fromRTS(m, quat.create(), p, [1, 1, 1]);
    }
    out.origin[0] = m[12]; out.origin[1] = m[13]; out.origin[2] = m[14];
    quat.fromMat4Basis(out.quat, m);
    if (this.space === GIZMO_SPACE.WORLD && sel.length === 1) quat.identity(out.quat);
    for (let i = 0; i < 3; i++) {
      vec3.set(out.axes[i], m[0 + i * 4], m[1 + i * 4], m[2 + i * 4]);
    }
    out.size = this._selectionRadius();
    return out;
  }

  /** Half-extent of the selection, used to size the gizmo relative to its bounds. */
  _selectionRadius() {
    const sel = this.selection;
    if (!sel.length) return 1;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const e of sel) {
      const b = e.worldAABB;
      minX = Math.min(minX, b.min[0]); minY = Math.min(minY, b.min[1]); minZ = Math.min(minZ, b.min[2]);
      maxX = Math.max(maxX, b.max[0]); maxY = Math.max(maxY, b.max[1]); maxZ = Math.max(maxZ, b.max[2]);
    }
    const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
    return Math.max(diag * 0.35, 0.3);
  }

  /** World size that yields a constant on-screen handle length. */
  screenSize(camera, viewHeightPx) {
    const f = this.frame();
    const dist = Math.max(0.05, vec3.dist(camera.position, f.origin));
    const h = 2 * Math.tan((camera.fov * Math.PI) / 360) * dist;
    return (this.size * h) / viewHeightPx;
  }

  /* ------------------------------------------------------------- drawing */

  draw(batch, camera, renderer, viewHeightPx) {
    if (!this.visible || !this.selection.length) return;
    const f = this.frame();
    const len = this.screenSize(camera, viewHeightPx);
    const hover = this.hoverHandle;
    const active = this.activeHandle;

    for (const axis of ['x', 'y', 'z']) {
      const col = [...(AXIS_COLOR[axis] || [1, 1, 1]), 1];
      const hot = hover === axis || active === axis;
      const c = hot ? [...AXIS_COLOR.hover, 1] : col;
      if (this.mode === GIZMO_MODE.TRANSLATE) this._drawArrow(batch, f, axis, len, c, hot);
      else if (this.mode === GIZMO_MODE.ROTATE) this._drawRing(batch, f, axis, len, c, hot);
      else this._drawScaleHandle(batch, f, axis, len, c, hot);
    }

    // Plane handles (translate only) and the uniform centre handle.
    if (this.mode === GIZMO_MODE.TRANSLATE) {
      for (const p of ['xy', 'yz', 'xz']) {
        const c = [...(AXIS_COLOR[p] || [1, 1, 1]), 1];
        const hot = hover === p || active === p;
        this._drawPlaneHandle(batch, f, p, len * 0.42, hot ? [...AXIS_COLOR.hover, 1] : c);
      }
      const c = hover === 'xyz' || active === 'xyz' ? [...AXIS_COLOR.hover, 1] : [...AXIS_COLOR.xyz, 1];
      this._drawPlaneHandle(batch, f, 'xyz', len * 0.2, c);
    } else if (this.mode === GIZMO_MODE.SCALE) {
      const c = hover === 'xyz' || active === 'xyz' ? [...AXIS_COLOR.hover, 1] : [...AXIS_COLOR.xyz, 1];
      sphere(batch, f.origin, len * 0.09, c, 8, 6);
    }
  }

  _drawArrow(batch, f, axis, len, color, hot) {
    const dir = f.axes[{ x: 0, y: 1, z: 2 }[axis]];
    const tip = vec3.scaleAndAdd(vec3.create(), f.origin, dir, len);
    const shaft = vec3.scaleAndAdd(vec3.create(), f.origin, dir, len * 0.82);
    const radius = len * (hot ? 0.055 : 0.042);
    cylinder(batch, f.origin, shaft, radius, radius * 1.15, color, 10);
    cone(batch, shaft, tip, radius * 2.1, len * 0.18, color, 12);
  }

  _drawScaleHandle(batch, f, axis, len, color, hot) {
    const dir = f.axes[{ x: 0, y: 1, z: 2 }[axis]];
    const tip = vec3.scaleAndAdd(vec3.create(), f.origin, dir, len);
    const s = len * (hot ? 0.075 : 0.06);
    box(batch, tip, dir, s, color);
    // A thin shaft makes the handle grabbable along its whole length.
    cylinder(batch, f.origin, tip, s * 0.28, s * 0.28, color, 8);
  }

  _drawRing(batch, f, axis, len, color, hot) {
    const dir = f.axes[{ x: 0, y: 1, z: 2 }[axis]];
    const r = len * (hot ? 0.92 : 0.85);
    ring(batch, f.origin, dir, r, len * 0.02, color, 48);
  }

  _drawPlaneHandle(batch, f, name, offset, color) {
    const o = vec3.create(f.origin);
    if (name === 'xyz') { sphere(batch, o, offset, color, 8, 6); return; }
    const a = f.axes[name[0] === 'x' ? 0 : name[1] === 'y' ? 1 : 2];
    const b = f.axes[name[0] === 'y' ? 1 : name[1] === 'z' ? 2 : 0];
    const center = vec3.scaleAndAdd(vec3.create(), o, a, offset * 0.72);
    vec3.scaleAndAdd(center, center, b, offset * 0.72);
    const s = offset;
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => {
      const p = vec3.clone(center);
      vec3.scaleAndAdd(p, p, a, x * s);
      vec3.scaleAndAdd(p, p, b, y * s);
      return p;
    });
    for (let i = 0; i < 4; i++) {
      batch.tri(corners[i], corners[(i + 1) % 4], vec3.scaleAndAdd(vec3.create(), center, a, 0), [color[0], color[1], color[2], color[3] * 0.9]);
    }
  }

  /* --------------------------------------------------------- hit testing */

  /** @param {number} px @param {number} py mouse position in CSS pixels */
  hitTest(camera, px, py, viewW, viewH) {
    if (!this.visible || !this.selection.length) return null;
    const f = this.frame();
    const len = this.screenSize(camera, viewH);
    const s = { x: px, y: py };
    const tol = 9;
    let best = null;
    const test = (name, points, radius = tol) => {
      for (let i = 0; i + 1 < points.length; i++) {
        const d = distToSegment(s, points[i], points[i + 1]);
        if (d < radius && (!best || d < best.d)) best = { handle: name, d };
      }
    };
    const project = (p) => camera.worldToScreen(p, viewW, viewH, { x: 0, y: 0, z: 0, visible: false });
    const o = project(f.origin);
    if (!o.visible) return null;

    const names = this.mode === GIZMO_MODE.TRANSLATE ? ['x', 'y', 'z', 'xy', 'yz', 'xz', 'xyz']
      : this.mode === GIZMO_MODE.ROTATE ? ['x', 'y', 'z', 'screen']
        : ['x', 'y', 'z', 'xyz'];

    for (const name of names) {
      if (name === 'screen') {
        const pts = this._screenRingPoints(camera, f, viewW, viewH);
        test('screen', pts, 12);
        continue;
      }
      if (name === 'xyz') {
        if (this.mode === GIZMO_MODE.TRANSLATE) {
          const c = project(f.origin);
          if (Math.hypot(s.x - c.x, s.y - c.y) < 12) return (best = { handle: 'xyz', d: 0 }).handle;
        } else {
          if (Math.hypot(s.x - o.x, s.y - o.y) < 12) return (best = { handle: 'xyz', d: 0 }).handle;
        }
        continue;
      }
      if (name.length === 2) {
        const a = f.axes[name[0] === 'x' ? 0 : name[1] === 'y' ? 1 : 2];
        const b = f.axes[name[0] === 'y' ? 1 : name[1] === 'z' ? 2 : 0];
        const off = len * 0.42;
        const center = vec3.clone(o);
        vec3.scaleAndAdd(center, center, a, off * 0.72);
        vec3.scaleAndAdd(center, center, b, off * 0.72);
        const s0 = vec3.clone(center); vec3.scaleAndAdd(s0, s0, a, -off);
        const s1 = vec3.clone(center); vec3.scaleAndAdd(s1, s1, a, off);
        const s2 = vec3.clone(center); vec3.scaleAndAdd(s2, s2, b, -off);
        const s3 = vec3.clone(center); vec3.scaleAndAdd(s3, s3, b, off);
        test(name, [project(s0), project(s1)], 8);
        test(name, [project(s2), project(s3)], 8);
        if (best && best.handle === name) return name;
        continue;
      }
      const i = { x: 0, y: 1, z: 2 }[name];
      const dir = f.axes[i];
      if (this.mode === GIZMO_MODE.ROTATE) {
        const pts = [];
        const r = len * 0.85;
        for (let k = 0; k <= 48; k++) {
          const a = (k / 48) * Math.PI * 2;
          const p = ringPoint(f.origin, dir, r, a);
          pts.push(project(p));
        }
        test(name, pts, 10);
      } else {
        const tip = project(vec3.scaleAndAdd(vec3.create(), f.origin, dir, len));
        test(name, [o, tip], name === (this.hoverHandle || '') ? tol * 1.6 : tol);
      }
    }
    return best?.handle || null;
  }

  _screenRingPoints(camera, f, viewW, viewH) {
    const pts = [];
    const r = this.screenSize(camera, viewH) * 0.85;
    for (let k = 0; k <= 48; k++) {
      const a = (k / 48) * Math.PI * 2;
      pts.push({ x: f.origin[0], y: 0, z: 0, ...camera.worldToScreen([f.origin[0] + Math.cos(a) * r, f.origin[1] + Math.sin(a) * r, f.origin[2]], viewW, viewH, {}) });
    }
    return pts;
  }

  /* ------------------------------------------------------------ dragging */

  beginDrag(handle, camera, px, py, viewW, viewH) {
    const f = this.frame();
    const r = camera.screenRay(px, py, viewW, viewH);
    const axisIndex = { x: 0, y: 1, z: 2, screen: 2 }[handle] ?? null;
    const axis = axisIndex === null ? null : (handle === 'screen' ? camera.forward : f.axes[axisIndex]);

    const drag = {
      handle,
      start: r,
      frame: { origin: vec3.clone(f.origin), axes: f.axes.map((a) => vec3.clone(a)), quat: quat.clone(f.quat) },
      startEntities: this.selection.map((e) => ({ entity: e, position: [...e.position], quaternion: [...e.quaternion], scale: [...e.scale] })),
      value: 0,
      hitStart: vec3.create(),
      delta: vec3.create(),
      planeNormal: vec3.create(),
      planePoint: vec3.clone(f.origin),
      startDistance: 0
    };

    if (handle === 'screen') {
      vec3.set(drag.planeNormal, 0, 0, 0);
      vec3.copy(drag.planeNormal, camera.forward);
    } else if (axis) {
      // A plane that contains the drag axis and faces the camera as squarely as
      // possible — the standard "closest to perpendicular" construction.
      const view = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), camera.position, f.origin));
      let n = vec3.cross(vec3.create(), axis, view);
      if (vec3.lenSq(n) < 1e-8) n = vec3.cross(vec3.create(), axis, Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]);
      vec3.normalize(n, n);
      vec3.copy(drag.planeNormal, n);
    } else {
      // Plane handle: its own plane.
      const a = f.axes[handle[0] === 'x' ? 0 : handle[1] === 'y' ? 1 : 2];
      const b = f.axes[handle[0] === 'y' ? 1 : handle[1] === 'z' ? 2 : 0];
      const n = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), a, b));
      vec3.copy(drag.planeNormal, n);
    }
    plane.normalize({ normal: drag.planeNormal, distance: vec3.dot(drag.planeNormal, f.origin) });

    const t = ray.intersectPlane(r, { normal: drag.planeNormal, distance: vec3.dot(drag.planeNormal, f.origin) });
    if (t >= 0) {
      ray.at(drag.hitStart, r, t);
    } else {
      drag.hitStart = vec3.clone(f.origin);
    }
    drag.startDistance = vec3.dist(f.origin, drag.hitStart);
    this.drag = drag;
    this.activeHandle = handle;
    return drag;
  }

  /** Solve the drag for the current mouse position and apply it to the selection. */
  updateDrag(camera, px, py, viewW, viewH) {
    const d = this.drag;
    if (!d) return null;
    const r = camera.screenRay(px, py, viewW, viewH);
    const pl = { normal: d.planeNormal, distance: vec3.dot(d.planeNormal, d.planePoint) };
    const t = ray.intersectPlane(r, pl);
    if (t < 0) return null;
    const hit = vec3.create();
    ray.at(hit, r, t);
    const origin = d.frame.origin;

    if (this.mode === GIZMO_MODE.TRANSLATE) {
      const raw = vec3.sub(vec3.create(), hit, d.hitStart);
      let delta;
      if (d.handle.length === 1 && d.handle !== 'screen') {
        const axis = d.frame.axes[{ x: 0, y: 1, z: 2 }[d.handle]];
        delta = vec3.scale(vec3.create(), axis, vec3.dot(raw, axis));
      } else if (d.handle === 'screen') {
        delta = raw;
      } else {
        delta = raw;
      }
      if (this.snap.enabled && this.snap.translate > 0) {
        const q = Math.max(this.snap.translate, 1e-4);
        delta[0] = Math.round(delta[0] / q) * q;
        delta[1] = Math.round(delta[1] / q) * q;
        delta[2] = Math.round(delta[2] / q) * q;
      }
      vec3.copy(d.delta, delta);
      for (const s of d.startEntities) {
        const local = worldToLocalDelta(delta, s.entity, d.frame.origin);
        s.entity.position = [s.position[0] + local[0], s.position[1] + local[1], s.position[2] + local[2]];
      }
      return { delta, label: `Δ ${vec3.len(delta).toFixed(3)} m` };
    }

    if (this.mode === GIZMO_MODE.ROTATE) {
      let axis;
      if (d.handle === 'screen') axis = d.frame.axes[2];
      else axis = d.frame.axes[{ x: 0, y: 1, z: 2 }[d.handle]];
      const v0 = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), d.hitStart, origin));
      const v1 = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), hit, origin));
      const cosA = clamp(vec3.dot(v0, v1), -1, 1);
      const dirSign = Math.sign(vec3.dot(vec3.cross(vec3.create(), v0, v1), axis)) || 1;
      let deg = Math.acos(cosA) * RAD2DEG * dirSign;
      if (this.snap.enabled && this.snap.rotate > 0) {
        deg = Math.round(deg / this.snap.rotate) * this.snap.rotate;
      }
      d.delta[0] = deg;
      for (const s of d.startEntities) {
        const localAxis = worldToLocalAxis(axis, s.entity);
        const q = quat.fromAxisAngle(quat.create(), localAxis, (deg * Math.PI) / 180);
        quat.multiply(s.entity.quaternion, q, s.quaternion);
        quat.normalize(s.entity.quaternion, s.entity.quaternion);
      }
      return { delta: [deg, 0, 0], label: `${deg.toFixed(1)}°` };
    }

    // Scale
    let factor;
    if (d.handle === 'xyz') {
      const d0 = Math.max(vec3.dist(d.hitStart, origin), 1e-4);
      const d1 = Math.max(vec3.dist(hit, origin), 1e-4);
      factor = d1 / d0;
    } else {
      const axis = d.frame.axes[{ x: 0, y: 1, z: 2 }[d.handle]];
      const a0 = vec3.dot(vec3.sub(vec3.create(), d.hitStart, origin), axis);
      const a1 = vec3.dot(vec3.sub(vec3.create(), hit, origin), axis);
      factor = clamp((d0Safe(a0, axis) + a1) / Math.max(Math.abs(a0), 1e-4), 0.01, 1e3);
      if (a0 < 0) factor = clamp(factor, 0.01, 1e3);
    }
    if (this.snap.enabled && this.snap.scale > 0) {
      const q = Math.max(this.snap.scale, 1e-3);
      factor = Math.max(q, Math.round(factor / q) * q);
    }
    d.delta[0] = factor;
    for (const s of d.startEntities) {
      if (d.handle === 'xyz') {
        s.entity.scale = [s.scale[0] * factor, s.scale[1] * factor, s.scale[2] * factor];
      } else {
        const i = { x: 0, y: 1, z: 2 }[d.handle];
        const ns = [...s.scale];
        ns[i] = Math.max(1e-3, s.scale[i] * factor);
        s.entity.scale = ns;
      }
    }
    return { delta: [factor, 0, 0], label: `×${factor.toFixed(3)}` };
  }

  endDrag() {
    const d = this.drag;
    this.drag = null;
    this.activeHandle = null;
    return d;
  }

  setMode(mode) { this.mode = mode; this.hoverHandle = null; }
  setSpace(space) { this.space = space; }
  toggleSpace() { this.space = this.space === GIZMO_SPACE.WORLD ? GIZMO_SPACE.LOCAL : GIZMO_SPACE.WORLD; return this.space; }
  toggleSnap() { this.snap.enabled = !this.snap.enabled; return this.snap.enabled; }
  setVisible(v) { this.visible = v; if (!v) { this.hoverHandle = null; this.endDrag(); } }
}

/* ------------------------------------------------------------ primitives */

function distToSegment(p, a, b) {
  if (!a?.visible || !b?.visible) return Infinity;
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
  t = clamp(t, 0, 1);
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

function ringPoint(origin, normal, radius, angle) {
  const ref = Math.abs(normal[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const right = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), normal, ref));
  const up = vec3.cross(vec3.create(), normal, right);
  return [
    origin[0] + right[0] * Math.cos(angle) * radius + up[0] * Math.sin(angle) * radius,
    origin[1] + right[1] * Math.cos(angle) * radius + up[1] * Math.sin(angle) * radius,
    origin[2] + right[2] * Math.cos(angle) * radius + up[2] * Math.sin(angle) * radius
  ];
}

function ring(batch, origin, normal, radius, width, color, segments) {
  let prev = null;
  for (let i = 0; i <= segments; i++) {
    const p = ringPoint(origin, normal, radius, (i / segments) * Math.PI * 2);
    if (prev) ribbon(batch, prev, p, origin, width, color);
    prev = p;
  }
}

function ribbon(batch, a, b, origin, width, color) {
  const dir = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), b, a));
  const toO = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), origin, vec3.lerp(vec3.create(), a, b, 0.5)));
  let n = vec3.cross(vec3.create(), dir, toO);
  if (vec3.lenSq(n) < 1e-9) n = vec3.cross(vec3.create(), dir, [0, 1, 0]);
  vec3.normalize(n, n);
  vec3.scale(n, n, width * 0.5);
  batch.quad(
    [a[0] + n[0], a[1] + n[1], a[2] + n[2]],
    [b[0] + n[0], b[1] + n[1], b[2] + n[2]],
    [b[0] - n[0], b[1] - n[1], b[2] - n[2]],
    [a[0] - n[0], a[1] - n[1], a[2] - n[2]],
    color
  );
}

function cylinder(batch, from, to, r0, r1, color, segments) {
  const axis = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), to, from));
  const ref = Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const right = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), axis, ref));
  const up = vec3.cross(vec3.create(), axis, right);
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2, a1 = ((i + 1) / segments) * Math.PI * 2;
    const p00 = offset(from, right, up, Math.cos(a0) * r0, Math.sin(a0) * r0);
    const p10 = offset(from, right, up, Math.cos(a1) * r0, Math.sin(a1) * r0);
    const p01 = offset(to, right, up, Math.cos(a1) * r1, Math.sin(a1) * r1);
    const p11 = offset(to, right, up, Math.cos(a0) * r1, Math.sin(a0) * r1);
    batch.quad(p00, p10, p01, p11, color);
    // Cap the far end so the handle reads as solid from every angle.
    if (r1 > 1e-5) batch.tri(offset(to, right, up, 0, 0), p11, p01, color);
  }
}

function cone(batch, from, to, radius, height, color, segments) {
  const axis = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), to, from));
  const ref = Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const right = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), axis, ref));
  const up = vec3.cross(vec3.create(), axis, right);
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2, a1 = ((i + 1) / segments) * Math.PI * 2;
    const p0 = offset(to, right, up, Math.cos(a0) * radius, Math.sin(a0) * radius);
    const p1 = offset(to, right, up, Math.cos(a1) * radius, Math.sin(a1) * radius);
    const base = vec3.scaleAndAdd(vec3.create(), to, axis, -height);
    batch.tri(to, p0, p1, color);
    batch.tri(base, p1, p0, color);
  }
}

function box(batch, center, axis, size, color) {
  const ref = Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const right = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), axis, ref));
  const up = vec3.cross(vec3.create(), axis, right);
  const c = [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v], i) => {
    const p = vec3.clone(center);
    vec3.scaleAndAdd(p, p, right, u * size);
    vec3.scaleAndAdd(p, p, up, v * size);
    vec3.scaleAndAdd(p, p, axis, i < 4 ? -size : size);
    return p;
  });
  for (const f of [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [3, 2, 6, 7], [0, 3, 7, 4], [1, 2, 6, 5]]) {
    batch.quad(c[f[0]], c[f[1]], c[f[2]], c[f[3]], color);
  }
}

function sphere(batch, center, radius, color, segments = 12, rings = 8) {
  for (let y = 0; y < rings; y++) {
    for (let x = 0; x < segments; x++) {
      const t0 = (y / rings) * Math.PI, t1 = ((y + 1) / rings) * Math.PI;
      const p0 = (x / segments) * Math.PI * 2, p1 = ((x + 1) / segments) * Math.PI * 2;
      const a = sph(center, radius, t0, p0);
      const b = sph(center, radius, t0, p1);
      const c = sph(center, radius, t1, p1);
      const d = sph(center, radius, t1, p0);
      batch.quad(a, b, c, d, color);
    }
  }
}

function sph(c, r, theta, phi) {
  return [
    c[0] + r * Math.sin(theta) * Math.cos(phi),
    c[1] + r * Math.cos(theta),
    c[2] + r * Math.sin(theta) * Math.sin(phi)
  ];
}

function offset(base, right, up, x, y) {
  return [
    base[0] + right[0] * x + up[0] * y,
    base[1] + right[1] * x + up[1] * y,
    base[2] + right[2] * x + up[2] * y
  ];
}

function d0Safe(a0, axis) { return a0 < 0 ? -a0 : a0; }

function worldToLocalDelta(delta, entity, pivotWorld) {
  // Move in world space, but around a shared pivot: convert the delta into the
  // parent's space of the entity being moved.
  const parent = entity.parent || { worldMatrix: null };
  if (!parent.worldMatrix) return delta;
  const inv = mat4.invert(mat4.create(), parent.worldMatrix);
  if (!inv) return delta;
  const out = vec3.create();
  vec3.transformMat4Dir(out, delta, inv);
  void pivotWorld;
  return out;
}

function worldToLocalAxis(axis, entity) {
  const parent = entity.parent || { worldMatrix: null };
  if (!parent.worldMatrix) return axis;
  const inv = mat4.invert(mat4.create(), parent.worldMatrix);
  if (!inv) return axis;
  const out = vec3.create();
  vec3.transformMat4Dir(out, axis, inv);
  return vec3.normalize(out, out);
}
