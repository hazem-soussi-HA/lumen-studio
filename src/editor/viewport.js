/**
 * Viewport — canvas, camera controller, pointer routing, picking and capture.
 *
 * Input model (documented in the shortcuts overlay):
 *   LMB              select / gizmo drag
 *   LMB + drag empty orbit, LMB + Alt  orbit, LMB + Shift  box-free pan
 *   RMB drag         pan        MMB drag  orbit      wheel  dolly
 *   Ctrl + RMB       focus the entity under the cursor
 *   WASD / QE        fly forward-back / up-down (hold Shift to sprint)
 *   F                frame the selection      G  toggle the grid
 */

import { Camera } from '../render/camera.js';
import { vec3, mat4, quat, clamp, rad, deg, aabb, damp } from '../core/math.js';
import { h } from './widgets.js';

export class Viewport {
  constructor(app, canvas) {
    this.app = app;
    this.canvas = canvas;
    this.camera = new Camera({ position: [0, 1.5, 6] });
    this.camera.near = 0.05;
    this.camera.far = 2000;

    // Orbit state.
    this.target = vec3.create(0, 0, 0);
    this.distance = 7;
    this.yaw = -35;
    this.pitch = -18;
    this.fov = 50;
    this.ortho = false;
    this.orthoHeight = 5;

    this.keys = new Set();
    this.pointers = new Map();
    this.mode = null;             // 'orbit' | 'pan' | 'gizmo' | 'select' | 'none'
    this.lastPointer = { x: 0, y: 0 };
    this.hoverEntity = null;
    this.dragResult = null;
    this.showAxisWidget = true;
    this.axisCanvas = document.getElementById('axisCanvas');
    this.axisCtx = this.axisCanvas?.getContext('2d');
    this._resized = true;
    this._fpsSamples = [];
    this._fps = 0;
    this._lastFrameTime = performance.now();

    this._bindEvents();
  }

  /* --------------------------------------------------------------- sizing */

  get width() { return this.canvas.clientWidth || 1; }
  get height() { return this.canvas.clientHeight || 1; }

  markResized() { this._resized = true; }

  syncSize() {
    if (!this._resized) return false;
    this._resized = false;
    this.camera.setAspect(this.width / this.height);
    return true;
  }

  /* -------------------------------------------------------------- camera */

  updateCamera(dt = 1 / 60) {
    // Keyboard fly.
    const speed = (this.keys.has('shift') ? 6 : 1.6) * Math.max(this.distance, 1) * dt;
    const fwd = [Math.sin(rad(this.yaw)) * -Math.cos(rad(this.pitch)), Math.sin(rad(this.pitch)), Math.cos(rad(this.yaw)) * -Math.cos(rad(this.pitch))];
    const right = [Math.cos(rad(this.yaw)), 0, -Math.sin(rad(this.yaw))];
    let moved = false;
    if (this.keys.has('w')) { vec3.scaleAndAdd(this.target, this.target, fwd, speed); moved = true; }
    if (this.keys.has('s')) { vec3.scaleAndAdd(this.target, this.target, fwd, -speed); moved = true; }
    if (this.keys.has('a')) { vec3.scaleAndAdd(this.target, this.target, right, -speed); moved = true; }
    if (this.keys.has('d')) { vec3.scaleAndAdd(this.target, this.target, right, speed); moved = true; }
    if (this.keys.has('q')) { this.target[1] -= speed; moved = true; }
    if (this.keys.has('e')) { this.target[1] += speed; moved = true; }
    if (moved) this._syncCamera();

    if (this.ortho) {
      this.camera.projectionType = 'orthographic';
      this.camera.orthoHeight = this.orthoHeight;
    } else {
      this.camera.projectionType = 'perspective';
      this.camera.fov = this.fov;
    }
    this.camera.near = Math.max(0.02, this.distance * 0.001);
    this.camera.far = Math.max(50, this.distance * 20);
    this.camera.setAspect(this.width / this.height);
    this._syncCamera();
  }

  _syncCamera() {
    const p = this.camera.position;
    const cp = Math.cos(rad(this.pitch));
    p[0] = this.target[0] + Math.sin(rad(this.yaw)) * -cp * this.distance;
    p[1] = this.target[1] + Math.sin(rad(this.pitch)) * -this.distance;
    p[2] = this.target[2] + Math.cos(rad(this.yaw)) * -cp * this.distance;
    if (this.pitch > 89.5) p[1] = this.target[1] + this.distance;
    if (this.pitch < -89.5) p[1] = this.target[1] - this.distance;
    mat4.lookAt(_view, p, this.target, [0, 1, 0]);
    // lookAt returns the *view* matrix; the camera stores a world rotation, and
    // the world's basis is the view's transposed one. Inverting recovers both the
    // world rotation and the eye translation in one step.
    mat4.invert(_world, _view);
    quat.fromMat4Basis(this.camera.rotation, _world);
    this.camera._sync();
  }

