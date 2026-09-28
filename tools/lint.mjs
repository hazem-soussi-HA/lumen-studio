/**
 * Project lint.
 *
 * There is no bundler in this project, so "linting" is deliberately small and
 * dependency-free:
 *
 *   1. every .js module must parse as an ES module (a stray backtick inside a GLSL
 *      template literal, for instance, is a *syntax* error in the browser and
 *      nothing else would catch it before a user does);
 *   2. every local import must resolve to a file that exists and exports the name;
 *   3. a few house rules that the WebGL side depends on.
 *
 * Run with `npm run lint`.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, dirname, resolve, extname } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const SKIP = new Set(['node_modules', 'chrome', '.git', 'test', 'tools', 'output', 'docs']);
const problems = [];
const files = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (extname(p) === '.js') files.push(p);
  }
}
walk(join(ROOT, 'src'));

/* ---------------------------------------------------------- 1. syntax -- */

const exportsOf = new Map();

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const rel = relative(ROOT, file);
  // `node --check` parses the file as the module it is (these are all ES modules)
  // without executing it. That is what catches a stray backtick inside a GLSL
  // template literal — a syntax error in the browser that nothing else would see.
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (res.status !== 0) {
    const msg = (res.stderr || '').split('\n').find((l) => /Error/.test(l)) || 'parse error';
    problems.push(`${rel}: ${msg.replace(process.cwd() + '/', '')}`);
    continue;
  }
  const names = new Set();
  // `export` may follow a same-line comment, so do not anchor to the line start.
  for (const m of src.matchAll(/(?:^|[^.\w$])export\s+(?:async\s+)?(?:class|function|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const t = part.trim().split(/\s+as\s+/);
      if (t.length) names.add((t[1] || t[0]).trim());
    }
  }
  if (/^export\s+default/m.test(src)) names.add('default');
  exportsOf.set(resolve(file), names);
}

/* ---------------------------------------------------------- 2. imports -- */

const importRe = /import\s+(?:([\w$]+)\s*,\s*)?(?:\{([^}]*)\}|([\w$*]+)|\*\s*as\s+([\w$]+))?\s*(?:from\s*)?['"]([^'"]+)['"]/g;

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const rel = relative(ROOT, file);
  for (const m of src.matchAll(importRe)) {
    const spec = m[5];
    if (!spec.startsWith('.')) continue;              // bare specifier: node_modules
    const target = resolve(dirname(file), spec);
    if (!existsFile(target)) {
      problems.push(`${rel}: import '${spec}' does not resolve`);
      continue;
    }
    const names = exportsOf.get(target);
    if (!names) continue;                              // target failed to parse
    const named = (m[2] || '').split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
    for (const n of named) {
      if (!names.has(n)) problems.push(`${rel}: '${n}' is not exported by ${relative(ROOT, target)}`);
    }
    if ((m[3] || m[4]) && !names.has('default') && m[3]) {
      problems.push(`${rel}: '${spec}' has no default export`);
    }
  }
}

/* ------------------------------------------------------- 3. house rules -- */

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const rel = relative(ROOT, file);
  const rel2 = rel.replace(/\\/g, '/');
  const isGLSL = rel2.includes('/gl/shaders/');
  const isServer = rel2.startsWith('server/');

  // GLSL must be authored neutrally: the transpiler injects #version and the
  // precision qualifiers, and varyings are rewritten per dialect.
  if (isGLSL) {
    for (const [i, line] of src.split('\n').entries()) {
      if (/^\s*#version/.test(line)) problems.push(`${rel}:${i + 1}: hard-coded #version (the transpiler adds it)`);
      if (/^\s*precision\s+(lowp|mediump|highp)\s+float/.test(line)) problems.push(`${rel}:${i + 1}: hand-written precision qualifier`);
      if (/\bin\s+\w+\s*(==|!=)\s*\d+/.test(line)) problems.push(`${rel}:${i + 1}: integer compare breaks on GLSL ES 1.00`);
    }
  }

  // The editor and engine run in the browser: no node built-ins, no CommonJS.
  if (!isServer && rel2.startsWith('src/')) {
    for (const m of src.matchAll(/from\s+['"](node:[^'"]+|fs|path|child_process)['"]/g)) {
      problems.push(`${rel}: browser module must not import '${m[1]}'`);
    }
    if (/\brequire\s*\(/.test(src)) problems.push(`${rel}: CommonJS require() in a browser module`);
  }

  // Console noise: the logger is the supported channel.
  for (const [i, line] of src.split('\n').entries()) {
    if (/\bconsole\.(log|debug)\s*\(/.test(line)) problems.push(`${rel}:${i + 1}: console.log — use this.log`);
  }

  // Trailing whitespace and tabs in indentation.
  for (const [i, line] of src.split('\n').entries()) {
    if (/[ \t]+$/.test(line)) problems.push(`${rel}:${i + 1}: trailing whitespace`);
    if (/^\t/.test(line)) problems.push(`${rel}:${i + 1}: tab indentation (this project uses 2 spaces)`);
  }
}

function existsFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

/* ------------------------------------------------------------- report -- */

const unique = [...new Set(problems)];
if (unique.length) {
  console.error(`\nlint: ${unique.length} problem${unique.length === 1 ? '' : 's'} in ${files.length} files\n`);
  for (const p of unique) console.error(`  ${p}`);
  console.error('');
  process.exit(1);
}
console.log(`lint: ${files.length} modules clean (syntax, imports, GLSL authoring rules, house style)`);
