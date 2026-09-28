/**
 * Sky, image-based lighting generation and background rendering.
 *
 * The whole IBL chain is produced on the GPU at start-up, with no external HDR:
 *   1. the analytic sky (pc_sky chunk) is rendered into a radiance cube;
 *   2. that cube is cosine-convolved into a small irradiance cube;
 *   3. it is GGX-importance-sampled into a mip chain — mip n is prefiltered for
 *      roughness n/(mips-1), which is the split-sum approximation;
 *   4. the split-sum BRDF integral is rasterised into a 2D LUT.
 * The CPU keeps the 9 SH coefficients of the same sky, so ambient light is still
 * correct on devices with no float render targets.
 */

// Registers the reusable GLSL chunks referenced by `#include <…>` below.
import './common.js';

export const CUBE_FACES = [
  { forward: [1, 0, 0], right: [0, 0, -1], up: [0, -1, 0] },
  { forward: [-1, 0, 0], right: [0, 0, 1], up: [0, -1, 0] },
  { forward: [0, 1, 0], right: [1, 0, 0], up: [0, 0, 1] },
  { forward: [0, -1, 0], right: [1, 0, 0], up: [0, 0, -1] },
  { forward: [0, 0, 1], right: [1, 0, 0], up: [0, -1, 0] },
  { forward: [0, 0, -1], right: [-1, 0, 0], up: [0, -1, 0] }
];

/** Shared cube-face pass: a unit quad whose corners map to a direction. */
export const cubeVertexShader = /* glsl */`
attribute vec2 aPosition;
uniform vec3 uFaceForward;
uniform vec3 uFaceRight;
uniform vec3 uFaceUp;
varying vec3 vDir;
void main() {
  vDir = normalize(uFaceForward + uFaceRight * aPosition.x + uFaceUp * aPosition.y);
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

/** Full-screen quad, uv in [0,1] (used for the BRDF LUT and the background). */
export const quadVertexShader = /* glsl */`
attribute vec2 aPosition;
varying vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

export const radianceFragmentShader = /* glsl */`
#include <pc_common>
#include <pc_sky>
varying vec3 vDir;
void main() {
  gl_FragColor = vec4(pcSkyRadiance(vDir, uSkyTurbidity, uSunIntensity) * uSkyExposure, 1.0);
}
`;

/** Rademacher sequence shared by the convolution passes. */
const HAMMERSLEY = /* glsl */`
float pcHammersley(int i, int n) {
  float inv = 0.0, p = 0.5, bits = float(i);
  for (int k = 0; k < 24; k++) {
    if (k >= 16) break;
    inv += p * mod(bits, 2.0);
    bits = floor(bits * 0.5);
    p *= 0.5;
  }
  return inv;
}
`;

/** Cosine convolution — a full irradiance cube. 16×16 per face is plenty. */
export const irradianceShader = /* glsl */`
#include <pc_common>
${HAMMERSLEY}
uniform samplerCube uSource;
varying vec3 vDir;

void main() {
  vec3 N = normalize(vDir);
  vec3 up = abs(N.y) < 0.999 ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0);
  vec3 right = normalize(cross(up, N));
  up = cross(N, right);

  vec3 sum = vec3(0.0);
  const int SAMPLES = 64;
  for (int i = 0; i < SAMPLES; i++) {
    vec2 xi = vec2(float(i) / float(SAMPLES), pcHammersley(i, SAMPLES));
    float phi = 6.28318530718 * xi.x;
    float cosT = sqrt(1.0 - xi.y);        // cosine-weighted: uniform over the disc
    float sinT = sqrt(xi.y);
    vec3 dir = cos(phi) * sinT * right + sin(phi) * sinT * up + cosT * N;
    sum += textureCube(uSource, dir).rgb;
  }
  gl_FragColor = vec4(sum / float(SAMPLES), 1.0);
}
`;

