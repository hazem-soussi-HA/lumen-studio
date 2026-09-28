# WebGL concept → implementation map

A traceability map from the subject matter of the French Wikipedia article on **WebGL**
to the code in this repository. It is organised by concept rather than by article
section, because the article's sections are ordered for a general reader while this
file is read by someone looking for "where is this implemented, and what bit us".

Each row is a claim about how WebGL works, the file that implements it, and — where it
mattered — the concrete failure that taught the lesson. Every "gotcha" below actually
happened in this codebase and is now covered by a check in `test/smoke.mjs` or
`npm run lint`.

---

## 1. What WebGL is

| Concept | Where | Note |
|---|---|---|
| WebGL is a JavaScript binding of a subset of OpenGL ES 2.0 — a thin API over the driver, with no scene graph, no camera, no material system, no file format | `src/gl/` | Everything above `gl/` is this project's own invention. The GL layer has no opinions about entities. |
| The API is a **state machine**: current program, bound buffers, bound textures, enabled capabilities, blend/depth/stencil state | `src/gl/context.js` | A state cache in front of the GL object. Every setter compares against the cache and skips redundant calls; this is most of the reason the frame graph is cheap. |
| Draw order follows call order; the pipeline is vertex → rasterisation → fragment | `src/render/renderer.js` | Passes are an explicit ordered list, not a dependency graph. Sorting within a pass is where the correctness lives (opaque front-to-back, transparent back-to-front). |
| The API is **asynchronous**; `finish()` and readbacks synchronise | — | Nothing calls `finish()`. The only readbacks are one-pixel id reads, deliberately, after an explicit render. |

## 2. Getting a context

| Concept | Where | Note |
|---|---|---|
| A context comes from a canvas with `getContext('webgl' \| 'webgl2' \| 'experimental-webgl')` | `src/gl/capabilities.js:116` | `experimental-webgl` was the pre-standard name. It is tried last, only after `webgl2` and `webgl` fail, and never assumed to exist. |
| `webgl2` is ES 3.0; `webgl` is ES 2.0 with extensions | `src/gl/capabilities.js:70` | Attribute lists differ per version. The context records which one it got and every feature check is keyed off that. |
| Context creation can fail, and can be lost (driver reset, GPU process crash, tab suspension) | `src/gl/context.js:77` | Every resource implements `_onContextLost` (drop all GL names) and `_onContextRestored` (recreate). Framebuffers replay their attachments and draw buffers, because a fresh GL framebuffer starts empty. Covered by the context loss/restore check. |
| A lost context should be prevented from restoring by default, then deliberately restored | `src/gl/context.js:61` | `preventDefault()` on the loss event, restore on demand, so a transient loss does not silently produce black frames while the user is mid-gesture. |

## 3. Shaders and programs

| Concept | Where | Note |
|---|---|---|
| Shaders are written in GLSL ES and compiled per program; two stages (vertex, fragment) must link | `src/gl/program.js` | Programs are cached by `(source, defines)` and reference-counted. A material change that alters a define compiles one new variant and releases the old. |
| Shaders are written in one dialect here and transpiled to ES 1.00 and 3.00 | `src/gl/program.js:37` `transpile()` | The linter (`npm run lint`) enforces the authoring rules that make the dual dialect possible: no hand-written `#version`, no `precision` (injected), `varying` on both stages, constant loop bounds, no bitwise ops, no integer `%`. |
| Precision must be declared; `highp` in fragment shaders is not always available | `src/gl/program.js` | Precision is injected per stage, with a fallback chain, because ESSL 1.00 permits declaring different defaults for vertex and fragment shaders. |
| Uniforms are typed; attribute locations are assigned by the driver and differ per program | `src/gl/mesh.js:185` | The VAO cache is keyed by `(program, instanced?)`. A location live in one program and optimised out in another must not inherit the old layout — reusing the VAO naively is a silent corruption bug. |
| Textures cannot be read in a vertex shader without an extension on ES 1.00 | `src/gl/shaders/pbr.js` | The shadow lookup is deliberately in the fragment stage for exactly this reason, and vertex-stage world-position varyings are used instead. |

## 4. Buffers, meshes, instancing

