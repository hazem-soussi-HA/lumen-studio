/**
 * Utility passes: grid, unlit lines/solids, object picking (the id buffer that
 * replaces the selection buffer WebGL does not have), screen-space effects and
 * the post-processing chain.
 */

// Registers the reusable GLSL chunks referenced by `#include <…>` below.
import './common.js';

import { FILTER } from '../texture.js';

/* --------------------------------------------------------------- grid --- */

export const gridVertexShader = /* glsl */`
attribute vec3 aPosition;
uniform mat4 uViewProjection;
uniform mat4 uModel;
uniform float uGridExtent;
varying vec3 vWorld;
void main() {
  vec4 w = uModel * vec4(aPosition * uGridExtent, 1.0);
  vWorld = w.xyz;
  gl_Position = uViewProjection * w;
}
`;

export const gridFragmentShader = /* glsl */`
#include <pc_common>
uniform vec3 uCameraPosition;
uniform vec3 uAxisColorX;
uniform vec3 uAxisColorZ;
uniform vec3 uMinorColor;
uniform float uCell;
uniform float uMajorEvery;
uniform float uFadeStart;
uniform float uFadeEnd;
uniform float uOpacity;
uniform float uPlaneY;
varying vec3 vWorld;

// Analytic anti-aliasing of a periodic line: distance to the nearest cell edge
// measured in pixels via screen-space derivatives.
float pcGridLine(vec2 p, float cell, float widthPx) {
#ifdef PC_GRID_AA
  vec2 g = abs(fract(p / cell - 0.5) - 0.5) * cell;
  vec2 fw = fwidth(p) * widthPx;
  vec2 l = smoothstep(vec2(0.0), fw, g);
  return 1.0 - min(l.x, l.y);
#else
  vec2 g = abs(fract(p / cell - 0.5) - 0.5) * cell;
  return 1.0 - step(g.x, cell * 0.02) - step(g.y, cell * 0.02);
#endif
}

void main() {
  vec2 p = vWorld.xz;
  float dist = length(vWorld.xz - uCameraPosition.xz);

  float minor = pcGridLine(p, uCell, 1.0);
  float major = pcGridLine(p, uCell * uMajorEvery, 1.4);

  // Axes get their own colour and always win over the cell lines.
  float ax = 1.0 - smoothstep(0.0, uCell * 0.03, abs(vWorld.x));
  float az = 1.0 - smoothstep(0.0, uCell * 0.03, abs(vWorld.z));

  float fade = 1.0 - pcSaturate((dist - uFadeStart) / max(uFadeEnd - uFadeStart, EPS));
  // Screen-space derivative LOD: keep the on-screen line density roughly constant.
  float lod = 1.0;
#ifdef PC_GRID_AA
  float px = max(fwidth(p.x), fwidth(p.y));
  lod = pcSaturate(px / uCell);
#endif
  float minorFade = fade * (1.0 - lod);

  float aMinor = minor * minorFade * 0.5;
  float aMajor = major * fade * 0.8;
  vec3 outCol = mix(uMinorColor, uMinorColor * 1.45, aMajor);
  float outA = max(aMinor, aMajor);

  outCol = mix(outCol, uAxisColorX, ax);
  outA = max(outA, ax * fade);
  outCol = mix(outCol, uAxisColorZ, az);
  outA = max(outA, az * fade);

  // Horizontal plane only: fade with height so the grid never shows on a slope.
  outA *= pcSaturate(1.0 - abs(vWorld.y - uPlaneY) * 4.0);
  float alpha = pcSaturate(outA) * uOpacity;
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(outCol, alpha);
}
`;

/* -------------------------------------------------------------- unlit --- */

export const unlitVertexShader = /* glsl */`
attribute vec3 aPosition;
attribute vec4 aColor;
uniform mat4 uViewProjection;
uniform mat4 uModel;
uniform mat4 uView;
varying vec4 vColor;
varying vec3 vWorld;
varying float vDepth;
void main() {
  vec4 w = uModel * vec4(aPosition, 1.0);
  vWorld = w.xyz;
  vColor = aColor;
  vDepth = -(uView * w).z;
  gl_Position = uViewProjection * w;
}
`;

export const unlitFragmentShader = /* glsl */`
#include <pc_common>
uniform float uFogAmount;
varying vec4 vColor;
varying vec3 vWorld;
varying float vDepth;
void main() {
  vec3 c = vColor.rgb;
  if (uFogAmount > 0.0) {
    c = mix(c, vec3(0.5), pcSaturate(1.0 - exp(-vDepth * 0.02)) * uFogAmount);
  }
  gl_FragColor = vec4(c, vColor.a);
}
`;

