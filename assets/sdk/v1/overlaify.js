/*!
 * Overlaify SDK v0.1.0 — https://www.overlaify.com
 * Connects an OBS Browser Source overlay to live-stream events.
 * Runtime for Overlay Spec v1 (docs/overlay-spec.md), served at /sdk/v1/overlaify.js. A later spec that
 * would break v1 overlays gets its own /sdk/vN/ path; this one keeps working for them.
 *
 *   Sources: each { platform, channel } in OVERLAIFY_CONFIG.sources, plus ?channel= as a Twitch source.
 *   A connector per platform turns that platform's events into the events below, tagged with `platform`.
 *   Platforms: twitch (chat, anonymous and read-only).
 *
 *   URL params:
 *     ?channel=name   connect to this Twitch channel's chat
 *     ?test=1         emit random simulated events (for previews)
 *     ?mute=1         silence Overlaify.chime()
 *     anything else   read with Overlaify.param(name, fallback)
 *   Settings saved for an installed overlay arrive as window.OVERLAIFY_CONFIG and act as defaults.
 *   window.OVERLAIFY_LIVE = { room } (set by /o/:id) connects it to its live control page, /c/:room,
 *   whose action keys arrive as Overlaify.dispatch(name, value, { live: true }). Previews in a frame don't connect.
 *
 *   Events: chat, follow, sub, gift, giftbomb, cheer, tip, raid  ('*' = all, each once)
 *     tip is money from any platform; Twitch bits fire cheer and tip, and reach '*' as the cheer.
 *   Lifecycle: connected, disconnected  ({ platform, channel })
 *
 *   An overlay can describe itself in <script type="application/json" id="overlaify-manifest">:
 *     { "settings": [{ key, label, type: text|number|color|toggle|select|segmented|range, default, desc?, group?,
 *                      options? (select/segmented: values or { value, label }), min?, max?, step?, unit? (range),
 *                      swatches? (color: preset hex colors) }],
 *       "actions":  [{ name, label, group?, style?: primary|secondary|danger, confirm?: true|text, wide?,
 *                      input?: { type: number|text|select, label, default, min?, max?, step?, options? } }] }
 *   Settings are its starting state (read them with Overlaify.param). Actions change that state while it
 *   runs: Overlaify.action('pause', fn) handles one, Overlaify.dispatch('pause') runs it (e.g. from chat).
 */
