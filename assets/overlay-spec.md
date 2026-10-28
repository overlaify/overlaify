# Overlaify Overlay Spec — v1

An Overlaify overlay is one HTML document that runs as an OBS Browser Source. Anything that follows this spec
— written in Overlaify Studio, by another AI, or by hand — can be hosted on Overlaify, previewed with simulated
events, configured from a settings panel and controlled live from a control page.

The spec has three parts:

1. **The document**: what the HTML file may contain.
2. **The runtime**: the `Overlaify` SDK the overlay talks to, and the events it receives.
3. **The manifest**: a JSON block in which the overlay declares its settings and live actions.

`src/lib/validate.js` checks an overlay against this spec. Each rule below names the code it reports.
**Errors** break the overlay on Overlaify and must be fixed. **Warnings** are quality problems.

---

## 1. The document

| Rule | Code |
|---|---|
| One complete HTML document (`<!doctype html><html>…</html>`). | `not_html` (warning) |
| A short overlay name in `<title>`. | `title_missing` (warning) |
| At most 80 KB (80,000 bytes), so that Studio can still edit it. | `too_large` |
| All CSS and JS inline. The one `<script src>` allowed is the SDK, `https://www.overlaify.com/sdk/v1/overlaify.js` (or `/sdk/v1/overlaify.js`), so the file also runs on its own; Overlaify replaces it with its own copy when hosting. | `external_script` |
| No external files: stylesheets, images, audio, video, iframes, CSS `url()`/`@import`. The only hosts allowed are Google Fonts (`fonts.googleapis.com`, `fonts.gstatic.com`) and Twitch emotes (`static-cdn.jtvnw.net`). Use `data:` URLs, inline SVG, canvas or emoji instead. | `external_resource` |
| No `<iframe>`, `<object>` or `<embed>`. | `embedded_frame` |
| Other URLs in the code (outside tags) point only at those hosts. | `external_url` (warning) |
| No network calls (`fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`): events come from the SDK. | `network_access` (warning) |
| No user interaction or dialogs (`alert`, `confirm`, `prompt`): the overlay just runs. | `blocking_dialog` (warning) |

Guidelines (not checked):

- The canvas is 1920×1080. `html` and `body`: `margin: 0; width: 1920px; height: 1080px; overflow: hidden; background: transparent`.
  Paint a full-screen background only for full scenes (Starting soon, BRB).
- Never insert user text as raw HTML. Use `Overlaify.escape(str)` or `textContent`, and `Overlaify.renderMessage(text, emotes)` for chat with emotes.
- Wrap `localStorage`/`sessionStorage` in `try/catch`: the page runs in a sandboxed, opaque origin.
- Animate with `transform` and `opacity`. Keep text readable over gameplay (contrast, outline or shadow, large sizes).

## 2. The runtime

Overlaify injects the SDK before the overlay's own scripts, so a global `Overlaify` object is always there.
Each spec version has its own SDK URL, `/sdk/v1/overlaify.js` for this one, so overlays written for it keep
working when a later spec changes the runtime. `Overlaify.spec` is the version the loaded SDK implements.

```
Overlaify.on(type, handler)           subscribe; returns an unsubscribe function. '*' receives every event once.
Overlaify.off(type, handler)
Overlaify.queue(handler, { gap })     returns enqueue(event); runs handler one event at a time. handler may be
                                      async or return ms to wait. Use it for alerts so they never overlap.
Overlaify.param(key, fallback)        a setting's value; number and boolean fallbacks coerce the type.
Overlaify.action(name, fn)            handle a manifest action; fn(value, event) gets the action's input value.
Overlaify.dispatch(name, value?)      run an action from the overlay's own code (e.g. a chat command).
Overlaify.escape(str)                 HTML-escape.
Overlaify.renderMessage(text, emotes) safe HTML with Twitch emote <img class="ov-emote">.
Overlaify.chime(kind, volume?)        built-in sound: 'alert' | 'pop' | 'coin' | 'fanfare' | 'low'. Respects mute.
Overlaify.sleep(ms)                   Promise delay.
Overlaify.simulate(type, overrides?)  emit a fake event (used by previews).
Overlaify.channel                     Twitch channel login ('' in previews).
Overlaify.sources                     the connected sources: [{ platform, channel, connected }].
Overlaify.isTest                      true when random test events are running.
```

### Events

Events have the same shape whatever platform they come from, so an overlay works on every platform
Overlaify connects to without knowing which one it is on. Today that is Twitch; more will follow without a new
spec version.

Every event has `type`, `id`, `timestamp`, `platform` (`'twitch'`), `user` (login), `userId` (`''` when
unknown), `name` (display name), `color` (hex or `null`) and `simulated` (boolean). Simulated events look like
Twitch events.

| Type | Extra fields |
|---|---|
| `chat` | `message`, `emotes`, `badges: string[]`, `isMod`, `isSub`, `isVip`, `isBroadcaster`, `bits`, `action` |
| `follow` | — |
| `sub` | `months`, `tier: 'prime' \| '1' \| '2' \| '3'`, `message` |
| `gift` | `recipient`, `recipientName`, `tier`, `anonymous` |
| `giftbomb` | `count`, `tier` (Twitch also sends one `gift` per recipient afterwards) |
| `tip` | `amount`, `currency`, `kind`, `usd`, `display`, `message`, `emotes` |
| `cheer` | `bits`, `message`, `emotes` (Twitch only) |
| `raid` | `viewers` |

