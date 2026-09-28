/**
 * Adapter interrogation.
 *
 * The Wikipedia article's "Implémentations" and "Limitations" sections are, in
 * engineering terms, exactly this file: WebGL is a *mask* over the underlying
 * OpenGL ES implementation, and which features survive the mask is decided by
 * (a) the context version, (b) the WebGL extension registry, (c) driver limits
 * and (d) whether the user agent is a block-listed / software device.
 *
 * Every decision the renderer makes is derived from the object produced here,
 * never from `if (isChrome)` sniffing.
 */

const GL = (name) => {
  if (typeof WebGL2RenderingContext !== 'undefined' && name in WebGL2RenderingContext.prototype) {
    return { is: true, WebGL2RenderingContext, value: WebGL2RenderingContext[name] };
  }
  if (typeof WebGLRenderingContext !== 'undefined' && name in WebGLRenderingContext.prototype) {
    return { is: true, WebGLRenderingContext, value: WebGLRenderingContext[name] };
  }
  return { is: false, value: undefined };
};

/** WebGL 1 extensions that materially change what we can do. */
export const EXT_V1 = {
  // > 65535 vertex/instance ids per draw without splitting the buffer.
  elementIndexUint: 'OES_element_index_uint',
  // Needed by dFdx/dFdy for normal mapping and SSAO on ES 1.00.
  standardDerivatives: 'OES_standard_derivatives',
  // Multi-target rendering — needed by G-buffer style passes.
  drawBuffers: 'WEBGL_draw_buffers',
  // Float/half-float render targets (HDR lighting, bloom, IBL convolution).
  colorBufferFloat: 'WEBGL_color_buffer_float',
  colorBufferHalfFloat: 'EXT_color_buffer_half_float',
  // Depth texture read-back (SSAO, soft particles, screen-space effects).
  depthTexture: 'WEBGL_depth_texture',
  // sRGB framebuffers. Textures use sRGB8_ALPHA8 on ES 3.0 / SRGB_EXT on ES 2.0.
  sRGB: 'EXT_sRGB',
  // Hardware PCF + slope-scaled bias: removes most shadow acne for free.
  depthTextureFloat: 'WEBGL_depth_texture',
  anisotropic: 'EXT_texture_filter_anisotropic',
  // Compressed texture containers (ASTC/ETC/BC) — accepted in uploads.
  compressedTextureS3TC: 'WEBGL_compressed_texture_s3tc',
  compressedTextureETC: 'WEBGL_compressed_texture_etc',
  compressedTexturePVRTC: 'WEBGL_compressed_texture_pvrtc',
  // 3D-ish: ESSL 1.00 has no sampler3D, but layered cube arrays exist here.
  textureCubeArray: 'WEBGL_compressed_texture_astc',
  // Extension: instanced drawing (ANGLE). The canonical ES 2.0 batching path.
  instancedArrays: 'ANGLE_instanced_arrays',
  instancedArraysWebGL2: undefined,
  timerQuery: 'EXT_disjoint_timer_query_webgl2',
  blendMinMax: 'EXT_blend_minmax',
  multiDraw: 'WEBGL_multi_draw'
};

/** WebGL 2 (ES 3.0) additions that are core, listed for the report only. */
export const CORE_V2_FEATURES = [
  'instanced rendering (drawElementsInstanced)',
  'vertex array objects (VAO)',
  'uniform buffer objects (UBO)',
  'sampler2DArray / sampler3D / samplerCube (shadow samplers, volumes, arrays)',
  'integer attributes & types (gl.vertexAttribIPointer)',
  'framebuffer completeness + MRT via drawBuffers natively',
  'transform feedback (GPU particle / skinning state)',
  'texture LOD clamp, seamless cube filtering',
  'non-power-of-two mipmaps & wrap (full ES 2.0 table)',
  'in/out function parameter qualifiers',
  'gl_VertexID, gl_InstanceID, gl_FragDepth, gl_FrontFacing',
  'blend equation separation (EXT_blend_equation_separate core)'
];

