/**
 * Mesh — interleaved vertex storage, index buffer, VAO and instancing.
 *
 * Layout (32 bytes/vertex, the classic pre-3.0 packing):
 *   position  float32x3   @ 0
 *   normal    float32x3   @ 12
 *   uv        float32x2   @ 24
 * Optional per-vertex colour is stored in a parallel buffer only when a mesh
 * actually uses it, so the common path stays at 8 floats.
 *
 * WebGL 1 has no vertex array object, so the attribute layout is re-applied on
 * every bind — cached here to keep the per-draw cost to two GL calls.
 */

import { BufferObject, IndexBuffer } from './buffer.js';
import { aabb, sphere } from '../core/math.js';

export const ATTRIB = {
  position: { name: 'aPosition', loc: 0, size: 3, offset: 0 },
  normal: { name: 'aNormal', loc: 1, size: 3, offset: 12 },
  uv: { name: 'aUv', loc: 2, size: 2, offset: 24 }
};
export const VERTEX_STRIDE = 32;

export const INSTANCE_ATTRIB = {
  i0: { loc: 3, size: 4, offset: 0 },
  i1: { loc: 4, size: 4, offset: 16 },
  i2: { loc: 5, size: 4, offset: 32 },
  i3: { loc: 6, size: 4, offset: 48 },
  iColor: { loc: 7, size: 4, offset: 64 }
};
export const INSTANCE_STRIDE = 80;

export class Mesh {
  /**
   * @param {GLContext} ctx
   * @param {object} data { positions: Float32Array, normals?, uvs?, colors?, indices: Uint32Array|Uint16Array }
   */
  constructor(ctx, data, { name = 'mesh' } = {}) {
    this.kind = 'mesh';
    this.ctx = ctx;
    this.gl = ctx.gl;
    this.name = name;
    this.aabb = aabb.create();
    this.sphere = sphere.create();
    this.drawCalls = 0;
    this.instances = 0;
    this._vao = null;
    this._vaoLayoutKey = null;
    this._indexRanges = null;
    this.boundsDirty = true;

    this._build(data);
    ctx.register(this);
  }

  _build(data) {
    const positions = data.positions instanceof Float32Array ? data.positions : new Float32Array(data.positions || []);
    const normals = data.normals ? (data.normals instanceof Float32Array ? data.normals : new Float32Array(data.normals)) : null;
    const uvs = data.uvs ? (data.uvs instanceof Float32Array ? data.uvs : new Float32Array(data.uvs)) : null;
    const colors = data.colors ? (data.colors instanceof Float32Array ? data.colors : new Float32Array(data.colors)) : null;
    const vertexCount = positions.length / 3;

    const stride = VERTEX_STRIDE;
    const interleaved = new Float32Array(vertexCount * 8);
    for (let i = 0; i < vertexCount; i++) {
      const o = i * 8;
      interleaved[o] = positions[i * 3];
      interleaved[o + 1] = positions[i * 3 + 1];
      interleaved[o + 2] = positions[i * 3 + 2];
      if (normals) {
        interleaved[o + 3] = normals[i * 3];
        interleaved[o + 4] = normals[i * 3 + 1];
        interleaved[o + 5] = normals[i * 3 + 2];
      } else { interleaved[o + 5] = 1; }
      if (uvs) {
        interleaved[o + 6] = uvs[i * 2];
        interleaved[o + 7] = uvs[i * 2 + 1];
      }
    }

    this.positions = positions;
    this.normals = normals;
    this.uvs = uvs;
    this.vertexColors = colors;
    this.vertexCount = vertexCount;
    this.interleaved = interleaved;
    this.vertexBuffer = new BufferObject(this.ctx, { name: `${this.name}.vtx`, data: interleaved, usage: 'static' });
    this.colorBuffer = colors
      ? new BufferObject(this.ctx, { name: `${this.name}.col`, data: colors, usage: 'static' })
      : null;

    const idx = data.indices;
    if (idx && idx.length) {
      this.indices = new IndexBuffer(this.ctx, idx, { name: `${this.name}.idx` });
      this.indexCount = idx.length;
      this.primitive = data.primitive || 'triangles';
    } else {
      this.indices = null;
      this.indexCount = vertexCount;
      this.primitive = data.primitive || 'triangles';
    }

    this.rebuildBounds();
  }

