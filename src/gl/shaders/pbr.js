/**
 * Forward PBR shader — the workhorse.
 *
 * Metallic/roughness workflow, analytic lights (point / spot / directional) with
 * inverse-square falloff and a radius window, image-based lighting from a
 * prefiltered radiance cube, two-cascade directional shadows, height fog, vertex
 * colours, instancing, and a debug channel that renders any intermediate value
 * straight to the screen (which is how the viewport visualisation menu works —
 * one pipeline, many views, no second material system).
 *
 * MAX_LIGHTS is a compile-time override: GLSL ES 1.00 only guarantees 16
 * fragment uniform vectors, so the light budget is a *compile* decision, not a
 * runtime one. The renderer picks a variant that fits the reported limit.
 */

// Registers the reusable GLSL chunks referenced by `#include <…>` below.
import './common.js';

export const vertexShader = /* glsl */`
#ifndef MAX_LIGHTS
#define MAX_LIGHTS 8
#endif

#include <pc_common>

attribute vec3 aPosition;
attribute vec3 aNormal;
attribute vec2 aUv;
#ifdef PCL_VERTEX_COLOR
attribute vec4 aColor;
#endif
#ifdef PCL_INSTANCED
attribute vec4 aInst0;
attribute vec4 aInst1;
attribute vec4 aInst2;
attribute vec4 aInst3;
attribute vec4 aInstColor;
#endif

uniform mat4 uViewProjection;
uniform mat4 uModel;
uniform mat3 uNormalMatrix;
uniform vec4 uUvTransform;        // xy = tiling, zw = offset
uniform float uUvRotation;
uniform vec3 uCameraPosition;
uniform mat4 uShadowMat0;
uniform mat4 uShadowMat1;
uniform float uFogDensity;
uniform float uFogEnabled;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec2 vUv;
varying float vViewDepth;
varying vec4 vShadow0;
varying vec4 vShadow1;
varying vec4 vColor;
varying float vFog;

void main() {
  vec4 world;
  vec3 nrm;

#ifdef PCL_INSTANCED
  mat4 m = mat4(aInst0, aInst1, aInst2, aInst3);
  world = m * vec4(aPosition, 1.0);
  // Instance matrices are authored with uniform scale, so the inverse-transpose
  // collapses to the 3x3 block; renormalising absorbs the rest.
  nrm = normalize(mat3(m) * aNormal);
  vColor = aInstColor;
#else
  world = uModel * vec4(aPosition, 1.0);
  nrm = normalize(uNormalMatrix * aNormal);
  vColor = vec4(1.0);
#endif

  vWorldPos = world.xyz;
  vNormal = nrm;
  vViewDepth = -(uViewProjection * world).z;

  float c = cos(uUvRotation), s = sin(uUvRotation);
  vUv = vec2(aUv.x * c - aUv.y * s, aUv.x * s + aUv.y * c) * uUvTransform.xy + uUvTransform.zw;

#ifdef PCL_VERTEX_COLOR
  vColor *= aColor;
#endif

  vShadow0 = uShadowMat0 * world;
  vShadow1 = uShadowMat1 * world;

  float dist = length(world.xyz - uCameraPosition);
  vFog = (1.0 - exp(-pcPow2(dist * uFogDensity))) * uFogEnabled;

  gl_Position = uViewProjection * world;
}
`;

