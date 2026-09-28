/**
 * Reusable GLSL chunks.
 *
 * Authoring rules for everything in this file (they are what make one source
 * tree compile as both GLSL ES 1.00 and 3.00):
 *   • loop bounds are compile-time constants, loop breaks on uniform conditions
 *   • no bitwise operators, no `round`/`trunc`/`inverse`, no `%` on integers
 *   • array indexing uses loop indices or constant expressions only
 *   • varyings are declared with the neutral `varying` keyword on both stages
 *   • no texture lookups in vertex shaders (needs EXT_shader_texture_lod on 1.00)
 *   • explicit precision is injected by the compiler, never written by hand
 */

import { chunk } from '../program.js';

chunk('pc_common', /* glsl */`
#ifndef PI
#define PI 3.14159265359
#endif
#define TWO_PI 6.28318530718
#define INV_PI 0.31830988618
#define EPS 1e-6

float pcSaturate(float x) { return clamp(x, 0.0, 1.0); }
vec2  pcSaturate(vec2 x)  { return clamp(x, 0.0, 1.0); }
vec3  pcSaturate(vec3 x)  { return clamp(x, 0.0, 1.0); }
float pcPow2(float x) { return x * x; }
float pcPow5(float x) { float t = x * x; return t * t * x; }

float pcLuminance(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// sRGB <-> linear. sRGB *textures* are decoded by the sampler (SRGB8_ALPHA8);
// these functions are used for colours chosen in the UI and for final encode.
vec3 pcLinearToSrgb(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(max(c, vec3(EPS)), vec3(1.0 / 2.4)) - 0.055;
  return pcSaturate(mix(lo, hi, step(vec3(0.0031308), c)));
}
vec3 pcSrgbToLinear(vec3 c) {
  vec3 lo = c / 12.92;
  vec3 hi = pow((max(c, vec3(EPS)) + 0.055) / 1.055, vec3(2.4));
  return mix(lo, hi, step(vec3(0.04045), c));
}

// ---------------------------------------------------------------- tonemap --
// ACES filmic approximation (Narkowicz) — cheap, keeps highlight hue.
vec3 pcTonemapAces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return pcSaturate((x * (a * x + b)) / (x * (c * x + d) + e));
}
vec3 pcTonemapReinhard(vec3 x) { return x / (1.0 + x); }
vec3 pcTonemapFilmic(vec3 x) {
  vec3 x2 = x * x;
  return pcSaturate((x * (2.51 * x2 + 0.03)) / (x2 * (2.43 * x2 + 0.59) + 0.14));
}
#define UC_A 0.15
#define UC_B 0.50
#define UC_C 0.10
#define UC_D 0.20
#define UC_E 0.02
#define UC_F 0.30
#define UC_W 11.2
vec3 pcTonemapUncharted2(vec3 x) {
  return ((x * (UC_A * x + UC_C * UC_B) + UC_D * UC_E) / (x * (UC_A * x + UC_B) + UC_D * UC_F)) - UC_E / UC_F;
}
// Uncharted 2 white-point fix so 1.0 maps to 1.0 after the curve.
vec3 pcTonemapUncharted2White(vec3 x) {
  float w = ((UC_W * (UC_A * UC_W + UC_C * UC_B) + UC_D * UC_E)
           / (UC_W * (UC_A * UC_W + UC_B) + UC_D * UC_F)) - UC_E / UC_F;
  return vec3(pcTonemapUncharted2(x / w));
}

// Tone-map modes. The numbers are the contract with the scene setting
// render.toneMapping (see TONE_MAP in scene/components.js):
//   0 none / 1 reinhard / 2 filmic / 3 uncharted2 / 4 linear / 5 aces
vec3 pcTonemap(vec3 c, int mode) {
  if (mode == 1) return pcTonemapReinhard(c);
  if (mode == 2) return pcTonemapFilmic(c);
  if (mode == 3) return pcTonemapUncharted2White(c);
  if (mode == 4) return c;                 // linear / clamp (crude but honest)
  if (mode == 5) return pcTonemapAces(c);
  return c;                                // 0 = none: pass linear through
}

// ------------------------------------------------------------------- noise --
float pcHash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float pcHash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 pcHash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float pcHash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

float pcValueNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = pcHash12(i);
  float b = pcHash12(i + vec2(1.0, 0.0));
  float c = pcHash12(i + vec2(0.0, 1.0));
  float d = pcHash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float pcFbm(vec2 p, int octaves) {
  float sum = 0.0, amp = 0.5, freq = 1.0;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    sum += amp * pcValueNoise(p * freq);
    freq *= 2.0;
    amp *= 0.5;
  }
  return sum;
}

// Interleaved gradient noise — used for dithering and stochastic sampling.
float pcIgn(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

vec3 pcDither(vec3 c, vec2 fragCoord) {
  return c + (pcIgn(fragCoord) - 0.5) / 255.0;
}
`);