  _createGL() {
    // Buffers and the index buffer rebuild themselves; only the VAO is ours.
    this._vao = null;
    this._vaoLayoutKey = null;
  }
  _onContextLost() { this._vao = null; this._vaoLayoutKey = null; }
  _onContextRestored() { this._createGL(); }

  rebuildBounds() {
    aabb.reset(this.aabb);
    aabb.addPoints(this.aabb, this.positions, 3);
    sphere.fromAABB(this.sphere, this.aabb);
    this.boundsDirty = false;
    return this;
  }

  /**
   * Apply the attribute layout and draw. `program` decides which optional
   * attributes are live, so unused streams cost nothing.
   *
   * The instance stream is bound whenever the draw is instanced. Callers that set
   * `mesh.instances` (the renderer's instanced path) must not have to repeat the
   * count here: binding without the stream while still issuing an instanced draw
   * leaves `aInst*` at their default 0/0/0/1, i.e. a zero matrix, and every
   * instance collapses to a degenerate triangle.
   */
  draw(program, { instances = 0, instanceBuffer = null, mode = null, range = null } = {}) {
    const gl = this.gl;
    const instanced = instances > 0 || (instanceBuffer && this.instances > 1);
    this._bindVAO(program, instanced ? instanceBuffer : null, instanced);
    if (this.indices) {
      const r = range || this.indices.ranges()[0];
      this._drawIndices(gl, r.offset, r.count, mode);
    } else {
      this._drawArrays(gl, mode, range);
    }
    this.drawCalls++;
    this.ctx.debug.draws++;
  }

  _drawIndices(gl, offset, count, mode) {
    const glMode = mode || (this.primitive === 'lines' ? gl.LINES : this.primitive === 'lineStrip' ? gl.LINE_STRIP : gl.TRIANGLES);
    const type = this.indices.type;
    const bytes = type === gl.UNSIGNED_INT ? 4 : 2;
    const byteOffset = offset * bytes;
    if (this.instances > 1) this._drawInstanced(gl, glMode, count, type, byteOffset);
    else gl.drawElements(glMode, count, type, byteOffset);
  }

  _drawArrays(gl, mode, range) {
    const glMode = mode || (this.primitive === 'lines' ? gl.LINES : this.primitive === 'lineStrip' ? gl.LINE_STRIP : gl.TRIANGLES);
    const first = range?.start ?? 0;
    const count = range?.count ?? this.vertexCount;
    if (this.instances > 1) {
      const ext = this.ctx.ext.instancedArrays;
      if (ext) {
        this._drawInstancedArrays(ext, glMode, first, count);
        return;
      }
    }
    gl.drawArrays(glMode, first, count);
  }

  _drawInstanced(gl, glMode, count, type, byteOffset) {
    if (this.ctx.caps.isWebGL2) {
      gl.drawElementsInstanced(glMode, count, type, byteOffset, this.instances);
    } else {
      const ext = this.ctx.ext.instancedArrays;
      if (!ext) { gl.drawElements(glMode, count, type, byteOffset); return; }
      ext.drawElementsInstancedANGLE(glMode, count, type, byteOffset, this.instances);
    }
  }

  _drawInstancedArrays(ext, glMode, first, count) {
    ext.drawArraysInstancedANGLE(glMode, first, count, this.instances);
  }

  _bindVAO(program, instanceBuffer, useInstances) {
    const gl = this.gl;
    if (!this.ctx.caps.isWebGL2) {
      // ES 1.00: re-apply the attribute pointers on every draw.
      if (this.indices) this.indices.bind();
      this._applyAttribs(program, instanceBuffer, useInstances);
      return;
    }
    const key = `${program._id}|${useInstances ? (instanceBuffer?._id ?? 'i') : 'n'}`;
    if (!this._vao) this._vao = gl.createVertexArray();
    this.ctx.bindVAO(this._vao);
    // ELEMENT_ARRAY_BUFFER binding is part of VAO state on ES 3.0, and other
    // passes (dynamic batches, post quads) leave other VAOs bound — re-binding is
    // one GL call and removes a whole class of INVALID_OPERATION at draw time.
    if (this.indices) this.indices.bind();
    if (this._vaoLayoutKey !== key) {
      this._applyAttribs(program, instanceBuffer, useInstances);
      this._vaoLayoutKey = key;
    }
  }

