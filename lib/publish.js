// login / logout / whoami / publish / download: move overlays between this machine and My overlays on overlaify.com.
// The CLI token lives in ~/.overlaify/credentials.json, one per site, so a local copy of the site
// (--site http://localhost:8788) has its own. OVERLAIFY_TOKEN overrides it, for CI.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir, hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { validateOverlay } from './validate.js';
import { SDK_TAG } from './commands.js';

export const DEFAULT_SITE = 'https://www.overlaify.com';
const CREDENTIALS = join(homedir(), '.overlaify/credentials.json');
const KINDS = ['alert', 'chat', 'goal', 'ticker', 'frame', 'custom'];

export function siteUrl(site) {
  const raw = site || process.env.OVERLAIFY_SITE || DEFAULT_SITE;
  let url;
  try { url = new URL(raw); } catch { throw new Error(`Not a URL: ${raw}`); }
  return url.origin;
}

const readCredentials = () => {
  try { return JSON.parse(readFileSync(CREDENTIALS, 'utf8')); } catch { return {}; }
};

function writeCredentials(all) {
  mkdirSync(dirname(CREDENTIALS), { recursive: true });
  writeFileSync(CREDENTIALS, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 });
  chmodSync(CREDENTIALS, 0o600);
}

const tokenFor = (site) => process.env.OVERLAIFY_TOKEN || readCredentials()[site]?.token || null;

async function api(site, path, { method = 'GET', body, token = tokenFor(site) } = {}) {
  const headers = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers['content-type'] = 'application/json';
  let res;
  try {
    res = await fetch(site + path, { method, headers, body: body && JSON.stringify(body) });
  } catch (err) {
    throw new Error(`Could not reach ${site} (${err.cause?.code || err.message}).`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error || `${method} ${path} failed (${res.status}).`);
    e.status = res.status;
    e.code = data.code;
    throw e;
  }
  return data;
}

/** The signed-in user for a site, or null. */
async function me(site, token) {
  const { user } = await api(site, '/api/me', { token });
  return user;
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {}
}

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(question)).trim(); } finally { rl.close(); }
}

/**
 * overlaify login [--site url] [--token t] [--no-browser]
 * Opens <site>/cli, where the signed-in user allows the CLI; the page hands the token back to a one-off
 * server on 127.0.0.1. With --no-browser (or over SSH) the page shows the token to paste instead.
 */
export async function login({ site, token, browser = true, log = console.log } = {}) {
  site = siteUrl(site);
  if (!token) token = browser ? await tokenFromBrowser(site, log) : await tokenFromPaste(site, log);
  token = token.trim();
  const user = await me(site, token).catch(() => null);
  if (!user) throw new Error('That token was not accepted. Run overlaify login again.');
  const all = readCredentials();
  all[site] = { token, user: { id: user.id, name: user.name } };
  writeCredentials(all);
  return { site, user };
}

function tokenFromBrowser(site, log) {
  const state = randomBytes(16).toString('hex');
  return new Promise((resolveToken, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
      const token = url.searchParams.get('token');
      if (url.searchParams.get('state') !== state || !/^ovl_[0-9a-f]{64}$/.test(token || '')) {
        res.writeHead(400, { 'content-type': 'text/plain' }).end('This sign-in link does not match. Run overlaify login again.');
        return;
      }
      res.writeHead(302, { location: `${site}/my` }).end();
      clearTimeout(timer);
      server.close();
      resolveToken(token);
    });
    const timer = setTimeout(() => { server.close(); reject(new Error('Timed out waiting for the browser. Run overlaify login again, or use --no-browser.')); }, 5 * 60 * 1000);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const q = new URLSearchParams({ port: String(server.address().port), state, name: hostname() });
      const url = `${site}/cli?${q}`;
      log(`Opening ${url}\nAllow the CLI there (sign in first if asked). Waiting…`);
      openBrowser(url);
    });
  });
}

async function tokenFromPaste(site, log) {
  if (!process.stdin.isTTY) throw new Error('Pass the token with --token, or set OVERLAIFY_TOKEN.');
  log(`Open ${site}/cli in a browser, allow the CLI and copy the token it shows.`);
  return ask('Token: ');
}

