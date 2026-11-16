#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { init, validate, installSkill, exportSkill, skillTargets, templates, bold, dim, green, red, yellow } from '../lib/commands.js';
import { dev } from '../lib/dev.js';
import { login, logout, whoami, publish, download, siteUrl } from '../lib/publish.js';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'));

const HELP = `${bold('overlaify')} ${version} — build Twitch overlays that follow the Overlaify Overlay Spec

Usage
  overlaify init [file] [--template <slug>] [--force]   start an overlay (blank starter, or a library template)
  overlaify init --list                                  list the library templates
  overlaify validate <files...> [--json]                 check overlays against the spec (exit 1 on errors)
  overlaify dev [file] [--port 4545] [--channel name] [--host 127.0.0.1]
                                                         preview with simulated events, properties and action keys;
                                                         gives an OBS URL that reloads when you save
  overlaify login [--site url] [--no-browser] [--token t]
                                                         connect the CLI to your overlaify.com account
  overlaify publish [file] [--public | --private] [--name n] [--title t] [--kind k] [--new]
                                                         publish an overlay to overlaify.com/<you>/<name>;
                                                         publishing the same file again adds a new version
  overlaify download <user>/<name> [file] [--version n] [--force]
                                                         save an overlay from overlaify.com as a local file;
                                                         a private one needs its owner logged in
  overlaify whoami | logout [--site url]                 show / forget the connected account
  overlaify spec                                         print the Overlay Spec (Markdown)
  overlaify skill                                        choose a target interactively (Claude Code in scripts)
  overlaify skill [--target <${[...skillTargets.keys()].join('|')}>] [--dir path]
                                                         install the skill for the specified local agent
  overlaify skill --target chatgpt [--output file.zip] [--force]
                                                         export overlaify-skill.zip for upload to ChatGPT`;

// --name value / --flag; everything else is positional.
function parse(argv) {
  const args = [], opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { args.push(a); continue; }
    const equals = a.indexOf('=');
    const k = a.slice(2, equals === -1 ? undefined : equals);
    if (equals !== -1) opts[k] = a.slice(equals + 1);
    else if (argv[i + 1] && !argv[i + 1].startsWith('--') && !['force', 'list', 'json', 'help', 'public', 'private', 'new', 'no-browser'].includes(k)) opts[k] = argv[++i];
    else opts[k] = true;
  }
  return { args, opts };
}

const [cmd, ...rest] = process.argv.slice(2);
const { args, opts } = parse(rest);

