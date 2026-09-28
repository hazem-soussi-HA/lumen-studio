# Architecture

Notes on how Lumen Studio is put together and, more usefully, *why* — including the
places where the obvious implementation is wrong and what the WebGL rules forced
instead. The WebGL-specific decisions are cross-referenced in
[`WEBGL-ARTICLE-MAP.md`](WEBGL-ARTICLE-MAP.md).

## Layers

```
editor/    DOM, input, panels, commands        ← the only layer that knows about HTML
render/    cameras, passes, frame graph        ← knows about Entity and GL, not the DOM
scene/     entities, components, materials     ← pure data + maths, no GL calls
gl/        thin, explicit WebGL 1/2 abstraction
core/      maths, history, logger, storage     ← no dependencies upward
```

The dependency arrow points strictly downwards. `scene/` never calls `gl.*` directly:
asset *records* hold GPU handles that `gl/` owns, and `render/` is the only place that
decides when to draw them. That is what makes undo/redo trivial — a snapshot is JSON
and rebuilding a document touches no GL state at all.

## The GL layer

**`context.js`** owns the canvas, the resize policy and a *state cache*. The cache is
the reason the renderer can set state redundantly without paying for it: every setter
compares against `ctx._state` and skips the call when the value is unchanged. It is
invalidated wholesale on `bindFramebuffer` to a target it has not seen, and on context
restore, because VAOs and FBO bindings are the two things a context loss silently
drops.

**`program.js`** holds the GLSL transpiler. Authoring rules, enforced by the linter:

* one source tree, `varying` in both stages — the transpiler rewrites to `in`/`out`
* no hand-written `#version` and no `precision` qualifiers — both are injected
* loop bounds are compile-time constants; `break` on a uniform condition
* no bitwise operators, no `%` on integers, no `round`/`trunc`/`inverse` (all ESSL 3.00
  only)
* no texture lookups in vertex shaders — that needs `EXT_shader_texture_lod` on 1.00,
  and the shadower uses the fragment stage deliberately instead

Programs are cached by `(source, defines)` and are reference-counted, so a material
edit that changes a define compiles a new variant without leaking the old one.

**`mesh.js`** owns VAOs. The VAO cache is keyed by `program id + instanced?`, because
the attribute *locations* differ per program: a location that is live in one program
and optimised out in another must not keep the old layout. Instance transforms are
uploaded as four `vec4` attributes rather than a `mat4` attribute, because ESSL 1.00
lets a matrix attribute consume four consecutive slots and drivers disagree about the
stride. `ANGLE_instanced_arrays` and native `drawElementsInstanced` therefore take
byte-identical code paths.

**`texture.js` / `framebuffer.js`** provide textures (2D, cube, 3D, and a 3D→atlas
fallback) and render targets (N colour attachments, optional mip chain, depth as
texture or renderbuffer, optional MSAA with a resolve blit). A render target that is
depth-only sets `drawBuffers([NONE])` — ES 3.0 treats an active draw buffer with no
matching fragment output as `INVALID_OPERATION`, not as a warning.

## The frame graph

`Renderer.render()` is a fixed sequence of passes, each owning one render target:

```
shadow cascades → background → opaque → SSAO → transparent → volumes
                → grid → helpers → gizmos → post → (id buffer, on demand)
```

Ordering rules that are easy to get wrong:

* opaque is sorted **front to back** for early-Z; transparent back to front.
* instanced draws are grouped by `(mesh, material, layout, spread)` — the generated
  transforms differ per item, so two items can only share a draw when all four agree.
* the volume pass runs after transparent, because fog is composited over the scene.
* the id buffer is *not* part of the main frame. It re-renders only when the scene is
  dirty or a pick forces it — and a forced pick re-collects the scene first, or it
  would answer with the draw list from the previous frame.

