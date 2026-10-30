# overlaify

Build Twitch overlays for OBS as single HTML files that follow the **Overlaify Overlay Spec**, whether you,
Claude or another AI writes them. Then check them, preview them with simulated events, and control them live
from your own machine. Free and local; [overlaify.com](https://www.overlaify.com) hosts the same files.

```bash
npx overlaify init my-alert.html                 # blank starter
npx overlaify init --list                        # library templates
npx overlaify init goal.html --template goal-bar
npx overlaify validate my-alert.html             # check against the spec (exit 1 on errors)
npx overlaify dev my-alert.html                  # dev page + OBS URL
npx overlaify login                              # connect your overlaify.com account
npx overlaify publish my-alert.html              # publish it to My overlays (asks public or private)
npx overlaify download alice/neon-alert          # save someone's overlay from overlaify.com as a local file
npx overlaify spec                               # print the spec
npx overlaify skill                              # install the Claude skill
```

## `overlaify dev`

The dev page at `http://localhost:4545/` has:

- a preview of the overlay at 1920×1080;
- buttons that fire follow, sub, gift, bits, raid and chat events;
- a properties panel built from the overlay's manifest, with your Twitch channel;
- the overlay's action keys (pause, add, reset…);
- the spec check.

Add `http://localhost:4545/overlay` to OBS as a Browser source (1920×1080). It gets real Twitch chat and
events from your channel, the action keys reach it live, and it reloads whenever you save the file.
Properties are saved in `.overlaify/<name>.json` next to the file.

Options: `--port`, `--channel <twitch name>`, and `--host 0.0.0.0` to reach it from a second streaming PC.

## `overlaify publish`

`overlaify login` opens overlaify.com in your browser; sign in and click Allow, and the CLI keeps a token in
`~/.overlaify/credentials.json`. Then:

```bash
npx overlaify publish my-alert.html             # first time: choose private (only you) or public
npx overlaify publish my-alert.html --public    # or say it up front
npx overlaify publish my-alert.html             # again: a new version of the same overlay
npx overlaify publish my-alert.html --new       # a separate overlay instead
npx overlaify publish my-alert.html --name neon # its name, and address: overlaify.com/<your username>/neon
```

The overlay must pass the spec. It gets its own page at `overlaify.com/<your username>/<name>`. The first publish
names it after the file (`my-alert.html` → `my-alert`) and lets you change that at the prompt; `--name` sets it
up front, shows up in My overlays with its OBS URL, and the
properties you chose in `overlaify dev` come with it. Which overlay a file was published as is kept in
`.overlaify/<name>.publish.json`.

Names work like GitHub repository names: unique among your overlays (ignoring case), while other users can have
the same one. They can use letters, digits, `-`, `_` and `.`. Rename an overlay in its Settings on overlaify.com,
and links to the old name redirect to the new one until you give the old name to another overlay.

- **Private**: only you can open it on overlaify.com. Its OBS URL still works.
- **Public**: anyone with a link can open it and remix it. Public overlays can be picked for the
  Overlaify Library.

Other options: `--title`, `--kind alert|chat|goal|ticker|frame|custom`, and `--site` for another copy of the
site. `OVERLAIFY_TOKEN` replaces the saved token, for CI. `overlaify whoami` and `overlaify logout` manage the
login.

## `overlaify download`

```bash
npx overlaify download alice/neon-alert                    # → neon-alert.html, the latest version
npx overlaify download https://www.overlaify.com/alice/neon-alert my.html
npx overlaify download alice/neon-alert --version 1        # an older version (1 is the first)
```

Saves the overlay at `overlaify.com/<user>/<name>` as a file that runs on its own (the SDK tag is put back),
ready for `overlaify dev`. It won't overwrite a file unless you pass `--force`. Anyone can download a public
overlay. A private one only downloads for its owner: log in first with `overlaify login`, or you get told to.

For your own overlay its saved properties come along in `.overlaify/<name>.json`, and the file is linked to the
overlay, so `overlaify publish` adds your changes to it as a new version.

## The spec in one minute

- One self-contained HTML file, at most 80 KB, with a transparent 1920×1080 canvas.
- It loads only `https://www.overlaify.com/sdk/v1/overlaify.js`.
- Events come from the SDK: `Overlaify.on('sub', fn)`, `Overlaify.queue(fn)` for alerts.
- A JSON manifest declares the overlay's properties (read them with `Overlaify.param`) and its live actions
  (handle them with `Overlaify.action`):

```html
<script type="application/json" id="overlaify-manifest">
{ "spec": 1,
  "properties": [{ "key": "color", "label": "Color", "type": "color", "default": "#c6ff3d" }],
  "actions":  [{ "name": "reset", "label": "Reset", "style": "danger", "confirm": true }] }
</script>
```

`npx overlaify spec` prints the full spec.

## Claude skill

`npx overlaify skill` installs a skill in `~/.claude/skills/overlaify`. After that, Claude Code can be asked
for an overlay and will write it to the spec, validate it and preview it with this CLI.

## Repository layout

```
bin/overlaify.js     the CLI entry
lib/                 init / validate / dev / login / publish / download / skill commands, the dev page, a tiny WebSocket server
lib/validate.js      the spec checker (synced from the site)
assets/              the SDK, the Library templates and the spec (synced)
skill/               the Claude skill: SKILL.md, plus the spec and three examples (synced)
scripts/sync.mjs     refreshes the synced copies
```

The spec, SDK, validator and templates are shared with [overlaify.com](https://www.overlaify.com), which is
where they change first. `npm run sync` fetches the templates from the Library on the site (`SITE=url` for
another copy) and copies the rest from a checkout of the site (`../overlaify_web` by default, or
`OVERLAIFY_WEB=path`). `SKILL.md` and everything else is edited here.

```bash
node bin/overlaify.js dev assets/templates/goal-bar.html   # run from the repo
npm publish                                                # publish to npm
```

## License

MIT