chunk('pc_geometry', /* glsl */`
// World-space basis from screen-space derivatives (no tangent attribute needed).
mat3 pcCotangentFrame(vec3 N, vec3 p, vec2 uv) {
  vec3 dp1 = dFdx(p);
  vec3 dp2 = dFdy(p);
  vec2 duv1 = dFdx(uv);
  vec2 duv2 = dFdy(uv);
  vec3 dp2perp = cross(dp2, N);
  vec3 dp1perp = cross(N, dp1);
  vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
  vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
  float invmax = inversesqrt(max(dot(T, T), dot(B, B)) + EPS);
  return mat3(T * invmax, B * invmax, N);
}

// Octahedral normal encoding — 2 channels instead of 3, used by the G-buffer.
vec2 pcOctEncode(vec3 n) {
  n /= (abs(n.x) + abs(n.y) + abs(n.z) + EPS);
  vec2 e = n.z >= 0.0 ? n.xy : (1.0 - abs(n.yx)) * vec2(n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0);
  return e * 0.5 + 0.5;
}
vec3 pcOctDecode(vec2 e) {
  e = e * 2.0 - 1.0;
  vec3 n = vec3(e.xy, 1.0 - abs(e.x) - abs(e.y));
  float t = max(-n.z, 0.0);
  n.x += n.x >= 0.0 ? -t : t;
  n.y += n.y >= 0.0 ? -t : t;
  return normalize(n);
}
`);

chunk('pc_pbr', /* glsl */`
// Cook-Torrance micro-facet BRDF: GGX/Trowbridge-Reitz NDF, Smith height-correlated
// visibility (already multiplied by 1/(4·NdotL·NdotV)), Schlick Fresnel.

float pcD_GGX(float NoH, float rough) {
  float a = rough * rough;
  float a2 = a * a;
  float d = NoH * NoH * (a2 - 1.0) + 1.0;
  return a2 / max(PI * d * d, EPS);
}

float pcV_SmithGGXCorrelated(float NoV, float NoL, float rough) {
  float a = rough * rough;
  float a2 = a * a;
  float lv = NoL * sqrt(NoV * NoV * (1.0 - a2) + a2);
  float ll = NoV * sqrt(NoL * NoL * (1.0 - a2) + a2);
  return 0.5 / max(lv + ll, EPS);
}

vec3 pcF_Schlick(vec3 f0, float f90, float VoH) {
  return f0 + (vec3(f90) - f0) * pcPow5(1.0 - VoH);
}
float pcF_SchlickF(float f0, float f90, float VoH) {
  return f0 + (f90 - f0) * pcPow5(1.0 - VoH);
}

// Roughness-aware Fresnel (Lagarde): widens the lobe for rough surfaces so
// energy-conserving approximations do not lose the grazing-angle response.
vec3 pcFresnelSchlickRoughness(vec3 f0, float cosT, float rough) {
  return f0 + (max(vec3(1.0 - rough), f0) - f0) * pcPow5(1.0 - cosT);
}

// Karis' analytic environment BRDF — returns the (scale, bias) pair that the
// 2D LUT would, so it is a drop-in replacement when no float target exists.
vec2 pcEnvBRDFApprox(vec3 f0, float rough, float NoV) {
  const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
  const vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
  vec4 r = rough * c0 + c1;
  float a004 = min(r.x * r.x, exp2(-9.28 * NoV)) * r.x + r.y;
  vec2 ab = vec2(-1.04, 1.04) * a004 + r.zw;
  return vec2(f0 * ab.x + vec3(ab.y));
}

// Split-sum with a real BRDF integration LUT. The sampler is declared here so
// any shader including pc_pbr can reach it; an unused one is optimised away.
uniform sampler2D uBRDFLut;
vec2 pcEnvBRDFLut(float NoV, float rough) {
  return texture2D(uBRDFLut, vec2(NoV, rough)).rg;
}

// Lambert diffuse with energy conservation against specular.
vec3 pcDiffuseLambert(vec3 albedo) { return albedo * INV_PI; }

vec3 pcDirectLighting(
  vec3 N, vec3 V, vec3 L, vec3 radiance,
  vec3 albedo, float metallic, float roughness, float ao, vec3 f0
) {
  vec3 H = normalize(V + L);
  float NoL = pcSaturate(dot(N, L));
  if (NoL <= 0.0) return vec3(0.0);
  float NoV = pcSaturate(dot(N, V)) + EPS;
  float NoH = pcSaturate(dot(N, H));
  float VoH = pcSaturate(dot(V, H));

  float a = roughness * roughness;
  float D = pcD_GGX(NoH, a);
  float Vis = pcV_SmithGGXCorrelated(NoV, NoL, a);
  vec3 F = pcF_Schlick(f0, 1.0, VoH);

  vec3 spec = D * Vis * F;
  vec3 kd = (vec3(1.0) - F) * (1.0 - metallic);
  vec3 diff = kd * albedo * INV_PI;
  return (diff + spec) * radiance * NoL * ao;
}

// Lambertian + specular occlusion (Lagarde's approximation).
float pcSpecularOcclusion(float NoV, float roughness, float ao) {
  return pcSaturate(pow(NoV + ao, exp2(-16.0 * roughness - 1.0)) - 1.0 + ao);
}
float pcHorizonOcclusion(float NoV, float ao) {
  float f = 1.0 - 0.5 * pcSaturate(-NoV + ao);
  return pcSaturate(ao * f + (1.0 - pow(1.0 - ao, 5.0)));
}
`);