| Concept | Where | Note |
|---|---|---|
| Geometry lives in buffer objects bound to attribute pointers | `src/gl/buffer.js`, `src/gl/mesh.js` | One `Mesh` owns its vertex/index buffers and its VAOs. |
| VAOs (core in ES 3.0) group attribute state so binding is one call | `src/gl/mesh.js:193` | `createVertexArray` is used when available; on WebGL 1 the attribute state is re-applied per draw. Divisors are VAO state on ES 3.0 and must be reset when leaving an instanced draw. |
| Instanced drawing (`drawElementsInstanced` on ES 3.0, `ANGLE_instanced_arrays` on ES 2.0) draws N copies in one call | `src/gl/mesh.js:296` `InstanceBuffer` | Per-instance transforms are uploaded as four `vec4` attributes, not a `mat4`: ESSL 1.00 lets a matrix attribute consume four consecutive slots and drivers disagree on the stride, so both paths get byte-identical data. |
| An instanced draw requires the instance attribute stream to be *bound* | `src/gl/mesh.js:127` | **Gotcha.** Issuing `drawElementsInstanced` while the VAO was bound without the instance stream leaves `aInst*` at their default `0,0,0,1` — a zero matrix. Every instance collapses to a degenerate triangle and the draw call is issued, so draw-call counters look healthy while nothing rasterises. Caught by the "instanced ring draws and picks" check. |
| Element indices are 16-bit unless `OES_element_index_uint` is present | `src/gl/capabilities.js` | The mesh builder picks the index width from the capability, not from the vertex count. |

## 5. Textures

| Concept | Where | Note |
|---|---|---|
| Textures are 2D, cube, or (ES 3.0) 3D; cube maps take six separate faces | `src/gl/texture.js:48` | `texImage2D(TEXTURE_CUBE_MAP, ...)` is an `INVALID_ENUM`: each face must be uploaded separately. Allocating the cube in one call is a classic. |
| Mipmaps: `generateMipmap`, per-level storage, LOD bias | `src/gl/texture.js` | A mipmapped render target must allocate *all* levels itself; a render target allocated at level 0 only is sampled as black at LOD > 0. The radiance cube generates its mips for the same reason. |
| NPOT textures are limited in ES 2.0 (no mipmaps, restricted wrap) | `src/gl/capabilities.js` | The capability object records it; the transpiler and texture code branch on `isWebGL2`. |
| Texture units are a fixed, small resource | `src/render/renderer.js` `UNIT` | A single named unit table (`diffuse`, `normal`, `screen`, `occlusion`, …) is shared by every pass, so a pass cannot leak a unit binding into the next one. |
| Anisotropic filtering is an extension | `src/gl/texture.js` | Optional, applied when available. |

## 6. Framebuffers and render targets

| Concept | Where | Note |
|---|---|---|
| Rendering to a texture requires a framebuffer object and a check of its completeness | `src/gl/framebuffer.js:56` | `checkFramebufferStatus` runs on every attach; an incomplete target warns instead of failing silently at draw time. |
| A render target is a composition: N colour attachments, optional depth (texture *or* renderbuffer), optional MSAA | `src/gl/framebuffer.js:139` `RenderTarget` | Depth-as-texture is needed for SSAO and soft particles; depth-as-renderbuffer is cheaper and not readable. The renderer picks from the capability report. |
| Multiple render targets (MRT) need `drawBuffers` | `src/gl/framebuffer.js:74` | ES 3.0 has it natively; ES 2.0 needs `WEBGL_draw_buffers`, which is a *different API with different enum values* (`COLOR_ATTACHMENT0_WEBGL` etc.). Calling `gl.drawBuffers` there is a `TypeError`, not a fallback. |
| A depth-only pass must not leave a colour draw buffer active | `src/gl/framebuffer.js:222` | ES 3.0 treats an active draw buffer with no matching fragment output as `INVALID_OPERATION`, not as a warning. Depth-only targets call `setDrawBuffers([NONE])`. |
| MSAA is resolved with `blitFramebuffer` from a multisampled FBO | `src/gl/framebuffer.js:256` | The resolve binds READ and DRAW framebuffers separately; the post chain then samples the single-sample texture. |
| The viewport is a rectangle in the target, not the canvas | `src/gl/context.js:147` | `applyViewport(target)` derives it from whichever target is bound, which is why every pass binds through `RenderTarget.bind()`. |
| Render targets are sized in device pixels, the canvas box is in CSS pixels | `src/gl/context.js:126`, `src/editor/editor.js` `_syncBackingStore` | **Gotcha.** The editor layout resizes the canvas element without any window event. Sizing the targets only on `window.resize` leaves the whole frame rendered into a stale target and stretched to fit — a 1×1 target is valid, silent, and catastrophic. A `ResizeObserver` plus a per-frame poll now drives it. |

## 7. Depth, blending, transparency

