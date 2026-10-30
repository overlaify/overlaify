---
name: overlaify
description: Build live-stream overlays for Twitch/OBS (alert boxes, chat boxes, goal bars, timers, counters, tickers, webcam frames, Starting soon / BRB scenes, chat-command effects) as single HTML files that follow the Overlaify Overlay Spec, then validate and preview them with the overlaify CLI. Use whenever someone wants a stream overlay, an OBS browser source, or to change one that already exists.
argument-hint: "[describe the overlay you want]"
---

# Overlaify overlays

An Overlaify overlay is one HTML file that runs as an OBS Browser Source (1920×1080, transparent). It gets
Twitch events from the Overlaify SDK and declares its properties and live control keys in a JSON manifest.
Following the spec is what makes it work in OBS, in `overlaify dev`, and on overlaify.com without changes.

The full rules are in `references/overlay-spec.md`. Read it before writing your first overlay in a session.
`examples/` has three overlays that pass the spec: an alert queue (`neon-alert.html`), a chat box
(`chat-stack.html`) and a goal with properties and actions (`goal-bar.html`).

## Workflow

1. **Start the file.** Use `npx overlaify init <file>.html` for a blank starter (an alert with a manifest),
   or `npx overlaify init <file>.html --template <slug>` to start from a library template
   (`npx overlaify init --list` shows them). Pick the template closest to the request, then edit it.
2. **Write the overlay** (rules below). Keep everything in the one file.
3. **Validate** with `npx overlaify validate <file>.html`. Fix every error; fix warnings unless there is a
   reason not to, and say what it is. Repeat until it passes.
4. **Preview.** Suggest that the user run `npx overlaify dev <file>.html`. It is a long-running server, so
   start it in the background if you run it yourself. It prints:
   - a dev page with the preview, event buttons (follow, sub, gift, bits, raid, chat), the properties panel
     and the action keys;
   - an OBS URL (`http://localhost:4545/overlay`) to add as a Browser source at 1920×1080. It reloads
     when the file is saved, and the action keys reach it live.
   Tell the user to set their Twitch channel in the dev page's properties so real chat and events arrive.
5. **Publish (only when the user asks).** `npx overlaify publish <file>.html --private` or `--public` puts it
   on overlaify.com at `/<their username>/<name>` with a hosted OBS URL (named after the file, e.g. `my-alert.html` → `my-alert`; `--name` sets another). Ask the user which one they want; never pick for
   them. Private: only they can open it on the site, but the OBS URL still works. Public: anyone with a link
   can open and remix it, and it can be picked for the Overlaify Library. If it says they're not logged in,
   ask them to run `npx overlaify login` (it opens a browser to approve). Publishing the same file again
   adds a new version.
6. **Start from an overlay on overlaify.com.** When the user names one (`<user>/<name>` or its page URL),
   `npx overlaify download <user>/<name> [file]` saves it as a local file to change, then carry on from step 3.
   A private one only downloads for its owner; if it says to log in, ask them to run `npx overlaify login`.

If `npx` can't be used, the file still works: it loads the SDK from overlaify.com, so OBS can open it as a
local file with `?channel=<twitch name>` added.

## Rules that matter most

- One self-contained HTML document, at most 80 KB. Inline all CSS and JS. Keep
  `<script src="https://www.overlaify.com/sdk/v1/overlaify.js"></script>` in `<head>`; it is the only
  external script. External files are limited to Google Fonts and Twitch emote images; draw everything else
  with CSS, inline SVG, canvas or emoji.
- `html, body { margin: 0; width: 1920px; height: 1080px; overflow: hidden; background: transparent; }`.
  Paint a full-screen background only for full scenes (Starting soon, BRB).
- Events come only from the SDK: `Overlaify.on('sub', fn)` and friends. There are no network calls, no
  clicks and no dialogs; the overlay just runs.
- Events look the same on every platform. For bits and other money, handle `tip` (show `e.display`, size
  with `e.usd`), not `cheer`, which is Twitch-only; never both, or bits count twice.
- For alerts, use `Overlaify.queue(handler)` so alerts never overlap.
- Never insert viewer text as HTML. Use `textContent`, `Overlaify.escape()`, or
  `Overlaify.renderMessage(text, emotes)` for chat with emotes.
- Manifest in `<head>`: `<script type="application/json" id="overlaify-manifest">{ "spec": 1, ... }</script>`.
  - Every customizable value is a **property**, declared under `"properties"` and read with `Overlaify.param('key', <same default>)`.
  - Every **action** has a handler, `Overlaify.action('name', fn)`. Add actions only for live state
    (timers, counters, goals, queues, scenes): pause/resume, add/remove, reset with `"style": "danger"` and
    `"confirm": true`.
  - Never declare `channel`, `volume`, `mute` or `test`; the platform provides them.
- Wrap `localStorage` in `try/catch` (the page runs sandboxed), and use it when an action's state should
  survive an OBS refresh.

## Making it look good

Aim for a premium, hand-made overlay pack, not a generic template:
- one clear visual idea;
- a palette and type pairing that match the streamer's description;
- motion with personality: an entrance, a subtle idle and an exit.

Animate `transform` and `opacity`. Text must stay readable over busy gameplay and on phone screens: large
sizes, strong contrast, an outline or shadow. Place things where streamers expect them unless asked
otherwise:
- alerts: top-center
- chat: left edge
- goal bars: top edge
- tickers: bottom edge
- webcam frames: a corner

## Changing an existing overlay

Edit the file in place and keep everything that wasn't asked to change. When behavior changes, update the
manifest too (new properties, renamed actions), then validate again. If its manifest still says `"settings"`,
rename that key to `"properties"`.