  _applyAttribs(program, instanceBuffer, useInstances) {
    const gl = this.gl;
    const buf = this.vertexBuffer.handle;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    const pLoc = program.attributes.get(ATTRIB.position.name)?.loc;
    const nLoc = program.attributes.get(ATTRIB.normal.name)?.loc;
    const uLoc = program.attributes.get(ATTRIB.uv.name)?.loc;
    const cLoc = program.attributes.get('aColor')?.loc;

    if (pLoc !== undefined && pLoc >= 0) {
      gl.enableVertexAttribArray(pLoc);
      gl.vertexAttribPointer(pLoc, 3, gl.FLOAT, false, VERTEX_STRIDE, ATTRIB.position.offset);
    }
    if (nLoc !== undefined && nLoc >= 0) {
      gl.enableVertexAttribArray(nLoc);
      gl.vertexAttribPointer(nLoc, 3, gl.FLOAT, false, VERTEX_STRIDE, ATTRIB.normal.offset);
    }
    if (uLoc !== undefined && uLoc >= 0) {
      gl.enableVertexAttribArray(uLoc);
      gl.vertexAttribPointer(uLoc, 2, gl.FLOAT, false, VERTEX_STRIDE, ATTRIB.uv.offset);
    }
    if (cLoc !== undefined && cLoc >= 0 && this.colorBuffer) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer.handle);
      gl.enableVertexAttribArray(cLoc);
      gl.vertexAttribPointer(cLoc, 4, gl.FLOAT, false, 0, 0);
    }

    if (useInstances && instanceBuffer) {
      instanceBuffer.apply(this, program);
    } else {
      this._disableInstanceAttribs(program);
    }
  }

  _disableInstanceAttribs(program) {
    const gl = this.gl;
    for (const key of ['aInst0', 'aInst1', 'aInst2', 'aInst3', 'aInstColor']) {
      const loc = program.attributes.get(key)?.loc;
      if (loc !== undefined && loc >= 0) gl.disableVertexAttribArray(loc);
    }
  }

  /** CPU-side ray/triangle intersection — the basis of gizmo and selection picking. */
  raycast(origin, direction, maxDistance = Infinity) {
    if (!this.indices || !this.positions) return null;
    const idx = this.indices.data;
    const p = this.positions;
    const v0 = _v0, v1 = _v1, v2 = _v2;
    let best = maxDistance;
    let found = false;
    for (let i = 0; i < idx.length; i += 3) {
      v0[0] = p[idx[i] * 3]; v0[1] = p[idx[i] * 3 + 1]; v0[2] = p[idx[i] * 3 + 2];
      v1[0] = p[idx[i + 1] * 3]; v1[1] = p[idx[i + 1] * 3 + 1]; v1[2] = p[idx[i + 1] * 3 + 2];
      v2[0] = p[idx[i + 2] * 3]; v2[1] = p[idx[i + 2] * 3 + 1]; v2[2] = p[idx[i + 2] * 3 + 2];
      const t = rayTriangle(origin, direction, v0, v1, v2);
      if (t >= 0 && t < best) { best = t; found = true; }
    }
    return found ? { distance: best, point: [origin[0] + direction[0] * best, origin[1] + direction[1] * best, origin[2] + direction[2] * best] } : null;
  }

  get triangleCount() {
    const c = this.indices ? this.indices.count : this.vertexCount;
    return this.primitive === 'lines' ? Math.floor(c / 2) : Math.floor(c / 3);
  }

  dispose() {
    this.vertexBuffer?.dispose();
    this.colorBuffer?.dispose();
    this.indices?.dispose();
    if (this._vao) { this.gl.deleteVertexArray(this._vao); this._vao = null; }
    this.ctx.unregister(this);
  }
}

