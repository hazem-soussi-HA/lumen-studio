/**
 * Lumen Studio — development / self-hosting server.
 *
 * Zero dependencies. Three responsibilities:
 *   1. Static file host for the ES-module engine + editor (correct MIME types,
 *      strong caching rules, byte-range-free but ETag-validated responses).
 *   2. A tiny REST surface for project persistence (the editor saves to
 *      localStorage first, then mirrors to the server when it is present).
 *   3. A Server-Sent Events channel so every open tab is notified when another
 *      tab commits a project — cheap collaborative "hot reload" of scene JSON.
 *
 *   node server/server.js [--port 8080] [--host 0.0.0.0] [--data .lumen]
 *
 *   The API surface has no authentication and answers CORS permissively, so the
 *   default bind is loopback. Binding anything else is opt-in and warns.
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/* ------------------------------------------------------------------ args -- */

function parseArgs(argv) {
  const out = { port: 8080, host: '127.0.0.1', data: path.join(ROOT, '.lumen') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') out.port = Number(argv[++i]);
    else if (a === '--host' || a === '-h') out.host = String(argv[++i]);
    else if (a === '--data') out.data = path.resolve(String(argv[++i]));
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

/* ------------------------------------------------------------------ mime -- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.hdr': 'image/vnd.radiance',
  '.ktx2': 'image/ktx2',
  '.bin': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.obj': 'text/plain; charset=utf-8',
  '.stl': 'application/sld',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.wasm': 'application/wasm'
};

/* ------------------------------------------------------------- utilities -- */

const LOOPBACK = /^(127(\.\d+){3}|::1|localhost)$/i;

const clients = new Set();

function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(frame); } catch { clients.delete(res); }
  }
}

function etagFor(stat) {
  return `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
}

function sendJSON(res, code, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'access-control-allow-origin': '*'
  });
  res.end(payload);
}

function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function ensureDataDir() {
  await fsp.mkdir(args.data, { recursive: true });
  await fsp.mkdir(path.join(args.data, 'projects'), { recursive: true });
}

function safeId(id) {
  return /^[A-Za-z0-9._-]{1,96}$/.test(id) ? id : null;
}

/* -------------------------------------------------------------- routing -- */

async function handleAPI(req, res, url) {
  const { pathname } = url;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,PUT,POST,DELETE,OPTIONS',
      'access-control-allow-headers': 'content-type'
    });
    return res.end();
  }

  if (pathname === '/api/health' && req.method === 'GET') {
    return sendJSON(res, 200, {
      ok: true,
      service: 'lumen-studio',
      version: '1.0.0',
      uptimeSeconds: Math.round(process.uptime()),
      node: process.version,
      subscribers: clients.size
    });
  }

  if (pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'access-control-allow-origin': '*'
    });
    res.write('retry: 2000\n\n');
    clients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 20000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }

  const m = /^\/api\/projects(?:\/([^/]+))?$/.exec(pathname);
  if (m) {
    const id = m[1] ? safeId(decodeURIComponent(m[1])) : null;
    if (m[1] && !id) return sendJSON(res, 400, { error: 'invalid project id' });
    const dir = path.join(args.data, 'projects');

    if (!id && req.method === 'GET') {
      const files = await fsp.readdir(dir).catch(() => []);
      const items = [];
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const stat = await fsp.stat(path.join(dir, f));
        let meta = {};
        try { meta = JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8')).meta || {}; } catch { /* partial */ }
        items.push({ id: f.slice(0, -5), size: stat.size, updated: stat.mtimeMs, ...meta });
      }
      items.sort((a, b) => b.updated - a.updated);
      return sendJSON(res, 200, { items });
    }

    if (id && req.method === 'GET') {
      try {
        const raw = await fsp.readFile(path.join(dir, `${id}.json`), 'utf8');
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(raw);
      } catch {
        return sendJSON(res, 404, { error: 'not found' });
      }
    }

    if (id && (req.method === 'PUT' || req.method === 'POST')) {
      const buf = await readBody(req);
      try { JSON.parse(buf.toString('utf8')); } catch { return sendJSON(res, 400, { error: 'invalid JSON' }); }
      await fsp.writeFile(path.join(dir, `${id}.json`), buf);
      broadcast('project:saved', { id, size: buf.length, at: Date.now() });
      return sendJSON(res, 200, { ok: true, id, size: buf.length });
    }

    if (id && req.method === 'DELETE') {
      await fsp.unlink(path.join(dir, `${id}.json`)).catch(() => {});
      broadcast('project:deleted', { id, at: Date.now() });
      return sendJSON(res, 200, { ok: true });
    }
  }

  return sendJSON(res, 404, { error: 'unknown endpoint', pathname });
}

/* --------------------------------------------------------------- static -- */

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const target = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!target.startsWith(ROOT)) return sendJSON(res, 403, { error: 'forbidden' });

  let stat;
  try { stat = await fsp.stat(target); } catch { return sendJSON(res, 404, { error: 'not found', path: rel }); }
  if (stat.isDirectory()) return serveStatic(req, res, new URL(url.pathname + '/index.html', 'http://x'));

  const etag = etagFor(stat);
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag });
    return res.end();
  }

  const ext = path.extname(target).toLowerCase();
  const headers = {
    'content-type': MIME[ext] || 'application/octet-stream',
    'content-length': stat.size,
    etag,
    'last-modified': stat.mtime.toUTCString(),
    // Source must always be revalidated; only heavy binaries may cache hard.
    'cache-control': /\.(png|jpg|jpeg|webp|gif|bmp|woff2|ktx2|glb|bin|hdr|wasm)$/.test(ext)
      ? 'public, max-age=604800'
      : 'no-cache',
    'x-content-type-options': 'nosniff'
  };

  if (req.method === 'HEAD') { res.writeHead(200, headers); return res.end(); }
  res.writeHead(200, headers);
  fs.createReadStream(target).pipe(res);
}

/* ----------------------------------------------------------------- boot -- */

async function main() {
  await ensureDataDir();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const done = (err) => {
      if (!err) return;
      console.error('[lumen] request failed:', err.message);
      if (!res.headersSent) sendJSON(res, 500, { error: 'internal error' });
      else res.end();
    };
    if (url.pathname.startsWith('/api/')) handleAPI(req, res, url).catch(done);
    else serveStatic(req, res, url).catch(done);
  });

  server.listen(args.port, args.host, () => {
    const shown = args.host === '0.0.0.0' ? 'localhost' : args.host;
    console.log('');
    console.log('  \x1b[1mLumen Studio\x1b[0m  \x1b[2m· WebGL engine + editor\x1b[0m');
    console.log(`  \x1b[36mhttp://${shown}:${args.port}/\x1b[0m`);
    console.log(`  \x1b[2mdata: ${args.data}\x1b[0m`);
    console.log(`  \x1b[2mdigest: ${crypto.createHash('sha1').update(ROOT).digest('hex').slice(0, 12)}\x1b[0m`);
    console.log('');
    if (!LOOPBACK.test(args.host)) {
      console.log('  \x1b[33m! Binding to a non-loopback address.\x1b[0m');
      console.log('  \x1b[2m  /api/projects has no authentication and CORS is "*", so anyone who can');
      console.log('  reach this port can read, overwrite and delete stored projects. Only do this');
      console.log('  on a network you trust.\x1b[0m');
      console.log('');
    }
  });

  const shutdown = () => { for (const c of clients) c.end(); server.close(() => process.exit(0)); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => { console.error(e); process.exit(1); });
