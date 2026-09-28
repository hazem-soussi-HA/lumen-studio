/**
 * Dynamic geometry batches.
 *
 * Everything the editor draws *about* the scene rather than *of* the scene —
 * grid lines, selection wireframes, transform gizmos, light helpers, camera
 * frusta, picking highlights, measurement rulers — goes through these batches.
 * They are rebuilt every frame into one interleaved stream (position + colour),
 * so an editor with 10 000 wireframe lines still issues a single draw call.
 */

import { BufferObject } from './buffer.js';

export const DYN_STRIDE = 7 * 4; // pos(3) + colour(4)

export class DynamicBatch {
  constructor(ctx, { name = 'batch', maxVertices = 8192, primitive = 'lines' } = {}) {
    this.ctx = ctx;
    this.gl = ctx.gl;
    this.name = name;
    this.primitive = primitive;
    this.maxVertices = maxVertices;
    this.data = new Float32Array(maxVertices * 7);
    this.count = 0;
    this.buffer = new BufferObject(ctx, { name, data: this.data, usage: 'stream' });
    this._vao = null;
    this._bound = false;
  }

  begin() { this.count = 0; return this; }

  get remaining() { return this.maxVertices - this.count; }

  _ensure(n) {
    if (this.count + n <= this.maxVertices) return true;
    this._grow(this.count + n);
    return true;
  }

  _grow(need) {
    this.maxVertices = Math.max(need, Math.ceil(this.maxVertices * 1.75));
    const next = new Float32Array(this.maxVertices * 7);
    next.set(this.data.subarray(0, this.count * 7));
    this.data = next;
    this.buffer.data = next;
    this.buffer.byteLength = next.byteLength;
  }

  vertex(x, y, z, c) {
    if (!this._ensure(1)) return false;
    const o = this.count * 7;
    this.data[o] = x; this.data[o + 1] = y; this.data[o + 2] = z;
    this.data[o + 3] = c[0]; this.data[o + 4] = c[1]; this.data[o + 5] = c[2];
    this.data[o + 6] = c[3] === undefined ? 1 : c[3];
    this.count++;
    return true;
  }

  line(ax, ay, az, bx, by, bz, c) { this.vertex(ax, ay, az, c); return this.vertex(bx, by, bz, c); }
  lineV(a, b, c) { return this.line(a[0], a[1], a[2], b[0], b[1], b[2], c); }

  tri(a, b, c, col) {
    this.vertex(a[0], a[1], a[2], col);
    this.vertex(b[0], b[1], b[2], col);
    this.vertex(c[0], c[1], c[2], col);
    return this;
  }

  quad(a, b, c, d, col) { this.tri(a, b, c, col); return this.tri(a, c, d, col); }

  /** Transformed AABB: 12 edges. */
  aabb(box, color, transform = null) {
    const c = [];
    for (let i = 0; i < 8; i++) {
      const p = [
        i & 1 ? box.max[0] : box.min[0],
        i & 2 ? box.max[1] : box.min[1],
        i & 4 ? box.max[2] : box.min[2]
      ];
      c.push(transform ? xf(transform, p) : p);
    }
    const E = [[0, 1], [1, 3], [3, 2], [2, 0], [4, 5], [5, 7], [7, 6], [6, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    for (const [a, b] of E) this.lineV(c[a], c[b], color);
    return this;
  }

  sphereLines(center, radius, color, segments = 24, rings = 12) {
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2, a1 = ((i + 1) / segments) * Math.PI * 2;
      for (let j = 0; j < rings; j++) {
        const b0 = (j / rings) * Math.PI, b1 = ((j + 1) / rings) * Math.PI;
        if (i > 0) this.lineV(sph(center, radius, a0, b0), sph(center, radius, a1, b0), color);
        if (j > 0) this.lineV(sph(center, radius, a0, b0), sph(center, radius, a0, b1), color);
      }
    }
    return this;
  }

  /**
   * Camera-facing quad used for "thick" lines. gl.lineWidth is clamped to 1 by
   * `ALIASED_LINE_WIDTH_RANGE` on virtually every WebGL implementation, so any
   * screen-space width is geometry, not a state change. `view` is the camera
   * world matrix, `right`/`up` the screen basis.
   */
  thickLine(a, b, color, width, right, up) {
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    // Project the segment onto the screen basis, then take the 2D normal.
    const sx = d[0] * right[0] + d[1] * right[1] + d[2] * right[2];
    const sy = d[0] * up[0] + d[1] * up[1] + d[2] * up[2];
    let nx = -sy, ny = sx;
    const len = Math.hypot(nx, ny);
    if (len < 1e-5) { nx = 0; ny = 0; }
    else { nx = (nx / len) * width; ny = (ny / len) * width; }
    const ox = right[0] * nx + up[0] * ny;
    const oy = right[1] * nx + up[1] * ny;
    const oz = right[2] * nx + up[2] * ny;
    return this.quad(
      [a[0] + ox, a[1] + oy, a[2] + oz],
      [b[0] + ox, b[1] + oy, b[2] + oz],
      [b[0] - ox, b[1] - oy, b[2] - oz],
      [a[0] - ox, a[1] - oy, a[2] - oz],
      color
    );
  }

  end() {
    if (!this.count) return this;
    this.buffer.upload(this.data.subarray(0, this.count * 7));
    return this;
  }

  draw(program) {
    if (!this.count) return false;
    const gl = this.gl;
    this.ctx.bindVAO(this.ctx.cachedVAO(this, '_vao'));
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer.handle);
    const lp = program.attributes.get('aPosition')?.loc;
    const lc = program.attributes.get('aColor')?.loc;
    if (lp !== undefined && lp >= 0) {
      gl.enableVertexAttribArray(lp);
      gl.vertexAttribPointer(lp, 3, gl.FLOAT, false, DYN_STRIDE, 0);
    }
    if (lc !== undefined && lc >= 0) {
      gl.enableVertexAttribArray(lc);
      gl.vertexAttribPointer(lc, 4, gl.FLOAT, false, DYN_STRIDE, 12);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    const mode = this.primitive === 'triangles' ? gl.TRIANGLES : this.primitive === 'lineStrip' ? gl.LINE_STRIP : gl.LINES;
    if (this.ctx.caps.isWebGL2) gl.drawArrays(mode, 0, this.count);
    else {
      const ext = this.ctx.ext.multiDraw;
      if (ext) ext.multiDrawArraysWEBGL(mode, null, 0, 0, this.count);
      else gl.drawArrays(mode, 0, this.count);
    }
    this.ctx.debug.draws++;
    return true;
  }

  dispose() {
    this.buffer.dispose();
    if (this._vao) this.gl.deleteVertexArray(this._vao);
  }
}

function sph(c, r, a, b) {
  return [
    c[0] + r * Math.sin(b) * Math.cos(a),
    c[1] + r * Math.cos(b),
    c[2] + r * Math.sin(b) * Math.sin(a)
  ];
}

function xf(m, p) {
  const x = p[0], y = p[1], z = p[2];
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14]
  ];
}