/** overlaify logout [--site url] — revokes the token on the site and forgets it here. */
export async function logout({ site } = {}) {
  site = siteUrl(site);
  const all = readCredentials();
  if (!all[site]) return false;
  await api(site, '/api/cli/token', { method: 'DELETE', token: all[site].token }).catch(() => {});
  delete all[site];
  writeCredentials(all);
  return true;
}

/** overlaify whoami [--site url] → the user, or null when not logged in. */
export async function whoami({ site } = {}) {
  site = siteUrl(site);
  if (!tokenFor(site)) return null;
  return me(site);
}

// Where a file was published: .overlaify/<name>.publish.json → { [site]: { projectId, id, url } },
// next to the settings `overlaify dev` keeps in .overlaify/<name>.json.
const stateFile = (file, ext) => join(dirname(file), '.overlaify', basename(file).replace(/\.html?$/i, '') + ext);
const readJsonFile = (f) => {
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; }
};

// An overlay's name works like a GitHub repository's: unique among your overlays (ignoring case), kept as typed.
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const isName = (n) => NAME_RE.test(n) && n !== '.' && n !== '..';
const NAME_RULE = 'must be up to 100 letters, digits, dashes, underscores or dots.';

// The file name as an overlay name: my_Alert v2.html → my-alert-v2. Empty when nothing usable is left.
const nameOf = (file) =>
  basename(file).replace(/\.html?$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60).replace(/^-+|-+$/g, '');

const titleOf = (html, file) =>
  (/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] || '').replace(/\s+/g, ' ').trim() || basename(file).replace(/\.html?$/i, '');

/**
 * overlaify publish [file] [--public | --private] [--name n] [--title t] [--kind k] [--new] [--site url]
 * Uploads the overlay to My overlays. The first publish of a file asks public or private; publishing it
 * again adds a new version to the same overlay (its OBS URL changes to the new version's) unless --new.
 * `name` is its unique name among your overlays and its address, overlaify.com/<handle>/<name>; a new overlay is otherwise named after its file
 * (asked at a terminal, with the file name as the default), or after its title when the file name has no usable letters.
 */
export async function publish(file, { site, visibility, name, title, kind, fresh, log = console.log } = {}) {
  site = siteUrl(site);
  file = resolve(file);
  if (!existsSync(file)) throw new Error(`No such file: ${file}`);
  if (kind && !KINDS.includes(kind)) throw new Error(`--kind must be one of ${KINDS.join(', ')}.`);
  if (name != null && !isName(name)) throw new Error(`--name ${NAME_RULE}`);
  if (!tokenFor(site)) throw new Error(`Not logged in to ${site}. Run: overlaify login${site === DEFAULT_SITE ? '' : ` --site ${site}`}`);

  const html = readFileSync(file, 'utf8');
  const check = validateOverlay(html);
  if (!check.ok) {
    throw new Error(`${basename(file)} doesn't pass the spec. Fix these first (overlaify validate ${basename(file)}):\n` +
      check.errors.map((i) => `  [${i.code}] ${i.message}`).join('\n'));
  }

  const published = readJsonFile(stateFile(file, '.publish.json')) || {};
  const previous = fresh ? null : published[site];
  if (!visibility && !previous) {
    if (!process.stdin.isTTY) throw new Error('Choose who can see it: --public or --private.');
    log('Who can open this overlay on Overlaify?\n  1) Private — only you (its OBS URL still works)\n  2) Public  — anyone with a link');
    const a = (await ask('Choose 1 or 2 [1]: ')).toLowerCase();
    visibility = a === '2' || a.startsWith('pub') ? 'public' : a === '' || a === '1' || a.startsWith('pri') ? 'private' : null;
    if (!visibility) throw new Error('Publishing cancelled.');
  }
  // A new overlay is named after its file unless --name says otherwise; at a terminal the name can be changed.
  if (name == null && !previous) {
    const fallback = nameOf(file);
    if (process.stdin.isTTY) {
      const a = (await ask(`Name, unique among your overlays (overlaify.com/<you>/<name>)${fallback ? ` [${fallback}]` : ''}: `)).trim();
      name = a || fallback || undefined;
      if (name && !isName(name)) throw new Error(`The name ${NAME_RULE}`);
    } else {
      name = fallback || undefined;
    }
  }

  const body = { html, title: title || titleOf(html, file), name, kind, visibility, config: readJsonFile(stateFile(file, '.json')) || undefined };
  let out;
  try {
    out = await api(site, '/api/my/overlays/publish', { method: 'POST', body: { ...body, projectId: previous?.projectId } });
  } catch (err) {
    // The overlay was deleted on the site: publish it as a new one, which needs a visibility.
    if (err.code !== 'project_not_found' || !previous) throw err;
    log(`The overlay published from ${basename(file)} is no longer in your account; publishing it as a new one.`);
    out = await api(site, '/api/my/overlays/publish', { method: 'POST', body: { ...body, visibility: visibility || 'private' } });
  }

  published[site] = { projectId: out.projectId, id: out.id, url: out.url };
  mkdirSync(dirname(stateFile(file, '.publish.json')), { recursive: true });
  writeFileSync(stateFile(file, '.publish.json'), JSON.stringify(published, null, 2) + '\n');
  return out;
}