try {
  if (!cmd || cmd === 'help' || cmd === '--help' || opts.help) {
    console.log(HELP);
  } else if (cmd === '--version' || cmd === 'version') {
    console.log(version);
  } else if (cmd === 'init') {
    if (opts.list) {
      for (const t of templates()) console.log(`${t.slug.padEnd(24)} ${dim(t.kind.padEnd(14))} ${t.title}`);
    } else {
      const file = init(args[0], { template: opts.template, force: opts.force });
      const rel = relative(process.cwd(), file);
      console.log(`${green('Created')} ${rel}\n\nNext:\n  overlaify dev ${rel}       preview it and get the OBS URL\n  overlaify validate ${rel}  check it against the spec`);
    }
  } else if (cmd === 'validate') {
    if (!args.length) throw new Error('Name the overlay files to check: overlaify validate overlay.html');
    process.exitCode = validate(args, { json: opts.json }) ? 1 : 0;
  } else if (cmd === 'dev') {
    const file = args[0] || onlyHtmlFile('dev');
    const host = opts.host || '127.0.0.1';
    const port = await dev(file, { port: Number(opts.port) || 4545, host, channel: opts.channel });
    const base = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;
    console.log(`${bold('overlaify dev')} ${relative(process.cwd(), file)}\n\n  Dev page   ${base}/\n  OBS URL    ${base}/overlay  ${dim('(Browser source, 1920 × 1080)')}\n\nSaving the file reloads the preview and OBS. Ctrl+C to stop.`);
  } else if (cmd === 'login') {
    const { site, user } = await login({ site: opts.site, token: typeof opts.token === 'string' ? opts.token : undefined, browser: !opts['no-browser'] });
    console.log(`${green('Logged in')} to ${site} as ${bold(user.name)}.\nPublish an overlay with: overlaify publish <file>.html`);
  } else if (cmd === 'logout') {
    console.log((await logout({ site: opts.site })) ? `Logged out of ${siteUrl(opts.site)}.` : `Not logged in to ${siteUrl(opts.site)}.`);
  } else if (cmd === 'whoami') {
    const user = await whoami({ site: opts.site });
    if (!user) { console.log(`Not logged in to ${siteUrl(opts.site)}. Run: overlaify login`); process.exitCode = 1; }
    else console.log(`${user.name} ${dim(`(${siteUrl(opts.site)}/${user.handle})`)}`);
  } else if (cmd === 'publish') {
    if (opts.public && opts.private) throw new Error('Pick one: --public or --private.');
    const file = args[0] || onlyHtmlFile('publish');
    const out = await publish(file, {
      site: opts.site, name: opts.name, title: opts.title, kind: opts.kind, fresh: opts.new,
      visibility: opts.public ? 'public' : opts.private ? 'private' : undefined
    });
    for (const w of out.warnings || []) console.log(`${yellow('warning')} ${dim(`[${w.code}]`)} ${w.message}`);
    console.log(`${green('Published')} ${bold(out.title)} ${dim(`(${out.visibility}, version ${out.versions})`)}\n\n  Page     ${out.page}\n  OBS URL  ${out.url}  ${dim('(Browser source, 1920 × 1080)')}`);
  } else if (cmd === 'download') {
    if (!args[0]) throw new Error('Name the overlay: overlaify download <user>/<name>');
    const out = await download(args[0], args[1], { site: opts.site, version: opts.version, force: opts.force });
    const rel = relative(process.cwd(), out.file);
    console.log(`${green('Downloaded')} ${bold(out.title)} ${dim(`(${out.handle}/${out.name}, version ${out.version} of ${out.versions})`)} to ${rel}\n\nNext:\n  overlaify dev ${rel}       preview it` +
      (out.owned ? `\n  overlaify publish ${rel}   publish your changes as a new version` : ''));
  } else if (cmd === 'spec') {
    process.stdout.write(readFileSync(join(PKG, 'assets/overlay-spec.md'), 'utf8'));
  } else if (cmd === 'skill') {
    if (args.length || opts.target === true) throw new Error('Use --target <agent>. Run overlaify skill --help for the available targets.');
    const target = opts.target ?? await chooseSkillTarget(opts);
    if (target === undefined) {
      process.exitCode = 130;
    } else if (target === 'chatgpt') {
      if (opts.dir !== undefined) throw new Error('Use --output to choose the ChatGPT ZIP path.');
      const file = exportSkill({ output: opts.output, force: opts.force });
      console.log(`${green('Exported')} the Overlaify skill to ${file}\nUpload this ZIP in ChatGPT Skills if your workspace allows skill uploads.`);
    } else {
      if (opts.output !== undefined) throw new Error('--output is only for --target chatgpt. Use --dir for local installs.');
      const dir = installSkill({ target, dir: opts.dir });
      console.log(`${green('Installed')} the Overlaify skill for ${skillTargets.get(target).client} in ${dir}\nAsk for a stream overlay using the Overlaify skill.`);
    }
  } else {
    throw new Error(`Unknown command "${cmd}". Run overlaify --help.`);
  }
} catch (err) {
  console.error(red('Error: ') + err.message);
  process.exitCode = 1;
}

async function chooseSkillTarget({ dir, output }) {
  if (dir !== undefined || output !== undefined || !process.stdin.isTTY || !process.stdout.isTTY) return 'claude';

  const choices = [...skillTargets].map(([target, { client }]) => [target, client]);
  choices.push(['chatgpt', 'ChatGPT (export an uploadable ZIP)']);
  console.log('Choose an AI for the Overlaify skill:');
  for (const [index, [, label]] of choices.entries()) console.log(`  ${index + 1}. ${label}`);

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'Enter a number [1]: ' });
  rl.on('SIGINT', () => rl.close());
  try {
    rl.prompt();
    for await (const line of rl) {
      const answer = line.trim();
      const index = answer ? Number(answer) - 1 : 0;
      if (/^\d*$/.test(answer) && choices[index]) return choices[index][0];
      console.log(`Enter a number from 1 to ${choices.length}.`);
      rl.prompt();
    }
  } finally {
    rl.close();
  }
  console.log('\nSkill setup canceled.');
}

function onlyHtmlFile(cmd = 'dev') {
  const html = readdirSync(process.cwd()).filter((f) => /\.html?$/i.test(f));
  if (html.length === 1) return html[0];
  throw new Error(html.length ? `Several .html files here; name one: overlaify ${cmd} ${html[0]}` : 'No .html file here. Start one with: overlaify init');
}
