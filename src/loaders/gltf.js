/**
 * glTF 2.0 loader (subset): embedded/base64 buffers, TRIANGLES primitives,
 * POSITION / NORMAL / TEXCOORD_0 accessors, node transforms, KHR_texture_basisu
 * ignored, Draco ignored (with a clear error rather than a silent failure).
 *
 * The scene is flattened into a single geometry in the root's space, which is what
 * the asset browser expects from an import.
 */

import { computeNormals } from './obj.js';
import { mat4, mat3, vec3, quat } from '../core/math.js';

export async function parseGLTF(input, isBinary = false) {
  let json;
  let binChunk = null;

  if (isBinary || input instanceof ArrayBuffer) {
    const buf = input instanceof ArrayBuffer ? input : new TextEncoder().encode(input).buffer;
    const view = new DataView(buf);
    if (view.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB container');
    const version = view.getUint32(4, true);
    if (version !== 2) throw new Error(`unsupported glTF version ${version}`);
    let offset = 12;
    while (offset < view.byteLength) {
      const len = view.getUint32(offset, true);
      const type = view.getUint32(offset + 4, true);
      const data = buf.slice(offset + 8, offset + 8 + len);
      if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(new Uint8Array(data)));
      else if (type === 0x004e4942) binChunk = data;
      offset += 8 + len + ((4 - (len % 4)) % 4);
    }
  } else {
    json = typeof input === 'string' ? JSON.parse(input) : input;
  }

  if (!json) throw new Error('glTF has no JSON chunk');
  if (json.extensionsRequired?.some((e) => e.startsWith('KHR_draco'))) {
    throw new Error('Draco-compressed glTF is not supported by this build');
  }

  // ---- buffers ------------------------------------------------------------
  const buffers = [];
  for (let i = 0; i < (json.buffers || []).length; i++) {
    const b = json.buffers[i];
    if (b.uri === undefined) {
      if (i === 0 && binChunk) buffers.push(binChunk);
      else throw new Error(`buffer ${i} has no data (external .bin is not fetched)`);
    } else if (b.uri.startsWith('data:')) {
      buffers.push(dataURIToArrayBuffer(b.uri));
    } else {
      throw new Error(`buffer ${i} uses an external uri (${b.uri.slice(0, 24)}…)`);
    }
  }

  const bufferViewData = (index) => {
    const bv = json.bufferViews[index];
    const buf = buffers[bv.buffer];
    return new Uint8Array(buf, bv.byteOffset || 0, bv.byteLength);
  };

  const readAccessor = (index) => {
    const acc = json.accessors[index];
    const comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[acc.type];
    if (!comps) throw new Error(`unsupported accessor type ${acc.type}`);
    const Ctor = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array }[acc.componentType];
    if (!Ctor) throw new Error(`unsupported component type ${acc.componentType}`);
    const out = new Ctor(acc.count * comps);
    if (acc.bufferView === undefined) return { data: out, comps, type: acc.type };

    const bytes = bufferViewData(acc.bufferView);
    const bv = json.bufferViews[acc.bufferView];
    const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
    const stride = bv.byteStride || comps * Ctor.BYTES_PER_ELEMENT;
    const elemSize = comps * Ctor.BYTES_PER_ELEMENT;

    if (stride === elemSize) {
      // Copy through a correctly-aligned view: typed arrays require the offset to
      // be a multiple of the element size, which glTF files do not guarantee.
      const tmp = new Ctor(bytes.buffer, bytes.byteOffset, acc.count * comps);
      out.set(tmp.subarray(0, acc.count * comps));
    } else {
      for (let i = 0; i < acc.count; i++) {
        const src = new Ctor(bytes.buffer, bytes.byteOffset + base + i * stride, comps);
        out.set(src, i * comps);
      }
    }

    if (acc.normalized) {
      const max = acc.componentType === 5120 ? 127 : acc.componentType === 5121 ? 255
        : acc.componentType === 5122 ? 32767 : acc.componentType === 5123 ? 65535 : 1;
      for (let i = 0; i < out.length; i++) out[i] = Math.max(out[i] / max, -1);
    }
    return { data: out, comps, type: acc.type };
  };

  // ---- node transforms ----------------------------------------------------
  const nodeMatrix = (node) => {
    if (!node) return mat4.create();
    if (node.matrix) return new Float32Array(node.matrix);
    const m = mat4.create();
    const q = node.rotation ? quat.create(...node.rotation) : qu4();
    return mat4.fromRTS(m, q, node.translation || [0, 0, 0], node.scale || [1, 1, 1]);
  };
  const qu4 = () => quat.create();

  const worldMatrices = new Map();
  const visit = (index, parent) => {
    const node = json.nodes[index];
    const world = mat4.multiply(mat4.create(), parent, nodeMatrix(node));
    worldMatrices.set(index, world);
    for (const c of node.children || []) visit(c, world);
  };
  const rootMatrix = mat4.create();
  for (const s of json.scenes || []) {
    for (const r of s.nodes || []) visit(r, rootMatrix);
  }
  for (let i = 0; i < (json.nodes || []).length; i++) {
    if (!worldMatrices.has(i)) worldMatrices.set(i, rootMatrix);
  }

  // ---- flatten meshes -----------------------------------------------------
  const positions = [], normals = [], uvs = [], indices = [], colors = [];
  let vertexOffset = 0;

  for (let nodeIndex = 0; nodeIndex < (json.nodes || []).length; nodeIndex++) {
    const node = json.nodes[nodeIndex];
    if (node.mesh === undefined) continue;
    const world = worldMatrices.get(nodeIndex);
    const normalMat = mat3.normalFromMat4(mat3.create(), world);
    const mesh = json.meshes[node.mesh];

    for (const prim of mesh.primitives || []) {
      if ((prim.mode ?? 4) !== 4) continue;            // triangles only
      const pos = readAccessor(prim.attributes.POSITION);
      const nrm = prim.attributes.NORMAL !== undefined ? readAccessor(prim.attributes.NORMAL) : null;
      const uv = prim.attributes.TEXCOORD_0 !== undefined ? readAccessor(prim.attributes.TEXCOORD_0) : null;
      const col = prim.attributes.COLOR_0 !== undefined ? readAccessor(prim.attributes.COLOR_0) : null;
      const idx = prim.indices !== undefined ? readAccessor(prim.indices) : null;

      const count = pos.data.length / 3;
      const start = vertexOffset;
      const p = vec3.create(), n = vec3.create();
      for (let i = 0; i < count; i++) {
        p[0] = pos.data[i * 3]; p[1] = pos.data[i * 3 + 1]; p[2] = pos.data[i * 3 + 2];
        vec3.transformMat4(p, p, world);
        positions.push(p[0], p[1], p[2]);
        if (nrm) {
          n[0] = nrm.data[i * 3]; n[1] = nrm.data[i * 3 + 1]; n[2] = nrm.data[i * 3 + 2];
          vec3.transformMat3(n, n, normalMat);
          vec3.normalize(n, n);
          normals.push(n[0], n[1], n[2]);
        }
        if (uv) uvs.push(uv.data[i * 2], uv.data[i * 2 + 1]);
        if (col) {
          const c = col.comps === 3 ? [...col.data.slice(i * 3, i * 3 + 3), 1] : col.data.slice(i * 4, i * 4 + 4);
          colors.push(c[0], c[1], c[2], c[3]);
        }
      }

      if (idx) {
        for (let i = 0; i < idx.data.length; i++) indices.push(start + idx.data[i]);
      } else {
        for (let i = 0; i < count; i++) indices.push(start + i);
      }
      vertexOffset += count;
    }
  }

  if (!positions.length) throw new Error('glTF contains no triangle geometry');

  const geometry = { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
  if (normals.length === positions.length) geometry.normals = new Float32Array(normals);
  else geometry.normals = computeNormals(geometry.positions, geometry.indices);
  if (uvs.length / 2 === positions.length / 3) geometry.uvs = new Float32Array(uvs);
  else geometry.uvs = planarUV(geometry.positions);
  if (colors.length === positions.length / 3 * 4) geometry.colors = new Float32Array(colors);
  return geometry;
}

function planarUV(positions) {
  const uvs = new Float32Array((positions.length / 3) * 2);
  for (let i = 0, j = 0; i < positions.length; i += 3, j += 2) {
    uvs[j] = positions[i] * 0.5 + 0.5;
    uvs[j + 1] = positions[i + 2] * 0.5 + 0.5;
  }
  return uvs;
}

function dataURIToArrayBuffer(uri) {
  const comma = uri.indexOf(',');
  const meta = uri.slice(5, comma);
  const data = uri.slice(comma + 1);
  if (meta.endsWith(';base64')) {
    const bin = atob(data);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }
  return new TextEncoder().encode(decodeURIComponent(data)).buffer;
}