const _v0 = new Float32Array(3), _v1 = new Float32Array(3), _v2 = new Float32Array(3);

function rayTriangle(o, d, v0, v1, v2) {
  const e1x = v1[0] - v0[0], e1y = v1[1] - v0[1], e1z = v1[2] - v0[2];
  const e2x = v2[0] - v0[0], e2y = v2[1] - v0[1], e2z = v2[2] - v0[2];
  const px = d[1] * e2z - d[2] * e2y;
  const py = d[2] * e2x - d[0] * e2z;
  const pz = d[0] * e2y - d[1] * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-12) return -1;
  const inv = 1 / det;
  const tx = o[0] - v0[0], ty = o[1] - v0[1], tz = o[2] - v0[2];
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return -1;
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
  if (v < 0 || u + v > 1) return -1;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return t >= 0 ? t : -1;
}

/**
 * Per-instance attribute stream. One `mat4` per instance is uploaded as four
 * `vec4` attributes rather than a `mat4` attribute: ES 1.00 guarantees that a
 * matrix attribute may consume four slots, and drivers disagree about the layout.
 * This keeps ANGLE_instanced_arrays and native ES 3.0 instancing identical.
 */
export class InstanceBuffer {
  constructor(ctx, capacity = 256) {
    this.ctx = ctx;
    this.gl = ctx.gl;
    this.capacity = capacity;
    this.data = new Float32Array(capacity * 20); // 4 vec4 matrix + vec4 colour
    this.count = 0;
    this.buffer = new BufferObject(ctx, { name: 'instances', data: this.data, usage: 'dynamic' });
    this._applied = null;
  }

  reset() { this.count = 0; return this; }

  push(matrix, color) {
    if (this.count >= this.capacity) this._grow();
    const o = this.count * 20;
    this.data.set(matrix, o);
    if (color) { this.data[o + 16] = color[0]; this.data[o + 17] = color[1]; this.data[o + 18] = color[2]; this.data[o + 19] = color[3] ?? 1; }
    this.count++;
    return this;
  }

  _grow() {
    this.capacity *= 2;
    const next = new Float32Array(this.capacity * 20);
    next.set(this.data);
    this.data = next;
    this.buffer.data = next;
    this.buffer.byteLength = next.byteLength;
    this.buffer.upload(next);
  }

  upload() {
    if (!this.count) return this;
    this.buffer.upload(this.data.subarray(0, this.count * 20));
    this._dirty = true;
    return this;
  }

  apply(mesh, program) {
    const gl = this.gl;
    if (this._dirty || this._applied !== mesh) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer.handle);
      const names = ['aInst0', 'aInst1', 'aInst2', 'aInst3', 'aInstColor'];
      const offs = [0, 16, 32, 48, 64];
      for (let i = 0; i < 5; i++) {
        const loc = program.attributes.get(names[i])?.loc;
        if (loc === undefined || loc < 0) continue;
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, INSTANCE_STRIDE, offs[i]);
        this._setDivisor(loc, i);
      }
      this._dirty = false;
      this._applied = mesh;
    }
  }

  _setDivisor(loc, index) {
    const gl = this.gl;
    if (this.ctx.caps.isWebGL2) {
      gl.vertexAttribDivisor(loc, 1);
    } else {
      const ext = this.ctx.ext.instancedArrays;
      if (ext) ext.vertexAttribDivisorANGLE(loc, 1);
    }
    // Divisors are VAO state on ES 3.0; reset them when leaving instanced mode.
    this._divisors ||= new Set();
    this._divisors.add(`${index}:${loc}`);
  }

  resetDivisors() {
    if (!this._divisors) return;
    const gl = this.gl;
    for (const d of this._divisors) {
      const loc = parseInt(d.split(':')[1], 10);
      if (this.ctx.caps.isWebGL2) gl.vertexAttribDivisor(loc, 0);
      else this.ctx.ext.instancedArrays?.vertexAttribDivisorANGLE(loc, 0);
    }
    this._divisors.clear();
  }

  dispose() { this.buffer.dispose(); }
}