export function createContext(canvas, opts = {}) {
  const attempts = [
    {
      label: 'webgl2 · high-performance',
      attrs: {
        alpha: false, depth: true, stencil: false, antialias: opts.antialias !== false,
        premultipliedAlpha: false, preserveDrawingBuffer: !!opts.preserveDrawingBuffer,
        powerPreference: 'high-performance', failIfMajorPerformanceCaveat: false,
        desynchronized: !!opts.desynchronized
      },
      want: 'webgl2'
    },
    {
      label: 'webgl1 · high-performance',
      attrs: {
        alpha: false, depth: true, stencil: false, antialias: opts.antialias !== false,
        premultipliedAlpha: false, preserveDrawingBuffer: !!opts.preserveDrawingBuffer,
        powerPreference: 'high-performance', failIfMajorPerformanceCaveat: false
      },
      want: 'webgl1'
    },
    {
      label: 'webgl1 · conservative (no MSAA)',
      attrs: {
        alpha: false, depth: true, stencil: false, antialias: false,
        premultipliedAlpha: false, preserveDrawingBuffer: !!opts.preserveDrawingBuffer,
        powerPreference: 'low-power', failIfMajorPerformanceCaveat: false
      },
      want: 'webgl1'
    },
    {
      label: 'webgl1 · software fallback',
      attrs: {
        alpha: false, depth: true, stencil: false, antialias: false,
        premultipliedAlpha: false, preserveDrawingBuffer: true,
        powerPreference: 'default', failIfMajorPerformanceCaveat: false
      },
      want: 'webgl1'
    }
  ];

  const errors = [];
  for (const attempt of attempts) {
    try {
      const gl = attempt.want === 'webgl2'
        ? canvas.getContext('webgl2', attempt.attrs)
        : canvas.getContext('webgl', attempt.attrs) || canvas.getContext('experimental-webgl', attempt.attrs);
      if (gl) return { gl, label: attempt.label, errors, wanted: attempt.want };
      errors.push(`${attempt.label}: context unavailable`);
    } catch (e) {
      errors.push(`${attempt.label}: ${e.message}`);
    }
  }
  return { gl: null, label: null, errors, wanted: null };
}

