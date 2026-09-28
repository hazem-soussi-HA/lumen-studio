/**
 * Lumen Studio — math kernel.
 *
 * Conventions (identical to the OpenGL pipeline that consumes these buffers):
 *   • Matrices are column-major `Float32Array(16)`, m[col*4 + row], i.e. the
 *     exact layout `uniformMatrix4fv` expects with `transpose = false`.
 *   • Multiplication is `out = a * b`, meaning "apply b first, then a".
 *   • Transforms are TRS-composed: M = T · R · S. Normals therefore need the
 *     inverse-transpose (see `normalMatrix3`), never the raw upper-left 3x3.
 *   • Quaternions are [x, y, z, w]; Euler angles are stored in degrees because
 *     the editor exposes them in degrees while the shaders stay radian-native.
 *   • Screen space: +X right, +Y up, depth mapped to [0,1] (GL convention),
 *     not the [0,1] flipped range of Direct3D.
 */

export const EPSILON = 1e-6;
export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

/* ---------------------------------------------------------------- scalars -- */

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const saturate = (v) => clamp(v, 0, 1);
export const lerp = (a, b, t) => a + (b - a) * t;
export const mix = lerp;
export const sign = Math.sign;
export const fract = (x) => x - Math.floor(x);
export const smoothstep = (e0, e1, x) => { const t = saturate((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
export const step = (edge, x) => (x < edge ? 0 : 1);
export const mod = (a, n) => ((a % n) + n) % n;
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
/** radians → degrees (the editor's Euler fields are stored in degrees) */
export const deg = (r) => r * RAD2DEG;
/** degrees → radians (shader-facing angles) */
export const rad = (d) => d * DEG2RAD;
export const approx = (a, b, e = 1e-5) => Math.abs(a - b) <= e;

/* ------------------------------------------------------------------- vec2 -- */

export const vec2 = {
  create: (x = 0, y = 0) => new Float32Array([x, y]),
  set: (o, x, y) => { o[0] = x; o[1] = y; return o; },
  copy: (o, a) => { o[0] = a[0]; o[1] = a[1]; return o; },
  add: (o, a, b) => { o[0] = a[0] + b[0]; o[1] = a[1] + b[1]; return o; },
  sub: (o, a, b) => { o[0] = a[0] - b[0]; o[1] = a[1] - b[1]; return o; },
  scale: (o, a, s) => { o[0] = a[0] * s; o[1] = a[1] * s; return o; },
  scaleAndAdd: (o, a, b, s) => { o[0] = a[0] + b[0] * s; o[1] = a[1] + b[1] * s; return o; },
  dot: (a, b) => a[0] * b[0] + a[1] * b[1],
  len: (a) => Math.hypot(a[0], a[1]),
  lenSq: (a) => a[0] * a[0] + a[1] * a[1],
  dist: (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]),
  normalize: (o, a) => { const l = Math.hypot(a[0], a[1]) || 1; o[0] = a[0] / l; o[1] = a[1] / l; return o; },
  lerp: (o, a, b, t) => { o[0] = a[0] + (b[0] - a[0]) * t; o[1] = a[1] + (b[1] - a[1]) * t; return o; },
  neg: (o, a) => { o[0] = -a[0]; o[1] = -a[1]; return o; }
};

/* ------------------------------------------------------------------- vec3 -- */

export const vec3 = {
  create: (x = 0, y = 0, z = 0) => new Float32Array([x, y, z]),
  createFrom: (a) => new Float32Array([a[0], a[1], a[2]]),
  clone: (a) => new Float32Array([a[0], a[1], a[2]]),
  set: (o, x, y, z) => { o[0] = x; o[1] = y; o[2] = z; return o; },
  copy: (o, a) => { o[0] = a[0]; o[1] = a[1]; o[2] = a[2]; return o; },
  add: (o, a, b) => { o[0] = a[0] + b[0]; o[1] = a[1] + b[1]; o[2] = a[2] + b[2]; return o; },
  sub: (o, a, b) => { o[0] = a[0] - b[0]; o[1] = a[1] - b[1]; o[2] = a[2] - b[2]; return o; },
  mul: (o, a, b) => { o[0] = a[0] * b[0]; o[1] = a[1] * b[1]; o[2] = a[2] * b[2]; return o; },
  scale: (o, a, s) => { o[0] = a[0] * s; o[1] = a[1] * s; o[2] = a[2] * s; return o; },
  scaleAndAdd: (o, a, b, s) => { o[0] = a[0] + b[0] * s; o[1] = a[1] + b[1] * s; o[2] = a[2] + b[2] * s; return o; },
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  lenSq: (a) => a[0] * a[0] + a[1] * a[1] + a[2] * a[2],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  dist: (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]),
  distSq: (a, b) => { const x = b[0] - a[0], y = b[1] - a[1], z = b[2] - a[2]; return x * x + y * y + z * z; },
  cross: (o, a, b) => {
    const ax = a[0], ay = a[1], az = a[2], bx = b[0], by = b[1], bz = b[2];
    o[0] = ay * bz - az * by; o[1] = az * bx - ax * bz; o[2] = ax * by - ay * bx; return o;
  },
  normalize: (o, a) => {
    const l = Math.hypot(a[0], a[1], a[2]);
    if (l < EPSILON) { o[0] = 0; o[1] = 0; o[2] = 0; return o; }
    o[0] = a[0] / l; o[1] = a[1] / l; o[2] = a[2] / l; return o;
  },
  negate: (o, a) => { o[0] = -a[0]; o[1] = -a[1]; o[2] = -a[2]; return o; },
  lerp: (o, a, b, t) => {
    o[0] = a[0] + (b[0] - a[0]) * t; o[1] = a[1] + (b[1] - a[1]) * t; o[2] = a[2] + (b[2] - a[2]) * t; return o;
  },
  transformMat4: (o, a, m) => {
    const x = a[0], y = a[1], z = a[2];
    let w = m[3] * x + m[7] * y + m[11] * z + m[15]; w = w || 1;
    o[0] = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
    o[1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
    o[2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
    return o;
  },
  transformMat4Dir: (o, a, m) => {
    const x = a[0], y = a[1], z = a[2];
    o[0] = m[0] * x + m[4] * y + m[8] * z;
    o[1] = m[1] * x + m[5] * y + m[9] * z;
    o[2] = m[2] * x + m[6] * y + m[10] * z;
    return o;
  },
  transformMat3: (o, a, m) => {
    const x = a[0], y = a[1], z = a[2];
    o[0] = m[0] * x + m[3] * y + m[6] * z;
    o[1] = m[1] * x + m[4] * y + m[7] * z;
    o[2] = m[2] * x + m[5] * y + m[8] * z;
    return o;
  },
  transformQuat: (o, a, q) => {
    const x = a[0], y = a[1], z = a[2], qx = q[0], qy = q[1], qz = q[2], qw = q[3];
    const ix = qw * x + qy * z - qz * y;
    const iy = qw * y + qz * x - qx * z;
    const iz = qw * z + qx * y - qy * x;
    const iw = -qx * x - qy * y - qz * z;
    o[0] = ix * qw + iw * -qx + iy * -qz - iz * -qy;
    o[1] = iy * qw + iw * -qy + iz * -qx - ix * -qz;
    o[2] = iz * qw + iw * -qz + ix * -qy - iy * -qx;
    return o;
  },
  min: (o, a, b) => { o[0] = Math.min(a[0], b[0]); o[1] = Math.min(a[1], b[1]); o[2] = Math.min(a[2], b[2]); return o; },
  max: (o, a, b) => { o[0] = Math.max(a[0], b[0]); o[1] = Math.max(a[1], b[1]); o[2] = Math.max(a[2], b[2]); return o; },
  equals: (a, b, e = 1e-5) => Math.abs(a[0] - b[0]) < e && Math.abs(a[1] - b[1]) < e && Math.abs(a[2] - b[2]) < e,
  /** Any component that is not finite poisons the value — used to reject bad UI input. */
  isFinite: (a) => Number.isFinite(a[0]) && Number.isFinite(a[1]) && Number.isFinite(a[2])
};

/* ------------------------------------------------------------------- vec4 -- */

export const vec4 = {
  create: (x = 0, y = 0, z = 0, w = 1) => new Float32Array([x, y, z, w]),
  clone: (a) => new Float32Array([a[0], a[1], a[2], a[3]]),
  set: (o, x, y, z, w) => { o[0] = x; o[1] = y; o[2] = z; o[3] = w; return o; },
  copy: (o, a) => { o[0] = a[0]; o[1] = a[1]; o[2] = a[2]; o[3] = a[3]; return o; },
  add: (o, a, b) => { o[0] = a[0] + b[0]; o[1] = a[1] + b[1]; o[2] = a[2] + b[2]; o[3] = a[3] + b[3]; return o; },
  scale: (o, a, s) => { o[0] = a[0] * s; o[1] = a[1] * s; o[2] = a[2] * s; o[3] = a[3] * s; return o; },
  lerp: (o, a, b, t) => {
    o[0] = a[0] + (b[0] - a[0]) * t; o[1] = a[1] + (b[1] - a[1]) * t;
    o[2] = a[2] + (b[2] - a[2]) * t; o[3] = a[3] + (b[3] - a[3]) * t; return o;
  },
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3],
  lenSq: (a) => a[0] * a[0] + a[1] * a[1] + a[2] * a[2] + a[3] * a[3],
  len: (a) => Math.hypot(a[0], a[1], a[2], a[3]),
  normalize: (o, a) => {
    const l = Math.hypot(a[0], a[1], a[2], a[3]) || 1;
    o[0] = a[0] / l; o[1] = a[1] / l; o[2] = a[2] / l; o[3] = a[3] / l; return o;
  }
};

/* -------------------------------------------------------------------- mat3 -- */

export const mat3 = {
  create: () => new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
  identity: (o) => { o.set([1, 0, 0, 0, 1, 0, 0, 0, 1]); return o; },
  copy: (o, a) => { o.set(a); return o; },
  /** Inverse-transpose of the upper-left 3x3 of a mat4: the correct normal transform. */
  normalFromMat4: (o, m) => {
    const a00 = m[0], a01 = m[1], a02 = m[2];
    const a10 = m[4], a11 = m[5], a12 = m[6];
    const a20 = m[8], a21 = m[9], a22 = m[10];
    const b01 = a22 * a11 - a12 * a21;
    const b11 = -a22 * a10 + a12 * a20;
    const b21 = a21 * a10 - a11 * a20;
    let det = a00 * b01 + a01 * b11 + a02 * b21;
    if (Math.abs(det) < 1e-12) { o.set([1, 0, 0, 0, 1, 0, 0, 0, 1]); return o; }
    det = 1 / det;
    o[0] = b01 * det;
    o[1] = (-a22 * a01 + a02 * a21) * det;
    o[2] = (a12 * a01 - a02 * a11) * det;
    o[3] = b11 * det;
    o[4] = (a22 * a00 - a02 * a20) * det;
    o[5] = (-a12 * a00 + a02 * a10) * det;
    o[6] = b21 * det;
    o[7] = (-a21 * a00 + a01 * a20) * det;
    o[8] = (a11 * a00 - a01 * a10) * det;
    return o;
  },
  /** Upper-left 3x3 of a mat4 (fine for orthonormal bases, wrong under non-uniform scale). */
  fromMat4: (o, m) => {
    o[0] = m[0]; o[1] = m[1]; o[2] = m[2];
    o[3] = m[4]; o[4] = m[5]; o[5] = m[6];
    o[6] = m[8]; o[7] = m[9]; o[8] = m[10];
    return o;
  },
  transpose: (o, a) => {
    if (o === a) {
      const a01 = a[1], a02 = a[2], a12 = a[5];
      o[1] = a[3]; o[2] = a[6]; o[5] = a[7];
      o[3] = a01; o[6] = a[2]; o[7] = a[12];
    } else {
      o[0] = a[0]; o[1] = a[3]; o[2] = a[6];
      o[3] = a[1]; o[4] = a[4]; o[5] = a[7];
      o[6] = a[2]; o[7] = a[5]; o[8] = a[8];
    }
    return o;
  },
  /** Rotation-only 3x3 from a quaternion (branchless, handles the antipodal case). */
  fromQuat: (o, q) => {
    const x = q[0], y = q[1], z = q[2], w = q[3];
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    o[0] = 1 - (yy + zz); o[1] = xy + wz; o[2] = xz - wy;
    o[3] = xy - wz; o[4] = 1 - (xx + zz); o[5] = yz + wx;
    o[6] = xz + wy; o[7] = yz - wx; o[8] = 1 - (xx + yy);
    return o;
  },
  multiply: (o, a, b) => {
    const a00 = a[0], a01 = a[1], a02 = a[2], a10 = a[3], a11 = a[4], a12 = a[5], a20 = a[6], a21 = a[7], a22 = a[8];
    for (let i = 0; i < 3; i++) {
      const b0 = b[i * 3], b1 = b[i * 3 + 1], b2 = b[i * 3 + 2];
      o[i * 3] = b0 * a00 + b1 * a10 + b2 * a20;
      o[i * 3 + 1] = b0 * a01 + b1 * a11 + b2 * a21;
      o[i * 3 + 2] = b0 * a02 + b1 * a12 + b2 * a22;
    }
    return o;
  }
};

/* -------------------------------------------------------------------- mat4 -- */

export const mat4 = {
  create: () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  identity: (o) => { o.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); return o; },
  copy: (o, a) => { o.set(a); return o; },
  clone: (a) => new Float32Array(a),

  fromRTS: (o, q, t, s) => {
    const x = q[0], y = q[1], z = q[2], w = q[3];
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    const sx = s[0], sy = s[1], sz = s[2];
    o[0] = (1 - (yy + zz)) * sx; o[1] = (xy + wz) * sx; o[2] = (xz - wy) * sx; o[3] = 0;
    o[4] = (xy - wz) * sy; o[5] = (1 - (xx + zz)) * sy; o[6] = (yz + wx) * sy; o[7] = 0;
    o[8] = (xz + wy) * sz; o[9] = (yz - wx) * sz; o[10] = (1 - (xx + yy)) * sz; o[11] = 0;
    o[12] = t[0]; o[13] = t[1]; o[14] = t[2]; o[15] = 1;
    return o;
  },

  fromTranslation: (o, t) => {
    mat4.identity(o); o[12] = t[0]; o[13] = t[1]; o[14] = t[2]; return o;
  },
  fromScaling: (o, s) => {
    mat4.identity(o); o[0] = s[0]; o[5] = s[1]; o[10] = s[2]; return o;
  },
  fromRotation: (o, q) => {
    mat3.fromQuat(_t3, q);
    o[0] = _t3[0]; o[1] = _t3[1]; o[2] = _t3[2]; o[3] = 0;
    o[4] = _t3[3]; o[5] = _t3[4]; o[6] = _t3[5]; o[7] = 0;
    o[8] = _t3[6]; o[9] = _t3[7]; o[10] = _t3[8]; o[11] = 0;
    o[12] = 0; o[13] = 0; o[14] = 0; o[15] = 1;
    return o;
  },

  multiply: (o, a, b) => {
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
    const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
    for (let i = 0; i < 4; i++) {
      const b0 = b[i * 4], b1 = b[i * 4 + 1], b2 = b[i * 4 + 2], b3 = b[i * 4 + 3];
      o[i * 4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
      o[i * 4 + 1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
      o[i * 4 + 2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
      o[i * 4 + 3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
    }
    return o;
  },

  /** Right-handed perspective with depth range [-1,1] → depth range [0,1] (GL clip space). */
  perspective: (o, fovYRad, aspect, near, far) => {
    const f = 1 / Math.tan(fovYRad / 2);
    o[0] = f / aspect; o[1] = 0; o[2] = 0; o[3] = 0;
    o[4] = 0; o[5] = f; o[6] = 0; o[7] = 0;
    o[8] = 0; o[9] = 0; o[10] = (far + near) / (near - far); o[11] = -1;
    o[12] = 0; o[13] = 0; o[14] = (2 * far * near) / (near - far); o[15] = 0;
    return o;
  },

  /** Right-handed orthographic, depth [0,1]. `zoom` divides the extents (dolly). */
  ortho: (o, halfW, halfH, near, far) => {
    const w = 1 / halfW, h = 1 / halfH, p = 1 / (far - near);
    o[0] = w; o[1] = 0; o[2] = 0; o[3] = 0;
    o[4] = 0; o[5] = h; o[6] = 0; o[7] = 0;
    o[8] = 0; o[9] = 0; o[10] = -2 * p; o[11] = 0;
    o[12] = 0; o[13] = 0; o[14] = -(far + near) * p; o[15] = 1;
    return o;
  },

  lookAt: (o, eye, target, up) => {
    let zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
    let l = Math.hypot(zx, zy, zz);
    if (l < EPSILON) { zx = 0; zy = 0; zz = 1; l = 1; }
    zx /= l; zy /= l; zz /= l;
    let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
    l = Math.hypot(xx, xy, xz);
    if (l < EPSILON) {
      // up is parallel to the view direction — pick any orthogonal axis.
      xx = Math.abs(zz) < 0.9 ? 0 : 1; xy = 0; xz = Math.abs(zz) < 0.9 ? 1 : 0;
      const t = xx * zz - xz * zy; xx = xy * zz - xz * zx; xy = t;
      l = Math.hypot(xx, xy, xz) || 1;
    }
    xx /= l; xy /= l; xz /= l;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    o[0] = xx; o[1] = yx; o[2] = zx; o[3] = 0;
    o[4] = xy; o[5] = yy; o[6] = zy; o[7] = 0;
    o[8] = xz; o[9] = yz; o[10] = zz; o[11] = 0;
    o[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
    o[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
    o[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
    o[15] = 1;
    return o;
  },

  invert: (o, m) => {
    const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
    const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
    const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
    const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
    const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10;
    const b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31;
    const b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (Math.abs(det) < 1e-12) return null;
    det = 1 / det;
    o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
    o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
    o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
    o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
    o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
    o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
    o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
    o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
    o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return o;
  },

  transpose: (o, a) => {
    if (o === a) {
      const a01 = a[1], a02 = a[2], a03 = a[3], a12 = a[6], a13 = a[7], a23 = a[11];
      o[1] = a[4]; o[2] = a[8]; o[3] = a[12];
      o[4] = a01; o[6] = a[9]; o[7] = a[13];
      o[8] = a02; o[9] = a12; o[11] = a[14];
      o[12] = a03; o[13] = a13; o[14] = a23;
    } else {
      o[0] = a[0]; o[1] = a[4]; o[2] = a[8]; o[3] = a[12];
      o[4] = a[1]; o[5] = a[5]; o[6] = a[9]; o[7] = a[13];
      o[8] = a[2]; o[9] = a[6]; o[10] = a[10]; o[11] = a[14];
      o[12] = a[3]; o[13] = a[7]; o[14] = a[11]; o[15] = a[15];
    }
    return o;
  },

  /** TRS decomposition. Returns [translation, rotation(quat), scale]. */
  decompose: (out, m) => {
    const sx = Math.hypot(m[0], m[1], m[2]);
    const sy = Math.hypot(m[4], m[5], m[6]);
    const sz = Math.hypot(m[8], m[9], m[10]);
    out.t[0] = m[12]; out.t[1] = m[13]; out.t[2] = m[14];
    const isx = sx === 0 ? 0 : 1 / sx, isy = sy === 0 ? 0 : 1 / sy, isz = sz === 0 ? 0 : 1 / sz;
    const r = out.r, s = out.s;
    s[0] = sx; s[1] = sy; s[2] = sz;
    r[0] = (m[6] * isy - m[5] * isz) * 0.5;
    r[1] = (m[8] * isz - m[9] * isx) * 0.5;
    r[2] = (m[1] * isx - m[2] * isy) * 0.5;
    r[3] = (m[0] * isx + m[4] * isy + m[10] * isz) * 0.5;
    const l = Math.hypot(r[0], r[1], r[2], r[3]);
    if (l < 1e-6) { r[0] = r[1] = r[2] = 0; r[3] = 1; }
    else { r[0] /= l; r[1] /= l; r[2] /= l; r[3] /= l; }
    return out;
  },

  getTranslation: (o, m) => { o[0] = m[12]; o[1] = m[13]; o[2] = m[14]; return o; },
  getScale: (o, m) => {
    o[0] = Math.hypot(m[0], m[1], m[2]);
    o[1] = Math.hypot(m[4], m[5], m[6]);
    o[2] = Math.hypot(m[8], m[9], m[10]);
    return o;
  },
  getXAxis: (o, m) => { o[0] = m[0]; o[1] = m[1]; o[2] = m[2]; return o; },
  getYAxis: (o, m) => { o[0] = m[4]; o[1] = m[5]; o[2] = m[6]; return o; },
  getZAxis: (o, m) => { o[0] = m[8]; o[1] = m[9]; o[2] = m[10]; return o; },

  transformPoint: (o, p, m) => vec3.transformMat4(o, p, m),
  transformDirection: (o, p, m) => vec3.transformMat4Dir(o, p, m)
};

const _t3 = new Float32Array(9);

/* -------------------------------------------------------------------- quat -- */

export const quat = {
  create: () => new Float32Array([0, 0, 0, 1]),
  identity: (o) => { o[0] = 0; o[1] = 0; o[2] = 0; o[3] = 1; return o; },
  copy: (o, a) => { o[0] = a[0]; o[1] = a[1]; o[2] = a[2]; o[3] = a[3]; return o; },
  clone: (a) => new Float32Array(a),

  fromAxisAngle: (o, axis, rad_) => {
    const l = Math.hypot(axis[0], axis[1], axis[2]) || 1;
    const h = rad_ * 0.5, s = Math.sin(h) / l;
    o[0] = axis[0] * s; o[1] = axis[1] * s; o[2] = axis[2] * s; o[3] = Math.cos(h);
    return o;
  },

  /**
   * Intrinsic XYZ Euler (PlayCanvas / Unity convention): R = Rx · Ry · Rz.
   * Input in degrees, matching the editor's rotation field. Composed as
   * q = qx · qy · qz so the code and `toEuler` can never disagree about the order.
   */
  fromEuler: (o, x, y, z) => {
    const hx = rad(x) * 0.5, hy = rad(y) * 0.5, hz = rad(z) * 0.5;
    _qx[0] = Math.sin(hx); _qx[1] = 0; _qx[2] = 0; _qx[3] = Math.cos(hx);
    _qy[0] = 0; _qy[1] = Math.sin(hy); _qy[2] = 0; _qy[3] = Math.cos(hy);
    _qz[0] = 0; _qz[1] = 0; _qz[2] = Math.sin(hz); _qz[3] = Math.cos(hz);
    quat.multiply(o, _qx, _qy);
    return quat.multiply(o, o, _qz);
  },

  /**
   * Inverse of fromEuler, returning degrees in [0,360).
   * For R = Rx·Ry·Rz the extraction is exact; at gimbal lock (|y| = 90°) the
   * residual X/Z rotation is folded into X with Z pinned to 0, so a hand-typed
   * 90° stays 90° instead of turning into 359.99°.
   */
  toEuler: (out, q) => {
    const x = q[0], y = q[1], z = q[2], w = q[3];
    const R00 = 1 - 2 * (y * y + z * z);
    const R01 = 2 * (x * y - w * z);
    const R02 = 2 * (x * z + w * y);
    const R10 = 2 * (x * y + w * z);
    const R11 = 1 - 2 * (x * x + z * z);
    const R12 = 2 * (y * z - w * x);
    const R22 = 1 - 2 * (x * x + y * y);

    const sinY = clamp(R02, -1, 1);
    let ex, ey, ez;
    if (Math.abs(sinY) < 0.9999999) {
      ey = Math.asin(sinY);
      ex = Math.atan2(-R12, R22);
      ez = Math.atan2(-R01, R00);
    } else {
      // At |y| = 90° the matrix only constrains cos(x)·[cos z, -sin z], so one
      // angle is redundant: fold everything into Z and pin X to 0. That keeps the
      // round-trip exact instead of drifting by the lost angle.
      ey = sinY > 0 ? Math.PI * 0.5 : -Math.PI * 0.5;
      ex = 0;
      ez = Math.atan2(R10, R11);
    }
    out[0] = mod(deg(ex) + 360, 360);
    out[1] = mod(deg(ey) + 360, 360);
    out[2] = mod(deg(ez) + 360, 360);
    return out;
  },

  /** Shortest-arc rotation taking unit vector `a` to unit vector `b`. */
  fromUnitVectors: (o, a, b) => {
    const d = vec3.dot(a, b);
    if (d > 0.999999) return quat.identity(o);
    if (d < -0.999999) {
      let axis = vec3.cross(vec3.create(), vec3.RIGHT, a);
      if (vec3.lenSq(axis) < 1e-8) axis = vec3.cross(vec3.create(), vec3.UP, a);
      vec3.normalize(axis, axis);
      o[0] = axis[0]; o[1] = axis[1]; o[2] = axis[2]; o[3] = 0;
      return o;
    }
    const c = vec3.cross(_tv0, a, b);
    o[0] = c[0]; o[1] = c[1]; o[2] = c[2]; o[3] = 1 + d;
    quat.normalize(o, o);
    return o;
  },

  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3],

  multiply: (o, a, b) => {
    const ax = a[0], ay = a[1], az = a[2], aw = a[3];
    const bx = b[0], by = b[1], bz = b[2], bw = b[3];
    o[0] = ax * bw + aw * bx + ay * bz - az * by;
    o[1] = ay * bw + aw * by + az * bx - ax * bz;
    o[2] = az * bw + aw * bz + ax * by - ay * bx;
    o[3] = aw * bw - ax * bx - ay * by - az * bz;
    return o;
  },

  normalize: (o, a) => {
    const l = Math.hypot(a[0], a[1], a[2], a[3]) || 1;
    o[0] = a[0] / l; o[1] = a[1] / l; o[2] = a[2] / l; o[3] = a[3] / l; return o;
  },
  conjugate: (o, a) => { o[0] = -a[0]; o[1] = -a[1]; o[2] = -a[2]; o[3] = a[3]; return o; },

  /**
   * Quaternion from the orthonormal upper-left 3×3 of a mat4 (a rotation or view
   * matrix, no scale). Shepperd's method: pick the largest diagonal term so the
   * square root never divides by ~0.
   */
  fromMat4Basis: (o, m) => {
    const m00 = m[0], m01 = m[4], m02 = m[8];
    const m10 = m[1], m11 = m[5], m12 = m[9];
    const m20 = m[2], m21 = m[6], m22 = m[10];
    const trace = m00 + m11 + m22;
    if (trace > 0) {
      const s = 0.5 / Math.sqrt(trace + 1.0);
      o[3] = 0.25 / s;
      o[0] = (m21 - m12) * s;
      o[1] = (m02 - m20) * s;
      o[2] = (m10 - m01) * s;
    } else if (m00 > m11 && m00 > m22) {
      const s = 2.0 * Math.sqrt(1.0 + m00 - m11 - m22);
      o[3] = (m21 - m12) / s;
      o[0] = 0.25 * s;
      o[1] = (m01 + m10) / s;
      o[2] = (m02 + m20) / s;
    } else if (m11 > m22) {
      const s = 2.0 * Math.sqrt(1.0 + m11 - m00 - m22);
      o[3] = (m02 - m20) / s;
      o[0] = (m01 + m10) / s;
      o[1] = 0.25 * s;
      o[2] = (m12 + m21) / s;
    } else {
      const s = 2.0 * Math.sqrt(1.0 + m22 - m00 - m11);
      o[3] = (m10 - m01) / s;
      o[0] = (m02 + m20) / s;
      o[1] = (m12 + m21) / s;
      o[2] = 0.25 * s;
    }
    return quat.normalize(o, o);
  },

  slerp: (o, a, b, t) => {
    let ax = a[0], ay = a[1], az = a[2], aw = a[3];
    let bx = b[0], by = b[1], bz = b[2], bw = b[3];
    let cos = ax * bx + ay * by + az * bz + aw * bw;
    if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
    if (1 - cos > 1e-6) {
      const omega = Math.acos(clamp(cos, -1, 1));
      const s = Math.sin(omega);
      const sa = Math.sin((1 - t) * omega) / s;
      const sb = Math.sin(t * omega) / s;
      o[0] = sa * ax + sb * bx; o[1] = sa * ay + sb * by;
      o[2] = sa * az + sb * bz; o[3] = sa * aw + sb * bw;
    } else {
      o[0] = ax + (bx - ax) * t; o[1] = ay + (by - ay) * t;
      o[2] = az + (bz - az) * t; o[3] = aw + (bw - aw) * t;
    }
    return quat.normalize(o, o);
  }
};

const _tv0 = vec3.create();
const _qx = new Float32Array(4);
const _qy = new Float32Array(4);
const _qz = new Float32Array(4);

/* ------------------------------------------------------------- constants -- */

vec3.RIGHT = vec3.create(1, 0, 0);
vec3.UP = vec3.create(0, 1, 0);
vec3.BACK = vec3.create(0, 0, 1);
vec3.ZERO = vec3.create(0, 0, 0);
vec3.ONE = vec3.create(1, 1, 1);

/* --------------------------------------------------------------- sphere -- */

export const sphere = {
  create: (c = vec3.create(), r = 1) => ({ center: c, radius: r }),
  fromAABB: (out, box) => {
    vec3.add(out.center, box.min, box.max);
    vec3.scale(out.center, out.center, 0.5);
    out.radius = vec3.dist(box.min, box.max) * 0.5;
    return out;
  },
  /** Bounding sphere that survives rotation (center rotates, radius grows by the max axis scale). */
  transform: (out, s, m) => {
    vec3.transformMat4(out.center, s.center, m);
    const sx = vec3.len(vec3.set(_tv1, m[0], m[1], m[2]));
    const sy = vec3.len(vec3.set(_tv1, m[4], m[5], m[6]));
    const sz = vec3.len(vec3.set(_tv1, m[8], m[9], m[10]));
    out.radius = s.radius * Math.max(sx, sy, sz);
    return out;
  },
  contains: (s, p) => vec3.distSq(s.center, p) <= s.radius * s.radius
};
const _tv1 = vec3.create();

/* ------------------------------------------------------------------ aabb -- */

export const aabb = {
  create: () => ({ min: vec3.create(Infinity, Infinity, Infinity), max: vec3.create(-Infinity, -Infinity, -Infinity) }),
  set: (o, min, max) => { vec3.copy(o.min, min); vec3.copy(o.max, max); return o; },
  copy: (o, a) => { vec3.copy(o.min, a.min); vec3.copy(o.max, a.max); return o; },
  isEmpty: (b) => b.min[0] > b.max[0],
  reset: (b) => { vec3.set(b.min, Infinity, Infinity, Infinity); vec3.set(b.max, -Infinity, -Infinity, -Infinity); return b; },
  addPoint: (b, x, y, z) => {
    if (x < b.min[0]) b.min[0] = x; if (y < b.min[1]) b.min[1] = y; if (z < b.min[2]) b.min[2] = z;
    if (x > b.max[0]) b.max[0] = x; if (y > b.max[1]) b.max[1] = y; if (z > b.max[2]) b.max[2] = z;
    return b;
  },
  addPoints: (b, arr, stride = 3, offset = 0) => {
    for (let i = offset; i + 2 < arr.length; i += stride) aabb.addPoint(b, arr[i], arr[i + 1], arr[i + 2]);
    return b;
  },
  addAABB: (b, o) => { aabb.addPoint(b, o.min[0], o.min[1], o.min[2]); aabb.addPoint(b, o.max[0], o.max[1], o.max[2]); return b; },
  expand: (b, v) => { b.min[0] -= v; b.min[1] -= v; b.min[2] -= v; b.max[0] += v; b.max[1] += v; b.max[2] += v; return b; },
  center: (o, b) => { vec3.add(o, b.min, b.max); vec3.scale(o, o, 0.5); return o; },
  size: (o, b) => vec3.sub(o, b.max, b.min),
  /** Enclose an existing AABB — used to grow a shadow cascade's fit volume. */
  includeTransformed: (b, other, m) => {
    if (aabb.isEmpty(other)) return b;
    for (let i = 0; i < 8; i++) {
      _p8[0] = i & 1 ? other.max[0] : other.min[0];
      _p8[1] = i & 2 ? other.max[1] : other.min[1];
      _p8[2] = i & 4 ? other.max[2] : other.min[2];
      vec3.transformMat4(_p8, _p8, m);
      aabb.addPoint(b, _p8[0], _p8[1], _p8[2]);
    }
    return b;
  },
  intersects: (a, b) => a.min[0] <= b.max[0] && a.max[0] >= b.min[0]
    && a.min[1] <= b.max[1] && a.max[1] >= b.min[1]
    && a.min[2] <= b.max[2] && a.max[2] >= b.min[2],
  corners: (out, b) => {
    let i = 0;
    for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) for (let z = 0; z < 2; z++) {
      out[i++] = x ? b.max[0] : b.min[0];
      out[i++] = y ? b.max[1] : b.min[1];
      out[i++] = z ? b.max[2] : b.min[2];
    }
    return out;
  }
};
const _p8 = vec3.create();

/* ----------------------------------------------------------------- plane -- */

export const plane = {
  create: (n = vec3.create(), d = 0) => ({ normal: n, distance: d }),
  fromPoints: (out, a, b, c) => {
    const ab = vec3.sub(_pl0, b, a);
    const ac = vec3.sub(_pl1, c, a);
    vec3.cross(out.normal, ab, ac);
    vec3.normalize(out.normal, out.normal);
    out.distance = vec3.dot(out.normal, a);
    return out;
  },
  normalize: (out) => {
    const l = vec3.len(out.normal) || 1;
    vec3.scale(out.normal, out.normal, 1 / l);
    out.distance /= l;
    return out;
  },
  signedDistance: (p, x) => vec3.dot(p, p.normal) - x.distance
};
const _pl0 = vec3.create(), _pl1 = vec3.create();

/* ------------------------------------------------------------------- ray -- */

export const ray = {
  create: (o = vec3.create(), d = vec3.create(0, 0, -1)) => ({ origin: o, direction: d }),
  copy: (o, r) => { vec3.copy(o.origin, r.origin); vec3.copy(o.direction, r.direction); return o; },
  at: (out, r, t) => vec3.scaleAndAdd(out, r.origin, r.direction, t),
  transform: (out, r, m) => {
    vec3.transformMat4(out.origin, r.origin, m);
    // Direction ignores translation: renormalise to keep t in world units.
    vec3.transformMat4Dir(out.direction, r.direction, m);
    vec3.normalize(out.direction, out.direction);
    return out;
  },

  /** Slab test; returns entry distance or -1. */
  intersectAABB: (r, box) => {
    let tmin = -Infinity, tmax = Infinity;
    for (let i = 0; i < 3; i++) {
      const inv = 1 / (r.direction[i] || 1e-9);
      let t1 = (box.min[i] - r.origin[i]) * inv;
      let t2 = (box.max[i] - r.origin[i]) * inv;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmax < tmin) return -1;
    }
    return tmin >= 0 ? tmin : (tmax >= 0 ? 0 : -1);
  },

  intersectSphere: (r, s) => {
    const oc = vec3.sub(_ry0, r.origin, s.center);
    const b = vec3.dot(oc, r.direction);
    const c = vec3.dot(oc, oc) - s.radius * s.radius;
    const h = b * b - c;
    if (h < 0) return -1;
    const sq = Math.sqrt(h);
    const t0 = -b - sq;
    if (t0 >= 0) return t0;
    const t1 = -b + sq;
    return t1 >= 0 ? t1 : -1;
  },

  intersectPlane: (r, p) => {
    const denom = vec3.dot(r.direction, p.normal);
    if (Math.abs(denom) < 1e-7) return -1;
    const t = (p.distance - vec3.dot(r.origin, p.normal)) / denom;
    return t >= 0 ? t : -1;
  },

  /** Möller–Trumbore, double-sided, returns t or -1. */
  intersectTriangle: (r, v0, v1, v2) => {
    const e1 = vec3.sub(_ry1, v1, v0);
    const e2 = vec3.sub(_ry2, v2, v0);
    const p = vec3.cross(_ry3, r.direction, e2);
    const det = vec3.dot(e1, p);
    if (Math.abs(det) < 1e-10) return -1;
    const inv = 1 / det;
    const t = vec3.sub(_ry4, r.origin, v0);
    const u = vec3.dot(t, p) * inv;
    if (u < -1e-6 || u > 1 + 1e-6) return -1;
    const q = vec3.cross(_ry5, t, e1);
    const v = vec3.dot(r.direction, q) * inv;
    if (v < -1e-6 || u + v > 1 + 1e-6) return -1;
    const dist = vec3.dot(e2, q) * inv;
    return dist >= 0 ? dist : -1;
  }
};
const _ry0 = vec3.create(), _ry1 = vec3.create(), _ry2 = vec3.create();
const _ry3 = vec3.create(), _ry4 = vec3.create(), _ry5 = vec3.create();

/* --------------------------------------------------------------- frustum -- */

export const frustum = {
  create: () => ({ planes: Array.from({ length: 6 }, () => plane.create()) }),
  /** Gribb–Hartmann extraction from a view-projection matrix (rows of the matrix). */
  fromMatrix: (out, m) => {
    const p = out.planes;
    const set = (i, a, b, c, d) => {
      const l = Math.hypot(a, b, c) || 1;
      p[i].normal[0] = a / l; p[i].normal[1] = b / l; p[i].normal[2] = c / l;
      p[i].distance = d / l;
    };
    set(0, m[3] + m[0], m[7] + m[4], m[11] + m[8], m[15] + m[12]);   // left
    set(1, m[3] - m[0], m[7] - m[4], m[11] - m[8], m[15] - m[12]);   // right
    set(2, m[3] + m[1], m[7] + m[5], m[11] + m[9], m[15] + m[13]);   // bottom
    set(3, m[3] - m[1], m[7] - m[5], m[11] - m[9], m[15] - m[13]);   // top
    set(4, m[3] + m[2], m[7] + m[6], m[11] + m[10], m[15] + m[14]);  // near
    set(5, m[3] - m[2], m[7] - m[6], m[11] - m[10], m[15] - m[14]);  // far
    return out;
  },
  containsPoint: (f, p) => {
    for (let i = 0; i < 6; i++) if (vec3.dot(f.planes[i].normal, p) + f.planes[i].distance < 0) return false;
    return true;
  },
  containsSphere: (f, s) => {
    for (let i = 0; i < 6; i++) {
      if (vec3.dot(f.planes[i].normal, s.center) + f.planes[i].distance < -s.radius) return false;
    }
    return true;
  },
  /** Conservative AABB test: choose the "positive vertex" per plane. */
  containsAABB: (f, b) => {
    for (let i = 0; i < 6; i++) {
      const n = f.planes[i].normal, d = f.planes[i].distance;
      const px = n[0] >= 0 ? b.max[0] : b.min[0];
      const py = n[1] >= 0 ? b.max[1] : b.min[1];
      const pz = n[2] >= 0 ? b.max[2] : b.min[2];
      if (n[0] * px + n[1] * py + n[2] * pz + d < 0) return false;
    }
    return true;
  }
};

/* ----------------------------------------------------------------- color -- */

export const color = {
  create: (r = 1, g = 1, b = 1, a = 1) => new Float32Array([r, g, b, a]),
  fromBytes: (r, g, b, a = 255) => new Float32Array([r / 255, g / 255, b / 255, a / 255]),
  fromHex: (hex) => {
    let h = String(hex).trim().replace(/^#/, '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (h.length === 6) h += 'ff';
    const n = parseInt(h, 16) || 0;
    return color.fromBytes((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
  },
  toHex: (c) => {
    const h = (v) => clamp(Math.round(v * 255), 0, 255).toString(16).padStart(2, '0');
    return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
  },
  toBytes: (c) => [clamp(Math.round(c[0] * 255), 0, 255), clamp(Math.round(c[1] * 255), 0, 255), clamp(Math.round(c[2] * 255), 0, 255), clamp(Math.round(c[3] * 255), 0, 255)],

  /** sRGB transfer function → linear. Textures flagged sRGB are decoded on sample;
   *  CPU-side colours must be converted here or lighting energy is wrong. */
  srgbToLinear: (c) => {
    const f = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
    return new Float32Array([f(c[0]), f(c[1]), f(c[2]), c[3] === undefined ? 1 : c[3]]);
  },
  linearToSrgb: (c) => {
    const f = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055);
    return new Float32Array([f(c[0]), f(c[1]), f(c[2]), c[3] === undefined ? 1 : c[3]]);
  },

  hsvToRgb: (h, s, v) => {
    const i = Math.floor(h * 6), f = h * 6 - i;
    const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    switch (mod(i, 6)) {
      case 0: return [v, t, p];
      case 1: return [q, v, p];
      case 2: return [p, v, t];
      case 3: return [p, q, v];
      case 4: return [t, p, v];
      default: return [v, p, q];
    }
  },
  rgbToHsv: (r, g, b) => {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d > 0) {
      if (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
      if (h < 0) h += 1;
    }
    return [h, mx === 0 ? 0 : d / mx, mx];
  },
  /** Rec.709 relative luminance of a linear colour. */
  luminance: (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2],
  /**
   * Cosine-weighted SH projection of an environment, accumulated in `sh` (9 × vec3).
   * World space is Y-up while the Ramamoorthi basis is Z-up, so the direction is
   * permuted here; the shader applies the same permutation to the normal.
   */
  projectSH9: (sh, dir, rgb, weight = 1) => {
    const x = dir[0], y = dir[2], z = dir[1];
    const Y = [
      0.282095,
      0.488603 * y, 0.488603 * z, 0.488603 * x,
      1.092548 * x * y, 1.092548 * y * z,
      0.315392 * (3 * z * z - 1),
      1.092548 * x * z,
      0.546274 * (x * x - y * y)
    ];
    for (let i = 0; i < 9; i++) {
      sh[i * 3] += rgb[0] * Y[i] * weight;
      sh[i * 3 + 1] += rgb[1] * Y[i] * weight;
      sh[i * 3 + 2] += rgb[2] * Y[i] * weight;
    }
    return sh;
  }
};