| Concept | Where | Note |
|---|---|---|
| The depth test and depth write decide occlusion; `less` is the useful comparison | `src/render/renderer.js` | Opaque geometry is sorted front-to-back so early-Z rejects before the fragment shader runs. |
| Blending is per-draw state, not per-object state | `src/render/renderer.js:691` | Transparent items are sorted back-to-front and drawn with depth-write off; the material chooses the blend mode. |
| Transparency has no correct sort order in general | `src/editor/editor.js` | The volume pass exists partly because fog cannot be expressed as per-object alpha without sorting artefacts. |

## 8. Picking — the article's "how do I know what I clicked"

WebGL offers no picking. There are three honest options, and this project uses the
third:

1. CPU ray casting against mesh geometry — duplicating the transform and intersection
   maths, and getting it subtly wrong;
2. re-rendering the scene on the CPU with a rasteriser;
3. **an id buffer**: render the scene with a fragment shader that writes a unique colour
   per object, then read back one pixel.

| Concept | Where | Note |
|---|---|---|
| The id buffer is a render target; selection is one `readPixels` of 1×1 | `src/render/renderer.js:916` `_renderPicking` | 24-bit ids packed into RGB; alpha 0 means "nothing here", which is why the buffer is cleared to `(0,0,0,0)`. |
| The id pass must draw the *same* geometry as the frame | `src/render/renderer.js:916` | **Gotcha.** An instanced entity occupies N places, so the id pass has to draw the same N instance matrices. Drawing a single copy paints an id over geometry that is not on screen, and the click returns an entity the user cannot see. |
| An on-demand pick must re-collect the scene, not reuse the last frame's draw list | `src/render/renderer.js:934` `pick()` | Otherwise a pick after a hide/move answers from stale state. Collection is pure CPU work, so it is cheap. |
| A readback must be `readPixels` from a framebuffer, and the state cache must be invalidated afterwards | `src/render/renderer.js:940` | Binding a framebuffer out from under the cache is exactly the case the cache cannot know about. |
| Reading the *canvas* is a different problem: without `preserveDrawingBuffer` it is empty outside the drawing task | `src/main.js` `pixelProbe` | The test harness copies the canvas to a 2D canvas in the same task as the draw. |

## 9. Transformations

| Concept | Where | Note |
|---|---|---|
| Transforms are 4×4 matrices, composed parent→child, with a separate normal matrix | `src/scene/entity.js`, `src/core/math.js` | The world matrix is cached and dirty-flagged; the normal matrix is the inverse-transpose. |
| Angles in GLSL are radians | `src/core/math.js` | `rad`/`deg` helpers, and the Euler extraction is round-trip tested — getting the composition order or the extraction wrong produces a rotation that is subtly wrong only at certain angles. |

## 10. Extensions and capability detection

| Concept | Where | Note |
|---|---|---|
| WebGL 1 reaches ES 3.0 features through extensions: `OES_element_index_uint`, `OES_standard_derivatives`, `WEBGL_draw_buffers`, `WEBGL_color_buffer_float`, `WEBGL_depth_texture`, `ANGLE_instanced_arrays`, `EXT_texture_filter_anisotropic`, `EXT_blend_minmax`, `EXT_disjoint_timer_query` | `src/gl/capabilities.js:26` `EXT_V1` | A named table, not scattered `getExtension` calls, so the capability report can list what is missing and the UI can show it. |
| An extension object is different per API version: `ANGLE_instanced_arrays` has methods, ES 3.0 has core methods | `src/gl/mesh.js`, `src/gl/program.js` | The code branches on `caps.isWebGL2` at every site where the two differ, including `vertexAttribDivisor` vs `vertexAttribDivisorANGLE` and the draw-buffer enums. |
| Get an extension as early as possible; some are lost if the context is created with the wrong attributes | `src/gl/capabilities.js:116` | Context creation is attempted with progressive attribute sets, and extensions are collected immediately after the first context that works. |
| A capability report, not user-agent sniffing | `src/gl/capabilities.js:240` | The tier is scored from the context version, limits, extension set, and the unmasked renderer string. Nothing anywhere tests for a browser name. |
| `WEBGL_debug_renderer_info` is itself gated | `src/gl/capabilities.js` | Unmasked renderer strings are only read when the extension is present, and the software-renderer check is a string test on that value — the only honest way to detect SwiftShader/llvmpipe. |

## 11. WebGL 2 / ES 3.0 differences actually used