/* ------------------------------------------------------------ picking --- */
/**
 * Object identification pass. WebGL 1/2 have no selection buffer (the ES 2.0
 * `GL_SELECT` render mode does not exist), so the editor renders the scene a
 * second time into an RGBA8 target, writing a 24-bit id and reading a single
 * pixel back. It is more expensive than the fixed-function original — exactly the
 * trade-off the article notes — but it is exact, works with instancing, and needs
 * only a 1×1 readPixels instead of a full scissor pass.
 */
export const pickingVertexShader = /* glsl */`
attribute vec3 aPosition;
attribute vec3 aNormal;
attribute vec2 aUv;
#ifdef PCL_INSTANCED
attribute vec4 aInst0;
attribute vec4 aInst1;
attribute vec4 aInst2;
attribute vec4 aInst3;
attribute vec4 aInstColor;
#endif
uniform mat4 uViewProjection;
uniform mat4 uModel;
varying vec3 vNormal;
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  vec4 world;
  vec3 nrm;
#ifdef PCL_INSTANCED
  mat4 m = mat4(aInst0, aInst1, aInst2, aInst3);
  world = m * vec4(aPosition, 1.0);
  nrm = normalize(mat3(m) * aNormal);
#else
  world = uModel * vec4(aPosition, 1.0);
  nrm = mat3(uModel) * aNormal;
#endif
  vWorld = world.xyz;
  vNormal = nrm;
  vUv = aUv;
  gl_Position = uViewProjection * world;
}
`;

export const pickingFragmentShader = /* glsl */`
#include <pc_common>
uniform vec4 uIdColor;
uniform float uAlphaTest;
uniform float uHasAlbedoMap;
uniform sampler2D uAlbedoMap;
varying vec3 vNormal;
varying vec2 vUv;
varying vec3 vWorld;
void main() {
#ifdef PC_PICK_ALPHA
  if (uHasAlbedoMap > 0.5 && texture2D(uAlbedoMap, vUv).a < uAlphaTest) discard;
#endif
  gl_FragColor = vec4(uIdColor.rgb, 1.0);
}
`;

/* ------------------------------------------------------------- volume --- */
/** Volumetric ray-march through a 3D texture (with the ES 1.00 atlas fallback). */
export const volumeVertexShader = /* glsl */`
attribute vec3 aPosition;
attribute vec3 aNormal;
attribute vec2 aUv;
uniform mat4 uViewProjection;
uniform mat4 uModel;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vUv;
void main() {
  vec4 w = uModel * vec4(aPosition, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(mat3(uModel) * aNormal);
  vUv = aUv;
  gl_Position = uViewProjection * w;
}
`;

export const volumeFragmentShader = /* glsl */`
#include <pc_common>
#include <pc_volume>
uniform vec3 uCameraPosition;
uniform vec3 uVolumeColor;
uniform float uDensity;
uniform float uSteps;
uniform vec3 uBoundsMin;
uniform vec3 uBoundsMax;
uniform float uVolumeSize;
uniform float uVolumeTiles;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vUv;

void main() {
  vec3 ro = uCameraPosition;
  vec3 rd = normalize(vWorld - ro);
  // A ray parallel to a slab face divides by zero, and Inf * 0 then poisons the
  // whole accumulator with NaN. Nudging the direction by a sub-epsilon keeps the
  // slab test finite for every pixel.
  rd += vec3(
    abs(rd.x) < 1e-5 ? (rd.x < 0.0 ? -1e-5 : 1e-5) : 0.0,
    abs(rd.y) < 1e-5 ? (rd.y < 0.0 ? -1e-5 : 1e-5) : 0.0,
    abs(rd.z) < 1e-5 ? (rd.z < 0.0 ? -1e-5 : 1e-5) : 0.0
  );
  rd = normalize(rd);
  vec3 invD = 1.0 / rd;
  vec3 t0 = (uBoundsMin - ro) * invD;
  vec3 t1 = (uBoundsMax - ro) * invD;
  vec3 tmin = min(t0, t1);
  vec3 tmax = max(t0, t1);
  float tEnter = max(max(tmin.x, tmin.y), tmin.z);
  float tExit = min(min(tmax.x, tmax.y), tmax.z);
  tEnter = max(tEnter, 0.0);
  if (tExit <= tEnter) discard;

  int steps = 48;
#ifdef PC_VOLUME_STEPS
  steps = int(uSteps + 0.5);
#endif
  float dt = (tExit - tEnter) / float(steps);
  float t = tEnter + dt * pcIgn(gl_FragCoord.xy);
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 64; i++) {
    if (i >= steps) break;
    vec3 p = ro + rd * t;
    vec3 uvw = (p - uBoundsMin) / max(uBoundsMax - uBoundsMin, vec3(EPS));
    float d = pcSampleVolumeAtlas(uVolume, uvw, uVolumeSize, uVolumeTiles).r;
    d = max(0.0, d - 0.12) * 3.0;
    acc += uVolumeColor * d * dt * uDensity;
    t += dt;
  }
  acc = min(acc, vec3(64.0));            // NaN/Inf guard before blending
  float alpha = pcSaturate(pcLuminance(acc) * 1.4);
  gl_FragColor = vec4(acc, alpha);
}
`;

