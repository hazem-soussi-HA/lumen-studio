/**
 * BufferObject — a thin, context-loss-safe wrapper over WebGLBuffer.
 * The CPU-side typed array is retained so uploads can be replayed after a
 * context restore (this is what separates an engine from a pile of draw calls).
 */

export const USAGE = {
  STATIC: 'static',
  DYNAMIC: 'dynamic',
  STREAM: 'stream'
};

export class BufferObject {
  constructor(ctx, { name = 'buffer', data = null, usage = 'static', target = null, count = 0, byteLength = 0 }) {
    this.kind = 'buffer';
    this.ctx = ctx;
    this.gl = ctx.gl;
    this.name = name;
    this.data = data;               // CPU copy (may be null for orphan-only buffers)
    this.usage = usage;
    this.target = target ?? ctx.gl.ARRAY_BUFFER;
    this.count = count;
    this.byteLength = byteLength || (data ? data.byteLength : 0);
    this._handle = null;
    this.version = 0;
    this._createGL();
    ctx.register(this);
  }

  _createGL() {
    const gl = this.gl;
    this._handle = gl.createBuffer();
    gl.bindBuffer(this.target, this._handle);
    if (this.data) {
      gl.bufferData(this.target, this.data, glUsage(gl, this.usage));
      this.byteLength = this.data.byteLength;
      this.count = this.data.length;
    } else if (this.byteLength) {
      gl.bufferData(this.target, this.byteLength, glUsage(gl, this.usage));
    }
    gl.bindBuffer(this.target, null);
    this.ctx.invalidateState();
  }

  _onContextLost() { this._handle = null; }
  _onContextRestored() { this._createGL(); }

  get handle() { return this._handle; }

  upload(data = this.data, byteOffset = 0, length = -1) {
    if (!this._handle) return this;
    const gl = this.gl;
    gl.bindBuffer(this.target, this._handle);
    if (data) {
      if (length < 0) gl.bufferSubData(this.target, byteOffset, data);
      else gl.bufferSubData(this.target, byteOffset, data, 0, length);
      this.version++;
    } else {
      // Orphan then refill: the driver may allocate fresh storage and avoid a
      // pipeline stall on the previous contents (triple-buffering in VRAM).
      gl.bufferData(this.target, this.byteLength, glUsage(gl, this.usage));
    }
    gl.bindBuffer(this.target, null);
    return this;
  }

  dispose() {
    if (this._handle) this.gl.deleteBuffer(this._handle);
    this._handle = null;
    this.ctx.unregister(this);
  }
}

function glUsage(gl, usage) {
  if (usage === 'dynamic') return gl.DYNAMIC_DRAW;
  if (usage === 'stream') return gl.STREAM_DRAW;
  return gl.STATIC_DRAW;
}

/**
 * Element index buffer with automatic 16/32-bit selection.
 * WebGL 1 only accepts 32-bit indices through OES_element_index_uint, so a mesh
 * that exceeds 65 535 vertices must be drawn in ranges rather than failing.
 */
export class IndexBuffer {
  constructor(ctx, indices, { name = 'indices' } = {}) {
    this.ctx = ctx;
    this.gl = ctx.gl;
    this.name = name;
    this.supports32 = !!ctx.caps.limits.indexUint;
    const maxIndex = indices && indices.length ? indices.reduce((m, v) => (v > m ? v : m), 0) : 0;
    this.maxIndex = maxIndex;

    if (this.supports32) {
      this.data = indices instanceof Uint32Array ? indices : new Uint32Array(indices);
      this.type = this.gl.UNSIGNED_INT;
    } else {
      this.data = indices instanceof Uint16Array ? indices : new Uint16Array(indices);
      this.type = this.gl.UNSIGNED_SHORT;
      this.overflow = maxIndex > 65535;
    }
    this.count = this.data ? this.data.length : 0;
    this.buffer = new BufferObject(ctx, { name, data: this.data, usage: 'static', target: this.gl.ELEMENT_ARRAY_BUFFER });
  }

  get handle() { return this.buffer.handle; }

  bind() { this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, this.buffer.handle); }

  /**
   * 32-bit geometry on a 16-bit-only device: draws are grouped by index range so
   * attribute pointers can be re-based. One range on capable hardware.
   */
  ranges() {
    if (!this.overflow) return [{ offset: 0, count: this.count }];
    return IndexBuffer.splitRanges(this.data, 65535);
  }

  static splitRanges(indices, maxVertex = 65535) {
    const out = [];
    let start = 0;
    for (let i = 3; i <= indices.length; i += 3) {
      if (indices[i - 1] > maxVertex || indices[i] > maxVertex || indices[i + 1] > maxVertex) {
        out.push({ start, count: i - start });
        start = i;
      }
    }
    out.push({ start, count: indices.length - start });
    return out;
  }

  dispose() { this.buffer.dispose(); }
}
