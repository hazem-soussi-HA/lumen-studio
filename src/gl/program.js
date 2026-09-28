/**
 * Shader tool-chain.
 *
 * Shaders in this project are authored once in a neutral dialect and compiled to
 * either GLSL ES 1.00 (WebGL 1 / OpenGL ES 2.0) or GLSL ES 3.00 (WebGL 2 /
 * OpenGL ES 3.0):
 *
 *   neutral  →  ES 3.00                      ES 1.00
 *   attribute  (vertex)  → in                attribute
 *   varying     (vertex)  → out               varying
 *   varying     (fragment)→ in                varying
 *   gl_FragColor         → pc_fragColor       gl_FragColor
 *   texture2D(s,uv)      → texture(s,uv)      texture2D(s,uv)
 *   textureCube(s,d)     → texture(s,d)       textureCube(s,d)
 *
 * Both dialects must satisfy the strictest common denominator so a single source
 * tree runs on a 2011 phone and a 2026 workstation: constant loop bounds, no
 * geometry/compute stages, no bitwise operators, no dynamic sampler indexing,
 * explicit precision.
 */

const CHUNKS = new Map();

/** Register a reusable GLSL chunk, expanded by `#include <name>`. */
export function chunk(name, source) {
  CHUNKS.set(name, source);
  return source;
}

export function hasChunk(name) { return CHUNKS.has(name); }
export function chunkNames() { return [...CHUNKS.keys()]; }

const MAX_INCLUDE_DEPTH = 12;

/* ------------------------------------------------------------ transpile -- */

