/**
 * Wavefront OBJ loader (v / vn / vt / f, with triangulation of n-gons, negative
 * indices and \\ line continuations). No dependencies, no object reuse — the
 * result is a plain typed-array geometry the mesh builder can upload directly.
 */

export function parseOBJ(text) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const map = new Map();               // "v/vt/vn" → new index (welds by cache)

  const lines = String(text).split('\n');
  let out = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    while (line.endsWith('\\') && i + 1 < lines.length) {
      line = line.slice(0, -1) + ' ' + lines[++i].trim();
    }
    out.push(line);
  }

  for (const raw of out) {
    if (!raw || raw[0] === '#') continue;
    const sp = raw.indexOf(' ');
    if (sp < 0) continue;
    const key = raw.slice(0, sp);
    const rest = raw.slice(sp + 1).trim();

    if (key === 'v') {
      const p = rest.split(/\s+/);
      positions.push(+p[0], +p[1], +p[2]);
    } else if (key === 'vn') {
      const p = rest.split(/\s+/);
      normals.push(+p[0], +p[1], +p[2]);
    } else if (key === 'vt') {
      const p = rest.split(/\s+/);
      uvs.push(+p[0], 1 - (+p[1] ?? 0));   // OBJ v is bottom-up, GL is top-down
    } else if (key === 'f') {
      const parts = rest.split(/\s+/).filter(Boolean);
      const face = [];
      for (const part of parts) {
        const idx = resolveVertex(part, positions.length / 3, normals.length / 3, uvs.length / 2);
        const cached = map.get(idx.key);
        if (cached !== undefined) { face.push(cached); continue; }
        positions.push(...idx.p);
        if (idx.n.length) normals.push(...idx.n);
        if (idx.t.length) uvs.push(...idx.t);
        map.set(idx.key, positions.length / 3 - 1);
        face.push(positions.length / 3 - 1);
      }
      // Fan-triangulate convex polygons (OBJ faces are required to be planar).
      for (let k = 1; k + 1 < face.length; k++) indices.push(face[0], face[k], face[k + 1]);
    }
    // mtllib / usemtl / g / o / s are irrelevant to a single-material import.
  }

  const geometry = {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices)
  };
  if (normals.length === positions.length) geometry.normals = new Float32Array(normals);
  if (uvs.length / 2 === positions.length / 3) geometry.uvs = new Float32Array(uvs);
  if (!geometry.normals) {
    geometry.normals = computeNormals(geometry.positions, geometry.indices);
  }
  return geometry;
}

function resolveVertex(part, vCount, nCount, tCount) {
  const bits = part.split('/');
  const vi = resolveIndex(bits[0], vCount);
  const ti = bits[1] ? resolveIndex(bits[1], tCount) : -1;
  const ni = bits[2] ? resolveIndex(bits[2], nCount) : -1;
  return {
    key: `${vi}/${ti}/${ni}`,
    p: [vi * 3, vi * 3 + 1, vi * 3 + 2],
    t: ti >= 0 ? [ti * 2, ti * 2 + 1] : [],
    n: ni >= 0 ? [ni * 3, ni * 3 + 1, ni * 3 + 2] : []
  };
}

function resolveIndex(token, count) {
  let i = parseInt(token, 10);
  if (Number.isNaN(i)) return 0;
  if (i < 0) i = count + i;            // relative index
  else i -= 1;                          // OBJ is 1-based
  return i < 0 ? 0 : i;
}

export function computeNormals(positions, indices) {
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    normals[a] += nx; normals[a + 1] += ny; normals[a + 2] += nz;
    normals[b] += nx; normals[b + 1] += ny; normals[b + 2] += nz;
    normals[c] += nx; normals[c + 1] += ny; normals[c + 2] += nz;
  }
  for (let i = 0; i < normals.length; i += 3) {
    const l = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    normals[i] /= l; normals[i + 1] /= l; normals[i + 2] /= l;
  }
  return normals;
}

/** Serialise a mesh back to OBJ (export of the selection). */
export function writeOBJ(mesh, { name = 'mesh' } = {}) {
  const p = mesh.positions, n = mesh.normals, u = mesh.uvs;
  const idx = mesh.indices?.data;
  const lines = [`# Lumen Studio export`, `o ${name}`];
  for (let i = 0; i < p.length; i += 3) lines.push(`v ${p[i].toFixed(6)} ${p[i + 1].toFixed(6)} ${p[i + 2].toFixed(6)}`);
  if (u) for (let i = 0; i < u.length; i += 2) lines.push(`vt ${u[i].toFixed(6)} ${u[i + 1].toFixed(6)}`);
  if (n) for (let i = 0; i < n.length; i += 3) lines.push(`vn ${n[i].toFixed(6)} ${n[i + 1].toFixed(6)} ${n[i + 2].toFixed(6)}`);
  const tri = idx ? idx.length / 3 : p.length / 9;
  for (let t = 0; t < tri; t++) {
    const a = (idx ? idx[t * 3] : t * 3) + 1;
    const b = (idx ? idx[t * 3 + 1] : t * 3 + 1) + 1;
    const c = (idx ? idx[t * 3 + 2] : t * 3 + 2) + 1;
    const f = (i) => (u ? `${i}/${i}/` : `${i}//`) + (n ? `${i}` : '');
    if (n) lines.push(`f ${f(a)} ${f(b)} ${f(c)}`);
    else if (u) lines.push(`f ${a}/${a} ${b}/${b} ${c}/${c}`);
    else lines.push(`f ${a} ${b} ${c}`);
  }
  return lines.join('\n');
}
