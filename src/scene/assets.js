/**
 * Asset store — folders, materials, textures, models, volumes and the import
 * queue. The panel that displays it is a thin view over this object.
 *
 * Assets are addressed by id and referenced from entity components by id, so
 * moving a file between folders never touches the scene graph.
 */

import { Emitter, uid, formatBytes, readFileAsDataURL, readFileAsArrayBuffer, readFileAsText } from '../core/utils.js';
import { Material, createMaterialData, MATERIAL_PRESETS } from './material.js';
import { Texture, VolumeTexture, FILTER, WRAP } from '../gl/texture.js';
import { Mesh } from '../gl/mesh.js';
import { primitiveGeometry, PRIMITIVES } from './primitives.js';
import { parseOBJ } from '../loaders/obj.js';
import { parseSTL } from '../loaders/stl.js';
import { parseGLTF } from '../loaders/gltf.js';

export const ASSET_TYPES = ['material', 'texture', 'model', 'volume', 'script', 'folder'];

export class AssetStore extends Emitter {
  constructor(ctx, log) {
    super();
    this.ctx = ctx;
    this.log = log;
    /** @type {Map<string, object>} */
    this.assets = new Map();
    this.folders = new Map();
    this.tasks = [];
    this.selected = null;
    this._byType = new Map();

    this.folders.set('root', { id: 'root', name: 'root', parent: null, expanded: true });
  }

  /* ------------------------------------------------------------- folders */

  createFolder(name, parent = 'root') {
    const id = uid().slice(0, 10);
    this.folders.set(id, { id, name: uniqueName(name, this.folderNames()), parent });
    this.emit('change', 'folder', id);
    return id;
  }

  renameFolder(id, name) {
    const f = this.folders.get(id);
    if (!f || id === 'root') return false;
    f.name = name;
    this.emit('change', 'folder', id);
    return true;
  }

  deleteFolder(id) {
    if (id === 'root') return false;
    const f = this.folders.get(id);
    if (!f) return false;
    for (const a of [...this.assets.values()]) if (a.folder === id) this.deleteAsset(a.id);
    for (const child of this.folders.values()) if (child.parent === id) child.parent = f.parent;
    this.folders.delete(id);
    this.emit('change', 'folder', id);
    return true;
  }

  folderNames() { return [...this.folders.values()].map((f) => f.name); }

  folderTree() {
    const map = new Map();
    for (const f of this.folders.values()) map.set(f.id, { ...f, children: [], assetCount: 0 });
    for (const node of map.values()) {
      if (node.parent && map.has(node.parent)) map.get(node.parent).children.push(node);
    }
    for (const a of this.assets.values()) {
      const f = map.get(a.folder);
      if (f) f.assetCount++;
    }
    const roots = [];
    for (const f of this.folders.values()) {
      if (f.parent === 'root') roots.push(map.get(f.id));
    }
    const build = (node) => {
      node.children = node.children.map(build).filter((c) => c.children.length || c.assetCount);
      return node;
    };
    return roots.map(build);
  }

  /* -------------------------------------------------------------- assets */

  add(asset) {
    if (!asset.id) asset.id = uid().slice(0, 10);
    if (!asset.folder) asset.folder = this.defaultFolderFor(asset.type);
    this.assets.set(asset.id, asset);
    this.emit('add', asset);
    this.emit('change', 'asset', asset.id);
    return asset;
  }

  defaultFolderFor(type) {
    for (const f of this.folders.values()) if (f.name === type) return f.id;
    return this.createFolder(type);
  }

  get(id) { return this.assets.get(id) || null; }
  byType(type) { return [...this.assets.values()].filter((a) => a.type === type); }
  all() { return [...this.assets.values()]; }
  count() { return this.assets.size; }

  deleteAsset(id) {
    const a = this.assets.get(id);
    if (!a) return false;
    if (a.gpu) a.gpu.dispose?.();
    this.assets.delete(id);
    if (this.selected === id) this.selected = null;
    this.emit('remove', a);
    this.emit('change', 'asset', id);
    return true;
  }

