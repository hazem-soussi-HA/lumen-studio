/**
 * Procedural geometry.
 *
 * Everything is generated on the CPU because WebGL has no geometry shader (see
 * docs/WEBGL-ARTICLE-MAP.md): tessellation, LOD generation and vertex welding are
 * mesh-building operations that a modern engine performs in a compute or
 * geometry stage. Doing them here is the portable equivalent.
 */

import { uid } from '../core/utils.js';

const TAU = Math.PI * 2;

function build(positions, normals, uvs, indices) {
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), uvs: new Float32Array(uvs), indices: new Uint32Array(indices) };
}

/** Unit box centred on the origin, 1×1×1, with per-face UVs and hard normals. */
export function box({ size = 1, segments = 1 } = {}) {
  const hx = size * 0.5, hy = size * 0.5, hz = size * 0.5;
  const faces = [
    { n: [0, 0, 1], v: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]], s: [hx, hy, hz] },
    { n: [0, 0, -1], v: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]], s: [hx, hy, hz] },
    { n: [1, 0, 0], v: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]], s: [hx, hy, hz] },
    { n: [-1, 0, 0], v: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]], s: [hx, hy, hz] },
    { n: [0, 1, 0], v: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]], s: [hx, hy, hz] },
    { n: [0, -1, 0], v: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]], s: [hx, hy, hz] }
  ];
  const positions = [], normals = [], uvs = [], indices = [];
  const uvCorners = [[0, 0], [1, 0], [1, 1], [0, 1]];
  let base = 0;
  for (const f of faces) {
    for (let i = 0; i < 4; i++) {
      const v = f.v[i];
      positions.push(v[0] * f.s[0], v[1] * f.s[1], v[2] * f.s[2]);
      normals.push(f.n[0], f.n[1], f.n[2]);
      uvs.push(uvCorners[i][0], uvCorners[i][1]);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    base += 4;
  }
  return build(positions, normals, uvs, indices);
}

/** UV sphere. `segments` = longitude, `rings` = latitude. */
export function sphere({ radius = 0.5, segments = 24, rings = 16 } = {}) {
  const positions = [], normals = [], uvs = [], indices = [];
  for (let y = 0; y <= rings; y++) {
    const v = y / rings;
    const phi = v * Math.PI;
    const sp = Math.sin(phi), cp = Math.cos(phi);
    for (let x = 0; x <= segments; x++) {
      const u = x / segments;
      const theta = u * TAU;
      const st = Math.sin(theta), ct = Math.cos(theta);
      const nx = sp * ct, ny = cp, nz = sp * st;
      positions.push(nx * radius, ny * radius, nz * radius);
      normals.push(nx, ny, nz);
      uvs.push(u, 1 - v);
    }
  }
  for (let y = 0; y < rings; y++) {
    for (let x = 0; x < segments; x++) {
      const a = y * (segments + 1) + x;
      const b = a + segments + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return build(positions, normals, uvs, indices);
}

/** Geodesic sphere by icosahedron subdivision — uniform triangles, no pole pinch. */
export function icosphere({ radius = 0.5, subdivisions = 2 } = {}) {
  const t = (1 + Math.sqrt(5)) / 2;
  let verts = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]
  ].map((v) => { const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l]; });

  let faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]
  ];

  for (let s = 0; s < subdivisions; s++) {
    const cache = new Map();
    const next = [];
    const midpoint = (a, b) => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (cache.has(key)) return cache.get(key);
      const va = verts[a], vb = verts[b];
      const m = [va[0] + vb[0], va[1] + vb[1], va[2] + vb[2]];
      const l = Math.hypot(...m);
      verts.push([m[0] / l, m[1] / l, m[2] / l]);
      const idx = verts.length - 1;
      cache.set(key, idx);
      return idx;
    };
    for (const [a, b, c] of faces) {
      const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = next;
  }

  const positions = [], normals = [], uvs = [], indices = [];
  // Spherical UVs with a seam fix: wrap phi and average the pole normal.
  for (const v of verts) {
    positions.push(v[0] * radius, v[1] * radius, v[2] * radius);
    normals.push(v[0], v[1], v[2]);
    const u = 0.5 + Math.atan2(v[2], v[0]) / TAU;
    const vv = 0.5 - Math.asin(Math.max(-1, Math.min(1, v[1]))) / Math.PI;
    uvs.push(u, vv);
  }
  for (const [a, b, c] of faces) indices.push(a, b, c);
  return build(positions, normals, uvs, indices);
}