/* --------------------------------------------------------------- post --- */

export const blitVertexShader = /* glsl */`
attribute vec2 aPosition;
varying vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

export const blitFragmentShader = /* glsl */`
uniform sampler2D uSource;
varying vec2 vUv;
void main() {
  gl_FragColor = texture2D(uSource, vUv);
}
`;

/**
 * Present a linear HDR target to an 8-bit target: exposure, the same ACES curve
 * the main composite uses, then the sRGB transfer function.
 *
 * Asset thumbnails go through this rather than a plain blit. A raw copy writes
 * linear radiance into an RGBA8 surface, so a mid-grey material lands at ~0.15
 * and every thumbnail reads as near-black — the preview would then disagree with
 * what the same material looks like in the viewport.
 */
export const presentFragmentShader = /* glsl */`
#include <pc_common>
uniform sampler2D uSource;
uniform float uExposure;
uniform int uToneMapMode;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(uSource, vUv).rgb * uExposure;
  c = pcTonemap(c, uToneMapMode);
  gl_FragColor = vec4(pcLinearToSrgb(pcSaturate(c)), 1.0);
}
`;

/** Progressive downsample (13-tap box, Call-of-Duty style) for the bloom chain. */
export const bloomDownShader = /* glsl */`
#include <pc_common>
uniform sampler2D uSource;
uniform vec2 uTexel;
uniform float uThreshold;
uniform float uSoftKnee;
uniform int uFirstPass;
varying vec2 vUv;

vec3 prefilter(vec3 c) {
  float br = max(c.r, max(c.g, c.b));
  float soft = br - uThreshold + uSoftKnee;
  soft = clamp(soft, 0.0, 2.0 * uSoftKnee);
  soft = soft * soft / (4.0 * uSoftKnee + EPS);
  return c * max(soft, br - uThreshold) / max(br, EPS);
}