/** Full, JSON-able capability report — surfaced in the UI and the docs. */
export function probeCapabilities(gl) {
  if (!gl) return null;
  const isGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;

  const ext = {};
  const requested = isGL2
    ? {
      colorBufferFloat: 'EXT_color_buffer_float',
      floatBlend: 'EXT_float_blend',
      textureFilterAnisotropic: 'EXT_texture_filter_anisotropic',
      textureCompressionBptc: 'EXT_texture_compression_bptc',
      textureCompressionAstc: 'WEBGL_compressed_texture_astc',
      textureCompressionEtc: 'WEBGL_compressed_texture_etc',
      debugRendererInfo: 'WEBGL_debug_renderer_info',
      timerQuery: 'EXT_disjoint_timer_query_webgl2',
      shaderTextureLod: 'EXT_shader_texture_lod',
      floatLinear: 'OES_texture_float_linear',
      provokVertex: 'WEBGL_provoking_vertex'
    }
    : {
      elementIndexUint: 'OES_element_index_uint',
      standardDerivatives: 'OES_standard_derivatives',
      drawBuffers: 'WEBGL_draw_buffers',
      depthTexture: 'WEBGL_depth_texture',
      colorBufferHalfFloat: 'EXT_color_buffer_half_float',
      colorBufferFloat: 'WEBGL_color_buffer_float',
      sRGB: 'EXT_sRGB',
      anisotropic: 'EXT_texture_filter_anisotropic',
      instancedArrays: 'ANGLE_instanced_arrays',
      multiDraw: 'WEBGL_multi_draw',
      timerQuery: 'EXT_disjoint_timer_query_webgl2',
      blendMinMax: 'EXT_blend_minmax',
      textureCubeArray: 'WEBGL_compressed_texture_astc',
      compressedTextureS3TC: 'WEBGL_compressed_texture_s3tc',
      compressedTextureETC: 'WEBGL_compressed_texture_etc',
      compressedTexturePVRTC: 'WEBGL_compressed_texture_pvrtc',
      halfFloatLinear: 'OES_texture_half_float_linear',
      floatLinear: 'OES_texture_float_linear',
      debugRendererInfo: 'WEBGL_debug_renderer_info'
    };

  for (const [key, name] of Object.entries(requested)) {
    if (!name) continue;
    try { ext[key] = gl.getExtension(name) || null; } catch { ext[key] = null; }
  }

  let vendor = 'unknown', renderer = 'unknown', unmaskedVendor = null, unmaskedRenderer = null;
  try {
    renderer = gl.getParameter(gl.RENDERER) || 'unknown';
    vendor = gl.getParameter(gl.VENDOR) || 'unknown';
  } catch { /* some privacy modes block this */ }
  if (ext.debugRendererInfo) {
    try {
      const dbg = ext.debugRendererInfo;
      unmaskedVendor = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL);
      unmaskedRenderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
      if (unmaskedRenderer) renderer = unmaskedRenderer;
    } catch { /* blocked */ }
  }

  const rs = (name) => { const f = GL(name); return f.is ? f.value : 0; };
  const limits = {
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    maxCubeMapTextureSize: gl.getParameter(gl.MAX_CUBE_MAP_TEXTURE_SIZE),
    maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
    maxTextureImageUnits: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS),
    maxVertexTextureImageUnits: gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS),
    maxCombinedTextureImageUnits: gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS),
    maxVertexAttribs: gl.getParameter(gl.MAX_VERTEX_ATTRIBS),
    maxVertexUniformVectors: gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS),
    maxFragmentUniformVectors: gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS),
    maxVaryingVectors: gl.getParameter(gl.MAX_VARYING_VECTORS),
    maxViewportDims: Array.from(gl.getParameter(gl.MAX_VIEWPORT_DIMS) || [0, 0]),
    aliasedLineWidthRange: Array.from(gl.getParameter(gl.ALIASED_LINE_WIDTH_RANGE) || [1, 1]),
    maxAnisotropy: ext.anisotropic ? gl.getParameter(ext.anisotropic.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : 1,
    maxSamples: isGL2 ? gl.getParameter(gl.MAX_SAMPLES) : 0,
    maxDrawBuffers: isGL2 ? gl.getParameter(gl.MAX_DRAW_BUFFERS) : (ext.drawBuffers ? gl.getParameter(ext.drawBuffers.MAX_DRAW_BUFFERS_WEBGL) : 1),
    maxTextureUnits: isGL2 ? gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS) : gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS),
    maxAnisotropyExt: !!ext.anisotropic,
    halfFloatLinear: isGL2 || !!ext.halfFloatLinear || !!ext.floatLinear,
    indexUint: isGL2 || !!ext.elementIndexUint,
    instancing: isGL2 || !!ext.instancedArrays,
    vao: isGL2,
    ubo: isGL2,
    sampler3D: isGL2,
    samplerArray: isGL2,
    transformFeedback: isGL2,
    MRT: isGL2 || !!ext.drawBuffers,
    derivatives: isGL2 || !!ext.standardDerivatives,
    colorBufferFloat: isGL2 || !!ext.colorBufferFloat || !!ext.colorBufferHalfFloat,
    depthTexture: isGL2 || !!ext.depthTexture,
    sRGBTexture: isGL2 || !!ext.sRGB,
    geometryShader: false, // never in WebGL 1 *or* 2 — see docs/WEBGL-ARTICLE-MAP.md
    computeShader: false,
    tesselationShader: false,
    timerQuery: !!ext.timerQuery
  };

  // ES 1.00 does not guarantee highp in fragment shaders; many mobile parts
  // only offer mediump. Substituting silently is a classic source of banding.
  const fragHighp = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT)?.precision ?? 0;
  const fragMediump = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.MEDIUM_FLOAT)?.precision ?? 0;
  const vertHighp = gl.getShaderPrecisionFormat(gl.VERTEX_SHADER, gl.HIGH_FLOAT)?.precision ?? 0;
  limits.precision = {
    fragmentHigh: fragHighp, fragmentMedium: fragMediump, vertexHigh: vertHighp,
    preferredFragment: fragHighp > 0 ? 'highp' : fragMediump > 0 ? 'mediump' : 'lowp'
  };

  const software = /swiftshader|llvmpipe|softwarerasterizer|software|mesa offscreen|basic render/i
    .test(`${renderer} ${unmaskedRenderer || ''}`);

  const tier = decideTier({ isGL2, limits, software, renderer });

  return {
    isWebGL2: isGL2,
    version: gl.getParameter(gl.VERSION),
    shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
    vendor, renderer, unmaskedVendor, unmaskedRenderer,
    glslNeutral: isGL2 ? '#version 300 es' : '#version 100',
    extensions: ext,
    extensionNames: Object.entries(requested)
      .filter(([, n]) => n)
      .map(([k, n]) => ({ key: k, name: n, present: !!ext[k] })),
    limits,
    software,
    tier,
    webgpu: typeof navigator !== 'undefined' && !!navigator.gpu,
    webgpuAdapter: null,
    contextAttributes: gl.getContextAttributes(),
    loseContext: (() => { try { return gl.getExtension('WEBGL_lose_context') || null; } catch { return null; } })()
  };
}