export function cylinder({ radius = 0.5, height = 1, segments = 24, capped = true, radiusTop = null } = {}) {
  const rt = radiusTop === null ? radius : radiusTop;
  const hh = height * 0.5;
  const positions = [], normals = [], uvs = [], indices = [];
  const slope = (radius - rt) / height;

  for (let y = 0; y < 2; y++) {
    const r = y === 0 ? rt : radius;
    const py = y === 0 ? hh : -hh;
    for (let x = 0; x <= segments; x++) {
      const u = x / segments;
      const a = u * TAU;
      const sx = Math.sin(a), cz = Math.cos(a);
      positions.push(sx * r, py, cz * r);
      const n = [sx, slope, cz];
      const l = Math.hypot(n[0], n[1], n[2]);
      normals.push(n[0] / l, n[1] / l, n[2] / l);
      uvs.push(u, y);
    }
  }
  for (let x = 0; x < segments; x++) {
    const a = x, b = x + segments + 1;
    indices.push(a, b, a + 1, a + 1, b, b + 1);
  }
  if (capped) {
    for (const [y, ny, r] of [[hh, 1, rt], [-hh, -1, radius]]) {
      const centre = positions.length / 3;
      positions.push(0, y, 0);
      normals.push(0, ny, 0);
      uvs.push(0.5, 0.5);
      for (let x = 0; x <= segments; x++) {
        const a = (x / segments) * TAU;
        positions.push(Math.sin(a) * r, y, Math.cos(a) * r);
        normals.push(0, ny, 0);
        uvs.push(Math.sin(a) * 0.5 + 0.5, Math.cos(a) * 0.5 + 0.5);
      }
      for (let x = 0; x < segments; x++) {
        if (ny > 0) indices.push(centre, centre + 1 + x, centre + 2 + x);
        else indices.push(centre, centre + 2 + x, centre + 1 + x);
      }
    }
  }
  return build(positions, normals, uvs, indices);
}

export function cone({ radius = 0.5, height = 1, segments = 24, capped = true } = {}) {
  return cylinder({ radius, radiusTop: 0.0001, height, segments, capped });
}

export function capsule({ radius = 0.25, height = 1, segments = 20, rings = 8 } = {}) {
  const hh = Math.max(0.0001, height * 0.5 - radius);
  const positions = [], normals = [], uvs = [], indices = [];
  const push = (p, n, u) => { positions.push(...p); normals.push(...n); uvs.push(...u); };
  // Two hemispheres + a cylinder wall.
  for (let i = 0; i <= rings; i++) {
    const phi = (i / rings) * (Math.PI * 0.5);
    for (let j = 0; j <= segments; j++) {
      const theta = (j / segments) * TAU;
      const n = [Math.cos(phi) * Math.sin(theta), Math.sin(phi), Math.cos(phi) * Math.cos(theta)];
      push([n[0] * radius, hh + n[1] * radius, n[2] * radius], n, [j / segments, i / rings]);
    }
  }
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const a = i * (segments + 1) + j, b = a + segments + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const bottomBase = positions.length / 3;
  for (let i = 0; i <= rings; i++) {
    const phi = (i / rings) * (Math.PI * 0.5);
    for (let j = 0; j <= segments; j++) {
      const theta = (j / segments) * TAU;
      const n = [Math.cos(phi) * Math.sin(theta), -Math.sin(phi), Math.cos(phi) * Math.cos(theta)];
      push([n[0] * radius, -hh + n[1] * radius, n[2] * radius], n, [j / segments, 1 - i / rings]);
    }
  }
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const a = bottomBase + i * (segments + 1) + j, b = a + segments + 1;
      indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  return build(positions, normals, uvs, indices);
}

export function torus({ radius = 0.4, tube = 0.12, segments = 32, sides = 16 } = {}) {
  const positions = [], normals = [], uvs = [], indices = [];
  for (let i = 0; i <= segments; i++) {
    const u = i / segments;
    const a = u * TAU;
    const cx = Math.cos(a), cz = Math.sin(a);
    for (let j = 0; j <= sides; j++) {
      const v = j / sides;
      const b = v * TAU;
      const r = radius + tube * Math.cos(b);
      positions.push(cx * r, tube * Math.sin(b), cz * r);
      normals.push(cx * Math.cos(b), Math.sin(b), cz * Math.cos(b));
      uvs.push(u, v);
    }
  }
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < sides; j++) {
      const a = i * (sides + 1) + j, b = a + sides + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return build(positions, normals, uvs, indices);
}

