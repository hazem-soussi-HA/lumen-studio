/**
 * Forward renderer.
 *
 * Frame graph
 *   [on demand] IBL rebuild                (radiance cube → irradiance → prefilter → BRDF LUT)
 *   shadow cascades 0..N-1                 depth-only, front-face culled
 *   scene target (HDR, MSAA)  ──►  sky background
 *                              ──►  opaque queue   front-to-back, instanced batches merged
 *                              ──►  volume queue   ray-marched
 *                              ──►  transparent queue back-to-front
 *                              ──►  grid → helpers → gizmos (unlit)
 *   [if dirty]  picking target             24-bit ids, 1×1 readPixels on click
 *   [if enabled] SSAO from the depth texture
 *   bloom: threshold → progressive downsample → additive tent upsample
 *   composite: AO · selection outline · exposure · bloom · tonemap · grade ·
 *              vignette · grain · chromatic aberration · FXAA → canvas
 *
 * Every branch below is driven by the capability report: no float render targets
 * means RGBA8 plus a clamped tonemapper, no instancing means one draw per object,
 * and a software rasteriser gets the `software` tier budget.
 */

import { mat4, mat3, vec3, quat, aabb, clamp, frustum, color as ColorUtil } from '../core/math.js';
import { ProgramCache } from '../gl/program.js';
import { BufferObject } from '../gl/buffer.js';
import { Mesh, InstanceBuffer } from '../gl/mesh.js';
import { RenderTarget, bindScreen } from '../gl/framebuffer.js';
import { DynamicBatch } from '../gl/dynamic.js';
import { whitePixel, flatNormalPixel, blackPixel } from '../gl/texture.js';
import { IBL } from './ibl.js';
import { ShadowSystem } from './shadow.js';
import { Camera } from './camera.js';
import { vertexShader as pbrVert, fragmentShader as pbrFrag, depthVertexShader, depthFragmentShader } from '../gl/shaders/pbr.js';
import {
  gridVertexShader, gridFragmentShader, unlitVertexShader, unlitFragmentShader,
  pickingVertexShader, pickingFragmentShader, blitVertexShader, blitFragmentShader, presentFragmentShader,
  bloomDownShader, bloomUpShader, compositeShader, ssaoShader,
  volumeVertexShader, volumeFragmentShader
} from '../gl/shaders/utility.js';
import { icosphere } from '../scene/primitives.js';
import { Material } from '../scene/material.js';
import { quadVertexShader, skyFragmentShader } from '../gl/shaders/sky.js';

export const DEBUG_VIEWS = [
  { id: 0, name: 'Shaded' },
  { id: 1, name: 'Base Colour' },
  { id: 2, name: 'World Normal' },
  { id: 3, name: 'Roughness' },
  { id: 4, name: 'Metalness' },
  { id: 5, name: 'Ambient Occlusion' },
  { id: 6, name: 'Emissive' },
  { id: 7, name: 'Linear Depth' },
  { id: 8, name: 'Specular F0' },
  { id: 9, name: 'Light Count' },
  { id: 10, name: 'Sun Shadow' },
  { id: 11, name: 'UV Tiling' },
  { id: 12, name: 'Fresnel' },
  { id: 13, name: 'Opacity' }
];

const UNIT = {
  diffuse: 0, normal: 1, metalRough: 2, occlusion: 3, emissive: 4,
  brdf: 5, prefiltered: 6, shadow0: 7, shadow1: 8, volume: 9, screen: 11, aux: 12
};

const MAX_LIGHTS_CAP = 8;

export class Renderer {
  constructor(ctx, log) {
    this.ctx = ctx;
    this.gl = ctx.gl;
    this.log = log;
    this.caps = ctx.caps;
    this.budget = ctx.caps.tier.budget;
    this.assets = null;              // injected by the application

    this.programs = new ProgramCache(ctx, log);
    this.ibl = new IBL(ctx, log);
    this.shadows = new ShadowSystem(ctx, {
      cascadeCount: 2,
      resolution: Math.min(2048, this.budget.shadowMapSize),
      log
    });

    this.settings = {
      exposure: 1.0,
      toneMapping: 5,   // ACES; see TONE_MAP in scene/components.js
      skyMode: 'cube',               // 'cube' (prefiltered) | 'analytic'
      bloom: this.budget.bloom,
      bloomStrength: 0.05,
      bloomThreshold: 1.05,
      bloomIterations: 5,
      ssao: this.budget.ssao,
      ssaoRadius: 0.6,
      ssaoIntensity: 1.1,
      selectionOutline: true,
      fxaa: true,
      vignette: 0.32,
      grain: 0.012,
      chromatic: 0.3,
      contrast: 1.02,
      saturation: 1.0,
      fog: true,
      fogColor: [0.4, 0.48, 0.6],
      fogDensity: 0.0055,
      fogHeightFalloff: 0.05,
      ambient: [0.1, 0.12, 0.16],
      ambientIntensity: 1.0,
      grid: true,
      gridCell: 1,
      gridMajorEvery: 10,
      gridOpacity: 0.7,
      gridColor: [0.32, 0.35, 0.4],
      gridAxisX: [0.85, 0.24, 0.32],
      gridAxisZ: [0.28, 0.5, 0.86],
      showShadows: true,
      outlineColor: [1, 0.62, 0.15]
    };

    this.debugView = 0;
    this.frame = 0;
    this.time = 0;
    this.drawCalls = 0;
    this.triangles = 0;
    this.visibleCount = 0;
    this.culledCount = 0;
    this.gpuTime = 0;
    this.gpuTimings = {};
    this.width = 2;
    this.height = 2;

    this._lights = {
      count: 0,
      pos4: new Float32Array(MAX_LIGHTS_CAP * 4),
      color: new Float32Array(MAX_LIGHTS_CAP * 3),
      params: new Float32Array(MAX_LIGHTS_CAP * 2),
      axis: new Float32Array(MAX_LIGHTS_CAP * 3),
      sunIndex: -1,
      sunIntensity: -1
    };

    this._opaque = [];
    this._transparent = [];
    this._volumes = [];
    this._shadowCasters = [];
    this._pickingIds = new Map();
    this._pickingDirty = true;
    this._instanceBuffer = null;
    this._previewSphere = null;
    this._previewCamera = new Camera({ position: [0, 0, 2.4] });

    this._initGeometry();
    this._initTextures();
    this._initTargets(2, 2);
  }

  /* ------------------------------------------------------------- startup */

