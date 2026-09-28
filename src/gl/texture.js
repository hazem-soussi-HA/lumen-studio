/**
 * Textures: 2D, cube, 3D volume and render-target colour/depth attachments.
 *
 * Colour-space handling follows the ES 3.0 rule that sRGB textures are decoded
 * on sample (SRGB8_ALPHA8 / SRGB_EXT_ALPHA8) so the shader always works in
 * linear light; the tonemapper re-encodes on output. On devices without the
 * extension we keep the texture linear and convert in the shader.
 */

import { clamp } from '../core/math.js';

export const FILTER = { nearest: 'nearest', linear: 'linear', mip: 'linearMipmap' };
export const WRAP = { repeat: 'repeat', clamp: 'clamp', mirror: 'mirror' };

export class Texture {
  constructor(ctx, opts = {}) {
    this.kind = 'texture';
    this.ctx = ctx;
    this.gl = ctx.gl;
    this.name = opts.name || 'texture';
    this.target = opts.target ?? ctx.gl.TEXTURE_2D;
    this.width = opts.width || 1;
    this.height = opts.height || 1;
    this.depth = opts.depth || 1;
    this.levels = opts.levels || 1;
    this.internalFormat = opts.internalFormat || ctx.gl.RGBA;
    this.format = opts.format || ctx.gl.RGBA;
    this.type = opts.type || ctx.gl.UNSIGNED_BYTE;
    this.mipmaps = opts.mipmaps ?? false;
    this.filter = opts.filter || FILTER.linear;
    this.wrapS = opts.wrap || WRAP.clamp;
    this.wrapT = opts.wrap || WRAP.clamp;
    this.wrapR = opts.wrapR || WRAP.clamp;
    this.anisotropy = opts.anisotropy || 0;
    this.compareMode = opts.compareMode || false; // hardware PCF shadow sampling
    this.srgb = !!opts.srgb;
    this.source = opts.source || null;   // CPU-side pixels, retained for restore
    this.compressed = opts.compressed || null;
    this._handle = null;
    this._createGL();
    ctx.register(this);
  }

