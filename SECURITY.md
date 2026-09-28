# Security policy

## Supported version

Only `main`. This is a single-developer project; there are no release tags and
no backport targets.

## Reporting a vulnerability

Please do **not** open a public issue. Use GitHub's private reporting form
(**Security → Report a vulnerability** on this repository).

Include: what happens, what you expected, how to reproduce, and the output of
**Help → Capabilities** in the editor if the issue is rendering-related. You
should get an acknowledgement within a few days.

## Known, intentional limitations

These are documented behaviour, not undisclosed vulnerabilities. They are
listed here because a security-minded reader should not have to find them.

### The development server has no authentication

`server/server.js` serves the static app and a small REST API for project
files, with `access-control-allow-origin: *` and no credentials of any kind.

- It **binds loopback (`127.0.0.1`) by default.** `npm start` is not reachable
  from the network.
- `--host 0.0.0.0` is opt-in and prints a warning on startup. If you use it,
  anyone who can reach that port can read, overwrite and delete the JSON
  projects in the `--data` directory (`.lumen/` by default). Do not use it on a
  network you do not control.
- **Do not deploy `server/server.js` as-is.** There is no TLS, no auth, no
  rate limit, no CSRF protection and no per-user isolation. Put a real reverse
  proxy in front of it, or do not expose it.

### The static build is safe to host anywhere

The GitHub Pages deployment is a plain static bundle: `index.html`, the ES
module graph under `src/`, and the documentation. There is no server-side
component, no credentials in the client, and no network calls to any third
party. The editor stores projects in `localStorage` and, only if an API answers
on the same origin, mirrors them there — on a static host there is no API and
it stays entirely local.

### Asset handling

Imported `.obj`, `.stl` and `.gltf` files are parsed in the browser. Textures
are decoded locally and uploaded from `Blob`/`ArrayBuffer` where possible, so
imported models do not taint the drawing buffer and cannot be used to make
`readPixels` throw. The one readback in the project reads a single pixel from
our own render target.

GLSL in this repository is first-party. The transpiler is not a sandbox, and no
code path compiles shader source received from an imported project file — so
there is no untrusted-shader execution surface to harden today. If that ever
changes, it needs a real answer before it ships.
