import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { validateOverlay } from './validate.js';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATES = join(PKG, 'assets/templates');
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

/** overlaify skill [--dir path] — installs the Overlaify skill for Claude (default ~/.claude/skills/overlaify). */
export function installSkill({ dir } = {}) {
  const target = resolve(dir || join(homedir(), '.claude/skills/overlaify'));
  rmSync(target, { recursive: true, force: true });
  cpSync(join(PKG, 'skill'), target, { recursive: true });
  return target;
}
