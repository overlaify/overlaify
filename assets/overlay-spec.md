# Overlaify Overlay Spec — v1

An Overlaify overlay is one HTML document that runs as an OBS Browser Source. Anything that follows this spec
— written in Overlaify Studio, by another AI, or by hand — can be hosted on Overlaify, previewed with simulated
events, configured from a properties panel and controlled live from a control page.

The spec has three parts:

1. **The document**: what the HTML file may contain.
2. **The runtime**: the `Overlaify` SDK the overlay talks to, and the events it receives.
3. **The manifest**: a JSON block in which the overlay declares its properties and live actions.

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
- Keep live state that should survive a refresh in the store (section 2, "State"), not in `localStorage`: hosted
  overlays run in a sandboxed, opaque origin where storage throws. Wrap any other `localStorage`/`sessionStorage`
  use in `try/catch`.
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
Overlaify.param(key, fallback)        a property's value; number and boolean fallbacks coerce the type.
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
Overlaify.store(def)                  the overlay's live state; see "State" below.
Overlaify.now() / random()            in a store handler: the event's time / seeded randomness. Elsewhere: local.
Overlaify.fx(name, data?)             a one-shot effect; Overlaify.on('fx:<name>', e => …) gets { data }.
Overlaify.after(ms, name, data?)      in a store handler: run timers[name] later. Overlaify.cancel(name) drops it.
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
for each source. Besides those, `action:<name>` and `fx:<name>`, subscribing to any other name (or a store
`events` handler for one) is reported as `unknown_event` (warning).

### Where values come from

- **Properties** saved by the streamer arrive as `window.OVERLAIFY_CONFIG`. URL query parameters override them.
  Both are read with `Overlaify.param`.
- Reserved keys, always provided by the platform: `channel`, `sources`, `volume`, `mute`, `test`.
- **Sources** say where events come from: `OVERLAIFY_CONFIG.sources`, a list of `{ platform, channel }`,
  plus `?channel=` as a Twitch source. One overlay can listen to several at once.
- **Actions** come from the control page (`/c/:id`), the preview's keys, or `Overlaify.dispatch`.

### State

Overlays with live state (scores, counters, goals, timers, rounds, players) keep it in one store, so it
survives an OBS refresh and the same file works in a browser, in `overlaify dev` and on Overlaify. Its handlers
are grouped like the manifest:

```js
const store = Overlaify.store({
  version: 1,                                   // bump when the state's shape changes; older saves are dropped
  state: () => ({ count: Overlaify.param('start', 0), endsAt: 0 }),   // the starting state
  actions: {                                    // (state, value, event), one per manifest action
    add: (s, n) => { s.count += Number(n) || 1; Overlaify.fx('bump'); },
    start: s => { s.endsAt = Overlaify.now() + 60000; Overlaify.after(60000, 'end'); },
    reset: s => { s.count = 0; }
  },
  events: {                                     // (state, event), platform events by type
    sub: s => { store.actions.add(s, 5); },      // handlers are plain functions and can call each other
    chat(s, e) { if (e.isMod && e.message === '!reset') store.actions.reset(s); }
  },
  timers: {                                     // (state, data), run by Overlaify.after
    end: s => { s.endsAt = 0; }
  }
});

store.render((s, prev) => { /* draw s; prev is null the first time */ });
Overlaify.on('fx:bump', () => Overlaify.chime('pop'));
```

- The store gets every event and action before `Overlaify.on` listeners. `events['*']` gets the events without
  their own handler, as `Overlaify.on('*')` does: Twitch bits once, as `cheer`.
- Handlers change `s` in place, or return a new state. They run on a copy: one that throws changes nothing.
- **Handlers are pure.** No DOM, no network, and no `Date.now()` or `Math.random()`. Inside a handler,
  `Overlaify.now()` is the event's time, `Overlaify.random()` is seeded and saved with the state, and
  `Overlaify.fx()` fires once the change is applied. That way the same events give the same state wherever
  they run. Outside handlers, as in `render`, `now()` and `random()` are the local clock and plain randomness.
- Keep the state plain JSON (objects, arrays, numbers, strings, booleans). Store times as absolute
  timestamps (`endsAt`) and draw countdowns from `endsAt - Overlaify.now()`.
- Things that happen later are timers, not `setTimeout`: `Overlaify.after(ms, name, data)` in a handler runs
  `timers[name]` at that time, also after a refresh. `Overlaify.cancel(name)` drops it.
- `render(state, prev)` must draw any state from scratch, because a refresh starts from a saved state. Compare
  with `prev` to pick an animation. Play sounds and one-off animations from `fx`, not from `render`.
- Handle chat commands in `events.chat`. Don't call `Overlaify.dispatch` from listeners to change state.
- `store` also has `getState()`, `subscribe(fn)` (no first call), `actions`, `dispatch(name, value)` and
  `reset()` (back to the starting state).