  _createGL() {
    const gl = this.gl;
    const t = this._handle || (this._handle = gl.createTexture());
    gl.bindTexture(this.target, t);
    if (this.target === gl.TEXTURE_CUBE_MAP) {
      // A cube map is six independent 2D images; one texImage2D on
      // TEXTURE_CUBE_MAP is an INVALID_ENUM, so allocate each face.
      for (let f = 0; f < 6; f++) {
        gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + f, 0, this.internalFormat,
          this.width, this.height, 0, this.format, this.type, this.source || null);
      }
    } else if (this.compressed) {
      gl.compressedTexImage2D(this.target, 0, this.compressed.internalFormat,
        this.width, this.height, 0, this.compressed.format, this.compressed.type, this.compressed.data);
    } else if (this.target === gl.TEXTURE_3D || this.target === gl.TEXTURE_2D_ARRAY) {
      gl.texImage3D(this.target, 0, this.internalFormat, this.width, this.height, this.depth,
        0, this.format, this.type, this.source || null);
    } else {
      gl.texImage2D(this.target, 0, this.internalFormat, this.width, this.height, 0,
        this.format, this.type, this.source || null);
    }
    this._applyParams();
    if (this.mipmaps) this._allocateMipLevels();
    gl.bindTexture(this.target, null);
    this.ctx.invalidateState();
  }

  /**
   * A texture with a mip *filter* but no mip *storage* is incomplete, and an
   * incomplete texture can never be a framebuffer attachment. Render targets that
   * are written level-by-level (bloom, prefiltered IBL) must therefore have every
   * level allocated up front.
   */
  _allocateMipLevels() {
    const gl = this.gl;
    const levels = 1 + Math.floor(Math.log2(Math.max(this.width, this.height)));
    for (let level = 1; level < levels; level++) {
      const w = Math.max(1, this.width >> level);
      const h = Math.max(1, this.height >> level);
      if (this.target === gl.TEXTURE_CUBE_MAP) {
        for (let f = 0; f < 6; f++) {
          gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + f, level, this.internalFormat, w, h, 0, this.format, this.type, null);
        }
      } else if (this.target === gl.TEXTURE_3D) {
        gl.texImage3D(gl.TEXTURE_3D, level, this.internalFormat, w, h, this.depth, 0, this.format, this.type, null);
      } else {
        gl.texImage2D(this.target, level, this.internalFormat, w, h, 0, this.format, this.type, null);
      }
    }
  }

  _onContextLost() { this._handle = null; }
  _onContextRestored() { this._createGL(); }

  /** The WebGLTexture name. */
  get handle() { return this._handle; }

  _applyParams() {
    const gl = this.gl;
    const min = this.mipmaps || this.levels > 1
      ? (this.filter === FILTER.nearest ? gl.NEAREST_MIPMAP_NEAREST : gl.LINEAR_MIPMAP_LINEAR)
      : (this.filter === FILTER.nearest ? gl.NEAREST : gl.LINEAR);
    gl.texParameteri(this.target, gl.TEXTURE_MIN_FILTER, min);
    gl.texParameteri(this.target, gl.TEXTURE_MAG_FILTER, this.filter === FILTER.nearest ? gl.NEAREST : gl.LINEAR);
    gl.texParameteri(this.target, gl.TEXTURE_WRAP_S, wrapEnum(gl, this.wrapS));
    gl.texParameteri(this.target, gl.TEXTURE_WRAP_T, wrapEnum(gl, this.wrapT));
    if (this.wrapR !== undefined && (this.target === gl.TEXTURE_3D || this.target === gl.TEXTURE_2D_ARRAY)) {
      gl.texParameteri(this.target, gl.TEXTURE_WRAP_R, wrapEnum(gl, this.wrapR));
    }
    if (this.compareMode) {
      gl.texParameteri(this.target, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
      gl.texParameteri(this.target, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    }
    const aniso = this.ctx.ext.anisotropic;
    if (aniso && this.anisotropy > 1) {
      const max = this.ctx.caps.limits.maxAnisotropy;
      gl.texParameterf(this.target, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(this.anisotropy, max));
    }
  }

  /** Upload (or re-upload) pixels and rebuild the mip chain. */
  setSource(source, { mipmap = this.mipmaps, width = this.width, height = this.height } = {}) {
    this.source = source;
    if (width !== this.width || height !== this.height) { this.width = width; this.height = height; }
    const gl = this.gl;
    gl.bindTexture(this.target, this._handle);
    gl.texImage2D(this.target, 0, this.internalFormat, this.width, this.height, 0, this.format, this.type, source);
    this._applyParams();
    if (mipmap) gl.generateMipmap(this.target);
    gl.bindTexture(this.target, null);
    return this;
  }

  setCubeFace(face, source, { mipmap = this.mipmaps, size = this.width } = {}) {
    const gl = this.gl;
    this.width = this.height = size;
    gl.bindTexture(this.target, this._handle);
    gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + face, 0, this.internalFormat, size, size, 0, this.format, this.type, source);
    this._applyParams();
    if (mipmap) gl.generateMipmap(this.target);
    gl.bindTexture(this.target, null);
    return this;
  }

  set3DSource(source) {
    const gl = this.gl;
    gl.bindTexture(this.target, this._handle);
    gl.texImage3D(this.target, 0, this.internalFormat, this.width, this.height, this.depth, 0, this.format, this.type, source);
    this._applyParams();
    if (this.mipmaps) gl.generateMipmap(this.target);
    gl.bindTexture(this.target, null);
    return this;
  }

  setWrap(s, t = s) { this.wrapS = s; this.wrapT = t; const gl = this.gl; gl.bindTexture(this.target, this._handle); this._applyParams(); gl.bindTexture(this.target, null); return this; }
  setAnisotropy(n) { this.anisotropy = n; const gl = this.gl; gl.bindTexture(this.target, this._handle); this._applyParams(); gl.bindTexture(this.target, null); return this; }
  setCompareMode(on) { this.compareMode = on; const gl = this.gl; gl.bindTexture(this.target, this._handle); this._applyParams(); gl.bindTexture(this.target, null); return this; }

  bind(unit) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(this.target, this._handle);
    return unit;
  }

  get bytes() {
    const bpp = { 1: 1, 2: 1, 4: 2, 8: 1 }[this.type] || 4;
    const ch = (this.format === this.gl.RGB ? 3 : this.format === this.gl.RGBA ? 4 : this.format === this.gl.LUMINANCE ? 1 : 4);
    let total = this.width * this.height * Math.max(1, ch * bpp);
    if (this.target === this.gl.TEXTURE_CUBE_MAP) total *= 6;
    if (this.mipmaps) total *= 4 / 3;
    return total;
  }

  dispose() { if (this._handle) this.gl.deleteTexture(this._handle); this._handle = null; this.ctx.unregister(this); }
}

function wrapEnum(gl, w) {
  if (w === WRAP.repeat) return gl.REPEAT;
  if (w === WRAP.mirror) return gl.MIRRORED_REPEAT;
  return gl.CLAMP_TO_EDGE;
}

/** 1×1 fallback so shaders can sample unconditionally without branching. */
export function whitePixel(ctx) {
  return new Texture(ctx, {
    name: 'white', width: 1, height: 1, source: new Uint8Array([255, 255, 255, 255]),
    filter: FILTER.nearest, wrap: WRAP.repeat
  });
}

export function flatNormalPixel(ctx) {
  return new Texture(ctx, {
    name: 'flatNormal', width: 1, height: 1, source: new Uint8Array([128, 128, 255, 255]),
    filter: FILTER.nearest, wrap: WRAP.repeat
  });
}