export const fragmentShader = /* glsl */`
#ifndef MAX_LIGHTS
#define MAX_LIGHTS 8
#endif

#include <pc_common>
#include <pc_geometry>
#include <pc_pbr>
#include <pc_shadow>

uniform vec3 uCameraPosition;
uniform vec4 uAlbedo;                 // rgb = base colour, a = opacity
uniform float uMetallic;
uniform float uRoughness;
uniform float uSpecular;
uniform vec3 uEmissive;
uniform float uEmissiveIntensity;
uniform float uOcclusionStrength;
uniform float uAlphaTest;
uniform float uTwoSided;

uniform sampler2D uAlbedoMap;
uniform sampler2D uNormalMap;
uniform sampler2D uMetalRoughMap;
uniform sampler2D uOcclusionMap;
uniform sampler2D uEmissiveMap;
uniform float uHasAlbedoMap;
uniform float uHasNormalMap;
uniform float uHasMetalRoughMap;
uniform float uHasOcclusionMap;
uniform float uHasEmissiveMap;
uniform float uNormalScale;
uniform float uOcclusionUvChannel;     // 0 = red, 1 = green channel

uniform vec3 uAmbient;
uniform float uAmbientIntensity;
uniform vec3 uSH[9];                   // 9 spherical-harmonic coefficients of the sky
uniform float uShEnabled;
uniform float uIblIntensity;
uniform samplerCube uPrefiltered;
uniform float uPrefilteredMips;
uniform float uIblEnabled;
uniform float uBrdfLutEnabled;

uniform vec4 uLightPos[MAX_LIGHTS];    // xyz = position (or direction for a sun), w = range (0 => sun)
uniform vec3 uLightColor[MAX_LIGHTS];  // rgb = colour * intensity
uniform vec2 uLightParams[MAX_LIGHTS]; // x = cos(outer), y = cos(inner); x < -0.5 => omni
uniform vec3 uLightAxis[MAX_LIGHTS];   // spot axis, from the light towards its target
uniform int uLightCount;

uniform float uFogDensity;
uniform float uFogEnabled;
uniform vec3 uFogColor;
uniform float uFogHeightFalloff;

uniform int uDebugMode;                // 0 = shaded, see pcDebugNames in the editor
uniform float uSelected;
uniform vec3 uSelectionColor;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec2 vUv;
varying float vViewDepth;
varying vec4 vShadow0;
varying vec4 vShadow1;
varying vec4 vColor;
varying float vFog;

// Irradiance from the 9 SH coefficients, using the convolution constants from
// Ramamoorthi & Hanrahan. The basis is Z-up, so the normal is permuted to match
// the permutation applied on the CPU when the coefficients were projected.
vec3 pcShIrradiance(vec3 N) {
  if (uShEnabled < 0.5) return uSH[0] * 0.31830988618;
  float x = N.x, y = N.z, z = N.y;
  const float c1 = 0.429043, c2 = 0.511664, c3 = 0.743125, c4 = 0.886227, c5 = 0.247708;
  return c4 * uSH[0]
    + 2.0 * c1 * (uSH[8] * (x * x - y * y) + uSH[5] * x * z + uSH[4] * y * z)
    + c3 * uSH[6] * z * z - c5 * uSH[6]
    + 2.0 * c2 * (uSH[3] * x + uSH[1] * y + uSH[2] * z);
}

// Inverse-square falloff with a finite-radius window. A bare 1/d^2 never reaches
// zero, which makes lights pop at the far clip; the polynomial window fixes it.
float pcAttenuation(float d, float range) {
  if (range <= 0.0) return 1.0;
  float d2 = max(d * d, 0.0001);
  float w = pcSaturate(1.0 - pcPow5(d / max(range, EPS)));
  return w * w / d2;
}

float pcSpotAttenuation(float cosAngle, vec2 params) {
  if (params.x < -0.5) return 1.0;
  return pcSaturate((cosAngle - params.x) / max(params.y - params.x, EPS));
}

vec3 shadeIBL(vec3 N, vec3 V, vec3 R, vec3 albedo, float metallic, float roughness, float ao, vec3 f0) {
  if (uIblEnabled < 0.5) return vec3(0.0);
  float NoV = pcSaturate(dot(N, V)) + EPS;
  vec3 diffuseIrr = pcShIrradiance(N) * uIblIntensity;
  vec3 prefiltered = textureCube(uPrefiltered, R, roughness * max(uPrefilteredMips - 1.0, 0.0)).rgb;
  vec2 ab = uBrdfLutEnabled > 0.5
    ? pcEnvBRDFLut(NoV, roughness)
    : pcEnvBRDFApprox(f0, roughness, NoV);
  // diffuseIrr is the cosine-convolved irradiance E(n) from the SH projection;
  // the Lambert BRDF still carries its 1/pi, otherwise ambient light comes out
  // pi times too strong and every surface reads as a white blob.
  vec3 kd = (vec3(1.0) - pcF_Schlick(f0, 1.0, NoV)) * (1.0 - metallic);
  vec3 diffuse = kd * diffuseIrr * albedo * INV_PI;
  vec3 specular = prefiltered * (f0 * ab.x + ab.y);
  return (diffuse + specular * pcSpecularOcclusion(NoV, roughness, ao)) * ao;
}

void main() {
  vec3 N = normalize(vNormal);
  if (uTwoSided > 0.5 && !gl_FrontFacing) N = -N;
  vec3 V = normalize(uCameraPosition - vWorldPos);

  vec4 base = uAlbedo * vColor;
  if (uHasAlbedoMap > 0.5) {
    vec4 t = texture2D(uAlbedoMap, vUv);
    base *= t;
  }
  if (base.a < uAlphaTest) discard;

  float metallic = uMetallic;
  float roughness = uRoughness;
  float ao = 1.0;

  if (uHasMetalRoughMap > 0.5) {
    vec4 mr = texture2D(uMetalRoughMap, vUv);
    roughness *= mr.g;
    metallic *= mr.b;
  }

  if (uHasNormalMap > 0.5) {
    vec3 n = texture2D(uNormalMap, vUv).rgb * 2.0 - 1.0;
    n.xy *= uNormalScale;
#ifdef PCL_NORMALMAP_DERIV
    mat3 tbn = pcCotangentFrame(N, -V, vUv);
#else
    // No screen-space derivatives available: synthesise an orthonormal basis from
    // the world axis least aligned with the normal.
    vec3 up = abs(N.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 T = normalize(cross(up, N));
    vec3 B = cross(N, T);
    mat3 tbn = mat3(T, B, N);
#endif
    N = normalize(tbn * normalize(n));
  }

  if (uHasOcclusionMap > 0.5) {
    vec4 o = texture2D(uOcclusionMap, vUv);
    float occl = uOcclusionUvChannel > 0.5 ? o.g : o.r;
    ao = mix(1.0, occl, uOcclusionStrength);
  }

  vec3 albedo = base.rgb;
  float opacity = base.a;
  roughness = clamp(roughness, 0.045, 1.0);
  metallic = pcSaturate(metallic);

  // Dielectric F0 from the specular slider (0.5 == 0.04 == IOR 1.5).
  vec3 f0 = mix(vec3(0.08 * uSpecular * uSpecular), albedo, metallic);
  vec3 R = reflect(-V, N);

  vec3 direct = vec3(0.0);
  float sunShadow = 1.0;

  for (int i = 0; i < MAX_LIGHTS; i++) {
    if (i >= uLightCount) break;
    float range = uLightPos[i].w;
    vec3 lp = uLightPos[i].xyz;
    // Sun: lp already points from the surface towards the light, no distance.
    vec3 toLight = range <= 0.0 ? lp : (vWorldPos - lp);
    vec3 L = normalize(toLight);
    float dist = range <= 0.0 ? 0.0 : length(toLight);

    float shadow = 1.0;
    if (range <= 0.0) shadow = pcGetShadow(vWorldPos, N, L, vViewDepth);
    if (range <= 0.0) sunShadow = shadow;

    float atten = pcAttenuation(dist, range);
    // Spot: angle between the light's axis and (light -> surface) == -L.
    float cone = uLightParams[i].x < -0.5
      ? 1.0
      : pcSpotAttenuation(dot(-L, normalize(uLightAxis[i])), uLightParams[i]);

    vec3 radiance = uLightColor[i] * atten * cone * shadow;
    if (pcSaturate(dot(N, L)) > 0.0) {
      direct += pcDirectLighting(N, V, L, radiance, albedo, metallic, roughness, ao, f0);
    }
  }

  vec3 ambient = uAmbient * uAmbientIntensity * albedo * ao;
  vec3 ibl = shadeIBL(N, V, R, albedo, metallic, roughness, ao, f0);
  vec3 emissive = uEmissive * uEmissiveIntensity;
  if (uHasEmissiveMap > 0.5) emissive *= texture2D(uEmissiveMap, vUv).rgb;

  vec3 color = direct + ambient + ibl + emissive;

  if (uFogEnabled > 0.5) {
    float h = exp(-max(vWorldPos.y, 0.0) * uFogHeightFalloff);
    color = mix(color, uFogColor, pcSaturate(vFog * h));
  }

  if (uSelected > 0.5) {
    float rim = pcSaturate(1.0 - dot(N, V));
    color = mix(color, uSelectionColor, 0.10 + rim * 0.45);
  }

  if (uDebugMode == 1) color = albedo;
  else if (uDebugMode == 2) color = N * 0.5 + 0.5;
  else if (uDebugMode == 3) color = vec3(roughness);
  else if (uDebugMode == 4) color = vec3(metallic);
  else if (uDebugMode == 5) color = vec3(ao);
  else if (uDebugMode == 6) color = emissive;
  else if (uDebugMode == 7) color = vec3(vViewDepth * 0.02);
  else if (uDebugMode == 8) color = f0;
  else if (uDebugMode == 9) color = vec3(float(uLightCount) / float(MAX_LIGHTS));
  else if (uDebugMode == 10) color = vec3(sunShadow);
  else if (uDebugMode == 11) color = vec3(fract(vUv), 0.35);
  else if (uDebugMode == 12) color = vec3(pow(1.0 - pcSaturate(dot(N, V)), 3.0));
  else if (uDebugMode == 13) color = vec3(opacity);

  gl_FragColor = vec4(color, opacity);
}
`;