void main() {
  vec2 t = uTexel;
  vec3 a = texture2D(uSource, vUv + t * vec2(-2.0, 2.0)).rgb;
  vec3 b = texture2D(uSource, vUv + t * vec2(0.0, 2.0)).rgb;
  vec3 c = texture2D(uSource, vUv + t * vec2(2.0, 2.0)).rgb;
  vec3 d = texture2D(uSource, vUv + t * vec2(-2.0, 0.0)).rgb;
  vec3 e = texture2D(uSource, vUv).rgb;
  vec3 f = texture2D(uSource, vUv + t * vec2(2.0, 0.0)).rgb;
  vec3 g = texture2D(uSource, vUv + t * vec2(-2.0, -2.0)).rgb;
  vec3 h = texture2D(uSource, vUv + t * vec2(0.0, -2.0)).rgb;
  vec3 i = texture2D(uSource, vUv + t * vec2(2.0, -2.0)).rgb;
  vec3 j = texture2D(uSource, vUv + t * vec2(-1.0, 1.0)).rgb;
  vec3 k = texture2D(uSource, vUv + t * vec2(1.0, 1.0)).rgb;
  vec3 l = texture2D(uSource, vUv + t * vec2(-1.0, -1.0)).rgb;
  vec3 m = texture2D(uSource, vUv + t * vec2(1.0, -1.0)).rgb;
  vec3 res = (j + k + l + m) * 0.125
    + (a + b + d + e) * 0.03125
    + (b + c + e + f) * 0.03125
    + (d + e + g + h) * 0.03125
    + (e + f + h + i) * 0.03125;
  if (uFirstPass == 1) res = prefilter(res);
  gl_FragColor = vec4(res, 1.0);
}
`;

/** Additive upsample with a 3x3 tent filter. */
export const bloomUpShader = /* glsl */`
uniform sampler2D uSource;
uniform vec2 uTexel;
uniform float uRadius;
varying vec2 vUv;
void main() {
  vec2 t = uTexel * uRadius;
  vec3 sum = texture2D(uSource, vUv + vec2(-1.0, 1.0) * t).rgb * 1.0;
  sum += texture2D(uSource, vUv + vec2(0.0, 1.0) * t).rgb * 2.0;
  sum += texture2D(uSource, vUv + vec2(1.0, 1.0) * t).rgb * 1.0;
  sum += texture2D(uSource, vUv + vec2(-1.0, 0.0) * t).rgb * 2.0;
  sum += texture2D(uSource, vUv).rgb * 4.0;
  sum += texture2D(uSource, vUv + vec2(1.0, 0.0) * t).rgb * 2.0;
  sum += texture2D(uSource, vUv + vec2(-1.0, -1.0) * t).rgb * 1.0;
  sum += texture2D(uSource, vUv + vec2(0.0, -1.0) * t).rgb * 2.0;
  sum += texture2D(uSource, vUv + vec2(1.0, -1.0) * t).rgb * 1.0;
  gl_FragColor = vec4(sum * 0.0625, 1.0);
}
`;

/**
 * Final composite: exposure → bloom → tonemap → grade → vignette → grain →
 * FXAA-lite. Exposure is applied *before* the tonemap in linear light, which is
 * the whole point of having an HDR target; on LDR targets the tonemapper is a
 * no-op clamp and the UI says so.
 */
export const compositeShader = /* glsl */`
#include <pc_common>
uniform sampler2D uSource;
uniform sampler2D uBloom;
uniform vec2 uResolution;
uniform float uExposure;
uniform float uBloomStrength;
uniform int uToneMapMode;
uniform float uVignette;
uniform float uGrain;
uniform float uChromatic;
uniform float uContrast;
uniform float uSaturation;
uniform float uTime;
uniform float uFxaa;
uniform sampler2D uSsao;
uniform float uSsaoEnabled;
uniform sampler2D uIds;
uniform float uOutlineEnabled;
uniform vec4 uSelectedIds[4];
uniform int uSelectedCount;
uniform vec3 uOutlineColor;
uniform float uOutlineThickness;
varying vec2 vUv;

vec3 sampleScene(vec2 uv) {
  return texture2D(uSource, uv).rgb;
}

bool pcIsSelected(vec4 id) {
  for (int i = 0; i < 4; i++) {
    if (i >= uSelectedCount) break;
    if (abs(id.r - uSelectedIds[i].r) < 0.004 &&
        abs(id.g - uSelectedIds[i].g) < 0.004 &&
        abs(id.b - uSelectedIds[i].b) < 0.004) return true;
  }
  return false;
}