export function transpile(source, opts) {
  const {
    stage = 'fragment',
    es3 = false,
    defines = null,
    precision = { vertex: 'highp', fragment: 'mediump' },
    derivatives = false,
    name = 'shader'
  } = opts;

  let src = String(source).replace(/^\uFEFF/, '');
  src = expandIncludes(src, name);

  const out = [];
  const fragOut = es3 ? 'pc_fragColor' : 'gl_FragColor';

  for (const raw of src.split('\n')) {
    const line = raw;
    const trimmed = line.trim();

    // A `#version` in the source is always wrong here — we own the header.
    if (trimmed.startsWith('#version')) continue;

    // Comment-only lines: never rewrite, they are prose.
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) { out.push(line); continue; }

    let l = line;

    if (es3) {
      if (stage === 'vertex') l = l.replace(/\battribute\b/g, 'in');
      l = l.replace(/\bvarying\b/g, stage === 'vertex' ? 'out' : 'in');
      l = l.replace(/\btexture2DLodEXT\s*\(/g, 'textureLod(');
      l = l.replace(/\btexture2DProjLodEXT\s*\(/g, 'textureProjLod(');
      l = l.replace(/\btexture2DProj\s*\(/g, 'textureProj(');
      l = l.replace(/\btexture2D\s*\(/g, 'texture(');
      l = l.replace(/\btextureCubeLodEXT\s*\(/g, 'textureLod(');
      l = l.replace(/\btextureCube\s*\(/g, 'texture(');
      l = l.replace(/\bgl_FragColor\b/g, fragOut);
      l = l.replace(/\bgl_FragDepthEXT\b/g, 'gl_FragDepth');
      l = l.replace(/\bshadow2DCube\s*\(/g, 'texture(');
    } else {
      // ES 1.00 has no gl_FragData[]; MRT paths are compiled behind a define.
      l = l.replace(/\bgl_FragData\s*\[\s*(\w+)\s*\]/g, 'pc_fragData[$1]');
    }

    out.push(l);
  }

  // GLSL ES 3.00 has no default precision for `float` in fragment shaders, and
  // ES 1.00 only guarantees `mediump` there — the qualifiers must be explicit.
  const q = precision[stage === 'vertex' ? 'vertex' : 'fragment'];
  const header = [
    `#version ${es3 ? '300 es' : '100'}`,
    `precision ${q} float;`,
    es3 ? `precision ${q} int;` : null
  ].filter(Boolean);

  if (!es3 && stage === 'fragment' && derivatives) {
    // dFdx/dFdy live behind an extension on ES 1.00.
    header.push('#extension GL_OES_standard_derivatives : enable');
  }
  if (!es3 && stage === 'fragment' && defines?.PCL_MRT) {
    header.push('#extension GL_EXT_draw_buffers : require');
  }
  if (defines) {
    for (const [k, v] of Object.entries(defines)) {
      if (v === false || v === undefined || v === null) continue;
      header.push(v === true ? `#define ${k} 1` : `#define ${k} ${v}`);
    }
  }
  if (es3 && stage === 'fragment' && defines?.PCL_MRT) {
    header.push('layout(location = 0) out vec4 pc_fragData[1];\nout vec4 pc_fragColor;');
  } else if (es3 && stage === 'fragment') {
    header.push('out vec4 pc_fragColor;');
  } else if (stage === 'fragment' && defines?.PCL_MRT) {
    header.push('#extension GL_EXT_draw_buffers : require', 'vec4 pc_fragData[1];');
  }

  return header.join('\n') + '\n' + out.join('\n');
}

function expandIncludes(src, name, depth = 0) {
  if (depth > MAX_INCLUDE_DEPTH) throw new Error(`#include depth exceeded in ${name}`);
  return src.replace(/^[ \t]*#include[ \t]+<([\w.-]+)>[ \t]*$/gm, (_, key) => {
    const c = CHUNKS.get(key);
    if (c === undefined) throw new Error(`unknown GLSL chunk "<${key}>" (from ${name})`);
    return expandIncludes(c, `${name}:${key}`, depth + 1);
  });
}

/* ------------------------------------------------------------- compile -- */

function annotate(source, log) {
  const lines = source.split('\n');
  const bad = new Set();
  for (const m of log.matchAll(/ERROR:\s*\d+:(\d+)/g)) bad.add(parseInt(m[1], 10));
  return lines
    .map((l, i) => `${bad.has(i + 1) ? '>>' : '  '}${String(i + 1).padStart(4)} | ${l}`)
    .filter((_, i) => bad.size === 0 || [...bad].some((b) => Math.abs(b - (i + 1)) < 6))
    .join('\n');
}

export function compileShader(gl, type, source, label) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) || '(no log)';
    gl.deleteShader(sh);
    const err = new Error(`[${label}] ${type === gl.VERTEX_SHADER ? 'vertex' : 'fragment'} shader failed:\n${log}\n${annotate(source, log)}`);
    err.compileLog = log;
    err.source = source;
    err.label = label;
    throw err;
  }
  return sh;
}

/* ------------------------------------------------------------- program -- */

const TYPE_SETTERS = new Map();
function initSetters(gl) {
  if (TYPE_SETTERS.size) return;
  const add = (t, fn) => TYPE_SETTERS.set(t, fn);
  add(gl.FLOAT, (gl2, l, v) => (typeof v === 'number' ? gl2.uniform1f(l, v) : gl2.uniform1fv(l, v)));
  // Uniform *arrays* (uLightPos[8], uSH[9], …) arrive as one long typed array,
  // so the vector setters must dispatch on the total component count, not on 3/4.
  add(gl.FLOAT_VEC2, (gl2, l, v) => (v.length === 2 ? gl2.uniform2fv(l, v) : gl2.uniform2f(l, v[0], v[1])));
  add(gl.FLOAT_VEC3, (gl2, l, v) => (v.length % 3 === 0 ? gl2.uniform3fv(l, v) : gl2.uniform3f(l, v[0], v[1], v[2])));
  add(gl.FLOAT_VEC4, (gl2, l, v) => (v.length % 4 === 0
    ? gl2.uniform4fv(l, v)
    : gl2.uniform4f(l, v[0], v[1], v[2], v[3])));
  add(gl.INT, (gl2, l, v) => (typeof v === 'number' ? gl2.uniform1i(l, v | 0) : gl2.uniform1iv(l, v)));
  add(gl.BOOL, (gl2, l, v) => (typeof v === 'boolean' ? gl2.uniform1i(l, v ? 1 : 0) : gl2.uniform1i(l, v[0] ? 1 : 0)));
  add(gl.INT_VEC2, (gl2, l, v) => gl2.uniform2iv(l, v));
  add(gl.INT_VEC3, (gl2, l, v) => gl2.uniform3iv(l, v));
  add(gl.INT_VEC4, (gl2, l, v) => gl2.uniform4iv(l, v));
  add(gl.FLOAT_MAT3, (gl2, l, v) => gl2.uniformMatrix3fv(l, false, v));
  add(gl.FLOAT_MAT4, (gl2, l, v) => gl2.uniformMatrix4fv(l, false, v));
  add(gl.SAMPLER_2D, (gl2, l, v) => gl2.uniform1i(l, v | 0));
  add(gl.SAMPLER_CUBE, (gl2, l, v) => gl2.uniform1i(l, v | 0));
  add(gl.SAMPLER_3D, (gl2, l, v) => gl2.uniform1i(l, v | 0));
  add(gl.SAMPLER_2D_SHADOW, (gl2, l, v) => gl2.uniform1i(l, v | 0));
  add(gl.SAMPLER_2D_ARRAY, (gl2, l, v) => gl2.uniform1i(l, v | 0));
}

export class Program {
  /**
   * @param {GLContext} ctx
   * @param {{name:string, vertex:string, fragment:string, defines?:object}} desc
   */
  constructor(ctx, desc) {
    this.kind = 'program';
    this.ctx = ctx;
    this.gl = ctx.gl;
    this.name = desc.name || 'program';
    // Accept both `vertex`/`fragment` and `vertexSource`/`fragmentSource` keys:
    // descriptors read better with the short form, the cache with the long one.
    this.vertexSource = desc.vertexSource ?? desc.vertex;
    this.fragmentSource = desc.fragmentSource ?? desc.fragment;
    if (typeof this.vertexSource !== 'string' || typeof this.fragmentSource !== 'string') {
      throw new Error(`[${this.name}] program descriptor is missing shader source`);
    }
    this.defines = desc.defines || null;
    this.usesDerivatives = !!desc.usesDerivatives;
    this.attributes = new Map();
    this.uniforms = new Map();
    this._handle = null;
    this._createGL();
    ctx.register(this);
  }

  _createGL() {
    const { gl, caps } = this.ctx;
    initSetters(gl);
    const opts = {
      stage: null,
      es3: caps.isWebGL2,
      defines: this.defines,
      // GLSL ES 1.00 does not guarantee `highp` in fragment shaders — the
      // driver reports the real precision and we inject the highest it honours.
      precision: precisionQualifiers(caps.limits.precision),
      derivatives: this.usesDerivatives,
      name: this.name
    };
    const vsSrc = transpile(this.vertexSource, { ...opts, stage: 'vertex' });
    const fsSrc = transpile(this.fragmentSource, { ...opts, stage: 'fragment' });

    const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc, `${this.name}:vs`);
    let fs;
    try {
      fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc, `${this.name}:fs`);
    } catch (e) {
      gl.deleteShader(vs);
      throw e;
    }
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(p);
      gl.deleteProgram(p);
      const err = new Error(`[${this.name}] link failed:\n${log}`);
      err.compileLog = log;
      err.vertexSource = vsSrc;
      err.fragmentSource = fsSrc;
      throw err;
    }
    this._handle = p;
    this._reflect();
  }

  _reflect() {
    const gl = this.gl;
    this.attributes.clear();
    this.uniforms.clear();

    const na = gl.getProgramParameter(this._handle, gl.ACTIVE_ATTRIBUTES);
    for (let i = 0; i < na; i++) {
      const info = gl.getActiveAttrib(this._handle, i);
      if (!info) continue;
      const loc = gl.getAttribLocation(this._handle, info.name);
      if (loc < 0) continue;
      this.attributes.set(baseName(info.name), { loc, size: info.size, type: info.type });
    }

    const nu = gl.getProgramParameter(this._handle, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < nu; i++) {
      const info = gl.getActiveUniform(this._handle, i);
      if (!info) continue;
      const loc = gl.getUniformLocation(this._handle, info.name);
      if (loc === null) continue;
      this.uniforms.set(baseName(info.name), { loc, size: info.size, type: info.type, name: info.name });
    }
  }

  _onContextLost() { this._handle = null; this.attributes.clear(); this.uniforms.clear(); }
  _onContextRestored() { this._createGL(); }

  get handle() { return this._handle; }

  bind() {
    this.ctx.useProgram(this._handle);
    return this;
  }

  has(name) { return this.uniforms.has(name); }
  hasAttribute(name) { return this.attributes.has(name); }

  /**
   * Type-dispatching uniform upload. Unknown names are ignored (dead code
   * eliminated by the compiler) but counted so stale code is visible.
   */
  set(name, value) {
    const u = this.uniforms.get(name);
    if (!u) { this._miss = (this._miss || 0) + 1; return this; }
    const setter = TYPE_SETTERS.get(u.type);
    if (!setter) { this._miss = (this._miss || 0) + 1; return this; }
    setter(this.gl, u.loc, value);
    return this;
  }

  setAll(obj) {
    for (const k in obj) this.set(k, obj[k]);
    return this;
  }

  /** Bind a texture to a unit and point the sampler uniform at it in one step. */
  setTexture(name, texture, unit) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(texture.target, texture ? texture.handle : null);
    this.set(name, unit);
    return this;
  }

  destroy() {
    if (this._handle) { this.gl.deleteProgram(this._handle); this._handle = null; }
    this.ctx.unregister(this);
  }
}

