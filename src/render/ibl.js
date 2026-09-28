/**
 * Image-based lighting: radiance cube, irradiance SH, prefiltered specular cube and
 * the split-sum BRDF LUT — all produced at runtime from the analytic sky.
 *
 * The whole chain is rebuilt whenever the sky settings change, which takes a few
 * milliseconds and needs no asset pipeline. On devices without float render
 * targets the chain degrades gracefully: the SH terms still light the scene, the
 * prefiltered cube falls back to the base level, and the analytic environment BRDF
 * replaces the LUT.
 */

import { ProgramCache } from '../gl/program.js';
import { Texture, FILTER, WRAP, hdrFormat } from '../gl/texture.js';
import { RenderTarget, Framebuffer } from '../gl/framebuffer.js';
import { BufferObject } from '../gl/buffer.js';
import { color, vec3, clamp } from '../core/math.js';
import {
  cubeVertexShader, quadVertexShader, radianceFragmentShader, irradianceShader,
  prefilterShader, brdfLutShader, CUBE_FACES, SKY_DEFAULTS
} from '../gl/shaders/sky.js';

export const IBL_CONFIG = {
  radianceSize: 128,
  irradianceSize: 16,
  prefilteredSize: 128,
  prefilteredMips: 6,
  brdfLutSize: 128,
  shSamples: 4096
};

