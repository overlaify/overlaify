// `overlaify dev <file>`: a local Overlaify for one overlay file.
//   /           the dev page: preview with simulated events, settings panel, action keys, spec check
//   /overlay    the overlay as OBS should load it: SDK and saved settings injected, reloads on save
//   /api/live/  the SDK's live-control socket, so action keys reach every copy running in OBS
// Settings are saved next to the file in .overlaify/<name>.json.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync, watch } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateOverlay } from './validate.js';
import { acceptWebSocket } from './ws.js';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const SDK_PATH = join(PKG, 'assets/sdk/v1/overlaify.js');
const DEV_PAGE = join(PKG, 'lib/dev.html');
const ROOM = 'local';

export function dev(file, { port = 4545, host = '127.0.0.1', channel } = {}) {
  file = resolve(file);
  if (!existsSync(file)) throw new Error(`No such file: ${file}`);
  const settingsFile = join(dirname(file), '.overlaify', basename(file).replace(/\.html?$/i, '') + '.json');

  const overlays = new Set(); // live sockets from running copies of the overlay
  const streams = new Set(); // server-sent event streams: dev pages and overlays waiting to reload

  const readSettings = () => {
    try { return JSON.parse(readFileSync(settingsFile, 'utf8')); } catch { return {}; }
  };
  if (channel) saveSettings({ ...readSettings(), channel });

  function saveSettings(values) {
    mkdirSync(dirname(settingsFile), { recursive: true });
    writeFileSync(settingsFile, JSON.stringify(values, null, 2) + '\n');
  }

  function broadcast(event, data = {}) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of streams) res.write(msg);
  }

  function presence() {
    const list = [...overlays];
    return { overlays: list.length, obs: list.filter((o) => o.obs).length };
  }

  function state() {
    const html = readFileSync(file, 'utf8');
    const { ok, errors, warnings, manifest } = validateOverlay(html);
    return {
      file,
      name: basename(file),
      bytes: Buffer.byteLength(html),
      check: { ok, errors, warnings },
      manifest,
      settings: readSettings(),
      ...presence()
    };
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, 'text/html', readFileSync(DEV_PAGE));
      if (req.method === 'GET' && url.pathname === '/overlay') {
        return send(res, 200, 'text/html', serveOverlay(readFileSync(file, 'utf8'), readSettings()), { 'cache-control': 'no-store' });
      }
      if (req.method === 'GET' && /^\/sdk\/(v1\/)?overlaify\.js$/.test(url.pathname)) {
        return send(res, 200, 'text/javascript', readFileSync(SDK_PATH));
      }
      if (req.method === 'GET' && url.pathname === '/api/state') return sendJson(res, state());
      if (req.method === 'POST' && url.pathname === '/api/settings') {
        const body = await readJson(req);
        const values = {};
        for (const [k, v] of Object.entries(body.settings || {})) {
          if (v !== '' && v != null) values[k] = String(v);
        }
        saveSettings(values);
        broadcast('reload');
        return sendJson(res, { settings: values });
      }
      if (req.method === 'POST' && url.pathname === '/api/action') {
        const { name, value } = await readJson(req);
        if (typeof name !== 'string' || !name) return sendJson(res, { error: 'name is required' }, 400);
        const id = Math.random().toString(36).slice(2, 10);
        const msg = JSON.stringify({ t: 'action', id, name, value: value ?? null });
        for (const o of overlays) o.ws.send(msg);
        return sendJson(res, { id, to: overlays.size });
      }
      if (req.method === 'GET' && url.pathname === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(`event: presence\ndata: ${JSON.stringify(presence())}\n\n`);
        streams.add(res);
        req.on('close', () => streams.delete(res));
        return;
      }
      send(res, 404, 'text/plain', 'Not found');
    } catch (err) {
      sendJson(res, { error: err.message }, 500);
    }
  });

  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== `/api/live/${ROOM}` || url.searchParams.get('role') !== 'overlay') {
      return socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
    }
    const entry = { obs: url.searchParams.get('obs') === '1', ws: null };
    entry.ws = acceptWebSocket(req, socket, {
      onMessage(ws, text) {
        if (text === 'ping') return ws.send('pong');
        let m;
        try { m = JSON.parse(text); } catch { return; }
        if (m && m.t === 'acted') broadcast('acted', { id: m.id, name: m.name, handled: !!m.handled });
      },
      onClose() {
        overlays.delete(entry);
        broadcast('presence', presence());
      }
    });
    if (!entry.ws) return;
    overlays.add(entry);
    broadcast('presence', presence());
  });

  // Editors often save by replacing the file, which ends a plain fs.watch on it; watching the folder survives that.
  let timer = null;
  watch(dirname(file), (event, name) => {
    if (name !== basename(file)) return;
    clearTimeout(timer);
    timer = setTimeout(() => broadcast('reload'), 80);
  });

  return listen(server, port, host);
}

// Tries the next ports when one is taken.
function listen(server, port, host, tries = 10) {
  return new Promise((resolvePort, reject) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE' && tries > 1) resolvePort(listen(server, port + 1, host, tries - 1));
      else reject(err);
    });
    server.listen(port, host, () => resolvePort(port));
  });
}

// The overlay as the hosted /o/:id serves it: its own SDK tag swapped for the local SDK, with saved settings
// and the live room set first. A small script reloads it when the file or its settings change.
export function serveOverlay(html, settings) {
  html = html.replace(/<script[^>]*src=["'][^"']*overlaify(\.min)?\.js["'][^>]*>\s*<\/script>\n?/gi, '');
  const cfg = Object.keys(settings).length
    ? `<script>window.OVERLAIFY_CONFIG=${JSON.stringify(settings).replace(/</g, '\\u003c')}</script>` : '';
  const tag = cfg +
    `<script>window.OVERLAIFY_LIVE=${JSON.stringify({ room: ROOM })}</script>` +
    '<script src="/sdk/v1/overlaify.js"></script>' +
    `<script>try{new EventSource('/events').addEventListener('reload',function(){location.reload()})}catch(e){}</script>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}\n${tag}`);
  return tag + '\n' + html;
}

function send(res, status, type, body, headers = {}) {
  res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, ...headers });
  res.end(body);
}

function sendJson(res, data, status = 200) {
  send(res, status, 'application/json', JSON.stringify(data), { 'cache-control': 'no-store' });
}

function readJson(req) {
  return new Promise((ok, fail) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try { ok(body ? JSON.parse(body) : {}); } catch { fail(new Error('Invalid JSON body')); }
    });
  });
}
