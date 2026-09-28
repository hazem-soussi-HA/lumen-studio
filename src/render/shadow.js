/**
 * Cascaded shadow maps for the directional (sun) light.
 *
 * WebGL 1 exposes neither sampler2DShadow arrays nor a way to render to a
 * depth-and-sample-in-one pass (that arrived with ES 3.0 framebuffer objects).
 * So: two orthographic depth targets, `sampler2DShadow` when
 * `WEBGL_depth_texture` is present, otherwise RGBA8 with the depth packed by the
 * depth shader. Cascades are fitted in light space around the sub-frustum, which
 * is what keeps texel density roughly uniform and the bias small.
 */

import { mat4, vec3, aabb, clamp } from '../core/math.js';

const _v = vec3.create();
import { RenderTarget } from '../gl/framebuffer.js';

const CORNERS = [
  [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
  [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]
];

export class ShadowCascade {
  constructor(ctx, size, name) {
    this.ctx = ctx;
    this.size = size;
    this.packed = !ctx.caps.limits.depthTexture;
    this.target = new RenderTarget(ctx, {
      name,
      width: size, height: size,
      count: 1,
      hdr: false,
      depth: this.packed ? 'renderbuffer' : 'texture',
      filter: 'linear',
      wrap: 'clamp',
      mips: false,
      // Packed path writes depth into the colour attachment; the depth-texture
      // path must leave the colour draw buffer switched off, because the depth
      // program declares no colour output there and ES 3.0 rejects a draw whose
      // active draw buffers have no matching fragment output.
      colorWrite: this.packed
    });
    this.view = mat4.create();
    this.proj = mat4.create();
    this.viewProj = mat4.create();
    this.texelWorldSize = 1;
    this.radius = 0;
    this.bias = 0.0005;
    this.center = vec3.create();
    if (!this.packed) this._prepareDepthSampling();
  }

  /**
   * The PBR shader declares `sampler2DShadow` whenever hardware PCF is on, so the
   * depth texture must carry TEXTURE_COMPARE_MODE = COMPARE_REF_TO_TEXTURE.
   * A plain sampler2D on a compare-mode texture — or a shadow sampler on a normal
   * one — is a type mismatch, and the failure is not an exception: the whole draw
   * call is dropped, so the symptom is a silently black viewport.
   */
  _prepareDepthSampling() {
    this.target.depthTexture?.setCompareMode(true);
  }

  get texture() { return this.target.depthTexture || this.target.texture; }
  get texel() { return [1 / this.size, 1 / this.size]; }

  dispose() { this.target.dispose(); }
}

export class ShadowSystem {
  constructor(ctx, { cascadeCount = 2, resolution = 2048, log } = {}) {
    this.ctx = ctx;
    this.log = log;
    this.cascadeCount = cascadeCount;
    this.resolution = resolution;
    this.cascades = [];
    this.lightDir = [0.3, -1, 0.4];
    this.shadowDistance = 60;
    this.bias = 0.2;
    this.strength = 1;
    this.enabled = true;
    this.rendered = 0;
    this._allocate();
  }

  _allocate() {
    for (const c of this.cascades) c.dispose();
    this.cascades = [];
    for (let i = 0; i < this.cascadeCount; i++) {
      this.cascades.push(new ShadowCascade(this.ctx, this.resolution, `shadow.c${i}`));
    }
  }

  setResolution(res) {
    if (res === this.resolution) return;
    this.resolution = res;
    this._allocate();
  }

  setCascadeCount(n) {
    if (n === this.cascadeCount) return;
    this.cascadeCount = clamp(n, 1, 4);
    this._allocate();
  }

  /** Practical split scheme: blend logarithmic and uniform distributions. */
  splits(near, far, n = this.cascadeCount, lambda = 0.72) {
    const out = [];
    const log = far / Math.max(near, 1e-4);
    for (let i = 1; i <= n; i++) {
      const p = i / n;
      const d = lambda * (near * Math.pow(log, p)) + (1 - lambda) * (near + (far - near) * p);
      out.push(d);
    }
    return out;
  }

  /**
   * Fit each cascade around the camera sub-frustum in light space, snapped to the
   * shadow-map texel grid so the shadow edges do not crawl while the camera moves.
   * @param {Camera} camera
   * @param {import('../core/math.js').Aabb[]} casters world-space AABBs of casters
   */
  update(camera, casters = []) {
    const dist = Math.min(this.shadowDistance, camera.far);
    this.splits(camera.near, dist);
    const lightDir = this.lightDir;
    const up = Math.abs(lightDir[1]) > 0.98 ? [0, 0, 1] : [0, 1, 0];

    for (let i = 0; i < this.cascades.length; i++) {
      const cascade = this.cascades[i];
      const near = i === 0 ? camera.near : this.splits[i - 1];
      const far = this.splits[i] ?? dist;

      // 1. World-space volume this cascade must cover.
      const box = aabb.create();
      for (const c of CORNERS) {
        const z = c[2] < 0 ? near : far;
        const p = camera.unproject(c[0], c[1], z);
        aabb.addPoint(box, p[0], p[1], p[2]);
      }
      for (const c of casters) {
        const dx = (c.min[0] + c.max[0]) * 0.5 - camera.position[0];
        const dy = (c.min[1] + c.max[1]) * 0.5 - camera.position[1];
        const dz = (c.min[2] + c.max[2]) * 0.5 - camera.position[2];
        if (Math.hypot(dx, dy, dz) < far * 1.6) aabb.addAABB(box, c);
      }

      const center = aabb.center(vec3.create(), box);
      const radius = vec3.len(aabb.size(vec3.create(), box)) * 0.5;
      vec3.copy(cascade.center, center);

      // 2. Light view, then the exact extent of the volume in light space.
      const eye = [
        center[0] - lightDir[0] * dist,
        center[1] - lightDir[1] * dist,
        center[2] - lightDir[2] * dist
      ];
      mat4.lookAt(cascade.view, eye, center, up);

      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (let k = 0; k < 8; k++) {
        const corner = [
          k & 1 ? box.max[0] : box.min[0],
          k & 2 ? box.max[1] : box.min[1],
          k & 4 ? box.max[2] : box.min[2]
        ];
        const p = vec3.transformMat4(_v, corner, cascade.view);
        minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
        minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
        minZ = Math.min(minZ, p[2]); maxZ = Math.max(maxZ, p[2]);
      }

      // 3. Texel snapping: quantise the centre in the shadow map's own grid.
      const texel = (maxX - minX) / this.resolution;
      const cx = (minX + maxX) * 0.5;
      const cy = (minY + maxY) * 0.5;
      const sx = Math.round(cx / texel) * texel;
      const sy = Math.round(cy / texel) * texel;

      const halfW = Math.max((maxX - minX) * 0.5, texel);
      const halfH = Math.max((maxY - minY) * 0.5, texel);
      // Light space looks down -Z, so the near plane is the *closest* depth.
      const zNear = Math.max(0.05, -maxZ);
      const zFar = Math.max(zNear + 0.1, -minZ);
      mat4.ortho(cascade.proj, halfW, halfH, zNear, zFar);
      cascade.proj[12] = sx;
      cascade.proj[13] = sy;
      mat4.multiply(cascade.viewProj, cascade.proj, cascade.view);

      cascade.texelWorldSize = texel;
      cascade.radius = Math.max(halfW, halfH);
      // Bias in normalised depth: proportional to the depth range of the slice.
      cascade.bias = (this.bias * (zFar - zNear)) / 1000;
    }
    return this;
  }

  get splitDistance() { return this.splits[this.splits.length - 1] || 100; }

  dispose() { for (const c of this.cascades) c.dispose(); this.cascades = []; }
}
