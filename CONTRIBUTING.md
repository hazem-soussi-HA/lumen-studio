# Contributing

Thanks for looking. The short version: `npm install`, `npm start`, and
`npm test` should be enough to build and verify a change.

## The constraints this project works within

These are not preferences. Breaking one is a rejected PR.

- **No engine, no framework, no bundler, no build step.** `index.html` loads
  ES modules and the browser resolves the graph. Do not add a bundler, a
  transpiler for JavaScript, or a `node_modules` runtime dependency.
- **One neutral GLSL source tree, compiled to ES 3.00 and 1.00.** The
  transpiler in `src/gl/program.js` is a small set of rules, not a compiler.
  `npm run lint` enforces them: no hand-written `#version`, no `precision`
  (it is injected), `varying` in both stages, constant loop bounds, no
  bitwise operators, no integer `%`.
- **A capability report, never user-agent sniffing.** The tier table in
  `src/gl/capabilities.js` is scored from the context version, the extension
  registry, driver limits and the unmasked renderer string. If a feature needs
  to be unavailable on weak hardware, score it, do not detect a browser.
- **Degrade honestly.** A software rasteriser gets a smaller budget, not a
  broken frame. The smoke test runs entirely in the `software` tier and still
  has to produce a correct image.
- **First-party shaders only.** The GLSL transpiler is not a sandbox. Nothing
  in this repository compiles shader source that arrived from a project file.

## Getting set up

```bash
npm install                                   # puppeteer-core, for the tests only
npx @puppeteer/browsers install chrome@stable # lands in ./chrome, picked up automatically
npm start                                     # http://localhost:8080
npm run lint
npm test                                      # 30 checks in headless Chrome
```

The smoke test needs no GPU — it runs Chrome with SwiftShader.

## Making a change

1. Branch off `main`.
2. Keep the module you are touching self-contained. The dependency graph is
   one-directional: `core/` knows about nothing, `gl/` knows about `core/`,
   `render/` and `scene/` know about `gl/`, `editor/` knows about everything.
   `npm run lint` checks this.
3. If you touched the renderer, say so in the PR and say which pass changed.
4. If you hit a WebGL footgun, document it. `docs/WEBGL-ARTICLE-MAP.md` is a
   table of concept → file → *the concrete failure that taught the lesson*.
   A new row with a real gotcha in it is one of the most useful contributions
   you can make.

## Tests

`test/smoke.mjs` is a real end-to-end test, not a compile check: it starts the
server, boots the editor, exercises the command registry, gizmo hit testing,
undo/redo, id-buffer picking on an instanced entity, context loss and restore,
and the GLSL transpiler in both dialects. It fails on any console error or
uncaught page error.

New behaviour that a user can see should come with a check here. It is a
plain array of named checks, and adding one is a few lines.

## Reporting bugs

Open an issue. Include the output of **Help → Capabilities** in the editor — it
answers most rendering questions outright.

## Licence

By contributing you agree that your contribution is licensed under the MIT
licence in [`LICENSE`](LICENSE).
