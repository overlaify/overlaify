// Refreshes the files the CLI shares with overlaify.com.
// From the Library on the site (default https://www.overlaify.com, or SITE=http://localhost:8788):
//   assets/templates/            ← /overlays/catalog.json and /overlays/<slug>  (`overlaify init --template`)
//   skill/examples/<slug>.html    ← three of them, SDK loaded from overlaify.com
// From a checkout of the site repo (default ../overlaify_web, or OVERLAIFY_WEB=path):
//   lib/validate.js              ← src/lib/validate.js        (the spec checker)
//   assets/sdk/v1/overlaify.js   ← public/sdk/v1/overlaify.js  (the runtime `overlaify dev` serves)
//   assets/overlay-spec.md       ← docs/overlay-spec.md        (`overlaify spec`)
//   skill/references/overlay-spec.md
// Run after the site changes the spec, SDK, validator or Library:  npm run sync
import { writeFileSync, cpSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = resolve(process.env.OVERLAIFY_WEB || join(ROOT, '../overlaify_web'));
const SITE = new URL(process.env.SITE || 'https://www.overlaify.com').origin;
const SDK_TAG = '<script src="https://www.overlaify.com/sdk/v1/overlaify.js"></script>';
// One of each shape: an alert queue, a chat box, a goal with settings and live actions.
const EXAMPLES = ['neon-alert', 'chat-stack', 'goal-bar'];
// The CLI ships only the basic template of each kind; the rest of the Library stays on the site.
const BASIC = [
  'neon-alert', 'chat-stack', 'goal-bar', 'starting-soon', 'be-right-back', 'webcam-frame',
  'subathon-timer', 'death-counter', 'emote-wall', 'newsroom-ticker', 'hug-command',
];

if (!existsSync(join(WEB, 'docs/overlay-spec.md'))) {
  console.error(`No overlaify_web checkout at ${WEB}. Set OVERLAIFY_WEB=path/to/overlaify_web.`);
  process.exit(1);
}

async function get(path) {
  const res = await fetch(SITE + path);
  if (!res.ok) throw new Error(`GET ${SITE}${path}: ${res.status}`);
  return res.text();
}

// Library overlays load the SDK from the site; the CLI's copies load it from overlaify.com, so they also work as files.
const withSdk = (html) => html.replace(/<script[^>]*src=["'][^"']*overlaify(\.min)?\.js["'][^>]*>\s*<\/script>/i, SDK_TAG);

// Fetch first, so a site that can't be reached leaves the current copies alone.
const catalog = JSON.parse(await get('/overlays/catalog.json')).filter((o) => BASIC.includes(o.slug));
const templates = {};
for (const o of catalog) templates[o.slug] = withSdk(await get(`/overlays/${o.slug}`));
for (const slug of new Set([...BASIC, ...EXAMPLES])) {
  if (!templates[slug]) throw new Error(`The template "${slug}" is not in the Library on ${SITE}.`);
}

cpSync(join(WEB, 'src/lib/validate.js'), join(ROOT, 'lib/validate.js'));

rmSync(join(ROOT, 'assets'), { recursive: true, force: true });
mkdirSync(join(ROOT, 'assets/templates'), { recursive: true });
cpSync(join(WEB, 'public/sdk/v1'), join(ROOT, 'assets/sdk/v1'), { recursive: true });
cpSync(join(WEB, 'docs/overlay-spec.md'), join(ROOT, 'assets/overlay-spec.md'));
writeFileSync(join(ROOT, 'assets/templates/catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
for (const [slug, html] of Object.entries(templates)) writeFileSync(join(ROOT, 'assets/templates', `${slug}.html`), html);

mkdirSync(join(ROOT, 'skill/references'), { recursive: true });
mkdirSync(join(ROOT, 'skill/examples'), { recursive: true });
cpSync(join(WEB, 'docs/overlay-spec.md'), join(ROOT, 'skill/references/overlay-spec.md'));
for (const slug of EXAMPLES) writeFileSync(join(ROOT, 'skill/examples', `${slug}.html`), templates[slug]);
console.log(`Synced ${catalog.length} templates from ${SITE}, and the validator, SDK and spec from ${WEB}.`);
