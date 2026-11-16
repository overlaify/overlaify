import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync, cpSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { validateOverlay } from './validate.js';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATES = join(PKG, 'assets/templates');
const SKILL = join(PKG, 'skill');
export const skillTargets = new Map([
  ['claude', { client: 'Claude Code', directory: '.claude/skills' }],
  ['codex', { client: 'Codex', directory: '.agents/skills' }],
  ['cursor', { client: 'Cursor', directory: '.cursor/skills' }],
  ['gemini', { client: 'Gemini CLI', directory: '.gemini/skills' }],
]);
export const SDK_TAG = '<script src="https://www.overlaify.com/sdk/v1/overlaify.js"></script>';

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
export const red = paint(31), yellow = paint(33), green = paint(32), dim = paint(2), bold = paint(1);

/** The library templates bundled with the CLI: [{ slug, title, kind, desc }]. */
export function templates() {
  return JSON.parse(readFileSync(join(TEMPLATES, 'catalog.json'), 'utf8'))
    .map(({ slug, title, kind, desc }) => ({ slug, title, kind, desc }));
}

/**
 * overlaify init [file] [--template slug] [--force]
 * Writes a starter overlay, or a copy of a library template, with the SDK loaded from overlaify.com
 * so the file also works on its own (OBS can load it as a local file).
 */
export function init(file, { template, force } = {}) {
  let html;
  if (template) {
    const t = templates().find((x) => x.slug === template);
    if (!t) throw new Error(`Unknown template "${template}". See the list with: overlaify init --list`);
    html = readFileSync(join(TEMPLATES, `${t.slug}.html`), 'utf8')
      .replace(/<script[^>]*src=["'][^"']*overlaify(\.min)?\.js["'][^>]*>\s*<\/script>/i, SDK_TAG);
  } else {
    html = readFileSync(join(PKG, 'lib/starter.html'), 'utf8');
  }
  file = resolve(file || (template ? `${template}.html` : 'overlay.html'));
  if (existsSync(file) && !force) throw new Error(`${relative(process.cwd(), file)} already exists (use --force to overwrite).`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html);
  return file;
}

/** overlaify validate <files...> — prints each file's issues. Returns the number of files with errors. */
export function validate(files, { json } = {}) {
  const results = files.map((f) => ({ file: f, ...validateOverlay(readFileSync(f, 'utf8')) }));
  if (json) {
    console.log(JSON.stringify(results.map(({ file, ok, errors, warnings }) => ({ file, ok, errors, warnings })), null, 2));
  } else {
    for (const r of results) {
      const tag = !r.ok ? red('FAIL') : r.warnings.length ? yellow('warn') : green(' ok ');
      console.log(`${tag}  ${relative(process.cwd(), resolve(r.file))}`);
      for (const i of r.errors) console.log(`      ${red('error')}   ${dim(`[${i.code}]`)} ${i.message}`);
      for (const i of r.warnings) console.log(`      ${yellow('warning')} ${dim(`[${i.code}]`)} ${i.message}`);
    }
    const failed = results.filter((r) => !r.ok).length;
    if (results.length > 1 || failed) console.log(`\n${results.length} checked: ${results.length - failed} pass, ${failed} fail.`);
  }
  return results.filter((r) => !r.ok).length;
}

/** Install the bundled skill in a local agent's user directory or a custom path. */
export function installSkill({ target = 'claude', dir } = {}) {
  const agent = skillTargets.get(target);
  if (!agent) throw new Error(`Unknown skill target "${target}". Choose ${[...skillTargets.keys(), 'chatgpt'].join(', ')}.`);
  if (dir !== undefined && (typeof dir !== 'string' || !dir.trim())) throw new Error('--dir requires a path.');
  const destination = resolve(dir ?? join(homedir(), agent.directory, 'overlaify'));
  cpSync(SKILL, destination, { recursive: true });
  return destination;
}

/** Export an Agent Skills ZIP with a single top-level folder for upload to ChatGPT. */
export function exportSkill({ output = 'overlaify-skill.zip', force } = {}) {
  if (typeof output !== 'string' || !/\.zip$/i.test(output)) throw new Error('--output requires a .zip file path.');
  const destination = resolve(output);
  const files = skillArchiveEntries(SKILL);
  // argument-hint is a Claude Code extension outside the Agent Skills frontmatter spec.
  const manifest = files['SKILL.md'].toString('utf8');
  files['SKILL.md'] = Buffer.from(manifest.replace(/^argument-hint: .*\r?\n/m, ''));
  const zip = zipSync({ overlaify: files });
  mkdirSync(dirname(destination), { recursive: true });
  try {
    writeFileSync(destination, zip, { flag: force ? 'w' : 'wx' });
  } catch (err) {
    if (err.code === 'EEXIST') throw new Error(`${destination} already exists (use --force to overwrite).`);
    throw err;
  }
  return destination;
}

function skillArchiveEntries(directory) {
  return Object.fromEntries(readdirSync(directory, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.') && (entry.isDirectory() || entry.isFile()))
    .map((entry) => {
      const path = join(directory, entry.name);
      return [entry.name, entry.isDirectory() ? skillArchiveEntries(path) : readFileSync(path)];
    }));
}