  rename(id, name) {
    const a = this.assets.get(id);
    if (!a) return false;
    a.name = name;
    if (a.type === 'material' && a.material) a.material.name = name;
    this.emit('change', 'asset', id);
    return true;
  }

  move(id, folder) {
    const a = this.assets.get(id);
    if (!a || !this.folders.has(folder)) return false;
    a.folder = folder;
    this.emit('change', 'asset', id);
    return true;
  }

  /* --------------------------------------------------------- factories -- */

  /**
   * Create a material asset.
   *
   * `opts` accepts either a named preset (`{ name, data }`, as in
   * MATERIAL_PRESETS) or — the common case — a flat bag of properties:
   * `createMaterial('Chrome', { metalness: 1, roughness: 0.08 })`. Only the
   * preset form was understood before, which silently produced default grey
   * materials for every call site that passed a flat bag.
   */
  createMaterial(name = 'Material', opts = null) {
    const preset = opts?.data ? opts : null;
    const data = preset ? createMaterialData(preset.data) : createMaterialData(opts || {});
    const material = new Material(this.ctx, { name: preset ? preset.name : (opts?.name || name), ...data });
    return this.add({ type: 'material', name: material.name, material, presetName: preset?.name || null });
  }

  /** Procedural texture: pixels are generated on the CPU, mips on the GPU. */
  createProceduralTexture(name, kind, size = 256) {
    const pixels = generateTexture(kind, size);
    const texture = new Texture(this.ctx, {
      name,
      width: size, height: size,
      internalFormat: this.ctx.gl.RGBA, format: this.ctx.gl.RGBA, type: this.ctx.gl.UNSIGNED_BYTE,
      mipmaps: true, filter: FILTER.mip, wrap: WRAP.repeat,
      source: pixels
    });
    this.emit('gpu', texture);
    return this.add({
      type: 'texture', name, kind, size,
      gpu: texture,
      channels: channelsFor(kind),
      srgb: isColorKind(kind)
    });
  }

  /** Create a texture from an image (already decoded to a canvas). */
  createTextureFromImage(name, image, { srgb = true, wrap = WRAP.repeat } = {}) {
    const texture = new Texture(this.ctx, {
      name,
      width: image.width, height: image.height,
      internalFormat: this.ctx.gl.RGBA, format: this.ctx.gl.RGBA, type: this.ctx.gl.UNSIGNED_BYTE,
      mipmaps: true, filter: FILTER.mip, wrap,
      source: image,
      anisotropy: Math.min(8, this.ctx.caps.limits.maxAnisotropy)
    });
    this.emit('gpu', texture);
    return this.add({
      type: 'texture', name, kind: 'image',
      width: image.width, height: image.height,
      gpu: texture, srgb, wrap,
      bytes: image.width * image.height * 4
    });
  }