/** GGX importance sampling — one mip level of the prefiltered specular cube. */
export const prefilterShader = /* glsl */`
#include <pc_common>
#include <pc_pbr>
uniform samplerCube uSource;
uniform float uRoughness;
uniform float uSourceSize;
varying vec3 vDir;

vec3 pcImportanceGGX(vec2 xi, vec3 N, float rough) {
  float a = rough * rough;
  float phi = 6.28318530718 * xi.x;
  float cosT = sqrt(max(0.0, (1.0 - xi.y) / (1.0 + (a * a - 1.0) * xi.y + 1e-6)));
  float sinT = sqrt(max(0.0, 1.0 - cosT * cosT));
  vec3 h = vec3(cos(phi) * sinT, sin(phi) * sinT, cosT);
  vec3 up = abs(N.z) < 0.999 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
  vec3 tx = normalize(cross(up, N));
  vec3 ty = cross(N, tx);
  return normalize(tx * h.x + ty * h.y + N * h.z);
}

void main() {
  vec3 N = normalize(vDir);
  vec3 V = N;                            // split-sum assumption: V == R == N
  const int SAMPLES = 48;
  vec3 sum = vec3(0.0);
  float total = 0.0;
  for (int i = 0; i < SAMPLES; i++) {
    vec2 xi = vec2(float(i) / float(SAMPLES), fract(float(i) * 0.6180339887 + 0.5));
    vec3 H = pcImportanceGGX(xi, N, uRoughness);
    vec3 L = normalize(2.0 * dot(V, H) * H - V);
    float NoL = dot(N, L);
    if (NoL > 0.0) {
      float NoH = pcSaturate(dot(N, H));
      // Mip selection from the sample solid angle removes the fireflies that
      // plague naive prefiltering (Karis' trick).
      float pdf = pcD_GGX(NoH, uRoughness * uRoughness) * 0.25 + 1e-4;
      float saTexel = 4.0 * PI / (6.0 * uSourceSize * uSourceSize);
      float saSample = 1.0 / (float(SAMPLES) * pdf + 1e-4);
      float mip = max(0.5 * log2(saSample / saTexel), 0.0);
      sum += textureCube(uSource, L, mip).rgb * NoL;
      total += NoL;
    }
  }
  gl_FragColor = vec4(sum / max(total, 1e-4), 1.0);
}
`;

/** Split-sum second term: the F0 scale/bias for a given (NdotV, roughness). */
export const brdfLutShader = /* glsl */`
#include <pc_common>
#include <pc_pbr>
varying vec2 vUv;

float pcG_SchlicksmithGGX(float NoV, float NoL, float rough) {
  float k = (rough * rough) * 0.5;
  float gv = NoV / (NoV * (1.0 - k) + k);
  float gl = NoL / (NoL * (1.0 - k) + k);
  return gv * gl;
}

vec3 pcImportanceGGX2(vec2 xi, vec3 N, float rough) {
  float a = rough * rough;
  float phi = 6.28318530718 * xi.x;
  float cosT = sqrt(max(0.0, (1.0 - xi.y) / (1.0 + (a * a - 1.0) * xi.y + 1e-6)));
  float sinT = sqrt(max(0.0, 1.0 - cosT * cosT));
  vec3 h = vec3(cos(phi) * sinT, sin(phi) * sinT, cosT);
  vec3 up = abs(N.z) < 0.999 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
  vec3 tx = normalize(cross(up, N));
  vec3 ty = cross(N, tx);
  return normalize(tx * h.x + ty * h.y + N * h.z);
}

void main() {
  float NoV = max(vUv.x, 0.002);
  float rough = max(vUv.y, 0.002);
  vec3 V = vec3(sqrt(1.0 - NoV * NoV), 0.0, NoV);
  vec3 N = vec3(0.0, 0.0, 1.0);
  float A = 0.0, B = 0.0;
  const int SAMPLES = 128;
  for (int i = 0; i < SAMPLES; i++) {
    vec2 xi = vec2(float(i) / float(SAMPLES), fract(float(i) * 0.6180339887 + 0.5));
    vec3 H = pcImportanceGGX2(xi, N, rough);
    vec3 L = normalize(2.0 * dot(V, H) * H - V);
    float NoL = pcSaturate(L.z);
    if (NoL > 0.0) {
      float NoH = pcSaturate(H.z);
      float VoH = pcSaturate(dot(V, H));
      float G = pcG_SchlicksmithGGX(NoV, NoL, rough);
      float GVis = G * VoH / max(NoH * NoV, 1e-4);
      float Fc = pcPow5(1.0 - VoH);
      A += (1.0 - Fc) * GVis;
      B += Fc * GVis;
    }
  }
  gl_FragColor = vec4(A / float(SAMPLES), B / float(SAMPLES), 0.0, 1.0);
}
`;

/** Background pass: full-screen triangle, ray from the inverse view-projection. */
export const skyFragmentShader = /* glsl */`
#include <pc_common>
#include <pc_sky>
uniform mat4 uInvViewProjection;
uniform vec3 uCameraPosition;
uniform float uBackgroundIntensity;
uniform samplerCube uRadiance;
varying vec2 vUv;

void main() {
  vec4 far = uInvViewProjection * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 dir = normalize(far.xyz / far.w - uCameraPosition);
#ifdef PC_SKY_ANALYTIC
  vec3 col = pcSkyColor(dir);
#else
  vec3 col = textureCube(uRadiance, dir).rgb;
#endif
  gl_FragColor = vec4(col * uBackgroundIntensity, 1.0);
}
`;

export const SKY_DEFAULTS = {
  zenith: [0.16, 0.32, 0.62],
  horizon: [0.62, 0.72, 0.86],
  ground: [0.18, 0.18, 0.2],
  sunDirection: [0.35, 0.62, 0.7],
  sunColor: [1.0, 0.96, 0.9],
  sunIntensity: 10.0,
  turbidity: 1.0,
  exposure: 1.0,
  groundBlend: 0.0,
  backgroundIntensity: 1.0,
  iblIntensity: 1.0
};
