/**
 * Material — a physical surface description plus the state that decides how it is
 * rasterised. Shading model is metallic/roughness; blend/cull/depth live here too
 * so the renderer can sort and batch from one object.
 */

import { color as ColorUtil } from '../core/math.js';
import { uid } from '../core/utils.js';

export const BLEND = {
  NONE: 'none',
  NORMAL: 'normal',
  PREMULTIPLIED: 'premultiplied',
  ADDITIVE: 'additive',
  MULTIPLY: 'multiply'
};

export const CULL = { BACK: 'back', FRONT: 'front', NONE: 'none' };

export function createMaterialData(overrides = {}) {
  return {
    // Surface
    diffuse: [0.8, 0.8, 0.8, 1],
    diffuseMap: null,
    metalness: 0.0,
    roughness: 0.5,
    specular: 0.5,
    metalRoughMap: null,
    normalMap: null,
    bumpiness: 1.0,
    occlusionMap: null,
    occlusionChannel: 'r',
    occlusionStrength: 1.0,
    emissive: [0, 0, 0],
    emissiveMap: null,
    emissiveIntensity: 1.0,
    // Alpha & raster state
    opacity: 1.0,
    blend: BLEND.NONE,
    alphaTest: 0.0,
    depthWrite: true,
    depthTest: true,
    cull: CULL.BACK,
    twoSidedLighting: false,
    // UV
    tiling: [1, 1],
    offset: [0, 0],
    rotation: 0,
    // Meta
    unlit: false,
    vertexColors: false,
    ...overrides
  };
}

export class Material {
  constructor(ctx, { id, name, ...data } = {}) {
    this.id = id || uid().slice(0, 12);
    this.type = 'material';
    this.name = name || 'Material';
    this.ctx = ctx;
    Object.assign(this, createMaterialData(data));
    this._key = null;
  }

  /** Stable signature of everything the shader cares about (for sorting/caching). */
  get key() {
    if (this._dirty !== false) {
      this._key = JSON.stringify([
        this.diffuse, this.metalness, this.roughness, this.specular, this.emissive,
        this.emissiveIntensity, this.opacity, this.alphaTest, this.blend, this.cull,
        this.twoSidedLighting, this.unlit, this.vertexColors, this.tiling, this.offset,
        this.rotation, this.diffuseMap, this.normalMap, this.metalRoughMap,
        this.occlusionMap, this.emissiveMap, this.bumpiness, this.occlusionStrength
      ]);
      this._dirty = false;
    }
    return this._key;
  }

  touch() { this._dirty = true; return this; }

  get isTransparent() {
    return this.blend !== BLEND.NONE || this.opacity < 1;
  }

  get usesAlphaTest() { return this.alphaTest > 0; }

  /** Normalised blend mode understood by GLContext.setBlend. */
  get blendMode() {
    switch (this.blend) {
      case BLEND.NORMAL: return 'alpha';
      case BLEND.PREMULTIPLIED: return 'premultiplied';
      case BLEND.ADDITIVE: return 'additive';
      case BLEND.MULTIPLY: return 'multiply';
      default: return 'none';
    }
  }

  get cullMode() {
    if (this.cull === CULL.NONE || this.twoSidedLighting) return 'none';
    return this.cull;
  }

  clone(name = `${this.name} copy`) {
    return new Material(this.ctx, { ...this.toJSON(), id: undefined, name });
  }

  toJSON() {
    const out = { name: this.name };
    for (const k in createMaterialData()) out[k] = this[k];
    return out;
  }

  static fromJSON(ctx, json) {
    return new Material(ctx, { ...json, id: json.id || uid().slice(0, 12) });
  }

  /** Base colour as a CSS string (used by the asset thumbnails and the UI). */
  get cssColor() { return ColorUtil.toHex(this.diffuse); }
}

/** Presets surfaced in the "new material" menu. */
export const MATERIAL_PRESETS = [
  { name: 'Standard', data: {} },
  { name: 'Polished Metal', data: { diffuse: [0.94, 0.94, 0.96, 1], metalness: 1, roughness: 0.16 } },
  { name: 'Brushed Steel', data: { diffuse: [0.78, 0.79, 0.82, 1], metalness: 1, roughness: 0.38 } },
  { name: 'Gold', data: { diffuse: [1.0, 0.77, 0.34, 1], metalness: 1, roughness: 0.24 } },
  { name: 'Copper', data: { diffuse: [0.95, 0.55, 0.35, 1], metalness: 1, roughness: 0.32 } },
  { name: 'Painted Plastic', data: { diffuse: [0.85, 0.22, 0.24, 1], metalness: 0, roughness: 0.42, specular: 0.6 } },
  { name: 'Ceramic', data: { diffuse: [0.95, 0.94, 0.9, 1], metalness: 0, roughness: 0.28, specular: 0.7 } },
  { name: 'Rubber', data: { diffuse: [0.16, 0.16, 0.17, 1], metalness: 0, roughness: 0.86, specular: 0.3 } },
  { name: 'Glass', data: { diffuse: [0.85, 0.92, 0.95, 1], metalness: 0, roughness: 0.04, opacity: 0.28, blend: BLEND.NORMAL, cull: CULL.NONE, specular: 1 } },
  { name: 'Emissive Neon', data: { diffuse: [0.05, 0.05, 0.06, 1], emissive: [0.0, 0.9, 1.0], emissiveIntensity: 6, roughness: 0.3 } },
  { name: 'Asphalt', data: { diffuse: [0.13, 0.13, 0.14, 1], roughness: 0.94, specular: 0.2 } },
  { name: 'Grass', data: { diffuse: [0.25, 0.45, 0.18, 1], roughness: 0.9, specular: 0.2 } },
  { name: 'Unlit White', data: { unlit: true, diffuse: [1, 1, 1, 1] } },
  { name: 'Vertex Coloured', data: { vertexColors: true, roughness: 0.7, diffuse: [1, 1, 1, 1] } }
];