  focusBox(box, { instant = false } = {}) {
    if (!box || aabb.isEmpty(box)) return;
    const c = aabb.center(_v1, box);
    const s = aabb.size(_v2, box);
    const radius = Math.max(vec3.len(s) * 0.5, 0.25);
    const dist = this.camera.distanceToFit(radius * 1.6);
    if (instant) {
      vec3.copy(this.target, c);
      this.distance = dist;
    } else {
      this._focusTween = { from: vec3.clone(this.target), to: vec3.clone(c), fromD: this.distance, toD: dist, t: 0 };
    }
  }

  focusEntity(entity, opts) {
    if (entity) this.focusBox(entity.worldAABB, opts);
  }

  stepFocusTween(dt) {
    const tw = this._focusTween;
    if (!tw) return;
    tw.t = Math.min(1, tw.t + dt * 4.5);
    const k = 1 - Math.pow(1 - tw.t, 3);
    vec3.lerp(this.target, tw.from, tw.to, k);
    this.distance = tw.fromD + (tw.toD - tw.fromD) * k;
    if (tw.t >= 1) this._focusTween = null;
  }

  setView(preset) {
    const d = this.distance;
    const t = this.target;
    const map = {
      front: [0, 0], back: [180, 0], left: [90, 0], right: [-90, 0],
      top: [0, -89.9], bottom: [0, 89.9], iso: [-35, -22]
    };
    const p = map[preset] || map.iso;
    this.yaw = p[0];
    this.pitch = p[1];
    if (preset === 'top' || preset === 'bottom') this.target[1] = t[1];
    this._syncCamera();
  }

  setOrtho(on) {
    this.ortho = on;
    this._syncCamera();
  }

  dolly(delta) {
    this.distance = clamp(this.distance * Math.pow(1.0015, delta), 0.02, 5000);
  }

  /* -------------------------------------------------------------- events */

  _bindEvents() {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    window.addEventListener('pointermove', (e) => this._onPointerMove(e));
    window.addEventListener('pointerup', (e) => this._onPointerUp(e));
    c.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    c.addEventListener('dblclick', (e) => this._onDoubleClick(e));
    c.addEventListener('pointerleave', () => {
      this.app.scene.setHover(null);
      this.hoverEntity = null;
    });
  }

