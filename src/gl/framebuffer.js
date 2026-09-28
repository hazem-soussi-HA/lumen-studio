/**
 * Framebuffers and render targets.
 *
 * `RenderTarget` is the composable unit the post-processing chain is built from:
 * N colour attachments (with optional mip chain for progressive bloom), a depth
 * attachment that can be a texture (readable depth for SSAO / soft particles) or
 * a renderbuffer (cheaper, not readable), and MSAA via WebGL 2 multisampled
 * renderbuffers resolved on `blit`.
 */

import { Texture, hdrFormat, depthFormat } from './texture.js';

export class Framebuffer {
  constructor(ctx, { name = 'fbo', width = 1, height = 1 } = {}) {
    this.kind = 'framebuffer';
    this.ctx = ctx;
    this.gl = ctx.gl;
    this.name = name;
    this.width = width;
    this.height = height;
    this._handle = null;
    this._createGL();
    ctx.register(this);
  }

  _createGL() {
    const gl = this.gl;
    this._handle = this._handle || gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._handle);
    this.ctx._state.framebuffer = this._handle;
  }

  _onContextLost() { this._handle = null; }
  _onContextRestored() {
    this._handle = null;
    this._createGL();
    // A fresh GL framebuffer starts with no attachments at all, so the restore
    // has to replay them: without this every render target comes back empty and
    // the first frame after a context loss is black.
    for (const a of this._colorAttachments || []) this._attachColor(a.att, a.attachment);
    if (this._depthAttachment) this._attachDepth(this._depthAttachment);
    if (this._drawBuffers) this._applyDrawBuffers(this._drawBuffers);
  }

  get handle() { return this._handle; }

  attachColor(att, attachment = 0) {
    this._colorAttachments ||= [];
    const existing = this._colorAttachments.findIndex((a) => a.attachment === attachment);
    const rec = { att, attachment };
    if (existing >= 0) this._colorAttachments[existing] = rec;
    else this._colorAttachments.push(rec);
    return this._attachColor(att, attachment);
  }

  _attachColor(att, attachment) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._handle);
    if (att.isRenderbuffer) {
      // Multisampled colour is a renderbuffer, never a texture: passing one to
      // framebufferTexture2D is a type error, and it takes the whole boot down.
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + attachment, gl.RENDERBUFFER, att.handle);
    } else {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + attachment, att.target, att.handle, 0);
    }
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      this.ctx.checkErrors(`Framebuffer.attachColor(${this.name})`);
      console.warn(`[fbo] ${this.name} incomplete: 0x${status.toString(16)}`);
    }
    return this;
  }

  /**
   * Draw buffers are framebuffer state, not context state, so a context loss
   * resets them. Recorded and replayed on restore, and validated per draw call by
   * the spec: an active draw buffer with no matching fragment output is an
   * INVALID_OPERATION, not a warning.
   */
  setDrawBuffers(bufs) {
    this._drawBuffers = bufs.slice();
    this._applyDrawBuffers(bufs);
    return this;
  }

  _applyDrawBuffers(bufs) {
    const gl = this.gl;
    const ext = this.ctx.ext.drawBuffers;
    if (this.ctx.caps.isWebGL2) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._handle);
      this.ctx._state.framebuffer = this._handle;
      gl.drawBuffers(bufs);
    } else if (ext) {
      // WEBGL_draw_buffers is a different API with its own method and its own
      // *_WEBGL suffixed enum values, so it cannot be called as gl.drawBuffers.
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._handle);
      this.ctx._state.framebuffer = this._handle;
      ext.drawBuffersWEBGL(bufs.map(webglDrawBufferEnum));
    }
    return this;
  }

  attachDepth(textureOrRb) {
    this._depthAttachment = textureOrRb;
    return this._attachDepth(textureOrRb);
  }

  _attachDepth(textureOrRb) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._handle);
    if (textureOrRb.isRenderbuffer) {
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, textureOrRb.handle);
    } else {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, textureOrRb.target, textureOrRb.handle, 0);
    }
    return this;
  }

  bind({ clear = false, clearColor = [0, 0, 0, 1], clearDepth = true } = {}) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._handle);
    this.ctx._state.framebuffer = this._handle;
    this.ctx.applyViewport(this);
    if (clear) {
      gl.clearColor(clearColor[0], clearColor[1], clearColor[2], clearColor[3]);
      let bits = gl.COLOR_BUFFER_BIT;
      if (clearDepth) { this.ctx.setDepth(true, true); bits |= gl.DEPTH_BUFFER_BIT; }
      gl.clear(bits);
    }
    return this;
  }

  /** Read a rectangle of pixels (used by the picking pass). */
  readPixels(x, y, w, h, format, type, out) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._handle);
    this.ctx._state.framebuffer = this._handle;
    gl.readPixels(x, y, w, h, format, type, out);
    return out;
  }

  dispose() { if (this._handle) this.gl.deleteFramebuffer(this._handle); this._handle = null; this.ctx.unregister(this); }
}