  /** Create a volume texture (3D, or a tile atlas on WebGL 1). */
  createVolume(name, size, fill) {
    const data = new Uint8Array(size * size * size * 4);
    if (typeof fill === 'function') {
      for (let z = 0; z < size; z++) {
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            const c = fill(x / size, y / size, z / size);
            const o = (z * size * size + y * size + x) * 4;
            data[o] = c[0] * 255; data[o + 1] = c[1] * 255; data[o + 2] = c[2] * 255; data[o + 3] = (c[3] ?? 1) * 255;
          }
        }
      }
    }
    const volume = new VolumeTexture(this.ctx, { size, data });
    this.emit('gpu', volume);
    return this.add({
      type: 'volume', name, size,
      gpu: volume,
      emulated: volume.emulated,
      bytes: data.length
    });
  }

  createModel(name, geometry, { primitive = null } = {}) {
    const mesh = new Mesh(this.ctx, geometry, { name });
    this.emit('gpu', mesh);
    return this.add({
      type: 'model', name, gpu: mesh, primitive,
      vertices: mesh.vertexCount, triangles: mesh.triangleCount
    });
  }

  createScript(name, source) {
    return this.add({ type: 'script', name, source, instances: [] });
  }

  /* -------------------------------------------------------------- tasks */

  /**
   * Import queue. Real importers are async (file read → parse → GPU upload), and
   * the UI shows each item with a progress bar, exactly like an asset pipeline
   * should. Errors are captured per task so one bad file cannot kill the batch.
   */
  async enqueue(files, { folder = null } = {}) {
    const created = [];
    for (const file of files) {
      const task = { id: uid().slice(0, 8), name: file.name, progress: 0, state: 'queued', error: null, size: file.size };
      this.tasks.unshift(task);
      this.emit('task', task);
      try {
        const asset = await this._importOne(file, folder);
        if (asset) { created.push(asset); task.state = 'done'; task.progress = 1; task.assetId = asset.id; }
        else { task.state = 'skipped'; }
      } catch (err) {
        task.state = 'error';
        task.error = err.message || String(err);
        this.log?.error(`import failed: ${file.name}`, task.error);
      }
      this.emit('task', task);
    }
    return created;
  }

  async _importOne(file, folder) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const targetFolder = folder || this.defaultFolderFor(ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'webp' ? 'texture' : 'model');
    const baseName = file.name.replace(/\.[^.]+$/, '');

    if (['obj', 'stl', 'gltf', 'glb'].includes(ext)) {
      const buf = ext === 'gltf' ? await readFileAsText(file) : await readFileAsArrayBuffer(file);
      const geo = ext === 'obj' ? parseOBJ(buf)
        : ext === 'stl' ? parseSTL(buf)
          : await parseGLTF(buf, ext === 'glb');
      if (!geo.indices?.length) throw new Error('no triangles found');
      const asset = this.createModel(baseName, geo);
      asset.folder = targetFolder;
      this.log?.info(`imported ${file.name}: ${geo.positions.length / 3} verts, ${geo.indices.length / 3} tris (${formatBytes(file.size)})`);
      this.emit('change', 'asset', asset.id);
      return asset;
    }

    if (['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'].includes(ext)) {
      const url = await readFileAsDataURL(file);
      const image = await loadImage(url);
      const asset = this.createTextureFromImage(baseName, image, { srgb: true });
      asset.folder = targetFolder;
      asset.dataUrl = url;
      asset.sourceFile = file.name;
      this.log?.info(`imported texture ${file.name}: ${image.width}×${image.height}`);
      this.emit('change', 'asset', asset.id);
      return asset;
    }

    if (['json', 'lumen'].includes(ext)) {
      const text = await readFileAsText(file);
      const data = JSON.parse(text);
      if (data && Array.isArray(data.assets)) {
        let n = 0;
        for (const a of data.assets) { this._restoreAsset(a); n++; }
        this.log?.info(`imported ${n} assets from ${file.name}`);
        return null;
      }
      throw new Error('unrecognised json payload');
    }

    throw new Error(`unsupported file type ".${ext}"`);
  }

  _restoreAsset(json) {
    switch (json.type) {
      case 'material': {
        const material = Material.fromJSON(this.ctx, json);
        return this.add({ ...json, id: json.id, material, gpu: null });
      }
      case 'texture': {
        // Textures are restored lazily from their data URL at load time.
        const asset = this.add({ ...json, gpu: null });
        if (json.dataUrl) {
          loadImage(json.dataUrl).then((img) => {
            const t = this.createTextureFromImage(json.name, img, { srgb: json.srgb !== false, wrap: json.wrap || WRAP.repeat });
            asset.gpu = t.gpu;
            asset.width = t.width; asset.height = t.height;
            asset.name = json.name;
            this.emit('change', 'asset', asset.id);
          }).catch((e) => this.log?.warn(`texture restore failed: ${json.name}`, e.message));
        }
        return asset;
      }
      case 'model': {
        if (json.geometry) {
          return this.createModel(json.name, decodeGeometry(json.geometry, this.ctx), { primitive: json.primitive });
        }
        return this.add({ ...json, gpu: null });
      }
      case 'volume': {
        return this.add({ ...json, gpu: null });
      }
      default:
        return this.add({ ...json });
    }
  }

  /* --------------------------------------------------------- serialising */

  toJSON({ includePixels = true } = {}) {
    const assets = [];
    for (const a of this.assets.values()) {
      const out = { id: a.id, type: a.type, name: a.name, folder: a.folder };
      if (a.type === 'material' && a.material) out.material = a.material.toJSON();
      if (a.type === 'texture') {
        out.kind = a.kind; out.srgb = a.srgb; out.wrap = a.wrap;
        out.width = a.width; out.height = a.height;
        if (includePixels && a.dataUrl) out.dataUrl = a.dataUrl;
      }
      if (a.type === 'model' && a.gpu) {
        out.primitive = a.primitive;
        out.geometry = {
          positions: encode(a.gpu.positions),
          normals: a.gpu.normals ? encode(a.gpu.normals) : null,
          uvs: a.gpu.uvs ? encode(a.gpu.uvs) : null,
          indices: encode(a.gpu.indices?.data || null)
        };
      }
      if (a.type === 'volume') { out.size = a.size; }
      if (a.type === 'script') out.source = a.source;
      assets.push(out);
    }
    return {
      version: 1,
      folders: [...this.folders.values()],
      assets
    };
  }

  fromJSON(json, { log } = {}) {
    if (!json) return;
    for (const f of json.folders || []) this.folders.set(f.id, f);
    for (const a of json.assets || []) {
      try { this._restoreAsset(a); } catch (e) { log?.warn(`asset "${a.name}" skipped: ${e.message}`); }
    }
    this.emit('change', 'all', null);
  }

  /** Assets referenced by the given entities, for "Save As" dependency analysis. */
  dependenciesOf(entities) {
    const ids = new Set();
    for (const e of entities) {
      const r = e.components.render;
      if (r?.mesh) ids.add(r.mesh);
      if (r?.material) ids.add(r.material);
      const v = e.components.volume;
      if (v?.asset) ids.add(v.asset);
    }
    return [...ids].map((id) => this.get(id)).filter(Boolean);
  }

  bytes() {
    let total = 0;
    for (const a of this.assets.values()) {
      total += a.bytes || 0;
      if (a.dataUrl) total += a.dataUrl.length;
    }
    return total;
  }
}