export class IBL {
  constructor(ctx, log) {
    this.ctx = ctx;
    this.gl = ctx.gl;
    this.log = log;
    this.programs = new ProgramCache(ctx, log);
    this.settings = { ...SKY_DEFAULTS };
    this.sh = new Float32Array(27);
    this.dirty = true;
    this.enabled = true;
    this.stats = { lastBuildMs: 0, samples: 0 };

    this._quad = new BufferObject(ctx, {
      name: 'ibl.quad',
      data: new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]),
      usage: 'static'
    });
    // Dedicated VAO: cube/quad generation must not disturb another pass's state.
    // Created lazily by ctx.cachedVAO so a context loss cannot leave it dangling.
  }

  setSky(settings) {
    let changed = false;
    for (const k in settings) {
      if (JSON.stringify(this.settings[k]) !== JSON.stringify(settings[k])) { this.settings[k] = settings[k]; changed = true; }
    }
    if (changed) this.dirty = true;
    return changed;
  }

  /** Compute the 9 SH coefficients of the analytic sky on the CPU. */
  computeSH() {
    const sh = this.sh;
    sh.fill(0);
    const N = IBL_CONFIG.shSamples;
    const dir = [0, 0, 0];
    let totalWeight = 0;
    for (let i = 0; i < N; i++) {
      // Fibonacci sphere: uniform, deterministic, no stratification artefacts.
      const t = (i + 0.5) / N;
      const cosT = 1 - 2 * t;
      const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
      const phi = i * 2.399963229728653;
      dir[0] = Math.cos(phi) * sinT;
      dir[1] = cosT;      // world Y is up
      dir[2] = Math.sin(phi) * sinT;
      const rgb = this.analyticRadiance(dir, 1);
      const dOmega = (4 * Math.PI) / N;
      color.projectSH9(sh, dir, rgb, dOmega);
      totalWeight += dOmega;
    }
    // Renormalise so energy is independent of the sample count.
    const k = (4 * Math.PI) / totalWeight;
    for (let i = 0; i < 27; i++) sh[i] *= k;
    return sh;
  }

  /** CPU mirror of the pcSkyRadiance() GLSL chunk — kept in sync by hand. */
  analyticRadiance(dir, intensityScale = 1) {
    const s = this.settings;
    const d = dir;
    const up = clamp(d[1] * 0.5 + 0.5, 0, 1);
    const horizon = Math.pow(1 - Math.abs(d[1]), 4);
    const sun = clamp(d[0] * s.sunDirection[0] + d[1] * s.sunDirection[1] + d[2] * s.sunDirection[2], 0, 1);
    const mixT = clamp(d[1] * 6 + s.groundBlend, 0, 1);
    const k = 0.65 + 0.35 * up;
    const mie = miePhase(sun, 0.76) * 0.06 * s.turbidity;
    const disc = smoothstep(0.99965, 0.99992, sun) * 12;
    const out = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const sky = s.zenith[c] * (1 - horizon) + s.horizon[c] * horizon;
      const col = s.ground[c] * (1 - mixT) + sky * mixT;
      out[c] = (col * k + s.sunColor[c] * (mie + disc)) * s.sunIntensity * s.exposure * intensityScale;
    }
    return out;
  }

  /** Build the GPU textures. Safe to call on every settings change. */
  build() {
    const ctx = this.ctx;
    const gl = ctx.gl;
    if (!this.enabled) return null;
    const t0 = performance.now();
    this.computeSH();

    const fmt = hdrFormat(ctx);
    const mkCube = (size, { mips = false, type = 'cube', filter = FILTER.linear, srgb = false }) => new Texture(ctx, {
      name: `ibl.${type}.${size}`,
      target: gl.TEXTURE_CUBE_MAP,
      width: size, height: size,
      internalFormat: srgb ? (ctx.caps.isWebGL2 ? gl.SRGB8_ALPHA8 : gl.RGBA8) : fmt.internalFormat,
      format: fmt.format, type: fmt.type,
      mipmaps: mips, filter, wrap: WRAP.clamp
    });

    this.radiance = mkCube(IBL_CONFIG.radianceSize, { mips: true, type: 'radiance' });
    this.irradiance = mkCube(IBL_CONFIG.irradianceSize, { type: 'irradiance' });
    this.prefiltered = mkCube(IBL_CONFIG.prefilteredSize, { mips: true, type: 'prefiltered' });
    this.brdfLut = new Texture(ctx, {
      name: 'ibl.brdfLut',
      width: IBL_CONFIG.brdfLutSize, height: IBL_CONFIG.brdfLutSize,
      internalFormat: fmt.internalFormat, format: fmt.format, type: fmt.type,
      filter: FILTER.linear, wrap: WRAP.clamp
    });

    this._renderCubeRadiance();
    this._renderIrradiance();
    this._renderPrefilter();
    this._renderBrdfLut();
    this.dirty = false;
    this.stats.lastBuildMs = performance.now() - t0;
    this.stats.samples = IBL_CONFIG.shSamples;
    ctx.checkErrors('ibl.build');
    return this;
  }

  _bindQuad() {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quad.handle);
  }

  _drawQuad(program) {
    const gl = this.gl;
    const ctx = this.ctx;
    ctx.bindVAO(ctx.cachedVAO(this, '_quadVAO'));
    this._bindQuad();
    const loc = program.attributes.get('aPosition')?.loc ?? 0;
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    ctx.debug.draws++;
  }

  _renderCubeRadiance() {
    const { gl } = this;
    const program = this.programs.get({
      name: 'ibl.radiance', vertex: cubeVertexShader, fragment: radianceFragmentShader
    });
    program.bind();
    this._setSkyUniforms(program);
    for (let f = 0; f < 6; f++) {
      this._bindCubeFace(this.radiance, f);
      const face = CUBE_FACES[f];
      program.set('uFaceForward', face.forward);
      program.set('uFaceRight', face.right);
      program.set('uFaceUp', face.up);
      this._drawQuad(program);
    }
    // Re-apply filtering now that every face exists and the mip chain is built.
    // The loop above re-pointed the FBO at each face, so nothing is bound to the
    // cube target any more — _applyParams needs the texture bound or it is a
    // silent no-op behind an INVALID_OPERATION.
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.radiance.handle);
    // Fill the mip chain. A fullscreen environment pass has enormous screen-space
    // derivatives on the direction vector, so the implicit LOD of `textureCube`
    // lands several levels down — with null-allocated levels that samples black
    // and the whole environment disappears. Generating the chain makes both the
    // convolution passes and the background correct.
    if (this.radiance.mipmaps) {
      gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.radiance.handle);
      gl.generateMipmap(gl.TEXTURE_CUBE_MAP);
      if (gl.getError() !== gl.NO_ERROR) {
        // Not every ES 2.0 device can mipmap a half-float target: fall back to
        // a single level, which costs sharpness in the specular prefilter.
        this.log?.warn('generateMipmap unavailable for the radiance cube — using a single mip');
        this.radiance.mipmaps = false;
        this.radiance._applyParams();
      }
    }
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
  }

  _renderIrradiance() {
    const { gl } = this;
    const program = this.programs.get({
      name: 'ibl.irradiance', vertex: cubeVertexShader, fragment: irradianceShader
    });
    program.bind();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.radiance.handle);
    program.set('uSource', 0);
    for (let f = 0; f < 6; f++) {
      this._bindCubeFace(this.irradiance, f);
      const face = CUBE_FACES[f];
      program.set('uFaceForward', face.forward);
      program.set('uFaceRight', face.right);
      program.set('uFaceUp', face.up);
      this._drawQuad(program);
    }
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
  }

  _renderPrefilter() {
    const { gl } = this;
    const program = this.programs.get({
      name: 'ibl.prefilter', vertex: cubeVertexShader, fragment: prefilterShader
    });
    program.bind();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.radiance.handle);
    program.set('uSource', 0);
    program.set('uSourceSize', IBL_CONFIG.radianceSize);
    for (let mip = 0; mip < IBL_CONFIG.prefilteredMips; mip++) {
      const size = Math.max(1, IBL_CONFIG.prefilteredSize >> mip);
      const rough = IBL_CONFIG.prefilteredMips > 1 ? mip / (IBL_CONFIG.prefilteredMips - 1) : 0;
      program.set('uRoughness', rough);
      for (let f = 0; f < 6; f++) {
        this._bindCubeFace(this.prefiltered, f, mip);
        const face = CUBE_FACES[f];
        program.set('uFaceForward', face.forward);
        program.set('uFaceRight', face.right);
        program.set('uFaceUp', face.up);
        this._drawQuad(program);
      }
    }
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
  }

  _renderBrdfLut() {
    const { ctx } = this;
    const program = this.programs.get({
      name: 'ibl.brdfLut', vertex: quadVertexShader, fragment: brdfLutShader
    });
    program.bind();
    const fbo = this._brdfFbo || (this._brdfFbo = new Framebuffer(ctx, { name: 'ibl.brdfFbo', width: IBL_CONFIG.brdfLutSize, height: IBL_CONFIG.brdfLutSize }));
    fbo.attachColor(this.brdfLut);
    fbo.bind({ clear: true, clearColor: [0, 0, 0, 1] });
    this._drawQuad(program);
  }

  _bindCubeFace(texture, face, level = 0) {
    const { gl, ctx } = this;
    const fbo = this._cubeFbo || (this._cubeFbo = new Framebuffer(ctx, { name: 'ibl.cubeFbo' }));
    fbo.bind({ clear: false });
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_CUBE_MAP_POSITIVE_X + face, texture.handle, level);
    ctx.applyViewport({ width: texture.width >> level, height: texture.height >> level });
  }

  _setSkyUniforms(program) {
    const s = this.settings;
    program.set('uSkyZenith', s.zenith);
    program.set('uSkyHorizon', s.horizon);
    program.set('uSkyGround', s.ground);
    program.set('uSunDirection', vec3.normalize(vec3.create(), s.sunDirection));
    program.set('uSunColor', s.sunColor);
    program.set('uSunIntensity', s.sunIntensity);
    program.set('uSkyTurbidity', s.turbidity);
    program.set('uSkyExposure', s.exposure);
    program.set('uGroundBlend', s.groundBlend);
  }

  /** SH coefficients formatted for the PBR shader (array of vec3). */
  shUniform(out = new Float32Array(27)) { out.set(this.sh); return out; }

  /** Irradiance of the SH in a given direction — also used by the light gizmos. */
  irradianceAt(dir) {
    const x = dir[0], y = dir[2], z = dir[1];
    const sh = this.sh;
    const c1 = 0.429043, c2 = 0.511664, c3 = 0.743125, c4 = 0.886227, c5 = 0.247708;
    const out = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      out[i] = c4 * sh[i]
        + 2 * c1 * (sh[24 + i] * (x * x - y * y) + sh[15 + i] * x * z + sh[12 + i] * y * z)
        + c3 * sh[18 + i] * z * z - c5 * sh[18 + i]
        + 2 * c2 * (sh[9 + i] * x + sh[3 + i] * y + sh[6 + i] * z);
    }
    return out;
  }

  get prefilteredMips() { return IBL_CONFIG.prefilteredMips; }

  /** Highest mip actually written into the prefiltered cube. */
  get prefilteredLevels() { return Math.min(IBL_CONFIG.prefilteredMips, IBL_CONFIG.prefilteredSize > 1 ? Math.log2(IBL_CONFIG.prefilteredSize) + 1 : 1); }
  get brdfLutAvailable() { return !!this.brdfLut; }
  get isEmulated() { return !this.ctx.caps.limits.colorBufferFloat; }

  dispose() {
    this.radiance?.dispose();
    this.irradiance?.dispose();
    this.prefiltered?.dispose();
    this.brdfLut?.dispose();
    this._cubeFbo?.dispose();
    this._brdfFbo?.dispose();
    this._quad.dispose();
    if (this._quadVAO) this.gl.deleteVertexArray(this._quadVAO);
    this.programs.clear();
  }
}

function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

function miePhase(c, g) {
  const g2 = g * g;
  const num = 3 * (1 - g2) * (1 + c * c);
  const den = 8 * Math.PI * (2 + g2) * Math.pow(1 + g2 - 2 * g * c, 1.5);
  return num / Math.max(den, 1e-6);
}