  _initGeometry() {
    const ctx = this.ctx;
    this._quad = new BufferObject(ctx, {
      name: 'quad',
      data: new Float32Array([-1, -1, 3, -1, -1, 3]),
      usage: 'static'
    });
    // Fullscreen passes get their own VAO. Without it, a post/IBL draw would
    // rewrite attribute 0 of whatever mesh VAO happens to be bound — silently
    // corrupting the next mesh that reuses it. Created lazily by ctx.cachedVAO so
    // a context loss cannot leave it dangling.
    this._gridMesh = new Mesh(ctx, {
      positions: new Float32Array([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1]),
      normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
      uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3])
    }, { name: 'grid' });

    this.overlayLines = new DynamicBatch(ctx, { name: 'overlay.lines', maxVertices: 32768, primitive: 'lines' });
    this.overlayTris = new DynamicBatch(ctx, { name: 'overlay.tris', maxVertices: 16384, primitive: 'triangles' });
    this.gizmoBatch = new DynamicBatch(ctx, { name: 'gizmo', maxVertices: 16384, primitive: 'triangles' });
  }

  _initTextures() {
    this.white = whitePixel(this.ctx);
    this.flatNormal = flatNormalPixel(this.ctx);
    this.black = blackPixel(this.ctx);
  }

  _initTargets(width, height) {
    const ctx = this.ctx;
    const hdr = this.caps.limits.colorBufferFloat;

    const rebuild = (name, opts) => {
      this[name]?.dispose();
      this[name] = new RenderTarget(ctx, { name, width, height, ...opts });
    };

    rebuild('sceneTarget', {
      count: 1, hdr, depth: 'renderbuffer', mips: false, filter: 'linear', msaa: this.budget.msaa
    });
    rebuild('depthTarget', {
      count: 1, hdr: false, filter: 'nearest', mips: false,
      depth: this.caps.limits.depthTexture ? 'texture' : 'renderbuffer'
    });
    rebuild('pickingTarget', {
      count: 1, hdr: false, depth: 'renderbuffer', filter: 'nearest', mips: false
    });
    if (this.caps.limits.depthTexture) {
      rebuild('ssaoTarget', { count: 1, hdr: false, depth: 'none', filter: 'linear' });
    } else {
      this.ssaoTarget?.dispose();
      this.ssaoTarget = null;
    }

    for (const t of this.bloomChain || []) t.dispose();
    this.bloomChain = [];
    if (this.settings.bloom) {
      let w = Math.max(1, width >> 1), h = Math.max(1, height >> 1);
      for (let i = 0; i < this.settings.bloomIterations; i++) {
        this.bloomChain.push(new RenderTarget(ctx, {
          name: `bloom.${i}`, width: w, height: h, count: 1, hdr, depth: 'none', filter: 'linear'
        }));
        w = Math.max(1, w >> 1);
        h = Math.max(1, h >> 1);
        if (w <= 4 || h <= 4) break;
      }
    }
  }

  resize(width, height) {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    if (this.width === w && this.height === h) return false;
    this.width = w;
    this.height = h;
    this._initTargets(w, h);
    this._pickingDirty = true;
    return true;
  }

  setSetting(key, value) {
    if (this.settings[key] === value) return;
    this.settings[key] = value;
    if (key === 'bloom') this._initTargets(this.width, this.height);
    if (key === 'ssao' && value && !this.ssaoTarget && this.caps.limits.depthTexture) {
      this.ssaoTarget = new RenderTarget(this.ctx, {
        name: 'ssao', width: this.width, height: this.height, count: 1, hdr: false, depth: 'none', filter: 'linear'
      });
    }
  }

  /* -------------------------------------------------------- frame graph */

  render(scene, camera, opts = {}) {
    if (this.ctx.lost) return null;
    const dt = opts.dt ?? 1 / 60;
    this.time += dt;
    this.frame++;
    this.drawCalls = 0;
    this.triangles = 0;

    if (this.ibl.dirty) {
      const t = performance.now();
      try { this.ibl.build(); } catch (e) { this.log?.warn('IBL build failed:', e.message); }
      this.log?.debug(`IBL rebuilt in ${(performance.now() - t).toFixed(1)} ms`);
    }

    this._collect(scene, camera);
    if (this.settings.showShadows && this._lights.sunIndex >= 0) {
      this.shadows.enabled = true;
      this.shadows.update(camera, this._shadowCasters);
    } else {
      this.shadows.enabled = false;
    }
    this._renderShadowPasses();

    const timer = this.ctx.beginTimer('frame');

    this.sceneTarget.bind({ clear: true, clearColor: [0, 0, 0, 1], clearDepth: true });
    this._renderBackground(camera);
    this._renderOpaque(camera);
    this._renderVolumes(camera);
    this._renderTransparent(camera);
    if (this.settings.grid) this._renderGrid(camera);
    if (opts.helpers?.length || opts.selection?.length || opts.hover) this._renderHelpers(camera, opts);
    if (opts.gizmos?.draw) this._renderGizmos(camera, opts);
    this.sceneTarget.resolve();

    if (this.settings.ssao && this.ssaoTarget) this._renderSsao(camera);
    if (this.settings.selectionOutline && (opts.selection?.length || opts.hover)) {
      this._renderPicking(scene, camera, opts);
    }
    this._renderPost();

    if (timer) this.ctx.endTimer(timer);
    const timings = this.ctx.drainTimers();
    if (timings) {
      for (const k in timings) this.gpuTimings[k] = (this.gpuTimings[k] || 0) * 0.8 + timings[k] * 0.2;
      this.gpuTime = this.gpuTimings.frame || 0;
    }

    const err = this.ctx.checkErrors('frame');
    if (err) this.log?.error('GL error during frame:', err.error, err.where);
    return { drawCalls: this.drawCalls, triangles: this.triangles };
  }

  /* ------------------------------------------------------------- collect */

  _collect(scene, camera) {
    const opaque = this._opaque, transparent = this._transparent, volumes = this._volumes, casters = this._shadowCasters;
    opaque.length = 0; transparent.length = 0; volumes.length = 0; casters.length = 0;
    this._lights.count = 0;
    this._lights.sunIndex = -1;
    this._lights.sunIntensity = -1;

    const cameraLayers = new Set(camera.layers || [0]);
    const camFrustum = camera.frustum;
    const family = scene.root.family();
    let visible = 0, culled = 0;

    for (const entity of family) {
      if (!entity.enabled) continue;
      if (entity.components.light) this._packLight(entity);
      if (entity.components.volume?.asset) {
        const asset = this.assets?.get(entity.components.volume.asset);
        const meshAsset = this.assets?.get(entity.components.render?.mesh);
        if (asset?.gpu && meshAsset?.gpu) {
          volumes.push({ entity, asset: asset.gpu, data: entity.components.volume, mesh: meshAsset.gpu });
        }
        continue;
      }
      const render = entity.components.render;
      if (!render || render.visible === false || !render.mesh) continue;
      const mesh = this.assets?.get(render.mesh)?.gpu;
      if (!mesh) continue;
      const material = this.assets?.get(render.material)?.material;
      if (!material) continue;

      let box = entity.worldAABB;
      const instances = Math.max(0, Math.floor(render.instanceCount || 0));
      const spread = render.instanceSpread ?? 4;
      const layout = render.instanceLayout || 'grid';
      // Instanced draws are one call for N copies, so the entity's own bounds
      // describe only the base mesh. Grow the box to enclose every instance,
      // otherwise the culler drops the entity when the base mesh is off-screen
      // (its instances are not) and the shadow fit volume ignores the whole set.
      if (instances > 1) {
        const e = instanceExtent({ instances, spread, layout });
        // A fresh box, not a shared scratch: the shadow-caster list keeps this
        // reference for the rest of the frame, long after the loop has moved on.
        box = aabb.expand({
          min: vec3.clone(box.min), max: vec3.clone(box.max)
        }, Math.max(e[0], e[2]));
        box.min[1] -= e[1]; box.max[1] += e[1];
      }
      if (camera.frustumCulling && !frustum.containsAABB(camFrustum, box)) { culled++; continue; }
      if (!(render.layers || [0]).some((l) => cameraLayers.has(l))) { culled++; continue; }

      const center = [(box.min[0] + box.max[0]) * 0.5, (box.min[1] + box.max[1]) * 0.5, (box.min[2] + box.max[2]) * 0.5];
      const item = {
        entity, mesh, material,
        world: entity.worldMatrix,
        normal: entity.normalMatrix,
        center,
        distance: vec3.distSq(center, camera.position),
        instances, spread, layout,
        castShadows: render.castShadows && material.cull !== 'none',
        receiveShadows: render.receiveShadows !== false
      };
      (material.isTransparent ? transparent : opaque).push(item);
      if (item.castShadows && this.settings.showShadows) casters.push(box);
      visible++;
    }

    this.visibleCount = visible;
    this.culledCount = culled;
    opaque.sort((a, b) => a.distance - b.distance);
    transparent.sort((a, b) => b.distance - a.distance);
  }

  _packLight(entity) {
    const L = entity.components.light;
    if (!L || L.enabled === false) return;
    const cap = Math.min(this._maxLights, this.budget.maxLights);
    if (this._lights.count >= cap) return;
    const i = this._lights.count++;
    const P = this._lights;
    const c = ColorUtil.srgbToLinear(L.color);
    const world = entity.worldMatrix;
    // The entity's local +Z axis is the light's direction (PlayCanvas convention:
    // a spot light shines down its -Z... we use +Z so the gizmo arrow matches).
    const f = [world[8], world[9], world[10]];
    const p = entity.worldPosition;

    P.color[i * 3] = c[0] * L.intensity;
    P.color[i * 3 + 1] = c[1] * L.intensity;
    P.color[i * 3 + 2] = c[2] * L.intensity;

    if (L.type === 'directional') {
      P.pos4[i * 4] = f[0]; P.pos4[i * 4 + 1] = f[1]; P.pos4[i * 4 + 2] = f[2];
      P.pos4[i * 4 + 3] = 0;
      P.params[i * 2] = -1; P.params[i * 2 + 1] = -1;
      P.axis[i * 3] = 0; P.axis[i * 3 + 1] = 1; P.axis[i * 3 + 2] = 0;
      if (L.castShadows && L.intensity > P.sunIntensity) {
        P.sunIntensity = L.intensity;
        P.sunIndex = i;
        this.shadows.bias = L.shadowBias ?? 0.2;
        this.shadows.shadowDistance = L.shadowDistance ?? 60;
        this.shadows.strength = 1;
      }
    } else {
      P.pos4[i * 4] = p[0]; P.pos4[i * 4 + 1] = p[1]; P.pos4[i * 4 + 2] = p[2];
      P.pos4[i * 4 + 3] = L.range ?? 10;
      if (L.type === 'spot') {
        P.params[i * 2] = Math.cos((L.outerConeAngle || 35) * Math.PI / 180);
        P.params[i * 2 + 1] = Math.cos((L.innerConeAngle || 20) * Math.PI / 180);
        P.axis[i * 3] = f[0]; P.axis[i * 3 + 1] = f[1]; P.axis[i * 3 + 2] = f[2];
      } else {
        P.params[i * 2] = -1; P.params[i * 2 + 1] = -1;
        P.axis[i * 3] = 0; P.axis[i * 3 + 1] = -1; P.axis[i * 3 + 2] = 0;
      }
    }
  }

  get _maxLights() {
    // GLSL ES 1.00 only guarantees 16 fragment uniform vectors, so the light
    // array size is a *compile-time* decision driven by the reported limit.
    const vectors = this.caps.limits.maxFragmentUniformVectors || 224;
    if (vectors >= 96) return 8;
    if (vectors >= 64) return 4;
    return 2;
  }

  /* -------------------------------------------------------------- passes */

  _renderShadowPasses() {
    if (!this.shadows.enabled) return;
    const { gl, ctx } = this;
    const program = this._depthProgram();
    program.bind();
    for (let i = 0; i < this.shadows.cascades.length; i++) {
      const cascade = this.shadows.cascades[i];
      ctx.setDepth(true, true, 'less');
      ctx.setCull('front');        // front-face culling hides most acne on thin geometry
      ctx.setBlend('none');
      cascade.target.bind({ clear: true, clearColor: [1, 1, 1, 1], clearDepth: true });
      program.set('uLightViewProjection', cascade.viewProj);
      program.set('uUvOffsetZ', i * 3.7);
      if (program.has('uAlphaTest')) program.setTexture('uAlbedoMap', this.white, UNIT.diffuse);
      for (const item of this._opaque) {
        if (!item.castShadows) continue;
        program.set('uModel', item.world);
        program.set('uAlphaTest', item.material.alphaTest || 0);
        program.set('uHasAlbedoMap', item.material.diffuseMap ? 1 : 0);
        if (item.material.diffuseMap) {
          program.setTexture('uAlbedoMap', this._textureFor(item.material.diffuseMap, this.white), UNIT.diffuse);
        }
        item.mesh.draw(program);
        this.drawCalls++;
        this.triangles += item.mesh.triangleCount;
      }
    }
  }

  _depthProgram() {
    return this.programs.get({
      name: 'depth', vertex: depthVertexShader, fragment: depthFragmentShader
    }, {
      PC_ALPHA_TEST_DEPTH: true,
      PC_PACKED_DEPTH: this.caps.limits.depthTexture ? false : true
    });
  }

  _renderBackground(camera) {
    const { gl, ctx } = this;
    const program = this.programs.get({
      name: 'sky', vertex: quadVertexShader, fragment: skyFragmentShader
    }, { PC_SKY_ANALYTIC: this.settings.skyMode === 'analytic' });
    program.bind();
    ctx.setDepth(true, false, 'lessEqual');
    ctx.setBlend('none');
    ctx.setCull('none');
    program.set('uInvViewProjection', mat4.invert(_m1, camera.viewProj));
    program.set('uCameraPosition', camera.position);
    program.set('uBackgroundIntensity', this.ibl.settings.backgroundIntensity);
    if (this.ibl.radiance) {
      gl.activeTexture(gl.TEXTURE0 + UNIT.screen);
      gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.ibl.radiance.handle);
      program.set('uRadiance', UNIT.screen);
    }
    this._setSkyUniforms(program);
    this._drawQuad(program);
    ctx.setDepth(true, true);
  }

  _setSkyUniforms(program) {
    const s = this.ibl.settings;
    program.set('uSkyZenith', s.zenith);
    program.set('uSkyHorizon', s.horizon);
    program.set('uSkyGround', s.ground);
    program.set('uSunDirection', vec3.normalize(_v1, s.sunDirection));
    program.set('uSunColor', s.sunColor);
    program.set('uSunIntensity', s.sunIntensity);
    program.set('uSkyTurbidity', s.turbidity);
    program.set('uSkyExposure', s.exposure);
    program.set('uGroundBlend', s.groundBlend);
  }

  _pbrProgram(item) {
    const m = item.material || {};
    return this.programs.get({
      name: 'pbr', vertex: pbrVert, fragment: pbrFrag
    }, {
      PCL_INSTANCED: item.instances > 0 && this.caps.limits.instancing,
      PCL_VERTEX_COLOR: m.vertexColors && !!item.mesh.vertexColors,
      PCL_NORMALMAP_DERIV: this.caps.limits.derivatives,
      PC_SHADOW_HW: this.caps.limits.depthTexture && this.settings.showShadows,
      MAX_LIGHTS: this._maxLights
    });
  }

  _renderOpaque(camera) {
    const { ctx } = this;
    ctx.setDepth(true, true, 'less');
    ctx.setBlend('none');

    if (!this.caps.limits.instancing) {
      for (const item of this._opaque) this._drawItem(item, camera, null, false);
      return;
    }

    // Merge every instanced request that shares a (mesh, material) pair into a
    // single draw call — the whole point of the instancing path.
    const groups = new Map();
    for (const item of this._opaque) {
      if (item.instances <= 0) { this._drawItem(item, camera, null, false); continue; }
      // Only requests that agree on the *generated transforms* can share a draw:
      // the instance stream is built per item from its layout and spread.
      const key = `${item.mesh._id}|${item.material.key}|${item.layout}|${item.spread}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { mesh: item.mesh, material: item.material, items: [] }));
      g.items.push(item);
    }
    if (!groups.size) return;

    const ib = this._getInstanceBuffer();
    ib.reset();
    for (const g of groups.values()) {
      ib.reset();
      for (const item of g.items) {
        for (let k = 0; k < item.instances; k++) {
          buildInstanceMatrix(_m2, item.entity.worldMatrix, k, item.spread, item.instances, item.layout);
          ib.push(_m2, instanceTint(k, item.instances));
        }
      }
      ib.upload();
      this._drawItem({
        entity: g.items[0].entity, mesh: g.mesh, material: g.material,
        world: g.items[0].world, normal: g.items[0].normal,
        instances: ib.count, castShadows: false
      }, camera, ib, true);
    }
    ib.resetDivisors();
    ib.reset();
  }

  _drawItem(item, camera, instanceBuffer, instanced) {
    const { ctx } = this;
    const m = item.material;
    const program = this._pbrProgram(item);
    program.bind();
    this._setCommonUniforms(program, camera);
    this._setMaterialUniforms(program, m, item);
    if (!instanced) {
      program.set('uModel', item.world);
      program.set('uNormalMatrix', item.normal);
    }
    ctx.setDepth(m.depthTest !== false, m.depthWrite !== false);
    ctx.setCull(m.cullMode);
    if (instanced) item.mesh.instances = item.instances;
    item.mesh.draw(program, { instanceBuffer });
    if (instanced) item.mesh.instances = 0;
    this.drawCalls++;
    this.triangles += item.mesh.triangleCount;
  }

  _setCommonUniforms(program, camera) {
    const { gl } = this;
    const s = this.settings;
    const P = this._lights;
    const max = this._maxLights;

    program.set('uViewProjection', camera.viewProj);
    program.set('uCameraPosition', camera.position);
    program.set('uAmbient', s.ambient);
    program.set('uAmbientIntensity', s.ambientIntensity);
    program.set('uFogColor', s.fogColor);
    program.set('uFogDensity', s.fogDensity);
    program.set('uFogEnabled', s.fog ? 1 : 0);
    program.set('uFogHeightFalloff', s.fogHeightFalloff);
    program.set('uDebugMode', this.debugView);
    program.set('uLightCount', Math.min(P.count, max));
    if (P.count) {
      program.set('uLightPos', P.pos4);
      program.set('uLightColor', P.color);
      program.set('uLightParams', P.params);
      program.set('uLightAxis', P.axis);
    }

    const shadowOn = this.settings.showShadows && this.shadows.enabled;
    program.set('uShadowEnabled', shadowOn ? 1 : 0);
    program.set('uShadowStrength', this.shadows.strength);
    program.set('uShadowSplit', this.shadows.splitDistance);
    const c0 = this.shadows.cascades[0];
    const c1 = this.shadows.cascades[1] || c0;
    if (c0) {
      program.set('uShadowMat0', c0.viewProj);
      program.set('uShadowMat1', c1.viewProj);
      program.set('uShadowTexel0', c0.texel);
      program.set('uShadowTexel1', c1.texel);
      program.set('uShadowBias0', c0.bias);
      program.set('uShadowBias1', c1.bias);
      gl.activeTexture(gl.TEXTURE0 + UNIT.shadow0);
      gl.bindTexture(c0.texture.target, c0.texture.handle);
      program.set('uShadow0', UNIT.shadow0);
      gl.activeTexture(gl.TEXTURE0 + UNIT.shadow1);
      gl.bindTexture(c1.texture.target, c1.texture.handle);
      program.set('uShadow1', UNIT.shadow1);
    }

    const iblOn = this.ibl.enabled && !!this.ibl.prefiltered;
    program.set('uIblEnabled', iblOn ? 1 : 0);
    program.set('uIblIntensity', this.ibl.settings.iblIntensity);
    program.set('uPrefilteredMips', this.ibl.prefilteredMips);
    program.set('uShEnabled', this.ibl.enabled && this.ibl.sh ? 1 : 0);
    if (this.ibl.sh) program.set('uSH', this.ibl.sh);
    if (iblOn) {
      gl.activeTexture(gl.TEXTURE0 + UNIT.prefiltered);
      gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.ibl.prefiltered.handle);
      program.set('uPrefiltered', UNIT.prefiltered);
    }
    if (this.ibl.brdfLut) {
      gl.activeTexture(gl.TEXTURE0 + UNIT.brdf);
      gl.bindTexture(this.ibl.brdfLut.target, this.ibl.brdfLut.handle);
      program.set('uBRDFLut', UNIT.brdf);
      program.set('uBrdfLutEnabled', 1);
    } else {
      program.set('uBrdfLutEnabled', 0);
    }
  }

  _setMaterialUniforms(program, m, item) {
    const { gl } = this;
    program.set('uUvTransform', [m.tiling[0], m.tiling[1], m.offset[0], m.offset[1]]);
    program.set('uUvRotation', m.rotation || 0);
    program.set('uAlbedo', m.diffuse);
    program.set('uMetallic', m.metalness);
    program.set('uRoughness', m.roughness);
    program.set('uSpecular', m.specular);
    program.set('uEmissive', m.emissive);
    program.set('uEmissiveIntensity', m.emissiveIntensity);
    program.set('uAlphaTest', m.alphaTest || 0);
    program.set('uTwoSided', m.twoSidedLighting ? 1 : 0);
    program.set('uOcclusionStrength', m.occlusionStrength);
    program.set('uNormalScale', m.bumpiness);
    program.set('uOcclusionUvChannel', m.occlusionChannel === 'g' ? 1 : 0);
    program.set('uSelected', item?.selected ? 1 : 0);
    program.set('uSelectionColor', this.settings.outlineColor);

    this._bindMap(program, 'uAlbedoMap', 'uHasAlbedoMap', m.diffuseMap, this.white, UNIT.diffuse);
    this._bindMap(program, 'uNormalMap', 'uHasNormalMap', m.normalMap, this.flatNormal, UNIT.normal);
    this._bindMap(program, 'uMetalRoughMap', 'uHasMetalRoughMap', m.metalRoughMap, this.white, UNIT.metalRough);
    this._bindMap(program, 'uOcclusionMap', 'uHasOcclusionMap', m.occlusionMap, this.white, UNIT.occlusion);
    this._bindMap(program, 'uEmissiveMap', 'uHasEmissiveMap', m.emissiveMap, this.black, UNIT.emissive);
  }

  _bindMap(program, samplerName, flagName, assetId, fallback, unit) {
    const { gl } = this;
    const tex = this._textureFor(assetId, fallback);
    program.set(flagName, tex && tex !== fallback ? 1 : 0);
    if (!tex) return;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(tex.target, tex.handle);
    program.set(samplerName, unit);
  }

  _textureFor(assetId, fallback) {
    if (!assetId) return fallback;
    return this.assets?.get(assetId)?.gpu || fallback;
  }

  _renderTransparent(camera) {
    for (const item of this._transparent) {
      const m = item.material;
      this.ctx.setBlend(m.blendMode);
      this.ctx.setDepth(m.depthTest !== false, m.depthWrite !== false);
      this.ctx.setCull(m.cullMode);
      this._drawItem(item, camera, null, false);
    }
    this.ctx.setBlend('none');
  }

  _renderVolumes(camera) {
    if (!this._volumes.length) return;
    const { gl, ctx } = this;
    const program = this.programs.get({
      name: 'volume', vertex: volumeVertexShader, fragment: volumeFragmentShader
    }, { PC_VOLUME_STEPS: 1 });
    program.bind();
    this._setCommonUniforms(program, camera);
    ctx.setBlend('alpha');
    ctx.setDepth(true, false);
    ctx.setCull('none');
    for (const v of this._volumes) {
      const d = v.data;
      const asset = v.asset;
      program.set('uModel', v.entity.worldMatrix);
      program.set('uVolumeColor', d.color);
      program.set('uDensity', d.density);
      program.set('uSteps', clamp(d.steps | 0, 8, 64));
      program.set('uVolumeSize', asset.volumeSize);
      program.set('uVolumeTiles', asset.tiles);
      program.set('uBoundsMin', v.entity.worldAABB.min);
      program.set('uBoundsMax', v.entity.worldAABB.max);
      gl.activeTexture(gl.TEXTURE0 + UNIT.volume);
      gl.bindTexture(asset.target, asset.handle);
      program.set('uVolume', UNIT.volume);
      v.mesh.draw(program);
      this.drawCalls++;
    }
    ctx.setBlend('none');
    ctx.setDepth(true, true);
  }

  _renderGrid(camera) {
    const { ctx } = this;
    const s = this.settings;
    const program = this.programs.get({
      name: 'grid', vertex: gridVertexShader, fragment: gridFragmentShader
    }, { PC_GRID_AA: this.caps.limits.derivatives });
    program.bind();
    // One quad, four vertices, snapped to the grid cell so the lines do not swim
    // as the camera moves.
    _m1.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    _m1[12] = Math.round(camera.position[0] / s.gridCell) * s.gridCell;
    _m1[14] = Math.round(camera.position[2] / s.gridCell) * s.gridCell;
    program.set('uViewProjection', camera.viewProj);
    program.set('uModel', _m1);
    program.set('uGridExtent', 3000);
    program.set('uCameraPosition', camera.position);
    program.set('uCell', s.gridCell);
    program.set('uMajorEvery', s.gridMajorEvery);
    program.set('uMinorColor', s.gridColor);
    program.set('uAxisColorX', s.gridAxisX);
    program.set('uAxisColorZ', s.gridAxisZ);
    program.set('uFadeStart', 6);
    program.set('uFadeEnd', 110);
    program.set('uOpacity', s.gridOpacity);
    program.set('uPlaneY', 0);
    ctx.setDepth(true, true, 'lequal');
    ctx.setBlend('alpha');
    ctx.setCull('none');
    this._gridMesh.draw(program);
    this.drawCalls++;
    ctx.setBlend('none');
  }

  _renderHelpers(camera, opts) {
    const lines = this.overlayLines;
    const tris = this.overlayTris;
    lines.begin();
    tris.begin();
    for (const entity of opts.helpers || []) {
      if (entity.hasComponent('light')) this._drawLightHelper(lines, tris, entity);
      if (entity.hasComponent('camera')) this._drawCameraHelper(lines, entity);
    }
    for (const entity of opts.selection || []) this._drawSelection(lines, entity, [1, 0.62, 0.15, 1]);
    if (opts.hover && !(opts.selection || []).includes(opts.hover)) {
      this._drawSelection(lines, opts.hover, [0.35, 0.85, 1, 0.85]);
    }
    lines.end();
    tris.end();
    this._drawUnlitBatch(lines, camera, 'none');
    this._drawUnlitBatch(tris, camera, 'alpha');
  }

  _drawSelection(batch, entity, color) {
    const box = entity.worldAABB;
    if (aabb.isEmpty(box)) return;
    batch.aabb(box, color, entity.worldMatrix);
    const size = aabb.size(_v1, box);
    const handle = Math.max(size[0], size[1], size[2]) * 0.04;
    if (handle < 0.004) return;
    const axisColor = [[1, 0.3, 0.3, 1], [0.35, 1, 0.4, 1], [0.35, 0.6, 1, 1]];
    for (let axis = 0; axis < 3; axis++) {
      for (const sign of [-1, 1]) {
        const c = [(box.min[0] + box.max[0]) * 0.5, (box.min[1] + box.max[1]) * 0.5, (box.min[2] + box.max[2]) * 0.5];
        c[axis] += sign * (size[axis] * 0.5 + handle);
        batch.aabb({
          min: [c[0] - handle, c[1] - handle, c[2] - handle],
          max: [c[0] + handle, c[1] + handle, c[2] + handle]
        }, axisColor[axis], entity.worldMatrix);
      }
    }
  }

  _drawLightHelper(batch, tris, entity) {
    const L = entity.components.light;
    const col = [...(L.color || [1, 1, 1]), 0.9];
    const p = entity.worldPosition;
    const f = [entity.worldMatrix[8], entity.worldMatrix[9], entity.worldMatrix[10]];
    if (L.type === 'directional') {
      const dir = [f[0], f[1], f[2]];
      const len = 4;
      const tip = [p[0] + dir[0] * len, p[1] + dir[1] * len, p[2] + dir[2] * len];
      batch.lineV(p, tip, col);
      arrowHead(batch, tip, dir, col);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        batch.lineV(p, [p[0] + Math.cos(a) * 1.1, p[1] - 0.5, p[2] + Math.sin(a) * 1.1], [col[0], col[1], col[2], 0.3]);
      }
    } else if (L.type === 'spot') {
      const range = L.range || 5;
      const outer = (L.outerConeAngle || 35) * Math.PI / 180;
      const r = Math.tan(outer) * range;
      for (let i = 0; i < 16; i++) {
        const a0 = (i / 16) * Math.PI * 2, a1 = ((i + 1) / 16) * Math.PI * 2;
        const p0 = coneRingPoint(p, f, a0, r, range);
        const p1 = coneRingPoint(p, f, a1, r, range);
        batch.lineV(p0, p1, col);
        batch.lineV(p, p0, [col[0], col[1], col[2], 0.25]);
      }
    } else {
      batch.sphereLines(p, Math.min(0.4, (L.range || 5) * 0.05), col, 16, 8);
    }
  }

  _drawCameraHelper(batch, entity) {
    const p = entity.worldPosition;
    const f = [entity.worldMatrix[8], entity.worldMatrix[9], entity.worldMatrix[10]];
    const up = [entity.worldMatrix[4], entity.worldMatrix[5], entity.worldMatrix[6]];
    const col = [0.4, 0.8, 1, 0.9];
    const dir = [f[0], f[1], f[2]];
    const d = 1.2, s = 0.42;
    const right = vec3.normalize(_v2, vec3.cross(_v2, dir, up));
    const realUp = vec3.cross(_v2, right, dir);
    const center = [p[0] + dir[0] * d, p[1] + dir[1] * d, p[2] + dir[2] * d];
    const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => [
      center[0] + right[0] * x * s + realUp[0] * y * s,
      center[1] + right[1] * x * s + realUp[1] * y * s,
      center[2] + right[2] * x * s + realUp[2] * y * s
    ]);
    for (let i = 0; i < 4; i++) {
      batch.lineV(pts[i], pts[(i + 1) % 4], col);
      batch.lineV(p, pts[i], [col[0], col[1], col[2], 0.35]);
    }
  }

  _drawUnlitBatch(batch, camera, blend) {
    if (!batch.count) return;
    const { ctx } = this;
    const program = this.programs.get({
      name: 'unlit', vertex: unlitVertexShader, fragment: unlitFragmentShader
    });
    program.bind();
    program.set('uViewProjection', camera.viewProj);
    program.set('uView', camera.view);
    ctx.setDepth(true, true, 'lequal');
    ctx.setBlend(blend);
    ctx.setCull('none');
    batch.draw(program);
    this.drawCalls++;
    ctx.setBlend('none');
  }

  _renderGizmos(camera, opts) {
    const batch = this.gizmoBatch;
    batch.begin();
    opts.gizmos.draw(batch, camera, this);
    batch.end();
    if (!batch.count) return;
    const { ctx } = this;
    const program = this.programs.get({
      name: 'unlit', vertex: unlitVertexShader, fragment: unlitFragmentShader
    });
    program.bind();
    program.set('uViewProjection', camera.viewProj);
    program.set('uView', camera.view);
    ctx.setDepth(false, false, 'always');
    ctx.setBlend('none');
    ctx.setCull('none');
    batch.draw(program);
    this.drawCalls++;
    ctx.setDepth(true, true);
  }

  /* --------------------------------------------------------- ssao/picking */

  _renderSsao(camera) {
    const { ctx } = this;
    if (!this.ssaoTarget || !this.depthTarget.depthTexture) return;
    const program = this.programs.get({
      name: 'ssao', vertex: quadVertexShader, fragment: ssaoShader
    });
    this.ssaoTarget.bind({ clear: true, clearColor: [1, 1, 1, 1] });
    program.bind();
    this._bindTex(program, 'uDepth', UNIT.aux, this.depthTarget.depthTexture);
    program.set('uProjection', camera.proj);
    program.set('uInverseProjection', mat4.invert(_m1, camera.proj));
    program.set('uResolution', [this.ssaoTarget.width, this.ssaoTarget.height]);
    program.set('uRadius', this.settings.ssaoRadius);
    program.set('uIntensity', this.settings.ssaoIntensity);
    program.set('uBias', 0.02);
    this._drawQuad(program);
  }

  _renderPicking(scene, camera, opts) {
    const { ctx } = this;
    this.pickingTarget.bind({ clear: true, clearColor: [0, 0, 0, 0], clearDepth: true });
    ctx.setDepth(true, true, 'less');
    ctx.setBlend('none');
    ctx.setCull('back');
    this._pickingIds.clear();
    let id = 1;
    // An instanced entity occupies N places on screen, so the id pass has to draw
    // the same N instances. Drawing a single copy instead would paint an id over
    // geometry that is not on screen, and the pick would return that entity for
    // pixels that actually show something else.
    const canInstance = this.caps.limits.instancing;
    const ib = canInstance ? this._getInstanceBuffer() : null;
    for (const item of this._opaque) {
      const useInstances = canInstance && item.instances > 0;
      const program = this.programs.get({
        name: 'picking', vertex: pickingVertexShader, fragment: pickingFragmentShader
      }, { PC_PICK_ALPHA: true, PCL_INSTANCED: useInstances });
      this._pickingIds.set(id, item.entity);
      program.bind();
      program.set('uViewProjection', camera.viewProj);
      program.set('uModel', item.world);
      program.set('uIdColor', idToColor(id++));
      program.set('uAlphaTest', item.material.alphaTest || 0);
      program.set('uHasAlbedoMap', item.material.diffuseMap ? 1 : 0);
      if (item.material.diffuseMap) program.setTexture('uAlbedoMap', this._textureFor(item.material.diffuseMap, this.white), UNIT.diffuse);
      if (useInstances) {
        ib.reset();
        for (let k = 0; k < item.instances; k++) {
          buildInstanceMatrix(_m2, item.entity.worldMatrix, k, item.spread, item.instances, item.layout);
          ib.push(_m2, instanceTint(k, item.instances));
        }
        ib.upload();
        item.mesh.instances = ib.count;
        item.mesh.draw(program, { instanceBuffer: ib, instances: ib.count });
        item.mesh.instances = 0;
      } else {
        item.mesh.draw(program);
      }
      this.drawCalls++;
    }
    if (ib) { ib.resetDivisors(); ib.reset(); }
    this._pickingSelection = (opts.selection || []).map((e) => this._idFor(e)).filter(Boolean);
  }

  _idFor(entity) {
    for (const [id, e] of this._pickingIds) if (e === entity) return id;
    return null;
  }

  /**
   * Screen-space pick. Re-uses the id buffer rendered this frame when possible,
   * otherwise renders it on demand and reads exactly one pixel back.
   */
  pick(scene, camera, x, y, { width, height, force = false } = {}) {
    const rt = this.pickingTarget;
    if (force || this._pickingDirty || this._pickingIds.size === 0) {
      // The id pass draws the collected draw list, so an on-demand pick has to
      // re-collect: without this it would re-render the list from the last frame
      // and happily return an entity that has since been hidden, moved or
      // deleted. Collection is pure CPU work (no GL calls), so it is cheap.
      this._collect(scene, camera);
      this._renderPicking(scene, camera, { selection: [] });
      this._pickingDirty = false;
    }
    const { gl } = this;
    const sx = Math.round(x * (rt.width / width));
    const sy = Math.round((height - y) * (rt.height / height));
    if (sx < 0 || sy < 0 || sx >= rt.width || sy >= rt.height) return null;
    const buf = new Uint8Array(4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt.fbo.handle);
    gl.readPixels(sx, sy, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.ctx.invalidateState();
    if (buf[3] === 0) return null;
    return this._pickingIds.get((buf[0] << 16) | (buf[1] << 8) | buf[2]) || null;
  }

  invalidatePicking() { this._pickingDirty = true; }

  /* ---------------------------------------------------------------- post */

  _renderPost() {
    const { gl, ctx } = this;
    const s = this.settings;
    if (s.bloom && this.bloomChain.length) this._renderBloom();

    bindScreen(ctx, { clear: true, clearColor: [0, 0, 0, 1] });
    const program = this.programs.get({
      name: 'composite', vertex: quadVertexShader, fragment: compositeShader
    }, { PC_SELECTED_IDS: 4 });
    program.bind();
    this._bindTex(program, 'uSource', UNIT.screen, this.sceneTarget.texture);
    this._bindTex(program, 'uBloom', UNIT.emissive, (s.bloom && this.bloomChain.length) ? this.bloomChain[0].texture : this.black);
    this._bindTex(program, 'uSsao', UNIT.aux, (s.ssao && this.ssaoTarget) ? this.ssaoTarget.texture : this.white);
    this._bindTex(program, 'uIds', UNIT.occlusion, (s.selectionOutline && this._pickingSelection?.length) ? this.pickingTarget.texture : this.black);
    program.set('uSsaoEnabled', s.ssao && this.ssaoTarget ? 1 : 0);
    program.set('uOutlineEnabled', s.selectionOutline && this._pickingSelection?.length ? 1 : 0);
    // Always 4 vec4s: a short array is an INVALID_VALUE at uniform4fv.
    const ids = new Float32Array(16);
    (this._pickingSelection || []).slice(0, 4).forEach((id, i) => ids.set(idToColor(id), i * 4));
    program.set('uSelectedIds', ids);
    program.set('uSelectedCount', Math.min(4, this._pickingSelection?.length || 0));
    program.set('uResolution', [this.width, this.height]);
    program.set('uExposure', s.exposure);
    program.set('uBloomStrength', s.bloom && this.bloomChain.length ? s.bloomStrength : 0);
    program.set('uToneMapMode', s.toneMapping);
    program.set('uVignette', s.vignette);
    program.set('uGrain', s.grain);
    program.set('uChromatic', s.chromatic);
    program.set('uContrast', s.contrast);
    program.set('uSaturation', s.saturation);
    program.set('uOutlineColor', s.outlineColor);
    program.set('uOutlineThickness', 1.5);
    program.set('uTime', this.time);
    program.set('uFxaa', s.fxaa ? 1 : 0);
    ctx.setDepth(false, false, 'always');
    ctx.setBlend('none');
    this._drawQuad(program);
  }

  _renderBloom() {
    const { ctx } = this;
    const s = this.settings;
    const down = this.programs.get({ name: 'bloomDown', vertex: quadVertexShader, fragment: bloomDownShader });
    const up = this.programs.get({ name: 'bloomUp', vertex: quadVertexShader, fragment: bloomUpShader });
    let src = this.sceneTarget;
    for (let i = 0; i < this.bloomChain.length; i++) {
      const dst = this.bloomChain[i];
      dst.bind({ clear: false });
      down.bind();
      this._bindTex(down, 'uSource', UNIT.screen, src.texture);
      down.set('uTexel', [1 / src.width, 1 / src.height]);
      down.set('uThreshold', s.bloomThreshold);
      down.set('uSoftKnee', 0.6);
      down.set('uFirstPass', i === 0 ? 1 : 0);
      this._drawQuad(down);
      src = dst;
    }
    ctx.setBlend('additive');
    for (let i = this.bloomChain.length - 1; i > 0; i--) {
      const dst = this.bloomChain[i - 1];
      dst.bind({ clear: false });
      up.bind();
      this._bindTex(up, 'uSource', UNIT.screen, this.bloomChain[i].texture);
      up.set('uTexel', [1 / this.bloomChain[i].width, 1 / this.bloomChain[i].height]);
      up.set('uRadius', 1.2);
      this._drawQuad(up);
    }
    ctx.setBlend('none');
  }

  _bindTex(program, uniformName, unit, texture) {
    const { gl } = this;
    if (!texture) return;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(texture.target, texture.handle);
    program.set(uniformName, unit);
  }

  _drawQuad(program) {
    const { gl } = this;
    this.ctx.bindVAO(this.ctx.cachedVAO(this, '_quadVAO'));
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quad.handle);
    const loc = program.attributes.get('aPosition')?.loc ?? 0;
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.drawCalls++;
    this.ctx.debug.draws++;
  }

  _getInstanceBuffer() {
    if (!this._instanceBuffer) this._instanceBuffer = new InstanceBuffer(this.ctx, 1024);
    return this._instanceBuffer;
  }

  /* ----------------------------------------------------------- previews */

  /**
   * Material preview ball for the asset browser — the same PBR shader as the
   * scene, a neutral two-light rig and a spherical environment, so the thumbnail
   * cannot drift from what the material actually looks like.
   */
  renderMaterialPreview(material, canvas, { size = 128 } = {}) {
    const { gl, ctx } = this;
    if (!this._previewSphere) {
      this._previewSphere = new Mesh(ctx, icosphere({ radius: 1, subdivisions: 2 }), { name: 'previewSphere' });
    }
    const target = this._thumbTarget && this._thumbTarget.width === size
      ? this._thumbTarget
      : (this._thumbTarget?.dispose(),
        this._thumbTarget = new RenderTarget(ctx, {
          name: 'thumb', width: size, height: size, count: 1,
          hdr: this.caps.limits.colorBufferFloat, depth: 'renderbuffer', filter: 'linear'
        }));

    const cam = this._previewCamera;
    cam.setAspect(1);
    cam._sync();

    // Swap in a preview draw list: one sphere, two studio lights.
    const savedOpaque = this._opaque;
    const savedTransparent = this._transparent;
    const savedLights = {
      count: this._lights.count,
      sunIndex: this._lights.sunIndex,
      sunIntensity: this._lights.sunIntensity,
      pos4: this._lights.pos4.slice(),
      color: this._lights.color.slice(),
      params: this._lights.params.slice(),
      axis: this._lights.axis.slice()
    };
    this._opaque = [];
    this._transparent = [];
    this._lights.count = 0;
    this._lights.sunIndex = -1;
    this._lights.pos4.fill(0);
    this._lights.color.fill(0);
    this._lights.params.fill(-1);
    this._lights.axis.fill(0);
    // Modest punctual lights: they add a *specular* term that is nearly the same
    // for every material, so cranking them makes every swatch look alike.
    this._packLightLike([1, 0.96, 0.9], 1.6, [0.6, 0.8, 0.5]);
    this._packLightLike([0.55, 0.66, 0.95], 0.6, [-0.7, 0.1, -0.4]);
    this._packLightLike([1, 1, 1], 0.9, [-0.2, 0.6, -0.8]);

    this._opaque.push({
      entity: null, mesh: this._previewSphere, material: material || new Material(this.ctx, { name: 'preview' }),
      world: mat4.create(), normal: mat3.create(), instances: 0,
      castShadows: false, receiveShadows: false
    });

    const savedShadows = this.shadows.enabled;
    this.shadows.enabled = false;
    // A thumbnail is a colour swatch, not a beauty render. The ambient term is
    // multiplied by the albedo, so it is the only contribution that actually
    // distinguishes a swatch; the scene's ambient is dark on purpose, which would
    // make every material a black ball. The scene's values are restored after.
    const savedAmbient = this.settings.ambient;
    const savedAmbientIntensity = this.settings.ambientIntensity;
    this.settings.ambient = [0.42, 0.42, 0.45];
    this.settings.ambientIntensity = 1;
    target.bind({ clear: true, clearColor: [0, 0, 0, 1], clearDepth: true });
    this._renderBackground(cam);
    for (const item of this._opaque) this._drawItem(item, cam, null, false);
    target.resolve();
    this.settings.ambient = savedAmbient;
    this.settings.ambientIntensity = savedAmbientIntensity;

    // Present with the same tone curve and transfer function as the main frame, so
    // a thumbnail is the material as the viewport would show it — into its own
    // 8-bit target. The alternative, blitting into a corner of the default
    // framebuffer and copying that region out with drawImage, reads whatever the
    // browser last handed over: the editor's own frame, or the previous
    // thumbnail. A readPixels from our own FBO is unambiguous.
    const ldr = this._thumbLdr && this._thumbLdr.width === size
      ? this._thumbLdr
      : (this._thumbLdr?.dispose(),
        this._thumbLdr = new RenderTarget(ctx, {
          name: 'thumb.ldr', width: size, height: size, count: 1,
          hdr: false, depth: 'none', filter: 'nearest'
        }));
    ldr.bind({ clear: true, clearColor: [0, 0, 0, 1], clearDepth: false });
    const present = this.programs.get({ name: 'present', vertex: blitVertexShader, fragment: presentFragmentShader });
    present.bind();
    this._bindTex(present, 'uSource', UNIT.screen, target.texture);
    present.set('uExposure', this.settings.exposure);
    present.set('uToneMapMode', 5);
    this._drawQuad(present);

    const g = canvas.getContext('2d');
    if (g) {
      const w = ldr.width, h = ldr.height;
      // Sized per call: a cached buffer of the wrong length silently reads back
      // garbage (or nothing) as soon as two callers ask for different sizes.
      if (!this._thumbPixels || this._thumbPixels.length !== w * h * 4) {
        this._thumbPixels = new Uint8Array(w * h * 4);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, ldr.fbo.handle);
      ctx._state.framebuffer = ldr.fbo.handle;
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, this._thumbPixels);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      ctx._state.framebuffer = null;
      ctx.invalidateState();
      const out = g.createImageData(canvas.width, canvas.height);
      // GL's origin is bottom-left, ImageData's is top-left: flip while copying.
      const dw = out.width, dh = out.height;
      for (let y = 0; y < dh; y++) {
        const sy = h - 1 - Math.min(h - 1, Math.floor((y * h) / dh));
        for (let x = 0; x < dw; x++) {
          const sx = Math.min(w - 1, Math.floor((x * w) / dw));
          const s = (sy * w + sx) * 4, d = (y * dw + x) * 4;
          out.data[d] = this._thumbPixels[s];
          out.data[d + 1] = this._thumbPixels[s + 1];
          out.data[d + 2] = this._thumbPixels[s + 2];
          out.data[d + 3] = 255;
        }
      }
      g.putImageData(out, 0, 0);
    }

    this._opaque = savedOpaque;
    this._transparent = savedTransparent;
    this._lights.count = savedLights.count;
    this._lights.sunIndex = savedLights.sunIndex;
    this._lights.sunIntensity = savedLights.sunIntensity;
    this._lights.pos4.set(savedLights.pos4);
    this._lights.color.set(savedLights.color);
    this._lights.params.set(savedLights.params);
    this._lights.axis.set(savedLights.axis);
    this.shadows.enabled = savedShadows;
    return canvas;
  }

  _packLightLike(color, intensity, dir) {
    const i = this._lights.count;
    if (i >= MAX_LIGHTS_CAP) return;
    this._lights.count++;
    const l = vec3.normalize(_v1, dir);
    this._lights.pos4[i * 4] = l[0];
    this._lights.pos4[i * 4 + 1] = l[1];
    this._lights.pos4[i * 4 + 2] = l[2];
    this._lights.pos4[i * 4 + 3] = 0;
    const c = ColorUtil.srgbToLinear(color);
    this._lights.color[i * 3] = c[0] * intensity;
    this._lights.color[i * 3 + 1] = c[1] * intensity;
    this._lights.color[i * 3 + 2] = c[2] * intensity;
    this._lights.params[i * 2] = -1;
    this._lights.params[i * 2 + 1] = -1;
    this._lights.axis[i * 3] = 0;
    this._lights.axis[i * 3 + 1] = 1;
    this._lights.axis[i * 3 + 2] = 0;
  }

  /* --------------------------------------------------------------- stats */

  get stats() {
    return {
      frame: this.frame,
      time: this.time,
      drawCalls: this.drawCalls,
      triangles: this.triangles,
      gpuTime: this.gpuTime,
      programs: this.programs.size,
      visible: this.visibleCount,
      culled: this.culledCount,
      lights: this._lights.count,
      resources: this.ctx.stats(),
      ibl: { ...this.ibl.stats },
      shadows: {
        enabled: this.shadows.enabled,
        cascades: this.shadows.cascades.length,
        resolution: this.shadows.resolution,
        distance: this.shadows.shadowDistance
      }
    };
  }

  dispose() {
    this.programs.clear();
    this.ibl.dispose();
    this.shadows.dispose();
    this.sceneTarget?.dispose();
    this.depthTarget?.dispose();
    this.pickingTarget?.dispose();
    this.ssaoTarget?.dispose();
    for (const t of this.bloomChain || []) t.dispose();
    this._thumbTarget?.dispose();
    this._thumbLdr?.dispose();
    this._quad.dispose();
    if (this._quadVAO) this.gl.deleteVertexArray(this._quadVAO);
    this._gridMesh.dispose();
    this._previewSphere?.dispose();
    this.overlayLines.dispose();
    this.overlayTris.dispose();
    this.gizmoBatch.dispose();
    this.white.dispose();
    this.flatNormal.dispose();
    this.black.dispose();
  }
}

/* ------------------------------------------------------------- helpers -- */

function idToColor(id) {
  return [((id >> 16) & 255) / 255, ((id >> 8) & 255) / 255, (id & 255) / 255, 1];
}

function arrowHead(batch, tip, dir, color) {
  const len = 0.35;
  const ref = Math.abs(dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const right = vec3.normalize(_v1, vec3.cross(_v1, dir, ref));
  const up = vec3.cross(_v2, dir, right);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const c = Math.cos(a) * 0.28 * len, s = Math.sin(a) * 0.28 * len;
    batch.lineV(tip, [
      tip[0] - dir[0] * len + right[0] * c + up[0] * s,
      tip[1] - dir[1] * len + right[1] * c + up[1] * s,
      tip[2] - dir[2] * len + right[2] * c + up[2] * s
    ], color);
  }
}

function coneRingPoint(origin, axis, angle, radius, depth) {
  const ref = Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const right = vec3.normalize(_v1, vec3.cross(_v1, axis, ref));
  const up = vec3.cross(_v2, axis, right);
  const c = Math.cos(angle) * radius, s = Math.sin(angle) * radius;
  return [
    origin[0] + axis[0] * depth + right[0] * c + up[0] * s,
    origin[1] + axis[1] * depth + right[1] * c + up[1] * s,
    origin[2] + axis[2] * depth + right[2] * c + up[2] * s
  ];
}

const _decompose = { t: vec3.create(), r: new Float32Array([0, 0, 0, 1]), s: vec3.create() };
const _qYaw = new Float32Array(4);
const _qUp = vec3.create(0, 1, 0);

/**
 * Per-instance transform for an instanced draw.
 *
 * `layout` decides the pattern: 'grid' fills a cols×cols square (the classic
 * particle/crowd test), 'ring' places the instances on a circle — a colonnade or
 * a wheel of spokes — and 'scatter' uses a deterministic hash so the result is
 * identical on every frame and every reload, which matters because a randomised
 * per-frame position would make the scene impossible to reproduce.
 */
function buildInstanceMatrix(out, base, k, spread, total, layout = 'grid') {
  mat4.decompose(_decompose, base);
  const n = Math.max(total, 1);
  let ox = 0, oz = 0, oy = 0, ry = 0;
  if (layout === 'ring') {
    const a = (k / n) * Math.PI * 2;
    ox = Math.cos(a) * spread;
    oz = Math.sin(a) * spread;
  } else if (layout === 'scatter') {
    // Two decorrelated hash channels, kept in [-0.5, 0.5] so `spread` is the full
    // width of the cloud rather than a radius.
    ox = (hash01(k * 2 + 1) - 0.5) * spread * 2;
    oz = (hash01(k * 2 + 7) - 0.5) * spread * 2;
    oy = (hash01(k * 5 + 3) - 0.5) * spread * 0.25;
    ry = hash01(k * 3 + 11) * Math.PI * 2;
  } else {
    const cols = Math.ceil(Math.sqrt(n));
    ox = ((k % cols) - (cols - 1) * 0.5) * spread;
    oz = (Math.floor(k / cols) - (cols - 1) * 0.5) * spread;
  }
  _decompose.t[0] += ox;
  _decompose.t[1] += oy;
  _decompose.t[2] += oz;
  if (ry) quat.multiply(_decompose.r, _decompose.r, quat.fromAxisAngle(_qYaw, _qUp, ry));
  return mat4.fromRTS(out, _decompose.r, _decompose.t, _decompose.s);
}

/** Deterministic 0..1 hash — no Math.random, so instances never jitter. */
function hash01(i) {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * How far instances can reach outside the entity's own bounds, per axis. Used to
 * give instanced items a real AABB: culling against the single base mesh would
 * drop the entity when the mesh is off-screen but its instances are not, and the
 * shadow fit volume would ignore every instance.
 */
function instanceExtent(item) {
  const n = Math.max(item.instances, 1);
  const spread = item.spread;
  switch (item.layout) {
    case 'ring': return [spread, 0, spread];
    case 'scatter': return [spread, spread * 0.125, spread];
    default: {
      const cols = Math.ceil(Math.sqrt(n));
      return [(cols - 1) * 0.5 * spread, 0, (Math.ceil(n / cols) - 1) * 0.5 * spread];
    }
  }
}

function instanceTint(k, total) {
  const h = (k / Math.max(total, 1)) * 0.1;
  return [
    0.9 + Math.sin(h * 6.283) * 0.1,
    0.9 + Math.sin(h * 6.283 + 2.1) * 0.1,
    0.9 + Math.sin(h * 6.283 + 4.2) * 0.1,
    1
  ];
}

const _m1 = mat4.create();
const _m2 = mat4.create();
const _v1 = vec3.create();
const _v2 = vec3.create();