  _localPoint(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _onPointerDown(e) {
    this.canvas.focus();
    this.canvas.setPointerCapture?.(e.pointerId);
    const p = this._localPoint(e);
    this.lastPointer = p;
    this.pointers.set(e.pointerId, { ...p, button: e.button });

    if (e.button === 0 && !e.altKey) {
      const gizmo = this.app.gizmo;
      const handle = gizmo.visible && gizmo.enabled ? gizmo.hitTest(this.camera, p.x, p.y, this.width, this.height) : null;
      if (handle) {
        this.mode = 'gizmo';
        gizmo.beginDrag(handle, this.camera, p.x, p.y, this.width, this.height);
        this.app.beginTransform('gizmo');
      } else {
        this.mode = 'select';
      }
    } else if (e.button === 0 && e.altKey) {
      this.mode = 'orbit';
    } else if (e.button === 2) {
      this.mode = e.ctrlKey ? 'focus' : 'pan';
    } else if (e.button === 1) {
      this.mode = e.shiftKey ? 'pan' : 'orbit';
    }
    e.preventDefault();
  }

  _onPointerMove(e) {
    const p = this._localPoint(e);
    const dx = p.x - this.lastPointer.x;
    const dy = p.y - this.lastPointer.y;
    this.lastPointer = p;
    this.mouse = p;

    switch (this.mode) {
      case 'orbit': this._orbit(dx, dy); break;
      case 'pan': this._pan(dx, dy); break;
      case 'gizmo': {
        const res = this.app.gizmo.updateDrag(this.camera, p.x, p.y, this.width, this.height);
        this.dragResult = res;
        if (res) this.app.setStatus(res.label);
        this.app.requestRender();
        break;
      }
      case 'select': {
        // Drag on empty space orbits; a click without movement selects.
        if (Math.abs(dx) + Math.abs(dy) > 3) this.mode = 'orbit';
        break;
      }
      default: {
        this._updateHover(p);
        const gizmo = this.app.gizmo;
        const handle = gizmo.visible && gizmo.enabled && !e.buttons ? gizmo.hitTest(this.camera, p.x, p.y, this.width, this.height) : null;
        if (handle !== gizmo.hoverHandle) {
          gizmo.hoverHandle = handle;
          this.canvas.style.cursor = handle ? 'grab' : 'default';
          this.app.requestRender();
        }
      }
    }
  }

  _onPointerUp(e) {
    const p = this._localPoint(e);
    if (this.mode === 'select') {
      const hit = this._pick(p.x, p.y);
      this.app.selectAt(hit, e.shiftKey || e.ctrlKey || e.metaKey);
    } else if (this.mode === 'gizmo') {
      this.app.endTransform(this.dragResult);
    } else if (this.mode === 'focus') {
      const hit = this._pick(p.x, p.y);
      if (hit) this.focusEntity(hit);
    }
    this.pointers.delete(e.pointerId);
    this.mode = null;
    this.dragResult = null;
    this.app.requestRender();
  }

  _onDoubleClick(e) {
    const p = this._localPoint(e);
    const hit = this._pick(p.x, p.y);
    if (hit) {
      this.app.gizmo.pivotMode = this.app.gizmo.pivotMode === 'pivot' ? 'center' : 'pivot';
      this.focusEntity(hit);
    }
  }

  _onWheel(e) {
    e.preventDefault();
    if (e.ctrlKey) {
      this.fov = clamp(this.fov * (1 + Math.sign(e.deltaY) * 0.06), 8, 120);
    } else {
      this.dolly(e.deltaY * (e.deltaMode === 1 ? 16 : 1));
    }
    this._syncCamera();
    this.app.requestRender();
  }

  _orbit(dx, dy) {
    this.yaw -= dx * 0.32;
    this.pitch = clamp(this.pitch - dy * 0.32, -89.9, 89.9);
    this._syncCamera();
    this.app.requestRender();
  }

  _pan(dx, dy) {
    // Pan in the camera's screen plane, scaled so 1 px ≈ 1 px at the target depth.
    const scale = (2 * Math.tan(rad(this.camera.fov) / 2) * this.distance) / this.height;
    const right = [this.camera.right[0], this.camera.right[1], this.camera.right[2]];
    const up = [this.camera.up[0], this.camera.up[1], this.camera.up[2]];
    vec3.scaleAndAdd(this.target, this.target, right, -dx * scale);
    vec3.scaleAndAdd(this.target, this.target, up, dy * scale);
    this._syncCamera();
    this.app.requestRender();
  }

  _updateHover(p) {
    if (this.app.isDragging()) return;
    const hit = this._pick(p.x, p.y);
    if (hit !== this.hoverEntity) {
      this.hoverEntity = hit;
      this.app.scene.setHover(hit);
      this.app.requestRender();
    }
  }

  _pick(x, y) {
    return this.app.renderer.pick(this.app.scene, this.camera, x, y, {
      width: this.width, height: this.height
    });
  }

  /* -------------------------------------------------------------- capture */

  /** Screenshot including the current frame (needs preserveDrawingBuffer or a
   *  same-frame read; we re-render into the canvas then copy synchronously). */
  async screenshot(filename = 'lumen.png') {
    this.app.renderNow();
    const blob = await new Promise((res) => this.canvas.toBlob(res, 'image/png'));
    if (blob) {
      const { downloadBlob } = await import('../core/utils.js');
      downloadBlob(blob, filename);
    }
    return blob;
  }

  /* ------------------------------------------------------------- widgets */

  drawAxisWidget() {
    if (!this.axisCtx) return;
    const g = this.axisCtx;
    const w = this.axisCanvas.width, h = this.axisCanvas.height;
    g.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2, r = w * 0.32;
    const view = mat4.copy(mat4.create(), this.camera.view);
    const axes = [
      { v: [1, 0, 0], label: 'X', color: '#f2555c' },
      { v: [0, 1, 0], label: 'Y', color: '#7ee06a' },
      { v: [0, 0, 1], label: 'Z', color: '#5b8cff' }
    ];
    const items = axes.map((a) => {
      const x = a.v[0] * view[0] + a.v[1] * view[4] + a.v[2] * view[8];
      const y = a.v[0] * view[1] + a.v[1] * view[5] + a.v[2] * view[9];
      const z = a.v[0] * view[2] + a.v[1] * view[6] + a.v[2] * view[10];
      return { ...a, sx: cx + x * r, sy: cy - y * r, depth: z };
    }).sort((a, b) => a.depth - b.depth);
    g.lineWidth = 1.5;
    for (const it of items) {
      g.strokeStyle = it.color;
      g.globalAlpha = it.depth > 0 ? 0.95 : 0.4;
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(it.sx, it.sy);
      g.stroke();
    }
    g.globalAlpha = 1;
    g.font = '600 10px ui-monospace, monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const it of items) {
      g.fillStyle = it.color;
      g.beginPath();
      g.arc(it.sx, it.sy, 9, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#0b0e13';
      g.fillText(it.label, it.sx, it.sy + 0.5);
    }
  }

  fps(dt) {
    const now = performance.now();
    const frame = now - this._lastFrameTime;
    this._lastFrameTime = now;
    this._fpsSamples.push(frame);
    if (this._fpsSamples.length > 30) this._fpsSamples.shift();
    const avg = this._fpsSamples.reduce((a, b) => a + b, 0) / this._fpsSamples.length;
    this._fps = 1000 / Math.max(avg, 0.001);
    this._cpuFrame = frame;
    return this._fps;
  }
}

const _view = mat4.create();
const _world = mat4.create();
const _v1 = vec3.create();
const _v2 = vec3.create();
