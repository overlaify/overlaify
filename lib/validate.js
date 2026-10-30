// Checks an overlay's HTML against the Overlaify Overlay Spec (docs/overlay-spec.md).
// Plain string scanning, no DOM, so it runs the same in Pages Functions, Node scripts and a future CLI.

export const SPEC_VERSION = 1;
export const MAX_BYTES = 80000;
export const PROPERTY_TYPES = ['text', 'number', 'toggle', 'color', 'select', 'segmented', 'range'];
export const ACTION_STYLES = ['primary', 'secondary', 'danger'];
export const INPUT_TYPES = ['number', 'text', 'select'];
export const RESERVED_KEYS = ['channel', 'sources', 'volume', 'mute', 'test'];
export const EVENTS = ['chat', 'follow', 'sub', 'gift', 'giftbomb', 'cheer', 'tip', 'raid'];
const LIFECYCLE = ['connected', 'disconnected', '*'];
const ALLOWED_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'static-cdn.jtvnw.net'];
const SDK_HOSTS = ['www.overlaify.com', 'overlaify.com'];
// Namespaces, not requests.
const NAMESPACE_HOSTS = ['www.w3.org'];
const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const HEX = /^#[0-9a-f]{6}$/i;

/**
 * validateOverlay(html) → { ok, errors, warnings, manifest }
 * Each issue is { code, message }. `ok` means no errors; warnings don't block hosting.
 */