// An overlay on the site: handle/name, @handle/name, or its page URL (whose origin is then the site).
function parseRef(ref, site) {
  let path = String(ref || '');
  if (/^https?:\/\//i.test(path)) {
    const url = new URL(path);
    site ||= url.origin;
    path = url.pathname;
  }
  const m = /^\/?@?([a-z0-9_-]+)\/([A-Za-z0-9._-]+)\/?$/i.exec(path);
  if (!m) throw new Error('Name an overlay as <user>/<name>, e.g. overlaify download alice/neon-alert (or paste its page URL).');
  return { site: siteUrl(site), handle: m[1].toLowerCase(), name: m[2] };
}

/**
 * overlaify download <user>/<name> [file] [--version n] [--force] [--site url]
 * Saves an overlay from overlaify.com/<user>/<name> as a local file (default <name>.html), with the SDK tag
 * put back so it runs on its own. A private overlay needs its owner to be logged in. For your own overlay the
 * saved settings come along for `overlaify dev`, and `overlaify publish` then adds versions to that overlay.
 */
export async function download(ref, file, { site, version, force } = {}) {
  let { site: origin, handle, name } = parseRef(ref, site);
  site = origin;
  if (version != null && !/^[1-9]\d*$/.test(String(version))) throw new Error('--version must be a version number: 1 is the first.');
  let out;
  try {
    out = await api(site, `/api/u/${handle}/${encodeURIComponent(name)}${version != null ? `?version=${version}` : ''}`);
  } catch (err) {
    if (err.status === 401) {
      const how = `overlaify login${site === DEFAULT_SITE ? '' : ` --site ${site}`}`;
      throw new Error(`${handle}/${name} is private. ${tokenFor(site) ? 'Your login has expired; log in again' : 'If it is yours, log in first'}: ${how}`);
    }
    throw err;
  }
  if (typeof out.html !== 'string') throw new Error(`${site} doesn't support downloads yet (no /api/u/${handle}/${name}).`);

  // A former name still finds the overlay; files and links use its name now.
  if (out.name) name = out.name;
  file = resolve(file || `${name}.html`);
  if (existsSync(file) && !force) throw new Error(`${basename(file)} already exists (use --force to overwrite).`);
  const html = /<head[^>]*>/i.test(out.html)
    ? out.html.replace(/<head[^>]*>/i, (m) => `${m}\n${SDK_TAG}`)
    : `${SDK_TAG}\n${out.html}`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html);

  if (out.owned) {
    mkdirSync(dirname(stateFile(file, '.json')), { recursive: true });
    if (out.config && Object.keys(out.config).length) writeFileSync(stateFile(file, '.json'), JSON.stringify(out.config, null, 2) + '\n');
    const published = readJsonFile(stateFile(file, '.publish.json')) || {};
    published[site] = { projectId: out.projectId, id: out.id, url: `${site}/o/${out.id}` };
    writeFileSync(stateFile(file, '.publish.json'), JSON.stringify(published, null, 2) + '\n');
  }
  return { ...out, file, page: `${site}/${handle}/${name}` };
}