/** Subdivided plane on XZ, centred, +Y up. */
export function plane({ size = 10, widthSegments = 10, heightSegments = 10, heightFn = null } = {}) {
  const positions = [], normals = [], uvs = [], indices = [];
  const h = size * 0.5;
  for (let z = 0; z <= heightSegments; z++) {
    for (let x = 0; x <= widthSegments; x++) {
      const u = x / widthSegments, v = z / heightSegments;
      const px = (u - 0.5) * size;
      const pz = (v - 0.5) * size;
      const py = heightFn ? heightFn(px, pz) : 0;
      positions.push(px, py, pz);
      normals.push(0, 1, 0);
      uvs.push(u, v);
    }
  }
  for (let z = 0; z < heightSegments; z++) {
    for (let x = 0; x < widthSegments; x++) {
      const a = z * (widthSegments + 1) + x, b = a + widthSegments + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  if (heightFn) computeNormals(positions, indices, normals);
  return build(positions, normals, uvs, indices);
}

/** Heightfield terrain with fBm noise — a nod to the cartography tools in the article. */
export function terrain({ size = 200, segments = 128, height = 26, octaves = 5, lacunarity = 2.0, gain = 0.5, seed = 1337 } = {}) {
  const rand = mulberry(seed);
  const perm = new Float32Array(512);
  for (let i = 0; i < 512; i++) perm[i] = rand();
  const noise2 = (x, y) => {
    const xi = Math.floor(x) & 255, yi = Math.floor(y) & 255;
    const xf = x - Math.floor(x), yf = y - Math.floor(y);
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const aa = perm[perm[xi] + yi], ab = perm[perm[xi] + yi + 1];
    const ba = perm[perm[xi + 1] + yi], bb = perm[perm[xi + 1] + yi + 1];
    return lerpN(lerpN(aa, ba, u), lerpN(ab, bb, u), v);
  };
  const ridged = (x, y) => {
    let sum = 0, amp = 0.5, freq = 1, norm = 0;
    for (let o = 0; o < octaves; o++) {
      const n = 1 - Math.abs(noise2(x * freq, y * freq) * 2 - 1);
      sum += n * n * amp;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  };
  const heightFn = (x, z) => {
    const nx = x * 0.012, nz = z * 0.012;
    const h = ridged(nx, nz);
    const falloff = 1 - Math.min(1, Math.hypot(x, z) / (size * 0.5));
    return (h * height) * (0.25 + 0.75 * falloff * falloff);
  };
  return plane({ size, widthSegments: segments, heightSegments: segments, heightFn });
}

function computeNormals(positions, indices, normals) {
  for (let i = 0; i < normals.length; i++) normals[i] = 0;
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
}

/** Weld coincident vertices, drop unused ones and remap indices. */
export function weld(geo, epsilon = 1e-4) {
  const map = new Map();
  const positions = [], normals = [], uvs = [];
  const remap = new Uint32Array(geo.positions.length / 3);
  for (let i = 0; i < geo.positions.length / 3; i++) {
    const x = geo.positions[i * 3], y = geo.positions[i * 3 + 1], z = geo.positions[i * 3 + 2];
    const key = `${Math.round(x / epsilon)},${Math.round(y / epsilon)},${Math.round(z / epsilon)}`;
    let idx = map.get(key);
    if (idx === undefined) {
      idx = positions.length / 3;
      map.set(key, idx);
      positions.push(x, y, z);
      normals.push(geo.normals[i * 3], geo.normals[i * 3 + 1], geo.normals[i * 3 + 2]);
      uvs.push(geo.uvs[i * 2], geo.uvs[i * 2 + 1]);
    }
    remap[i] = idx;
  }
  const indices = new Uint32Array(geo.indices.length);
  for (let i = 0; i < geo.indices.length; i++) indices[i] = remap[geo.indices[i]];
  return build(positions, normals, uvs, indices);
}

/** Per-vertex colour attribute from a callback. */
export function colorize(geo, fn) {
  const n = geo.positions.length / 3;
  const colors = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const c = fn(geo.positions[i * 3], geo.positions[i * 3 + 1], geo.positions[i * 3 + 2], i);
    colors[i * 4] = c[0]; colors[i * 4 + 1] = c[1]; colors[i * 4 + 2] = c[2]; colors[i * 4 + 3] = c[3] ?? 1;
  }
  return { ...geo, colors };
}

export const PRIMITIVES = {
  box: { label: 'Box', fn: box, icon: '▣' },
  sphere: { label: 'Sphere', fn: sphere, icon: '◯' },
  icosphere: { label: 'Icosphere', fn: icosphere, icon: '◍' },
  cylinder: { label: 'Cylinder', fn: cylinder, icon: '⬮' },
  cone: { label: 'Cone', fn: cone, icon: '▲' },
  capsule: { label: 'Capsule', fn: capsule, icon: '⬬' },
  torus: { label: 'Torus', fn: torus, icon: '◎' },
  plane: { label: 'Plane', fn: plane, icon: '▤' },
  terrain: { label: 'Terrain', fn: terrain, icon: '⛰' }
};

export const primitiveGeometry = (name, opts) => {
  const def = PRIMITIVES[name] || PRIMITIVES.box;
  return def.fn(opts || {});
};

/** Screen-space quad used for backgrounds, gizmo planes and post passes. */
export function fullscreenQuadPositions() {
  return new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]);
}

export function unitQuadPositions2D() {
  return new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]);
}

export const newMeshId = () => uid('m');

function mulberry(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const lerpN = (a, b, t) => a + (b - a) * t;