/* --------------------------------------------------------- procedural -- */

export const PROCEDURAL_KINDS = [
  { id: 'checker', label: 'Checker' },
  { id: 'grid', label: 'Grid' },
  { id: 'noise', label: 'Noise' },
  { id: 'fbm', label: 'fBm Clouds' },
  { id: 'brick', label: 'Brick' },
  { id: 'wood', label: 'Wood' },
  { id: 'metalScratch', label: 'Scratched Metal' },
  { id: 'normalFlat', label: 'Tangent Normal' },
  { id: 'normalBump', label: 'Bump Normal' },
  { id: 'aoFlat', label: 'Ambient Occlusion' },
  { id: 'mrRough', label: 'Roughness' },
  { id: 'mrMetal', label: 'Metalness' },
  { id: 'emissiveRamp', label: 'Emissive Ramp' }
];

function generateTexture(kind, size) {
  const data = new Uint8Array(size * size * 4);
  const n2 = valueNoise2(0x9e3779b9);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const o = (y * size + x) * 4;
      let r = 255, g = 255, b = 255, a = 255;
      switch (kind) {
        case 'checker': {
          const c = ((x >> 4) + (y >> 4)) & 1;
          r = g = b = c ? 235 : 25;
          break;
        }
        case 'grid': {
          const lx = x % 32, ly = y % 32;
          const line = lx < 2 || ly < 2;
          r = g = b = line ? 255 : 18;
          break;
        }
        case 'noise': {
          const n = n2(x * 0.5, y * 0.5) * 255;
          r = g = b = n;
          break;
        }
        case 'fbm': {
          let s = 0, amp = 0.5, f = 1;
          for (let o2 = 0; o2 < 5; o2++) { s += n2(x * 0.08 * f, y * 0.08 * f) * amp; amp *= 0.5; f *= 2; }
          const c = Math.min(255, s * 255 * 1.6);
          r = g = b = c;
          break;
        }
        case 'brick': {
          const row = Math.floor(y / 16);
          const off = (row & 1) ? 16 : 0;
          const bx = ((x + off) % 32), by = y % 16;
          const mortar = bx < 2 || by < 2;
          const tint = 0.75 + 0.25 * n2(x * 0.4, y * 0.4);
          r = mortar ? 190 : 190 * tint;
          g = mortar ? 185 : 95 * tint;
          b = mortar ? 180 : 80 * tint;
          break;
        }
        case 'wood': {
          const ring = Math.sin((u * 18 + n2(x * 0.02, y * 0.2) * 6)) * 0.5 + 0.5;
          const c = 0.35 + ring * 0.4;
          r = 190 * c; g = 140 * c; b = 85 * c;
          break;
        }
        case 'metalScratch': {
          const s1 = n2(x * 0.9, y * 0.02);
          const c = 0.55 + s1 * 0.35;
          r = g = b = c * 255;
          break;
        }
        case 'normalFlat': r = 128; g = 128; b = 255; break;
        case 'normalBump': {
          const h = (x, y) => fbm(n2, x * 0.06, y * 0.06);
          const dx = (h(x + 1, y) - h(x - 1, y)) * 2.2;
          const dy = (h(x, y + 1) - h(x, y - 1)) * 2.2;
          const nx = -dx, ny = -dy, nz = 1;
          const l = Math.hypot(nx, ny, nz);
          r = (nx / l * 0.5 + 0.5) * 255;
          g = (ny / l * 0.5 + 0.5) * 255;
          b = (nz / l * 0.5 + 0.5) * 255;
          break;
        }
        case 'aoFlat': r = g = b = 255; break;
        case 'mrRough': r = 0; g = 40 + n2(x * 0.3, y * 0.3) * 180; b = 0; break;
        case 'mrMetal': r = 0; g = 0; b = 40 + n2(x * 0.15, y * 0.15) * 215; break;
        case 'emissiveRamp': {
          const c = v;
          r = c * 255; g = (1 - Math.abs(c - 0.5) * 2) * 255; b = (1 - c) * 255;
          break;
        }
        default: break;
      }
      data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = a;
    }
  }
  return data;
}