export class RenderTarget {
  /**
   * @param {GLContext} ctx
   * @param {object} o { name, width, height, count, hdr, depth:'texture'|'renderbuffer'|'none',
   *                    mips, filter, wrap, msaa }
   */
  constructor(ctx, o = {}) {
    this.ctx = ctx;
    this.gl = ctx.gl;
    this.name = o.name || 'rt';
    this.width = Math.max(1, o.width || 1);
    this.height = Math.max(1, o.height || 1);
    this.count = o.count || 1;
    this.hdr = o.hdr ?? true;
    this.depthMode = o.depth || 'renderbuffer';
    this.mips = !!o.mips;
    this.filter = o.filter || 'linear';
    this.wrap = o.wrap || 'clamp';
    this.msaa = o.msaa || 0;
    this.samples = 0;
    // Depth-only pass: the colour attachment exists but must not be written, or
    // ES 3.0 rejects the draw for having an active draw buffer with no output.
    this.colorWrite = o.colorWrite !== false;

    this._format = this.hdr ? hdrFormat(ctx) : { internalFormat: ctx.gl.RGBA8, format: ctx.gl.RGBA, type: ctx.gl.UNSIGNED_BYTE };
    this._depthFormat = depthFormat(ctx);
    this.build();
  }

  build() {
    const gl = this.gl;
    const filterEnum = this.filter === 'nearest' ? gl.NEAREST : gl.LINEAR;
    const wrapEnum = this.wrap === 'repeat' ? gl.REPEAT : gl.CLAMP_TO_EDGE;

    this.colorTextures = [];
    for (let i = 0; i < this.count; i++) {
      const t = new Texture(this.ctx, {
        name: `${this.name}.color${i}`,
        width: this.width, height: this.height,
        internalFormat: this._format.internalFormat,
        format: this._format.format, type: this._format.type,
        mipmaps: this.mips, filter: this.mips ? 'linear' : this.filter, wrap: this.wrap
      });
      // generateMipmap is only legal on filterable formats; verify up front.
      this.colorTextures.push(t);
    }

    this.depthTexture = null;
    this.depthRenderbuffer = null;
    if (this.depthMode === 'texture') {
      this.depthTexture = new Texture(this.ctx, {
        name: `${this.name}.depth`, width: this.width, height: this.height,
        internalFormat: this._depthFormat.internalFormat, format: this._depthFormat.format, type: this._depthFormat.type,
        filter: this.filter, wrap: this.wrap, compareMode: false
      });
    } else if (this.depthMode === 'renderbuffer') {
      this.depthRenderbuffer = new Renderbuffer(this.ctx, {
        name: `${this.name}.depth`, width: this.width, height: this.height,
        internalFormat: this.ctx.caps.isWebGL2 ? gl.DEPTH_COMPONENT24 : gl.DEPTH_COMPONENT16
      });
    }

    // WebGL 2 only: a multisampled renderbuffer FBO plus a single-sample resolve FBO.
    if (this.msaa > 0 && this.ctx.caps.isWebGL2) {
      this.samples = Math.min(this.msaa, this.ctx.caps.limits.maxSamples || this.msaa);
      this.msaaTarget = new Framebuffer(this.ctx, { name: `${this.name}.msaa`, width: this.width, height: this.height });
      for (let i = 0; i < this.count; i++) {
        this.msaaTarget.attachColor(new Renderbuffer(this.ctx, {
          name: `${this.name}.msaa.c${i}`, width: this.width, height: this.height,
          internalFormat: this._format.internalFormat, samples: this.samples
        }), i);
      }
      if (this.depthMode !== 'none') {
        this.msaaDepth = new Renderbuffer(this.ctx, {
          name: `${this.name}.msaa.d`, width: this.width, height: this.height,
          internalFormat: this._depthModeInternal(), samples: this.samples
        });
        this.msaaTarget.attachDepth(this.msaaDepth);
      }
    }

    this.fbo = new Framebuffer(this.ctx, { name: this.name, width: this.width, height: this.height });
    for (let i = 0; i < this.count; i++) this.fbo.attachColor(this.colorTextures[i], i);
    if (this.colorWrite === false) this.fbo.setDrawBuffers([this.gl.NONE]);
    else if (this.count > 1 && this.ctx.caps.isWebGL2) {
      const bufs = [];
      for (let i = 0; i < this.count; i++) bufs.push(this.gl.COLOR_ATTACHMENT0 + i);
      this.fbo.setDrawBuffers(bufs);
    }
    if (this.depthTexture) this.fbo.attachDepth(this.depthTexture);
    else if (this.depthRenderbuffer) this.fbo.attachDepth(this.depthRenderbuffer);
  }