Targets are sized from the canvas element box. A `ResizeObserver` on the canvas plus a
per-frame size poll both feed `_syncBackingStore()`. The window `resize` event alone is
not enough: dragging a splitter resizes the canvas without resizing the window, and
missing it leaves the whole frame rendered into a stale-size target and stretched to
fit — a 1×1 target is a valid, silent, catastrophic failure.

## Lighting

Forward, single pass, with everything in the same fragment shader:

* **Direct**: one directional light, up to 32 total (8 on a software tier), Cook-Torrance
  GGX with Smith height-correlated visibility and Schlick Fresnel. Omni and spot
  attenuation and cones are evaluated per light.
* **Shadows**: 2 cascades, practical split scheme, rendered as a depth-only pass into
  `DEPTH_COMPONENT24` textures read with `sampler2DShadow` (hardware PCF + bilinear
  comparison filtering). Slopes are applied in the shader for bias.
* **IBL**: the analytic sky is rendered to a 128² radiance cube on the CPU, convolved
  into 9 SH coefficients for irradiance and into 6 roughness mips for the specular
  lobe, plus a 128² split-sum BRDF LUT. The diffuse term keeps its `1/π` — dropping it
  is the classic "everything is a white blob" bug.
* **AO**: SSAO from the depth buffer on WebGL 2 only; the software tier drops it.

There is no deferred path and no light culling by cluster: at 32 lights a single pass
with a uniform array is simpler and, on the hardware this targets, faster than building
a G-buffer and resolving it.

## Scene representation

`Entity` is a transform + components + children. The world matrix is cached and dirty-
flagged; `worldAABB` is recomputed only when the transform or the mesh asset changes,
and the asset store provides a *mesh resolver* so an entity's bounds come from the
referenced GPU mesh rather than a unit cube.

Instanced entities are the one place where `worldAABB` is not enough: a single entity
occupies N places. The collector grows the box to enclose every generated instance
(`instanceExtent()`), because culling against the base mesh alone drops the entity when
the base mesh is off-screen but its instances are not, and the shadow fit volume would
otherwise ignore all of them.

Instance layouts are `grid`, `ring` and `scatter`. Scatter uses a deterministic hash
rather than `Math.random`, because a layout that changes every frame is not a scene,
it is noise.

## Editor

Commands (`src/core/commands.js`) are the single mutation API: a name, a category, a
keybinding, a run function, and an undo/redo pair. Every panel mutates through a
command, so undo is total rather than best-effort, and the command palette is not a
separate code path that could drift from the UI.

Selection and camera framing exclude entities that are not visibly geometry: a volume's
bounds mesh is a ray-marching proxy, and a material with `opacity: 0` draws nothing.
Framing either one fits an empty box several times larger than the content.

The editor is event-driven with a 4 Hz heartbeat: it renders when something changed,
and keeps a low-rate render so lights, animations and the stats overlay stay live.
That keeps an idle tab from pinning a GPU.

## Testing

`test/smoke.mjs` drives the real editor in headless Chrome (SwiftShader if there is no
GPU) and asserts on observable state — 29 checks covering the capability report, draw
counts, shader variants, a non-black frame, absence of GL errors, id-buffer picking
against known entities, instanced drawing *and* picking, material property
round-tripping, entity creation, property editing, undo/redo, gizmo geometry and hit
testing, the OBJ parser, both GLSL dialects, the debug views, the command registry,
context loss and restore, and that nothing logged an error.

Two of those checks exist because they were real bugs:

* `material options applied on create` — `createMaterial(name, opts)` only understood a
  preset wrapper, so every caller passing a flat options bag silently got default grey.
* `instanced ring draws and picks` — the draw issued an instanced call without binding
  the instance stream (every instance collapsed to a zero matrix), and the id pass drew
  a single copy, so clicking the middle of the screen returned a phantom pillar.

`npm run lint` parses every module, resolves every local import, checks the exported
name exists on the other side, and enforces the GLSL authoring rules and a few house
style rules — no dependencies, ~5 s for 42 modules.