function fbm(n2, x, y) {
  let s = 0, amp = 0.5, f = 1;
  for (let i = 0; i < 4; i++) { s += n2(x * f, y * f) * amp; amp *= 0.5; f *= 2; }
  return s;
}

function valueNoise2(seed) {
  const hash = (x, y) => {
    let h = (x * 374761393 + y * 668265263 + seed) | 0;
    h = (h ^ (h >> 13)) * 1274126177;
    return ((h ^ (h >> 16)) >>> 0) / 4294967295;
  };
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    return (a + (b - a) * u) + ((c + (d - c) * u) - (a + (b - a) * u)) * v;
  };
}

function channelsFor(kind) {
  if (kind === 'normalFlat' || kind === 'normalBump') return 'normal';
  if (kind === 'aoFlat') return 'occlusion';
  if (kind === 'mrRough' || kind === 'mrMetal') return 'metalRough';
  if (kind === 'emissiveRamp') return 'emissive';
  return 'color';
}

function isColorKind(kind) { return channelsFor(kind) === 'color'; }

function encode(arr) {
  if (!arr) return null;
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(s);
}

function decode(str, Ctor) {
  if (!str) return null;
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Ctor(bytes.buffer);
}

function decodeGeometry(g, ctx) {
  const geometry = {};
  if (g.positions) geometry.positions = decode(g.positions, Float32Array);
  if (g.normals) geometry.normals = decode(g.normals, Float32Array);
  if (g.uvs) geometry.uvs = decode(g.uvs, Float32Array);
  if (g.indices) {
    const i32 = decode(g.indices, Uint32Array);
    geometry.indices = ctx?.caps?.limits?.indexUint ? i32 : new Uint16Array(i32);
  }
  if (!geometry.positions) throw new Error('serialised geometry has no positions');
  return geometry;
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image decode failed'));
    img.src = src;
  });
}

function uniqueName(name, existing) {
  if (!existing.includes(name)) return name;
  let i = 1;
  while (existing.includes(`${name}.${i}`)) i++;
  return `${name}.${i}`;
}

export { decode, createMaterialData, MATERIAL_PRESETS, PRIMITIVES, primitiveGeometry };