function decideTier({ isGL2, limits, software, renderer }) {
  const score =
    (isGL2 ? 40 : 0) +
    (limits.colorBufferFloat ? 12 : 0) +
    (limits.instancing ? 10 : 0) +
    (limits.indexUint ? 8 : 0) +
    (limits.depthTexture ? 8 : 0) +
    (limits.derivatives ? 8 : 0) +
    (limits.maxTextureSize >= 8192 ? 8 : limits.maxTextureSize >= 4096 ? 4 : 0) +
    (limits.maxAnisotropy > 4 ? 4 : 0) +
    (/apple|nvidia|radeon|geforce|rtx|radeon rx|arc a/i.test(renderer) ? 12 : 0) -
    (software ? 45 : 0);

  if (software) return { name: 'software', score, budget: { shadowMapSize: 1024, msaa: 0, maxDPR: 1, bloom: false, ssao: false, ibl: false, maxLights: 8 } };
  if (score >= 70) return { name: 'ultra', score, budget: { shadowMapSize: 2048, msaa: 4, maxDPR: 2, bloom: true, ssao: true, ibl: true, maxLights: 32 } };
  if (score >= 50) return { name: 'high', score, budget: { shadowMapSize: 2048, msaa: 4, maxDPR: 2, bloom: true, ssao: true, ibl: true, maxLights: 24 } };
  if (score >= 32) return { name: 'medium', score, budget: { shadowMapSize: 1024, msaa: 2, maxDPR: 1.5, bloom: true, ssao: false, ibl: true, maxLights: 16 } };
  return { name: 'low', score, budget: { shadowMapSize: 1024, msaa: 0, maxDPR: 1, bloom: false, ssao: false, ibl: false, maxLights: 8 } };
}

/** Feature → capability map powering the UI badges ("supported / emulated / unavailable"). */
export function featureMap(caps) {
  if (!caps) return {};
  const L = caps.limits;
  return {
    'WebGL 2.0 (ES 3.00)': caps.isWebGL2 ? 'core' : 'fallback:webgl1',
    'Instanced rendering': L.instancing ? 'core' : 'unavailable',
    '32-bit indices': L.indexUint ? 'core' : 'unavailable',
    'Geometry shader': 'unavailable:by-spec',
    'Compute shader': 'unavailable:by-spec',
    'Transform feedback': L.transformFeedback ? 'core' : 'unavailable',
    'Uniform buffer objects': L.ubo ? 'core' : 'unavailable',
    'sampler3D (3D textures)': L.sampler3D ? 'core' : 'emulated:atlas',
    'sampler2DArray': L.samplerArray ? 'core' : 'unavailable',
    'Multiple render targets': L.MRT ? 'core' : 'unavailable',
    'Depth textures': L.depthTexture ? 'core' : 'unavailable',
    'Float render targets (HDR)': L.colorBufferFloat ? 'core' : 'emulated:ldr',
    'sRGB textures': L.sRGBTexture ? 'core' : 'emulated:gamma-math',
    'screen-space derivatives': L.derivatives ? 'core' : 'unavailable',
    'Anisotropic filtering': L.maxAnisotropy > 1 ? 'core' : 'unavailable',
    'GPU timer queries': L.timerQuery ? 'core' : 'unavailable',
    'Object picking': 'emulated:id-buffer',
    'WebGPU': caps.webgpu ? 'available:parallel-backend' : 'unavailable'
  };
}