void main() {
  vec2 uv = vUv;
  vec3 col;

  if (uFxaa > 0.5) {
    // FXAA 3.11 console variant: luma-based edge blend, 5 taps.
    vec3 rgbNW = sampleScene(uv + vec2(-1.0, -1.0) / uResolution);
    vec3 rgbNE = sampleScene(uv + vec2(1.0, -1.0) / uResolution);
    vec3 rgbSW = sampleScene(uv + vec2(-1.0, 1.0) / uResolution);
    vec3 rgbSE = sampleScene(uv + vec2(1.0, 1.0) / uResolution);
    vec3 rgbM = sampleScene(uv);
    float lNW = pcLuminance(rgbNW), lNE = pcLuminance(rgbNE);
    float lSW = pcLuminance(rgbSW), lSE = pcLuminance(rgbSE);
    float lM = pcLuminance(rgbM);
    float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
    float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
    vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
    float reduce = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);
    float rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
    dir = pcSaturate(dir * rcp) / uResolution;
    vec3 a = 0.5 * (sampleScene(uv + dir * (1.0 / 3.0 - 0.5)) + sampleScene(uv + dir * (2.0 / 3.0 - 0.5)));
    vec3 b = a * 0.5 + 0.25 * (sampleScene(uv - dir * 0.5) + sampleScene(uv + dir * 0.5));
    float lB = pcLuminance(b);
    col = (lB < lMin || lB > lMax) ? a : b;
  } else {
    col = sampleScene(uv);
  }

  if (uChromatic > 0.0) {
    vec2 dir = (uv - 0.5) * uChromatic * 0.01;
    col.r = sampleScene(uv + dir).r;
    col.b = sampleScene(uv - dir).b;
  }

  // Screen-space ambient occlusion, applied in linear light before the tonemap.
  if (uSsaoEnabled > 0.5) {
    float ao = texture2D(uSsao, uv).r;
    col *= mix(1.0, ao, 0.85);
  }

  // Selection outline: an edge in the id buffer, antialiased by coverage.
  if (uOutlineEnabled > 0.5) {
    vec2 t = uOutlineThickness / uResolution;
    vec4 id = texture2D(uIds, uv);
    if (pcIsSelected(id)) {
      float edge = 0.0;
      for (int i = 0; i < 8; i++) {
        vec2 o = vec2(0.0);
        if (i == 0) o = vec2(-1.0, -1.0);
        else if (i == 1) o = vec2(0.0, -1.0);
        else if (i == 2) o = vec2(1.0, -1.0);
        else if (i == 3) o = vec2(-1.0, 0.0);
        else if (i == 4) o = vec2(1.0, 0.0);
        else if (i == 5) o = vec2(-1.0, 1.0);
        else if (i == 6) o = vec2(0.0, 1.0);
        else o = vec2(1.0, 1.0);
        vec4 n = texture2D(uIds, uv + o * t);
        if (n.a < 0.5 || !pcIsSelected(n)) edge += 0.125;
      }
      col = mix(col, uOutlineColor, pcSaturate(edge));
    }
  }

  if (uBloomStrength > 0.0) {
    col += texture2D(uBloom, uv).rgb * uBloomStrength;
  }

  col *= uExposure;
  col = pcTonemap(col, uToneMapMode);

  // Linear → display. The default framebuffer is a plain RGBA8 surface (not
  // SRGB8_ALPHA8), so the transfer function has to be applied here or the whole
  // image reads washed out and low-contrast.
  col = pcLinearToSrgb(pcSaturate(col));

  // Grade in display space: contrast around 0.5, then saturation.
  col = pcSaturate((col - 0.5) * uContrast + 0.5);
  float lum = pcLuminance(col);
  col = pcSaturate(mix(vec3(lum), col, uSaturation));

  float d = distance(uv, vec2(0.5));
  col *= 1.0 - pcSaturate((d - 0.35) * uVignette);

  if (uGrain > 0.0) {
    col += (pcHash12(uv * uResolution + uTime) - 0.5) * uGrain;
  }

  gl_FragColor = vec4(pcDither(pcSaturate(col), gl_FragCoord.xy), 1.0);
}
`;

/** SSAO (WebGL 2 depth path; disabled automatically when depth textures are absent). */
export const ssaoShader = /* glsl */`
#include <pc_common>
uniform sampler2D uDepth;
uniform mat4 uProjection;
uniform mat4 uInverseProjection;
uniform vec2 uResolution;
uniform float uRadius;
uniform float uIntensity;
uniform float uBias;
varying vec2 vUv;

vec3 viewPosFromDepth(vec2 uv, float d) {
  vec4 ndc = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 v = uInverseProjection * ndc;
  return v.xyz / v.w;
}

void main() {
  float depth = texture2D(uDepth, vUv).r;
  if (depth >= 1.0) { gl_FragColor = vec4(1.0); return; }
  vec3 P = viewPosFromDepth(vUv, depth);

  float occ = 0.0;
  float ang = pcHash12(gl_FragCoord.xy) * 6.28318530718;
  const int KERNEL = 12;
  for (int i = 0; i < KERNEL; i++) {
    float fi = float(i);
    float a = ang + fi * 2.39996323;             // golden-angle spiral
    float r = uRadius * sqrt((fi + 0.5) / float(KERNEL));
    vec3 dir = vec3(cos(a), sin(a), 0.0);
    vec3 offset = dir * r;
    offset.z = -0.15 - 0.35 * pcHash11(fi);
    vec3 sp = P + offset;
    vec4 clip = uProjection * vec4(sp, 1.0);
    vec2 suv = clip.xy / clip.w * 0.5 + 0.5;
    if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) continue;
    float sd = texture2D(uDepth, suv).r;
    vec3 sampleP = viewPosFromDepth(suv, sd);
    float rangeCheck = smoothstep(0.0, 1.0, uRadius / max(abs(P.z - sampleP.z), 1e-4));
    occ += (sampleP.z >= sp.z + uBias ? 1.0 : 0.0) * rangeCheck;
  }
  float ao = 1.0 - (occ / float(KERNEL)) * uIntensity;
  gl_FragColor = vec4(pcSaturate(ao), pcSaturate(occ / float(KERNEL)), 0.0, 1.0);
}
`;

export const postFilter = FILTER.linear;