export function blackPixel(ctx) {
  return new Texture(ctx, {
    name: 'black', width: 1, height: 1, source: new Uint8Array([0, 0, 0, 255]),
    filter: FILTER.nearest, wrap: WRAP.repeat
  });
}

/**
 * 3D volume with an atlas fallback.
 *
 * GLSL ES 1.00 has no `sampler3D` at all, and the article is explicit that WebGL
 * does not expose the ES 2.0 3D-texture extension. So a volume is stored twice:
 *   • WebGL 2  → a real TEXTURE_3D, sampled with `texture()`.
 *   • WebGL 1  → a 2D tile atlas (depth slices laid out on a grid) plus a chunk
 *                that performs manual trilinear filtering: slice lerp in Z,
 *                bilinear in the two atlas axes, with the manual bilinear weights
 *                compensating for the half-texel inset introduced by tiling.
 */
export class VolumeTexture extends Texture {
  constructor(ctx, { size = 32, data = null, srgb = false } = {}) {
    const isGL2 = ctx.caps.isWebGL2;
    const tiles = Math.ceil(Math.sqrt(size));
    const atlas = tiles * size;
    super(ctx, {
      name: 'volume',
      target: isGL2 ? ctx.gl.TEXTURE_3D : ctx.gl.TEXTURE_2D,
      width: isGL2 ? size : atlas,
      height: isGL2 ? size : atlas,
      depth: isGL2 ? size : size,
      internalFormat: srgb && isGL2 ? ctx.gl.SRGB8_ALPHA8 : ctx.gl.RGBA,
      format: ctx.gl.RGBA,
      type: ctx.gl.UNSIGNED_BYTE,
      filter: FILTER.linear,
      wrap: WRAP.clamp,
      srgb
    });
    this.kind = 'texture';
    this.volumeSize = size;
    this.tiles = tiles;
    this.atlasSize = atlas;
    this.emulated = !isGL2;
    if (data) this.setVolume(data, size);
  }

  setVolume(data, size = this.volumeSize) {
    this.volumeSize = size;
    this.depth = size;
    this.data = data;
    if (this.emulated) {
      // Repack slices into a square tile atlas.
      const gl = this.gl;
      const tiles = Math.ceil(Math.sqrt(size));
      const atlas = tiles * size;
      const out = new Uint8Array(atlas * atlas * 4);
      for (let z = 0; z < size; z++) {
        const tx = (z % tiles) * size;
        const ty = Math.floor(z / tiles) * size;
        for (let y = 0; y < size; y++) {
          const src = (z * size * size + y * size) * 4;
          const dst = ((ty + y) * atlas + tx) * 4;
          out.set(data.subarray(src, src + size * 4), dst);
        }
      }
      this.width = atlas; this.height = atlas;
      gl.bindTexture(gl.TEXTURE_2D, this._handle);
      gl.texImage2D(gl.TEXTURE_2D, 0, this.internalFormat, atlas, atlas, 0, gl.RGBA, gl.UNSIGNED_BYTE, out);
      this._applyParams();
      gl.bindTexture(gl.TEXTURE_2D, null);
    } else {
      const gl = this.gl;
      this.width = size; this.height = size;
      gl.bindTexture(gl.TEXTURE_3D, this._handle);
      gl.texImage3D(gl.TEXTURE_3D, 0, this.internalFormat, size, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
      this._applyParams();
      gl.bindTexture(gl.TEXTURE_3D, null);
    }
    return this;
  }
}

/** Factory choosing the best available float render-target format. */
export function hdrFormat(ctx) {
  const gl = ctx.gl;
  const ext = ctx.ext;
  if (ctx.caps.isWebGL2 || ext.colorBufferFloat) return { internalFormat: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT, name: 'RGBA16F' };
  if (ext.colorBufferHalfFloat) return { internalFormat: gl.RGBA, format: gl.RGBA, type: gl.HALF_FLOAT, name: 'RGBA/HALF_FLOAT' };
  return { internalFormat: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, name: 'RGBA8 (LDR fallback)' };
}

export function depthFormat(ctx) {
  const gl = ctx.gl;
  if (ctx.caps.isWebGL2 || ctx.ext.depthTexture) return { internalFormat: gl.DEPTH_COMPONENT24, format: gl.DEPTH_COMPONENT, type: gl.UNSIGNED_INT, name: 'DEPTH_COMPONENT24' };
  return { internalFormat: gl.DEPTH_COMPONENT16, format: gl.DEPTH_COMPONENT, type: gl.UNSIGNED_SHORT, name: 'DEPTH_COMPONENT16' };
}

export function srgbFormat(ctx) {
  const gl = ctx.gl;
  if (ctx.caps.isWebGL2) return { internalFormat: gl.SRGB8_ALPHA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE };
  if (ctx.ext.sRGB) return { internalFormat: gl.SRGB8_ALPHA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE };
  return { internalFormat: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE };
}

export function clampTo(v, lo, hi) { return clamp(v, lo, hi); }