chunk('pc_shadow', /* glsl */`
// Shadow sampling for one directional light split into two cascades, plus one
// slot reserved for a spot light. Hardware PCF when the depth texture carries
// COMPARE_REF_TO_TEXTURE, otherwise 3x3 manual PCF — the classic ES 2.0 path.

// Hardware PCF needs a shadow-typed sampler, which only exists in ES 3.0
// (WebGL 1 always compares manually, see the #else branch below).
#ifdef PC_SHADOW_HW
// ES 3.00 gives samplers their own precision namespace: they must be qualified.
uniform highp sampler2DShadow uShadow0;
uniform highp sampler2DShadow uShadow1;
uniform highp sampler2DShadow uShadow2;
#else
uniform sampler2D uShadow0;
uniform sampler2D uShadow1;
uniform sampler2D uShadow2;
#endif
uniform mat4 uShadowMat0;
uniform mat4 uShadowMat1;
uniform mat4 uShadowMat2;
uniform vec2 uShadowTexel0;
uniform vec2 uShadowTexel1;
uniform vec2 uShadowTexel2;
uniform float uShadowBias0;
uniform float uShadowBias1;
uniform float uShadowBias2;
uniform float uShadowSplit;   // normalised view depth where cascade 2 starts
uniform float uShadowStrength;
uniform float uShadowEnabled;

#ifdef PC_SHADOW_HW
float pcShadowCascade(highp sampler2DShadow smap, mat4 smat, vec3 uvz, float bias, vec2 texel) {
  vec4 c = smat * vec4(uvz, 1.0);
  if (c.z > 1.0 || c.x < 0.0 || c.x > 1.0 || c.y < 0.0 || c.y > 1.0) return 1.0;
  return texture2D(smap, vec3(c.xy, c.z - bias));
}
#else
float pcShadowCascade(sampler2D smap, mat4 smat, vec3 uvz, float bias, vec2 texel) {
  vec4 c = smat * vec4(uvz, 1.0);
  if (c.z > 1.0 || c.x < 0.0 || c.x > 1.0 || c.y < 0.0 || c.y > 1.0) return 1.0;
  float z = c.z - bias;
  float s = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      s += step(z, texture2D(smap, c.xy + vec2(float(x), float(y)) * texel).r);
    }
  }
  return s * 0.11111111;
}
#endif

float pcGetShadow(vec3 worldPos, vec3 N, vec3 L, float viewDepth) {
  if (uShadowEnabled < 0.5) return 1.0;
  // Normal-offset bias: displace the lookup along the surface normal, scaled by
  // the slope. Far more stable than a pure depth bias, which needs per-cascade
  // constants and still produces peter-panning at grazing angles.
  float slope = pcSaturate(1.0 - dot(N, L));
  vec3 offsetPos = worldPos + N * (0.02 + 0.10 * slope) * max(viewDepth * 0.02, 0.05);
  float s;
  if (viewDepth < uShadowSplit) {
    s = pcShadowCascade(uShadow0, uShadowMat0, offsetPos, uShadowBias0 + 0.0012 * slope, uShadowTexel0);
  } else {
    s = pcShadowCascade(uShadow1, uShadowMat1, offsetPos, uShadowBias1 + 0.0026 * slope, uShadowTexel1);
  }
  float fade = 1.0 - pcSaturate((viewDepth - uShadowSplit * 0.85) / max(uShadowSplit * 0.15, EPS));
  return mix(1.0, s, fade * uShadowStrength);
}
`);