- One store per overlay. Overlays that don't call `Overlaify.store` work as before.
- Today the state is saved in `localStorage` where the page has it (`overlaify dev`, a local file) and kept in
  memory on hosted overlays. Saving on Overlaify itself is planned; overlays need no changes for it.

## 3. The manifest

The overlay declares itself in a JSON block in `<head>`, before its own scripts:

```html
<script type="application/json" id="overlaify-manifest">
{
  "spec": 1,
  "properties": [ ... ],
  "actions": [ ... ]
}
</script>
```

| Rule | Code |
|---|---|
| Overlays that read properties or handle actions have a manifest. Without one, the streamer gets no properties panel or keys. | `manifest_missing` (warning) |
| At most one manifest block. | `manifest_duplicate` |
| `type="application/json"`, so the browser does not run it. | `manifest_type` |
| Valid JSON object: double quotes, no comments, no trailing commas. | `manifest_json` |
| `"spec": 1`. | `spec_missing` (warning), `spec_version` |
| `properties` and `actions` are arrays when present. | `manifest_shape` |
| `properties` was called `settings` before; an old manifest with `settings` and no `properties` still works. | `manifest_settings` (warning) |
| No other top-level keys. | `manifest_unknown_key` (warning) |

### Properties

Properties are the overlay's starting state. The streamer edits them in a panel; the overlay reads each one with
`Overlaify.param(key, fallback)`, using the manifest's default as the fallback.

```json
{ "key": "color", "label": "Fill color", "type": "color", "default": "#ff4f8b",
  "swatches": ["#ff4f8b", "#ffb547", "#c6ff3d"], "group": "Look", "desc": "Bar and glow." }
```

| Field | Rule | Code |
|---|---|---|
| `key` | Required. Letters, digits, `_` or `-`, starting with a letter, at most 40 characters. Unique. | `property_key`, `property_duplicate` |
| | Not a reserved key (`channel`, `volume`, `mute`, `test`). | `property_reserved` |
| `label` | Short name shown in the panel. | `property_label` (warning) |
| `type` | `text`, `number`, `toggle`, `color`, `select`, `segmented` or `range`. | `property_type` |
| `default` | Required, and matching the type (see below). | `property_default_missing` (warning), `property_default` |
| `desc`, `group` | Optional strings. `group` puts properties under a heading; use groups once there are more than about 4 properties. | `property_field` (warning) |

By type:

| Type | Default | Other fields |
|---|---|---|
| `text` | string | — |
| `number` | number | — |
| `toggle` | boolean; read with a boolean fallback | — |
| `color` | `#rrggbb` | `swatches`: optional array of `#rrggbb` presets (`property_swatches`) |
| `select` | one of the option values | `options`: non-empty array (`property_options`) |
| `segmented` | one of the option values | `options`: 2–4 short choices (`property_options`; more than 4 is a warning) |
| `range` | number within `min`–`max` | `min` and `max` required, `min < max`, `step > 0`, optional `unit` (`property_range`) |

Options are plain values (`"subs"`) or `{ "value": "subs", "label": "Subs" }`.

Consistency with the code:

- Every property is read with `Overlaify.param('key', …)`. → `property_unused` (warning)
- Every `Overlaify.param('key', …)`, other than reserved keys, is declared as a property. → `param_undeclared` (warning)

### Actions

Actions change the overlay while it runs (pause, add time, reset, show a message). They appear as keys on the
control page. Add them only when the overlay has state worth controlling live: timers, counters, goals, queues
or toggled scenes.

```json
{ "name": "add", "label": "Add", "input": { "type": "number", "label": "Amount", "default": 1, "step": 1, "min": 1 } }
```

| Field | Rule | Code |
|---|---|---|
| `name` | Required, same format as property keys, unique. | `action_name`, `action_duplicate` |
| `label` | The key's text. | `action_label` (warning) |
| `group` | Optional heading. | `action_field` (warning) |
| `style` | `primary` (default), `secondary` (less used half of a pair) or `danger` (resets and clears). | `action_style` |
| `confirm` | `true` or a short question. The key asks for a second press. Use it on anything that throws away progress. | `action_confirm` |
| `wide` | `true` makes the key take a full row. | `action_field` (warning) |
| `input` | `{ type: number \| text \| select, label, default, min?, max?, step?, options? }`: a value sent with the action. `select` needs `options`, and a `number` default must be a number. | `action_input` |

Consistency with the code:

- Every action has a handler: `Overlaify.action('name', fn)`, or `actions.name` in the store. Otherwise its key does
  nothing. → `action_unhandled`
- Every handler is declared in the manifest, unless it is only dispatched from the overlay's own code. → `action_undeclared` (warning)

---

## Versioning

This is spec version 1. Additions that old overlays can ignore (new event types, new property types, new
optional fields) keep the version number. Changes that would break an existing overlay raise it and
get a new SDK URL (`/sdk/v2/…`); `/sdk/v1/overlaify.js` stays as it is for v1 overlays.