`tip` is money from a viewer on any platform. `amount` is in `currency`, which is `'bits'` for Twitch bits or an
ISO code such as `'USD'`; `kind` names the platform's feature (`'bits'` on Twitch); `usd` is the approximate
value in US dollars, for thresholds and sizing; `display` is ready to show, such as `"500 bits"`. Twitch bits
fire both `cheer` and `tip`. Handle `tip` in new overlays so they also count tips from other platforms, and
never both, or bits count twice (`cheer_and_tip`, warning). `'*'` gets Twitch bits once, as the `cheer`.

Lifecycle events, not included in `'*'`: `connected`, `disconnected`, with `platform` and `channel`; they fire
for each source. Subscribing to any other name is reported as `unknown_event` (warning).

### Where values come from

- **Settings** saved by the streamer arrive as `window.OVERLAIFY_CONFIG`. URL query parameters override them.
  Both are read with `Overlaify.param`.
- Reserved keys, always provided by the platform: `channel`, `sources`, `volume`, `mute`, `test`.
- **Sources** say where events come from: `OVERLAIFY_CONFIG.sources`, a list of `{ platform, channel }`,
  plus `?channel=` as a Twitch source. One overlay can listen to several at once.
- **Actions** come from the control page (`/c/:id`), the preview's keys, or `Overlaify.dispatch`.

## 3. The manifest

The overlay declares itself in a JSON block in `<head>`, before its own scripts:

```html
<script type="application/json" id="overlaify-manifest">
{
  "spec": 1,
  "settings": [ ... ],
  "actions": [ ... ]
}
</script>
```

| Rule | Code |
|---|---|
| Overlays that read settings or handle actions have a manifest. Without one, the streamer gets no settings panel or keys. | `manifest_missing` (warning) |
| At most one manifest block. | `manifest_duplicate` |
| `type="application/json"`, so the browser does not run it. | `manifest_type` |
| Valid JSON object: double quotes, no comments, no trailing commas. | `manifest_json` |
| `"spec": 1`. | `spec_missing` (warning), `spec_version` |
| `settings` and `actions` are arrays when present. | `manifest_shape` |
| No other top-level keys. | `manifest_unknown_key` (warning) |

### Settings

Settings are the overlay's starting state. The streamer edits them in a panel; the overlay reads each one with
`Overlaify.param(key, fallback)`, using the manifest's default as the fallback.

```json
{ "key": "color", "label": "Fill color", "type": "color", "default": "#ff4f8b",
  "swatches": ["#ff4f8b", "#ffb547", "#c6ff3d"], "group": "Look", "desc": "Bar and glow." }
```

| Field | Rule | Code |
|---|---|---|
| `key` | Required. Letters, digits, `_` or `-`, starting with a letter, at most 40 characters. Unique. | `setting_key`, `setting_duplicate` |
| | Not a reserved key (`channel`, `volume`, `mute`, `test`). | `setting_reserved` |
| `label` | Short name shown in the panel. | `setting_label` (warning) |
| `type` | `text`, `number`, `toggle`, `color`, `select`, `segmented` or `range`. | `setting_type` |
| `default` | Required, and matching the type (see below). | `setting_default_missing` (warning), `setting_default` |
| `desc`, `group` | Optional strings. `group` puts settings under a heading; use groups once there are more than about 4 settings. | `setting_field` (warning) |

By type:

| Type | Default | Other fields |
|---|---|---|
| `text` | string | — |
| `number` | number | — |
| `toggle` | boolean; read with a boolean fallback | — |
| `color` | `#rrggbb` | `swatches`: optional array of `#rrggbb` presets (`setting_swatches`) |
| `select` | one of the option values | `options`: non-empty array (`setting_options`) |
| `segmented` | one of the option values | `options`: 2–4 short choices (`setting_options`; more than 4 is a warning) |
| `range` | number within `min`–`max` | `min` and `max` required, `min < max`, `step > 0`, optional `unit` (`setting_range`) |

Options are plain values (`"subs"`) or `{ "value": "subs", "label": "Subs" }`.

Consistency with the code:

- Every setting is read with `Overlaify.param('key', …)`. → `setting_unused` (warning)
- Every `Overlaify.param('key', …)`, other than reserved keys, is declared as a setting. → `param_undeclared` (warning)

### Actions

Actions change the overlay while it runs (pause, add time, reset, show a message). They appear as keys on the
control page. Add them only when the overlay has state worth controlling live: timers, counters, goals, queues
or toggled scenes.

```json
{ "name": "add", "label": "Add", "input": { "type": "number", "label": "Amount", "default": 1, "step": 1, "min": 1 } }
```

| Field | Rule | Code |
|---|---|---|
| `name` | Required, same format as setting keys, unique. | `action_name`, `action_duplicate` |
| `label` | The key's text. | `action_label` (warning) |
| `group` | Optional heading. | `action_field` (warning) |
| `style` | `primary` (default), `secondary` (less used half of a pair) or `danger` (resets and clears). | `action_style` |
| `confirm` | `true` or a short question. The key asks for a second press. Use it on anything that throws away progress. | `action_confirm` |
| `wide` | `true` makes the key take a full row. | `action_field` (warning) |
| `input` | `{ type: number \| text \| select, label, default, min?, max?, step?, options? }`: a value sent with the action. `select` needs `options`, and a `number` default must be a number. | `action_input` |

Consistency with the code:

- Every action has a handler, `Overlaify.action('name', fn)`. Otherwise its key does nothing. → `action_unhandled`
- Every handler is declared in the manifest, unless it is only dispatched from the overlay's own code. → `action_undeclared` (warning)

---

## Versioning

This is spec version 1. Additions that old overlays can ignore (new event types, new setting types, new
optional fields) keep the version number. Changes that would break an existing overlay raise it and
get a new SDK URL (`/sdk/v2/…`); `/sdk/v1/overlaify.js` stays as it is for v1 overlays.
