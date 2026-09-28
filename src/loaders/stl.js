/**
 * Binary + ASCII STL loader. Both variants describe a triangle soup, so vertices
 * are welded afterwards — otherwise a 20k-triangle mesh would upload 60k vertices
 * and break the 16-bit index path on WebGL 1 for no reason.
 */

import { computeNormals } from './obj.js';

export function parseSTL(buffer) {
  const view = buffer instanceof ArrayBuffer ? new DataView(buffer) : new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const isAscii = looksAscii(buffer);
  const { positions, indices } = isAscii ? parseAscii(buffer) : parseBinary(view);

  const geometry = { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
  geometry.normals = computeNormals(geometry.positions, geometry.indices);
  geometry.uvs = planarUV(geometry.positions);
  return weld(geometry);
}

function looksAscii(buffer) {
  const bytes = new Uint8Array(buffer.slice(0, Math.min(84, buffer.byteLength)));
  const head = new TextDecoder('ascii').decode(bytes).toLowerCase();
  return head.includes('solid') && !head.startsWith('solid binary');
}

function parseBinary(view) {
  const triangles = view.getUint32(80, true);
  const positions = new Array(triangles * 9);
  const indices = new Array(triangles * 3);
  let o = 84;
  for (let t = 0; t < triangles; t++) {
    // 12 floats per record: normal (3) + 3 vertices (9).
    o += 12; // skip the stored normal; we recompute from winding
    for (let v = 0; v < 3; v++) {
      const i = (t * 3 + v) * 3;
      positions[i] = view.getFloat32(o, true);
      positions[i + 1] = view.getFloat32(o + 4, true);
      positions[i + 2] = view.getFloat32(o + 8, true);
      indices[t * 3 + v] = t * 3 + v;
      o += 12;
    }
    o += 2; // attribute byte count
  }
  return { positions, indices };
}

function parseAscii(buffer) {
  const text = new TextDecoder().decode(new Uint8Array(buffer));
  const positions = [];
  const indices = [];
  const re = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
  let m;
  while ((m = re.exec(text))) {
    positions.push(+m[1], +m[2], +m[3]);
    indices.push(positions.length / 3 - 1);
  }
  return { positions, indices };
}

function planarUV(positions) {
  const uvs = new Float32Array(positions.length / 3 * 2);
  for (let i = 0, j = 0; i < positions.length; i += 3, j += 2) {
    uvs[j] = positions[i] * 0.5 + 0.5;
    uvs[j + 1] = positions[i + 2] * 0.5 + 0.5;
  }
  return uvs;
}

function weld(geo, epsilon = 1e-5) {
  const map = new Map();
  const positions = [];
  const uvs = [];
  const remap = new Uint32Array(geo.positions.length / 3);
  for (let i = 0; i < geo.positions.length / 3; i++) {
    const x = geo.positions[i * 3], y = geo.positions[i * 3 + 1], z = geo.positions[i * 3 + 2];
    const key = `${Math.round(x / epsilon)},${Math.round(y / epsilon)},${Math.round(z / epsilon)}`;
    let idx = map.get(key);
    if (idx === undefined) {
      idx = positions.length / 3;
      map.set(key, idx);
      positions.push(x, y, z);
      uvs.push(geo.uvs[i * 2], geo.uvs[i * 2 + 1]);
    }
    remap[i] = idx;
  }
  const indices = new Uint32Array(geo.indices.length);
  for (let i = 0; i < geo.indices.length; i++) indices[i] = remap[geo.indices[i]];
  return { positions: new Float32Array(positions), normals: geo.normals, uvs: new Float32Array(uvs), indices };
}