  _depthModeInternal() {
    const gl = this.gl;
    return this.ctx.caps.isWebGL2 ? gl.DEPTH_COMPONENT24 : gl.DEPTH_COMPONENT16;
  }

  get texture() { return this.colorTextures[0]; }

  setSize(width, height) {
    width = Math.max(1, Math.round(width));
    height = Math.max(1, Math.round(height));
    if (width === this.width && height === this.height) return false;
    this.width = width; this.height = height;
    this.dispose();
    this.build();
    return true;
  }

  bind(opts) {
    if (this.msaaTarget) this.msaaTarget.bind(opts);
    else this.fbo.bind(opts);
    return this;
  }

  /** Resolve MSAA into the single-sample textures. */
  resolve() {
    if (!this.msaaTarget) return this;
    const gl = this.gl;
    for (let i = 0; i < this.count; i++) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.msaaTarget.handle);
      gl.readBuffer(gl.COLOR_ATTACHMENT0 + i);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.fbo.handle);
      gl.blitFramebuffer(0, 0, this.width, this.height, 0, 0, this.width, this.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    this.ctx.invalidateState();
    return this;
  }

  generateMips() {
    if (!this.mips) return this;
    const gl = this.gl;
    for (const t of this.colorTextures) {
      gl.bindTexture(t.target, t.handle);
      gl.generateMipmap(t.target);
    }
    gl.bindTexture(this.colorTextures[0].target, null);
    return this;
  }

  dispose() {
    this.colorTextures?.forEach((t) => t.dispose());
    this.depthTexture?.dispose();
    this.depthRenderbuffer?.dispose();
    this.msaaTarget?.dispose();
    this.msaaDepth?.dispose();
    this.fbo?.dispose();
    this.colorTextures = this.depthTexture = this.depthRenderbuffer = this.msaaTarget = this.msaaDepth = this.fbo = null;
  }
}

export class Renderbuffer {
  constructor(ctx, o = {}) {
    this.ctx = ctx;
    this.gl = ctx.gl;
    this.kind = 'framebuffer';
    this.isRenderbuffer = true;
    this.name = o.name || 'rb';
    this.width = o.width || 1;
    this.height = o.height || 1;
    this.internalFormat = o.internalFormat;
    this.samples = o.samples || 0;
    this._handle = null;
    this._createGL();
    ctx.register(this);
  }

  _createGL() {
    const gl = this.gl;
    this._handle = this._handle || gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this._handle);
    if (this.samples > 0) {
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.samples, this.internalFormat, this.width, this.height);
    } else {
      gl.renderbufferStorage(gl.RENDERBUFFER, this.internalFormat, this.width, this.height);
    }
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
  }

  _onContextLost() { this._handle = null; }
  _onContextRestored() { this._createGL(); }

  get handle() { return this._handle; }
  dispose() { if (this._handle) this.gl.deleteRenderbuffer(this._handle); this._handle = null; this.ctx.unregister(this); }
}

/** WEBGL_draw_buffers re-declares these under a *_WEBGL suffix. */
function webglDrawBufferEnum(e) {
  return e === 0 ? 0x1800 /* NONE */ : 0x8CE0 + (e - 0x8CE0) /* COLOR_ATTACHMENT0 + n */;
}

/**
 * Bind the default framebuffer (the canvas) and reset the state cache.
 */
export function bindScreen(ctx, { clear = true, clearColor = [0, 0, 0, 1], clearDepth = true } = {}) {
  const gl = ctx.gl;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  ctx._state.framebuffer = null;
  ctx.applyViewport(null);
  if (clear) {
    gl.clearColor(clearColor[0], clearColor[1], clearColor[2], clearColor[3]);
    let bits = gl.COLOR_BUFFER_BIT;
    if (clearDepth) { ctx.setDepth(true, true); bits |= gl.DEPTH_BUFFER_BIT; }
    gl.clear(bits);
  }
  return ctx;
}