function baseName(n) { return n.endsWith('[0]') ? n.slice(0, -3) : n; }

/**
 * Turn a precision *report* into the qualifiers to inject. `highp` is preferred
 * but silently downgraded: many mobile ES 2.0 parts only offer mediump, and
 * writing `highp` there produces either a link error or quiet banding.
 */
function precisionQualifiers(report) {
  const vertex = (report?.vertexHigh ?? 0) > 0 ? 'highp' : (report?.fragmentMedium ?? 0) > 0 ? 'mediump' : 'lowp';
  const fragment = (report?.fragmentHigh ?? 0) > 0 ? 'highp'
    : (report?.fragmentMedium ?? 0) > 0 ? 'mediump'
      : 'lowp';
  return { vertex, fragment };
}

/**
 * Compiles program variants lazily from a descriptor + define set, then reuses
 * them. One descriptor, many specialisations (e.g. PBR with/without IBL).
 */
export class ProgramCache {
  constructor(ctx, log) {
    this.ctx = ctx;
    this.log = log;
    this.map = new Map();
    this.misses = 0;
  }

  get(desc, defines = {}) {
    const key = `${desc.name}|${stableDefines(defines)}`;
    let p = this.map.get(key);
    if (p) return p;
    const definesClean = {};
    for (const k in defines) if (defines[k] !== false && defines[k] !== undefined && defines[k] !== null) definesClean[k] = defines[k];
    try {
      p = new Program(this.ctx, {
        name: `${desc.name}${Object.keys(definesClean).length ? `[${stableDefines(definesClean)}]` : ''}`,
        vertexSource: desc.vertex,
        fragmentSource: desc.fragment,
        defines: definesClean,
        usesDerivatives: desc.usesDerivatives
      });
    } catch (e) {
      this.misses++;
      this.log?.error(`program variant failed: ${key}`, e.message);
      throw e;
    }
    this.map.set(key, p);
    return p;
  }

  clear() {
    for (const p of this.map.values()) p.destroy();
    this.map.clear();
  }

  get size() { return this.map.size; }
}

function stableDefines(d) {
  return Object.keys(d).sort().filter((k) => d[k] !== false).map((k) => `${k}=${d[k] === true ? 1 : d[k]}`).join(',');
}