| Feature | Used for | Where |
|---|---|---|
| Instanced rendering (core) | colonnade, scatter layouts | `src/gl/mesh.js` |
| Vertex array objects (core) | one VAO per (program, mode) | `src/gl/mesh.js:193` |
| `sampler2DShadow` + `TEXTURE_COMPARE_MODE` | hardware PCF, slope-scaled shadow bias | `src/gl/texture.js:113` |
| `sampler3D` | ray-marched fog volumes | `src/gl/texture.js:210` |
| Float/half-float colour buffers | HDR lighting before tone mapping | `src/gl/framebuffer.js` |
| Depth textures (core) | SSAO from the depth buffer | `src/render/renderer.js:898` |
| Non-constant loop bounds, `in/out`, integer types | the transpiler's escape hatches | `src/gl/program.js` |
| `gl_InstanceID`, `gl_VertexID`, `gl_FragDepth` | available; not yet used | — |

Where ES 3.0 is absent, the fallback is: a 2D tile atlas for 3D textures, a
`type === 'lowp'|'mediump'|'highp'` chain for precision, and a brute-force 2D+shade
approximation for the environment BRDF (`uBrdfLutEnabled = 0`).

## 12. Performance

| Concept | Where | Note |
|---|---|---|
| State changes are expensive; batch by program and by geometry | `src/render/renderer.js:521` | Instanced requests sharing `(mesh, material, layout, spread)` merge into one draw. |
| Overdraw is expensive; sort front-to-back | `src/render/renderer.js` `_collect` | Opaque sorted by distance, transparent reversed. |
| Frustum culling before drawing | `src/render/renderer.js:308` | Per entity AABB, from the GPU mesh via the scene's mesh resolver. Instanced entities get a box grown to enclose every instance. |
| Overdraw and fill rate are the budget, not triangle count | `src/gl/capabilities.js:275` | The tier table scales shadow map size, MSAA, DPR, and post passes, which is what actually costs. |
| Do not render when nothing changed | `src/editor/editor.js:306` | The editor is event-driven with a 4 Hz heartbeat. |
| Cap the backing store on high-DPI displays | `src/gl/context.js:126` | `maxDPR` comes from the tier; a 3× retina canvas is 9× the fill cost. |

## 13. Security and the origin rules

| Concept | Where | Note |
|---|---|---|
| An image from another origin taints the canvas and makes `readPixels` throw | `src/gl/texture.js` | Textures are uploaded from `Blob`/`ArrayBuffer` and decoded locally wherever possible, so imported models never taint the drawing buffer. |
| `readPixels` on a tainted canvas is a security error, not a warning | `src/render/renderer.js:940` | The only readback in the project is from our own render target, which is never tainted. |
| Cookies and credentials are sent with cross-origin requests unless restricted | `server/server.js` | The dev server sets `x-content-type-options: nosniff` and answers CORS preflights permissively (`*`) — acceptable for a local static dev server, and the reason it must never be exposed publicly as-is. |
| Untrusted GLSL is a denial-of-service risk (infinite loops, huge allocations) | `src/gl/program.js` | Shaders are first-party here; the transpiler is not a sandbox, and nothing in the project compiles shader source received from a project file. |

## 14. Compatibility and limits

| Concept | Where | Note |
|---|---|---|
| Support is per browser, per driver, per GPU, and per OS | `src/gl/capabilities.js` | The report is shown in the UI (Help → Capabilities) so a bug report can start with the numbers. |
| Software rasterisers work but are 2–3 orders of magnitude slower | `src/gl/capabilities.js:275` | Detected from the unmasked renderer string; the tier drops MSAA, post, IBL and shadow resolution. The smoke test runs entirely in this tier. |
| Context loss is normal on real hardware | `src/gl/context.js` | Resources rebuild from their descriptors; the scene document is untouched, so nothing is lost but the frame. |
| `EXT_disjoint_timer_query` results are asynchronous and frequently unavailable | `src/gl/capabilities.js` | Detected, not yet consumed — the stats panel reports CPU-side frame time only. |

---

## Where the article stops and this project starts

Everything in sections 1–14 is WebGL: what the API guarantees, what it forbids, and
which of its many footguns actually bite. Everything below is invention, and carries
no authority from the article:

* the scene graph, components, undo/redo and the command system (`src/scene/`,
  `src/core/history.js`, `src/core/commands.js`);
* the PBR model itself (GGX, Smith, the split-sum approximation) — that is
  *physically based rendering*, a separate literature;
* cascaded shadow maps, SSAO, bloom, ACES;
* the IBL convolution (SH projection, roughness prefilter chain, BRDF LUT);
* the editor, the importers, the asset store, the demo scene.

The engine's own rules — dual-dialect GLSL, capability-driven budgeting, element-box
resize tracking — are engineering decisions, documented with their reasons in
[`ARCHITECTURE.md`](ARCHITECTURE.md).