/** Depth-only pass for the shadow cascades. */
export const depthVertexShader = /* glsl */`
#include <pc_common>

attribute vec3 aPosition;
attribute vec2 aUv;
#ifdef PCL_INSTANCED
attribute vec4 aInst0;
attribute vec4 aInst1;
attribute vec4 aInst2;
attribute vec4 aInst3;
attribute vec4 aInstColor;
#endif

uniform mat4 uLightViewProjection;
uniform mat4 uModel;
uniform float uUvOffsetZ;

varying vec2 vUv;

void main() {
  vec4 world;
#ifdef PCL_INSTANCED
  world = mat4(aInst0, aInst1, aInst2, aInst3) * vec4(aPosition, 1.0);
#else
  world = uModel * vec4(aPosition, 1.0);
#endif
  vUv = aUv + vec2(uUvOffsetZ, 0.0);
  gl_Position = uLightViewProjection * world;
}
`;

export const depthFragmentShader = /* glsl */`
#include <pc_common>

uniform float uAlphaTest;
uniform float uHasAlbedoMap;
uniform sampler2D uAlbedoMap;
varying vec2 vUv;

void main() {
#ifdef PC_ALPHA_TEST_DEPTH
  if (uHasAlbedoMap > 0.5 && texture2D(uAlbedoMap, vUv).a < uAlphaTest) discard;
#endif
#ifdef PC_PACKED_DEPTH
  // ES 1.00 with no depth-texture support: store gl_FragCoord.z packed into
  // RGBA8 and unpack it in the shadow lookup. Four times the bandwidth, but it
  // works everywhere — the trade-off the article describes for missing features.
  float d = gl_FragCoord.z;
  vec4 enc = fract(d * vec4(1.0, 255.0, 65025.0, 16581375.0));
  enc -= enc.yzzw * vec4(1.0 / 255.0, 1.0 / 255.0, 1.0 / 255.0, 0.0);
  gl_FragColor = enc;
#else
  // Depth goes through the depth attachment here, but the fragment stage still
  // has to write *something*: ES 3.0 rejects a draw whose active draw buffers
  // have no matching output. ES 2.0 has no way to mask a draw buffer off (see
  // RenderTarget's colorWrite), so the dummy write is what keeps this portable.
  gl_FragColor = vec4(1.0);
#endif
}
`;