chunk('pc_volume', /* glsl */`
// 3D texture sampling with a tiled-atlas fallback for GLSL ES 1.00.
// WebGL 1 exposes no sampler3D (the ES 2.0 OES_texture_3D extension is not part
// of the WebGL feature set), so the volume is a square tile atlas and the Z
// interpolation is done by hand — two bilinear samples plus a lerp.

uniform sampler2D uVolume;
uniform vec3 uVolumeInfo;   // x: 1/size  y: 1/atlas  z: number of tiles

vec4 pcSampleVolumeAtlas(sampler2D tex, vec3 uvw, float size, float tiles) {
  uvw = clamp(uvw, vec3(0.5 / size), vec3(1.0 - 0.5 / size));
  float slice = uvw.z * size - 0.5;
  float z0 = floor(slice);
  float z1 = z0 + 1.0;
  float fz = slice - z0;
  z0 = clamp(z0, 0.0, size - 1.0);
  z1 = clamp(z1, 0.0, size - 1.0);
  float invAtlas = 1.0 / (tiles * size);
  vec2 uv0 = vec2(mod(z0, tiles), floor(z0 / tiles)) * invAtlas + uvw.xy * invAtlas;
  vec2 uv1 = vec2(mod(z1, tiles), floor(z1 / tiles)) * invAtlas + uvw.xy * invAtlas;
  return mix(texture2D(tex, uv0), texture2D(tex, uv1), fz);
}
`);

chunk('pc_sky', /* glsl */`
// Analytic sky shared by the skybox, the IBL prefilter and the ambient probe.
// A simplified Preetham: Rayleigh + Mie phase terms over a physically-plausible
// gradient, plus a sun disc and optional ground bounce.

uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyGround;
uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform float uSkyTurbidity;
uniform float uSkyExposure;
uniform float uGroundBlend;

float pcRayleighPhase(float c) { return (3.0 / (16.0 * PI)) * (1.0 + c * c); }
float pcMiePhase(float c, float g) {
  float g2 = g * g;
  float num = 3.0 * (1.0 - g2) * (1.0 + c * c);
  float den = 8.0 * PI * (2.0 + g2) * pow(1.0 + g2 - 2.0 * g * c, 1.5);
  return num / max(den, EPS);
}

vec3 pcSkyRadiance(vec3 dir, float turbidity, float intensity) {
  float up = pcSaturate(dir.y * 0.5 + 0.5);
  float horizon = pow(1.0 - abs(dir.y), 4.0);
  vec3 sky = mix(uSkyZenith, uSkyHorizon, horizon);
  vec3 ground = uSkyGround;
  vec3 col = mix(ground, sky, pcSaturate(dir.y * 6.0 + uGroundBlend));
  float sun = pcSaturate(dot(normalize(dir), uSunDirection));
  // Mie forward scattering halo around the sun, then the disc itself.
  col += uSunColor * pcMiePhase(sun, 0.76) * 0.06 * turbidity;
  float disc = smoothstep(0.99965, 0.99992, sun);
  col += uSunColor * disc * 12.0;
  col *= mix(0.65, 1.0, up);
  return col * intensity;
}

vec3 pcSkyColor(vec3 dir) {
  return pcSkyRadiance(normalize(dir), uSkyTurbidity, uSunIntensity) * uSkyExposure;
}
`);

chunk('pc_shadow_depth', /* glsl */`
// Depth-only pass. Written to a depth texture (or a packed colour target when
// depth textures are unavailable) with an empty fragment stage on ES 3.0.
`);

export const CHUNK_NAMES = [
  'pc_common', 'pc_geometry', 'pc_pbr', 'pc_shadow', 'pc_volume', 'pc_sky'
];