export function validateOverlay(html) {
  const errors = [];
  const warnings = [];
  const err = (code, message) => errors.push({ code, message });
  const warn = (code, message) => warnings.push({ code, message });
  html = String(html || '');

  checkDocument(html, err, warn);

  const blocks = manifestBlocks(html);
  let manifest = null;
  if (blocks.length > 1) err('manifest_duplicate', `Found ${blocks.length} overlaify-manifest blocks; keep one.`);
  if (blocks.length) {
    const b = blocks[0];
    if (!/\btype\s*=\s*["']?application\/json\b/i.test(b.attrs)) {
      err('manifest_type', 'The overlaify-manifest <script> needs type="application/json".');
    }
    try {
      manifest = JSON.parse(b.body);
    } catch (e) {
      err('manifest_json', `The manifest is not valid JSON (${e.message}). Use double quotes, no comments, no trailing commas.`);
    }
    if (manifest !== null && (typeof manifest !== 'object' || Array.isArray(manifest))) {
      err('manifest_json', 'The manifest must be a JSON object: { "spec": 1, "properties": [...], "actions": [...] }.');
      manifest = null;
    }
    if (manifest) checkManifest(manifest, err, warn);
  }

  checkCode(stripManifest(html), manifest, blocks.length > 0, err, warn);

  return { ok: errors.length === 0, errors, warnings, manifest };
}

/** The issues as a bulleted list, for showing a person or asking a model to fix them. */
export function formatIssues(issues) {
  return issues.map((i) => `- [${i.code}] ${i.message}`).join('\n');
}

/* ------------------------------------------------------------------ */
/* Document                                                            */
/* ------------------------------------------------------------------ */

function checkDocument(html, err, warn) {
  const bytes = new TextEncoder().encode(html).length;
  if (bytes > MAX_BYTES) err('too_large', `The overlay is ${Math.round(bytes / 1000)} KB; the limit is ${MAX_BYTES / 1000} KB.`);
  if (!/<html[\s>]/i.test(html)) warn('not_html', 'Not a complete HTML document; wrap it in <!doctype html><html>…</html>.');
  if (!/<title>\s*[^<\s][^<]*<\/title>/i.test(html)) warn('title_missing', 'Add a short overlay name in <title>.');

  const tags = html.match(/<[a-z][^>]*>/gi) || [];
  for (const tag of tags) {
    const name = tag.match(/^<([a-z0-9-]+)/i)[1].toLowerCase();
    if (name === 'iframe' || name === 'object' || name === 'embed') {
      err('embedded_frame', `<${name}> is not allowed; overlays can't embed other pages.`);
      continue;
    }
    if (name === 'script') {
      const src = attr(tag, 'src');
      // The SDK tag is fine (local previews need it); Overlaify swaps it for its own when hosting.
      if (src !== null && !isSdkUrl(src)) {
        err('external_script', `<script src="${short(src)}"> is not allowed; put all JS inline.`);
      }
      continue;
    }
    if (name === 'link') {
      const href = attr(tag, 'href');
      const rel = (attr(tag, 'rel') || '').toLowerCase();
      // preconnect/dns-prefetch only warm up a connection; they load nothing.
      if (href !== null && !isDynamic(href) && !/\b(preconnect|dns-prefetch)\b/.test(rel) && !allowedUrl(href)) {
        err('external_resource', `<link href="${short(href)}"> loads an external file; inline it (only Google Fonts are allowed).`);
      }
      continue;
    }
    for (const a of ['src', 'poster', 'data']) {
      const v = attr(tag, a);
      if (v !== null && !isDynamic(v) && !allowedUrl(v)) {
        err('external_resource', `<${name} ${a}="${short(v)}"> loads an external file; use a data: URL, inline SVG, canvas or emoji.`);
      }
    }
    if (name === 'image' || name === 'use' || name === 'feimage') {
      const v = attr(tag, 'href') ?? attr(tag, 'xlink:href');
      if (v !== null && !v.startsWith('#') && !isDynamic(v) && !allowedUrl(v)) {
        err('external_resource', `<${name} href="${short(v)}"> loads an external file.`);
      }
    }
  }

  // CSS only: <style> blocks and style="" attributes (in JS, url(...) is usually a function call).
  const css = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].map((m) => m[1])
    .concat(tags.map((t) => attr(t, 'style')).filter(Boolean)).join('\n');
  for (const m of css.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)) {
    const u = m[2].trim();
    if (u && !u.startsWith('#') && !isDynamic(u) && !allowedUrl(u)) err('external_resource', `CSS url(${short(u)}) loads an external file; use a data: URL or a gradient.`);
  }
  // @import url(...) was covered above.
  for (const m of css.matchAll(/@import\s+['"]([^'"]+)/gi)) {
    if (!allowedUrl(m[1])) err('external_resource', `@import ${short(m[1])} loads an external stylesheet; inline it (only Google Fonts are allowed).`);
  }
}

// data:/blob: and the spec's allowed hosts. Relative URLs have nothing to load from on Overlaify.
function allowedUrl(u) {
  u = u.trim();
  if (!u || /^(data|blob):/i.test(u)) return true;
  const host = hostOf(u);
  return host !== null && ALLOWED_HOSTS.includes(host);
}

// Markup built in JS (`<img src="${url}">`, 'url(' + x + ')') is filled in at run time; the scan can't judge it.
function isDynamic(v) {
  return /\$\{|['"`]|\s\+|\+\s/.test(v);
}

// /sdk/v1/overlaify.js, on Overlaify or relative to wherever the overlay is served (overlaify dev).
function isSdkUrl(u) {
  const host = hostOf(u);
  return (host === null || SDK_HOSTS.includes(host)) && /(^|\/)sdk\/(v\d+\/)?overlaify(\.min)?\.js(\?|$)/i.test(u);
}

function hostOf(u) {
  const m = u.match(/^(?:https?:)?\/\/([^/?#:\s]+)/i);
  return m ? m[1].toLowerCase() : null;
}

function attr(tag, name) {
  const re = new RegExp(`\\s${name.replace(':', '\\:')}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = tag.match(re);
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
}

function short(s) {
  return s.length > 60 ? s.slice(0, 57) + '...' : s;
}

/* ------------------------------------------------------------------ */
/* Manifest                                                            */
/* ------------------------------------------------------------------ */

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const isManifest = (attrs) => /\bid\s*=\s*["']?overlaify-manifest\b/i.test(attrs);

function manifestBlocks(html) {
  return [...html.matchAll(SCRIPT)].filter((m) => isManifest(m[1])).map((m) => ({ attrs: m[1], body: m[2] }));
}

function stripManifest(html) {
  return html.replace(SCRIPT, (all, attrs) => (isManifest(attrs) ? '' : all));
}

/**
 * The manifest's properties. Overlays from before the rename call them "settings", which is still read
 * when there is no "properties".
 */
export function propertiesOf(m) {
  if (!m || typeof m !== 'object') return [];
  const list = 'properties' in m ? m.properties : m.settings;
  return Array.isArray(list) ? list : [];
}

function checkManifest(m, err, warn) {
  if (!('spec' in m)) warn('spec_missing', `Add "spec": ${SPEC_VERSION} to the manifest.`);
  else if (m.spec !== SPEC_VERSION) err('spec_version', `Unknown spec version ${JSON.stringify(m.spec)}; this validator knows spec ${SPEC_VERSION}.`);
  const legacy = 'settings' in m && !('properties' in m);
  if (legacy) warn('manifest_settings', '"settings" is now called "properties"; rename the key.');
  for (const k of Object.keys(m)) {
    if (!['spec', 'properties', 'actions'].includes(k) && !(legacy && k === 'settings')) {
      warn('manifest_unknown_key', `Unknown manifest key "${k}"; only spec, properties and actions are read.`);
    }
  }
  const pk = legacy ? 'settings' : 'properties';
  if (pk in m && !Array.isArray(m[pk])) err('manifest_shape', `"${pk}" must be an array.`);
  if ('actions' in m && !Array.isArray(m.actions)) err('manifest_shape', '"actions" must be an array.');

  const keys = new Set();
  propertiesOf(m).forEach((s, i) => checkProperty(s, i, keys, err, warn));
  const names = new Set();
  (Array.isArray(m.actions) ? m.actions : []).forEach((a, i) => checkAction(a, i, names, err, warn));
}

function checkProperty(s, i, keys, err, warn) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return err('property_key', `properties[${i}] must be an object.`);
  const at = typeof s.key === 'string' ? `Property "${s.key}"` : `properties[${i}]`;
  if (typeof s.key !== 'string' || !NAME.test(s.key)) {
    err('property_key', `${at}: "key" must be letters, digits, _ or -, starting with a letter (max 40).`);
  } else if (RESERVED_KEYS.includes(s.key)) {
    err('property_reserved', `${at}: "${s.key}" is reserved; the platform always provides ${RESERVED_KEYS.join(', ')}.`);
  } else if (keys.has(s.key)) {
    err('property_duplicate', `${at} is declared twice.`);
  } else {
    keys.add(s.key);
  }
  if (typeof s.label !== 'string' || !s.label.trim()) warn('property_label', `${at}: add a short "label".`);
  for (const f of ['desc', 'group']) {
    if (f in s && typeof s[f] !== 'string') warn('property_field', `${at}: "${f}" should be a string.`);
  }
  if (!PROPERTY_TYPES.includes(s.type)) {
    return err('property_type', `${at}: "type" must be one of ${PROPERTY_TYPES.join(', ')}.`);
  }

  const has = 'default' in s;
  const d = s.default;
  if (!has) warn('property_default_missing', `${at}: add a "default" (the value the overlay starts with).`);
  const bad = (want) => err('property_default', `${at}: "default" must be ${want}, got ${JSON.stringify(d)}.`);

  switch (s.type) {
    case 'text':
      if (has && typeof d !== 'string') bad('a string');
      break;
    case 'number':
      if (has && !isNum(d)) bad('a number');
      break;
    case 'toggle':
      if (has && typeof d !== 'boolean') bad('true or false');
      break;
    case 'color':
      if (has && !(typeof d === 'string' && HEX.test(d))) bad('a #rrggbb color');
      if ('swatches' in s && !(Array.isArray(s.swatches) && s.swatches.every((c) => typeof c === 'string' && HEX.test(c)))) {
        err('property_swatches', `${at}: "swatches" must be an array of #rrggbb colors.`);
      }
      break;
    case 'select':
    case 'segmented': {
      const values = optionValues(s.options);
      if (!values) {
        err('property_options', `${at}: "options" must be a non-empty array of values or { "value", "label" }.`);
        break;
      }
      if (s.type === 'segmented' && values.length > 4) warn('property_options', `${at}: segmented fits 2-4 choices; use "select" for ${values.length}.`);
      if (has && !values.includes(String(d))) bad(`one of the options (${values.join(', ')})`);
      break;
    }
    case 'range':
      if (!isNum(s.min) || !isNum(s.max) || s.min >= s.max) {
        err('property_range', `${at}: a range needs numeric "min" < "max".`);
      } else if (has && (!isNum(d) || d < s.min || d > s.max)) {
        bad(`a number from ${s.min} to ${s.max}`);
      }
      if ('step' in s && !(isNum(s.step) && s.step > 0)) err('property_range', `${at}: "step" must be a number above 0.`);
      break;
  }
}

function checkAction(a, i, names, err, warn) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return err('action_name', `actions[${i}] must be an object.`);
  const at = typeof a.name === 'string' ? `Action "${a.name}"` : `actions[${i}]`;
  if (typeof a.name !== 'string' || !NAME.test(a.name)) {
    err('action_name', `${at}: "name" must be letters, digits, _ or -, starting with a letter (max 40).`);
  } else if (names.has(a.name)) {
    err('action_duplicate', `${at} is declared twice.`);
  } else {
    names.add(a.name);
  }
  if (typeof a.label !== 'string' || !a.label.trim()) warn('action_label', `${at}: add a "label" for its key.`);
  if ('group' in a && typeof a.group !== 'string') warn('action_field', `${at}: "group" should be a string.`);
  if ('wide' in a && typeof a.wide !== 'boolean') warn('action_field', `${at}: "wide" should be true or false.`);
  if ('style' in a && !ACTION_STYLES.includes(a.style)) err('action_style', `${at}: "style" must be one of ${ACTION_STYLES.join(', ')}.`);
  if ('confirm' in a && typeof a.confirm !== 'boolean' && typeof a.confirm !== 'string') {
    err('action_confirm', `${at}: "confirm" must be true or a short question.`);
  }
  if (!('input' in a)) return;
  const p = a.input;
  if (!p || typeof p !== 'object' || !INPUT_TYPES.includes(p.type)) {
    return err('action_input', `${at}: "input" must be { "type": ${INPUT_TYPES.join(' | ')}, "label", "default", ... }.`);
  }
  if (p.type === 'number') {
    for (const f of ['default', 'min', 'max', 'step']) {
      if (f in p && !isNum(p[f])) err('action_input', `${at}: input "${f}" must be a number.`);
    }
  }
  if (p.type === 'select') {
    const values = optionValues(p.options);
    if (!values) err('action_input', `${at}: a select input needs non-empty "options".`);
    else if ('default' in p && !values.includes(String(p.default))) err('action_input', `${at}: input "default" must be one of the options.`);
  }
}

function optionValues(options) {
  if (!Array.isArray(options) || !options.length) return null;
  const out = [];
  for (const o of options) {
    if (typeof o === 'string' || isNum(o)) out.push(String(o));
    else if (o && typeof o === 'object' && (typeof o.value === 'string' || isNum(o.value))) out.push(String(o.value));
    else return null;
  }
  return out;
}

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

/* ------------------------------------------------------------------ */
/* Code                                                                */
/* ------------------------------------------------------------------ */

// Literal first arguments of Overlaify.<fn>('...'), e.g. calls('param') → Set of property keys read.
function calls(code, fn) {
  const re = new RegExp(`\\bOverlaify\\s*\\.\\s*${fn}\\s*\\(\\s*(['"\`])([^'"\`]+)\\1`, 'g');
  return new Set([...code.matchAll(re)].map((m) => m[2]));
}

// Keys of one handler group (`actions`, `events`) in an Overlaify.store({...}) call: the property names
// directly inside `<group>: { … }`, as `name(…) {`, `name: …` or `'name': …`. Strings and comments are skipped.
function storeKeys(code, group) {
  const keys = new Set();
  const call = code.search(/\bOverlaify\s*\.\s*store\s*\(/);
  if (call < 0) return keys;
  const head = new RegExp(`\\b${group}\\s*:\\s*\\{`, 'g');
  head.lastIndex = call;
  const m = head.exec(code);
  if (!m) return keys;
  let depth = 0, expectKey = true;
  for (let i = m.index + m[0].length - 1; i < code.length; i++) {
    const c = code[i];
    if (c === '/' && code[i + 1] === '/') { i = code.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && code[i + 1] === '*') { i = code.indexOf('*/', i + 2) + 1; if (i <= 0) break; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < code.length && code[j] !== c) j += code[j] === '\\' ? 2 : 1;
      if (depth === 1 && expectKey && /^\s*[:(]/.test(code.slice(j + 1))) keys.add(code.slice(i + 1, j));
      expectKey = false;
      i = j;
      continue;
    }
    if ('{[('.includes(c)) { depth++; if (depth === 1) expectKey = true; continue; }
    if ('}])'.includes(c)) { depth--; if (depth === 0) break; continue; }
    if (depth !== 1) continue;
    if (c === ',') { expectKey = true; continue; }
    if (expectKey && /[A-Za-z_$]/.test(c)) {
      const word = code.slice(i).match(/^[\w$]+/)[0];
      if (/^\s*[:(]/.test(code.slice(i + word.length))) keys.add(word);
      expectKey = false;
      i += word.length - 1;
      continue;
    }
    if (!/\s/.test(c)) expectKey = false;
  }
  return keys;
}

function checkCode(code, manifest, hasManifest, err, warn) {
  const params = calls(code, 'param');
  const handlers = calls(code, 'action');
  // Overlaify.store({ actions: { add(s) {…} } }) handles actions by key.
  for (const k of storeKeys(code, 'actions')) handlers.add(k);
  const properties = new Set(propertiesOf(manifest).map((s) => s?.key)
    .filter((k) => typeof k === 'string' && NAME.test(k) && !RESERVED_KEYS.includes(k)));
  const actions = new Set((Array.isArray(manifest?.actions) ? manifest.actions : []).map((a) => a?.name).filter(Boolean));
  const ownParams = [...params].filter((k) => !RESERVED_KEYS.includes(k));

  if (!hasManifest && (ownParams.length || handlers.size)) {
    warn('manifest_missing', 'The overlay reads properties or handles actions but has no overlaify-manifest, so the streamer gets no properties panel or keys.');
  }
  if (manifest) {
    // Overlaify.params.get(...) or a computed key reads properties this scan can't see.
    const dynamic = /\bOverlaify\s*\.\s*params\b/.test(code) || /\bOverlaify\s*\.\s*param\s*\(\s*[^'"`\s)]/.test(code);
    if (!dynamic) {
      for (const k of properties) {
        if (!params.has(k)) warn('property_unused', `Property "${k}" is never read; use Overlaify.param('${k}', <default>) or remove it.`);
      }
    }
    for (const k of ownParams) {
      if (!properties.has(k)) warn('param_undeclared', `Overlaify.param('${k}') is not declared in the manifest's properties, so the panel can't set it.`);
    }
    const dynamicActions = /\bOverlaify\s*\.\s*action\s*\(\s*[^'"`\s)]/.test(code);
    if (!dynamicActions) {
      for (const n of actions) {
        if (!handlers.has(n)) err('action_unhandled', `Action "${n}" has no handler; add Overlaify.action('${n}', fn) or a store action ${n}(s, value), or remove it, or its key does nothing.`);
      }
    }
    for (const n of handlers) {
      if (!actions.has(n)) warn('action_undeclared', `Overlaify.action('${n}') is not in the manifest, so the streamer has no key for it.`);
    }
  }

  const events = calls(code, 'on');
  for (const t of events) {
    if (!EVENTS.includes(t) && !LIFECYCLE.includes(t) && !t.startsWith('action:') && !t.startsWith('fx:')) {
      warn('unknown_event', `Overlaify.on('${t}') never fires; events are ${EVENTS.join(', ')} (plus connected, disconnected, '*').`);
    }
  }
  // A store's events handlers count like Overlaify.on.
  const storeEvents = storeKeys(code, 'events');
  for (const t of storeEvents) {
    if (!EVENTS.includes(t) && t !== '*') {
      warn('unknown_event', `The store's events.${t} never runs; events are ${EVENTS.join(', ')} (plus '*').`);
    }
  }
  const handled = new Set([...events, ...storeEvents]);
  if (handled.has('cheer') && handled.has('tip')) {
    warn('cheer_and_tip', `Twitch bits fire both 'cheer' and 'tip', so handling both counts them twice; handle 'tip' alone.`);
  }

  const scripts = [...code.matchAll(SCRIPT)].map((m) => m[2]).join('\n');
  const net = scripts.match(/\b(fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/);
  if (net) warn('network_access', `${net[1]}() makes network calls; overlays get events from the SDK.`);
  const dialog = scripts.match(/(?:^|[^\w$.]|\bwindow\.)(alert|confirm|prompt)\s*\(/);
  if (dialog) warn('blocking_dialog', `${dialog[1]}() needs a person to click; overlays must just run.`);

  const urls = new Set();
  for (const m of code.matchAll(/\bhttps?:\/\/[^\s"'`)<>]+/gi)) {
    const host = hostOf(m[0]);
    if (host && !ALLOWED_HOSTS.includes(host) && !NAMESPACE_HOSTS.includes(host) && !SDK_HOSTS.includes(host)) urls.add(host);
  }
  if (urls.size) warn('external_url', `The code mentions ${[...urls].join(', ')}; overlays can only load from Google Fonts and Twitch emotes.`);
}