(function () {
  'use strict';
  if (window.Overlaify) return;

  // Saved settings (window.OVERLAIFY_CONFIG, set by /o/:id) are the defaults; the URL's own params win.
  // Structured config (sources) stays out of params.
  var params = new URLSearchParams(location.search);
  var saved = window.OVERLAIFY_CONFIG || {};
  Object.keys(saved).forEach(function (k) {
    if (!params.has(k) && (saved[k] === null || typeof saved[k] !== 'object')) params.set(k, saved[k]);
  });
  var listeners = {};
  var seq = 0;
  var inFrame = false;
  try { inFrame = window.top !== window.self; } catch (e) { inFrame = true; }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function uid() { return Date.now().toString(36) + '-' + (++seq).toString(36); }
  function cleanChannel(s) { return String(s || '').toLowerCase().replace(/^#/, '').trim(); }

  // Twitch bits are both a cheer and a tip. '*' gets them once, as the cheer, as it always has.
  function emitBits(emit, d) {
    var bits = Number(d.bits) || 0;
    var tip = Object.assign({}, d, {
      amount: bits, currency: 'bits', kind: 'bits', usd: bits / 100,
      display: bits.toLocaleString('en-US') + (bits === 1 ? ' bit' : ' bits')
    });
    delete tip.bits;
    return { cheer: emit('cheer', d), tip: emit('tip', tip, { wildcard: false }) };
  }

  function escapeHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // emotes: { "25": [[0,4],[12,16]] }  (Twitch code-point offsets)
  function renderMessage(text, emotes) {
    var chars = Array.from(String(text || ''));
    var repl = [];
    if (emotes) {
      Object.keys(emotes).forEach(function (id) {
        (emotes[id] || []).forEach(function (r) { repl.push({ s: r[0], e: r[1], id: id }); });
      });
    }
    repl.sort(function (a, b) { return a.s - b.s; });
    var out = '', i = 0;
    repl.forEach(function (r) {
      if (r.s < i || r.s >= chars.length) return;
      out += escapeHTML(chars.slice(i, r.s).join(''));
      var name = chars.slice(r.s, r.e + 1).join('');
      out += '<img class="ov-emote" alt="' + escapeHTML(name) + '" src="https://static-cdn.jtvnw.net/emoticons/v2/' +
        encodeURIComponent(r.id) + '/default/dark/2.0" style="height:1.4em;vertical-align:middle">';
      i = r.e + 1;
    });
    return out + escapeHTML(chars.slice(i).join(''));
  }

  var O = {
    version: '0.1.0',
    spec: 1,
    params: params,
    channel: cleanChannel(params.get('channel')),
    sources: [],
    isTest: params.get('test') === '1',
    connected: false,

    param: function (name, fallback) {
      var v = params.get(name);
      if (v === null || v === '') return fallback;
      if (typeof fallback === 'number') { var n = Number(v); return isNaN(n) ? fallback : n; }
      if (typeof fallback === 'boolean') return v === '1' || v === 'true';
      return v;
    },

    on: function (type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
      return function () { O.off(type, fn); };
    },
    off: function (type, fn) {
      listeners[type] = (listeners[type] || []).filter(function (f) { return f !== fn; });
    },
    // opts.wildcard === false keeps the event from '*' (it duplicates one '*' already got).
    emit: function (type, data, opts) {
      var ev = Object.assign({ type: type, id: uid(), timestamp: Date.now(), user: '', name: '', color: null }, data || {});
      var own = type === 'connected' || type === 'disconnected' || type.indexOf('action:') === 0 || (opts && opts.wildcard === false);
      var fns = (listeners[type] || []).concat(own ? [] : (listeners['*'] || []));
      fns.forEach(function (fn) { try { fn(ev); } catch (e) { console.error('[overlaify] handler error', e); } });
      return ev;
    },

    // Sequential runner: handler(ev) may return a Promise or a number (ms to wait).
    queue: function (handler, opts) {
      var gap = (opts && opts.gap != null) ? opts.gap : 300;
      var items = [], busy = false;
      function pump() {
        if (busy) return;
        busy = true;
        (function next() {
          if (!items.length) { busy = false; return; }
          var ev = items.shift();
          Promise.resolve().then(function () { return handler(ev); })
            .then(function (r) { return typeof r === 'number' ? sleep(r) : null; })
            .catch(function (e) { console.error('[overlaify] queue error', e); })
            .then(function () { return sleep(gap); })
            .then(next);
        })();
      }
      return function (ev) { items.push(ev); pump(); };
    },

    escape: escapeHTML,
    renderMessage: renderMessage,
    sleep: sleep,

    // Tiny built-in synth so overlays can have sound without audio files.
    chime: function (kind, volume) {
      if (params.get('mute') === '1') return;
      try {
        var C = O._ac || (O._ac = new (window.AudioContext || window.webkitAudioContext)());
        var v = volume == null ? Number(params.get('volume') || 0.25) : volume;
        var notes = { alert: [660, 880, 1320], pop: [880], coin: [988, 1319], fanfare: [523, 659, 784, 1047], low: [220, 165] }[kind || 'alert'] || [660];
        var t = C.currentTime;
        notes.forEach(function (f, i) {
          var o = C.createOscillator(), g = C.createGain(), at = t + i * 0.1;
          o.type = kind === 'coin' ? 'square' : (kind === 'low' ? 'sawtooth' : 'sine');
          o.frequency.value = f;
          g.gain.setValueAtTime(0.0001, at);
          g.gain.exponentialRampToValueAtTime(Math.max(v, 0.0002), at + 0.015);
          g.gain.exponentialRampToValueAtTime(0.0001, at + 0.35);
          o.connect(g); g.connect(C.destination);
          o.start(at); o.stop(at + 0.4);
        });
      } catch (e) { /* audio not available */ }
    },

    // Simulated events look like Twitch's: a simulated tip is bits, so it fires cheer too.
    simulate: function (type, overrides) {
      var d = Object.assign(fake(type), overrides || {});
      if (type === 'cheer' || type === 'tip') {
        if (type === 'tip' && overrides && overrides.amount != null) d.bits = Number(overrides.amount);
        var fired = emitBits(O.emit, d);
        return type === 'tip' ? fired.tip : fired.cheer;
      }
      return O.emit(type, d);
    },

    // fn(value, ev) runs when the action is dispatched; value is its input, if it takes one.
    action: function (name, fn) {
      return O.on('action:' + name, function (ev) { return fn(ev.value, ev); });
    },
    dispatch: function (name, value, extra) {
      return O.emit('action:' + name, Object.assign({ value: value }, extra || {}));
    }
  };

  /* ------------------------------------------------------------------ */
  /* Simulation data                                                     */
  /* ------------------------------------------------------------------ */
  var NAMES = ['PixelPanda', 'nightowl_gg', 'CaptainCrit', 'mochi_bytes', 'LagLord', 'SpeedySloth', 'xX_Quokka_Xx', 'RetroRaven', 'kindofabigdeal', 'ByteSizedBard', 'ZeroGravityZoe', 'TacoTuesday'];
  var COLORS = ['#ff4f8b', '#c6ff3d', '#5ce1ff', '#ffb547', '#b48bff', '#ff6b4a', '#4dffa6', '#ffd23f'];
  var LINES = ['LETS GOOO', 'that was insane 😂', 'gg', 'how long have you been playing this?', 'POG', 'chat is so cozy today', 'first time here, love the vibe!', 'no way he hit that', 'hydrate check 💧', 'one more run!', 'W streamer', 'what keyboard is that?'];
  function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
  function rnd(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }
  function fake(type) {
    var name = pick(NAMES);
    var base = { platform: 'twitch', user: name.toLowerCase(), name: name, color: pick(COLORS), simulated: true };
    switch (type) {
      case 'chat': return Object.assign(base, { message: pick(LINES), emotes: null, badges: Math.random() < .3 ? ['subscriber'] : [], isMod: Math.random() < .1, isSub: Math.random() < .3, isVip: false, isBroadcaster: false, bits: 0 });
      case 'sub': return Object.assign(base, { months: pick([1, 1, 3, 6, 12, 24]), tier: pick(['1', '1', '1', '2', '3', 'prime']), message: Math.random() < .5 ? pick(LINES) : '' });
      case 'gift': var r = pick(NAMES); return Object.assign(base, { recipient: r.toLowerCase(), recipientName: r, tier: '1' });
      case 'giftbomb': return Object.assign(base, { count: pick([5, 10, 20, 50]), tier: '1' });
      case 'cheer': case 'tip': return Object.assign(base, { bits: pick([100, 250, 500, 1000, 5000]), message: pick(LINES), emotes: null });
      case 'raid': return Object.assign(base, { viewers: rnd(8, 900) });
      default: return base; // follow, custom
    }
  }

  /* ------------------------------------------------------------------ */
  /* Connectors                                                          */
  /* ------------------------------------------------------------------ */
  // One per platform. start(source, hub) connects to source.channel and keeps reconnecting.
  //   hub.emit(type, data, opts)  emit an event; `platform` is added for you
  //   hub.status(connected)       report the connection going up or down
  // Events must have the shapes in the spec, so overlays never need to know the platform.
  var CONNECTORS = {
    twitch: { start: startTwitch }
  };

  function readSources() {
    var list = Array.isArray(saved.sources) ? saved.sources : [];
    var out = [];
    list.forEach(function (s) {
      if (!s || typeof s.platform !== 'string' || typeof s.channel !== 'string') return;
      var src = { platform: s.platform.toLowerCase(), channel: cleanChannel(s.channel) };
      if (src.channel) out.push(src);
    });
    if (O.channel && !out.some(function (s) { return s.platform === 'twitch' && s.channel === O.channel; })) {
      out.unshift({ platform: 'twitch', channel: O.channel });
    }
    if (!O.channel) {
      var tw = out.filter(function (s) { return s.platform === 'twitch'; })[0];
      if (tw) O.channel = tw.channel;
    }
    return out;
  }

  function startSources() {
    if (!('WebSocket' in window)) return;
    O.sources.forEach(function (src) {
      var c = CONNECTORS[src.platform];
      if (!c) { console.warn('[overlaify] no connector for ' + src.platform); return; }
      src.connected = false;
      c.start(src, {
        emit: function (type, data, opts) { return O.emit(type, Object.assign({ platform: src.platform }, data), opts); },
        status: function (up) {
          if (src.connected === up) return;
          src.connected = up;
          O.connected = O.sources.some(function (s) { return s.connected; });
          O.emit(up ? 'connected' : 'disconnected', { platform: src.platform, channel: src.channel });
        }
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* Twitch: IRC chat (anonymous, read-only)                             */
  /* ------------------------------------------------------------------ */
  function unescapeTag(v) {
    return v.replace(/\\(.)/g, function (_, c) { return ({ s: ' ', ':': ';', '\\': '\\', r: '\r', n: '\n' })[c] || c; });
  }
  function parseLine(line) {
    var tags = {}, prefix = '', rest = line;
    if (rest[0] === '@') {
      var sp = rest.indexOf(' ');
      rest.slice(1, sp).split(';').forEach(function (kv) {
        var i = kv.indexOf('=');
        if (i === -1) tags[kv] = ''; else tags[kv.slice(0, i)] = unescapeTag(kv.slice(i + 1));
      });
      rest = rest.slice(sp + 1);
    }
    if (rest[0] === ':') { var sp2 = rest.indexOf(' '); prefix = rest.slice(1, sp2); rest = rest.slice(sp2 + 1); }
    var trailing = '', ti = rest.indexOf(' :');
    if (ti !== -1) { trailing = rest.slice(ti + 2); rest = rest.slice(0, ti); }
    var parts = rest.split(' ');
    return { tags: tags, prefix: prefix, command: parts.shift(), params: parts, trailing: trailing };
  }
  function parseEmotes(s) {
    if (!s) return null;
    var out = {};
    s.split('/').forEach(function (part) {
      var c = part.indexOf(':'); if (c === -1) return;
      out[part.slice(0, c)] = part.slice(c + 1).split(',').map(function (r) { var p = r.split('-'); return [Number(p[0]), Number(p[1])]; });
    });
    return out;
  }
  function tierOf(plan) { return plan === 'Prime' ? 'prime' : plan === '2000' ? '2' : plan === '3000' ? '3' : '1'; }
  function badgesOf(s) { return s ? s.split(',').map(function (b) { return b.split('/')[0]; }) : []; }

  function handleTwitch(m, ws, hub) {
    var t = m.tags;
    switch (m.command) {
      case 'PING': ws.send('PONG :' + (m.trailing || 'tmi.twitch.tv')); break;
      case 'RECONNECT': ws.close(); break;
      case 'JOIN': hub.status(true); break;
      case 'PRIVMSG': {
        var text = m.trailing, action = false;
        if (text.indexOf('\u0001ACTION ') === 0) { text = text.slice(8, -1); action = true; }
        var login = m.prefix.split('!')[0];
        var badges = badgesOf(t.badges);
        var bits = Number(t.bits || 0);
        var common = { user: login, userId: t['user-id'] || '', name: t['display-name'] || login, color: t.color || null };
        hub.emit('chat', Object.assign({}, common, {
          message: text, emotes: parseEmotes(t.emotes), badges: badges, action: action, bits: bits,
          isMod: t.mod === '1' || badges.indexOf('moderator') !== -1, isSub: t.subscriber === '1',
          isVip: badges.indexOf('vip') !== -1, isBroadcaster: badges.indexOf('broadcaster') !== -1
        }));
        if (bits > 0) emitBits(hub.emit, Object.assign({}, common, { bits: bits, message: text, emotes: parseEmotes(t.emotes) }));
        break;
      }
      case 'USERNOTICE': {
        var id = t['msg-id'];
        var c = { user: t.login || '', userId: t['user-id'] || '', name: t['display-name'] || t.login || '', color: t.color || null };
        if (id === 'sub' || id === 'resub') {
          hub.emit('sub', Object.assign(c, { months: Number(t['msg-param-cumulative-months'] || 1), tier: tierOf(t['msg-param-sub-plan']), message: m.trailing || '', emotes: parseEmotes(t.emotes) }));
        } else if (id === 'subgift' || id === 'anonsubgift') {
          hub.emit('gift', Object.assign(c, { recipient: t['msg-param-recipient-user-name'] || '', recipientName: t['msg-param-recipient-display-name'] || '', tier: tierOf(t['msg-param-sub-plan']), anonymous: id === 'anonsubgift' }));
        } else if (id === 'submysterygift' || id === 'anonsubmysterygift') {
          hub.emit('giftbomb', Object.assign(c, { count: Number(t['msg-param-mass-gift-count'] || 1), tier: tierOf(t['msg-param-sub-plan']) }));
        } else if (id === 'raid') {
          hub.emit('raid', Object.assign(c, { user: t['msg-param-login'] || c.user, name: t['msg-param-displayName'] || c.name, viewers: Number(t['msg-param-viewerCount'] || 0) }));
        }
        break;
      }
    }
  }

  function startTwitch(src, hub) {
    var backoff = 1000;
    (function connect() {
      var ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
      ws.onopen = function () {
        backoff = 1000;
        ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
        ws.send('PASS SCHMOOPIIE');
        ws.send('NICK justinfan' + rnd(10000, 99999));
        ws.send('JOIN #' + src.channel);
      };
      ws.onmessage = function (e) {
        String(e.data).split('\r\n').forEach(function (line) {
          if (!line) return;
          try { handleTwitch(parseLine(line), ws, hub); } catch (err) { console.warn('[overlaify] parse error', err, line); }
        });
      };
      ws.onclose = function () {
        hub.status(false);
        setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 30000);
      };
    })();
  }

  /* ------------------------------------------------------------------ */
  /* Live control: actions pressed on /c/:room                           */
  /* ------------------------------------------------------------------ */
  var liveBackoff = 1000;
  function connectLive() {
    var live = window.OVERLAIFY_LIVE;
    if (!live || !live.room || inFrame || O.isTest || !('WebSocket' in window)) return;
    var ws, ping;
    try {
      ws = new WebSocket((location.protocol === 'http:' ? 'ws:' : 'wss:') + '//' + location.host + '/api/live/' +
        encodeURIComponent(live.room) + '?role=overlay' + (/\bOBS\//.test(navigator.userAgent) ? '&obs=1' : ''));
    } catch (e) { return; }
    ws.onopen = function () {
      liveBackoff = 1000;
      ping = setInterval(function () { ws.send('ping'); }, 30000);
    };
    ws.onmessage = function (e) {
      var m;
      try { m = JSON.parse(e.data); } catch (err) { return; }
      if (!m || m.t !== 'action' || typeof m.name !== 'string') return;
      O.dispatch(m.name, m.value, { live: true });
      ws.send(JSON.stringify({ t: 'acted', id: m.id, name: m.name, handled: (listeners['action:' + m.name] || []).length > 0 }));
    };
    ws.onclose = function () {
      clearInterval(ping);
      setTimeout(connectLive, liveBackoff);
      liveBackoff = Math.min(liveBackoff * 2, 30000);
    };
  }

  /* ------------------------------------------------------------------ */
  /* Editor bridge + test mode                                           */
  /* ------------------------------------------------------------------ */
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (d && d.__overlaify === 'action' && typeof d.name === 'string') {
      O.dispatch(d.name, d.value);
      if (e.source) e.source.postMessage({ __overlaify: 'acted', name: d.name, handled: (listeners['action:' + d.name] || []).length > 0 }, '*');
      return;
    }
    if (!d || d.__overlaify !== 'simulate' || typeof d.type !== 'string') return;
    O.simulate(d.type, d.data);
    // Tell the editor whether anything listened, so it can flag events this overlay ignores.
    var types = d.type === 'cheer' || d.type === 'tip' ? ['cheer', 'tip', '*'] : [d.type, '*'];
    var handled = types.some(function (t) { return (listeners[t] || []).length > 0; });
    if (e.source) e.source.postMessage({ __overlaify: 'simulated', type: d.type, handled: handled }, '*');
  });

  function startTestMode() {
    var weights = [['chat', 10], ['follow', 2], ['sub', 2], ['cheer', 2], ['gift', 1], ['giftbomb', .5], ['raid', .5]];
    var total = weights.reduce(function (s, w) { return s + w[1]; }, 0);
    (function tick() {
      var r = Math.random() * total, type = 'chat';
      for (var i = 0; i < weights.length; i++) { r -= weights[i][1]; if (r <= 0) { type = weights[i][0]; break; } }
      O.simulate(type);
      setTimeout(tick, type === 'chat' ? rnd(900, 2200) : rnd(2500, 4500));
    })();
  }

  function hint() {
    if (O.sources.length || O.isTest || inFrame) return;
    var el = document.createElement('div');
    el.textContent = 'Overlaify: add ?channel=YOUR_TWITCH_NAME to this URL';
    el.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:2147483647;font:600 16px system-ui,sans-serif;color:#0b0a10;background:#c6ff3d;padding:10px 14px;border-radius:8px';
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 15000);
  }

  O.sources = readSources();
  window.Overlaify = O;

  function boot() {
    // Let overlay code register listeners first.
    setTimeout(function () {
      startSources();
      connectLive();
      if (O.isTest) startTestMode();
      if (document.body) hint();
    }, 50);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
