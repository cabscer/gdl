/*!
 * GD Mod Menu — drop-in overlay for the Unity WebGL build of Geometry Dash Lite.
 *
 * Must load BEFORE ./Build/UnityLoader.js so the clock and audio hooks are
 * in place when the game starts.
 *
 * Works entirely from the browser side (the game itself is compiled), so it
 * offers: game speed, pause + frame step, volume, auto hold / auto tap,
 * FPS counter, screenshot, fullscreen and a SendMessage console.
 *
 * Hotkeys:  `  menu     [  pause/resume     ]  frame step     -  =  speed down/up
 */
(function () {
  'use strict';
  if (window.GDMod) return;

  /* ------------------------------------------------------------------ *
   *  Settings
   * ------------------------------------------------------------------ */
  var DEFAULTS = { speed: 1, volume: 1, input: 'Space', cps: 8, fps: false };
  var cfg = {};
  var k;
  for (k in DEFAULTS) cfg[k] = DEFAULTS[k];
  try {
    var saved = JSON.parse(localStorage.getItem('gdmod') || '{}');
    for (k in saved) if (k in DEFAULTS) cfg[k] = saved[k];
  } catch (e) { /* storage unavailable, use defaults */ }
  cfg.speed = clamp(+cfg.speed || 1, 0.1, 3);
  cfg.volume = clamp(isFinite(+cfg.volume) ? +cfg.volume : 1, 0, 1);
  cfg.cps = clamp(+cfg.cps || 8, 1, 30);

  function save() {
    try { localStorage.setItem('gdmod', JSON.stringify(cfg)); } catch (e) { /* ignore */ }
  }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  var state = { paused: false, auto: 'off' };

  /* ------------------------------------------------------------------ *
   *  Virtual clock (speed, pause, frame step)
   *  Unity reads time from performance.now / Date.now and from the
   *  requestAnimationFrame timestamp, so scaling those scales the game.
   * ------------------------------------------------------------------ */
  function Clock(realFn) {
    var rBase = realFn(), vBase = rBase, scale = 1;
    return {
      now: function () { return vBase + (realFn() - rBase) * scale; },
      set: function (s) {
        var r = realFn();
        vBase = vBase + (r - rBase) * scale;
        rBase = r;
        scale = s;
      },
      jump: function (ms) { vBase += ms; }
    };
  }

  var perfClock = Clock(performance.now.bind(performance));
  var dateClock = Clock(Date.now.bind(Date));
  performance.now = function () { return perfClock.now(); };
  Date.now = function () { return dateClock.now(); };

  function applyTime() {
    var s = state.paused ? 0 : cfg.speed;
    perfClock.set(s);
    dateClock.set(s);
  }

  /* ------------------------------------------------------------------ *
   *  Frame hook (rAF): timestamp scaling, FPS counter, screenshots
   * ------------------------------------------------------------------ */
  var frames = 0;
  var shotPending = false;
  var realRAF = window.requestAnimationFrame.bind(window);

  window.requestAnimationFrame = function (cb) {
    return realRAF(function () {
      frames++;
      try {
        cb(perfClock.now());
      } finally {
        if (shotPending) { shotPending = false; takeShot(); }
      }
    });
  };

  function getCanvas() {
    return document.querySelector('#gameContainer canvas') || document.querySelector('canvas');
  }

  function takeShot() {
    var c = getCanvas();
    if (!c) return;
    try {
      var a = document.createElement('a');
      a.href = c.toDataURL('image/png');
      a.download = 'geometry-dash-' + new Date().toISOString().replace(/[:.]/g, '-') + '.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast('Screenshot saved');
    } catch (e) {
      toast('Screenshot failed');
    }
  }

  /* ------------------------------------------------------------------ *
   *  Master volume (routes everything bound for ctx.destination
   *  through one gain node per AudioContext)
   * ------------------------------------------------------------------ */
  var masters = [];
  (function hookAudio() {
    var Base = window.BaseAudioContext || window.AudioContext || window.webkitAudioContext;
    if (!Base) return;
    var desc = Object.getOwnPropertyDescriptor(Base.prototype, 'destination');
    if (!desc || !desc.get) return;
    var map = new WeakMap();
    Object.defineProperty(Base.prototype, 'destination', {
      configurable: true,
      get: function () {
        var m = map.get(this);
        if (!m) {
          var real = desc.get.call(this);
          var g = this.createGain();
          g.gain.value = cfg.volume;
          g.connect(real);
          m = g;
          map.set(this, m);
          masters.push(g);
        }
        return m;
      }
    });
  })();

  function applyVolume() {
    masters.forEach(function (g) { g.gain.value = cfg.volume; });
  }

  /* ------------------------------------------------------------------ *
   *  Auto hold / auto tap (synthetic input on the game canvas)
   * ------------------------------------------------------------------ */
  var KEYS = {
    Space: { key: ' ', code: 'Space', kc: 32 },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', kc: 38 }
  };

  function fireKey(type) {
    var def = KEYS[cfg.input];
    var e = new KeyboardEvent(type, { key: def.key, code: def.code, bubbles: true, cancelable: true });
    Object.defineProperty(e, 'keyCode', { get: function () { return def.kc; } });
    Object.defineProperty(e, 'which', { get: function () { return def.kc; } });
    (getCanvas() || document).dispatchEvent(e);
  }

  function fireMouse(type) {
    var c = getCanvas();
    if (!c) return;
    var r = c.getBoundingClientRect();
    c.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, button: 0,
      buttons: type === 'mouseup' ? 0 : 1,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, view: window
    }));
  }

  function press() { if (cfg.input === 'Click') fireMouse('mousedown'); else fireKey('keydown'); }
  function release() { if (cfg.input === 'Click') fireMouse('mouseup'); else fireKey('keyup'); }

  var autoTimer = null;
  function setAuto(mode) {
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    if (state.auto !== 'off') release();
    state.auto = mode;
    if (mode === 'hold') {
      press();
      autoTimer = setInterval(press, 100); // re-assert after deaths / restarts
    } else if (mode === 'tap') {
      var period = 1000 / cfg.cps;
      var down = Math.min(40, period / 2);
      autoTimer = setInterval(function () {
        press();
        setTimeout(release, down);
      }, period);
    }
    refreshUI();
  }

  /* ------------------------------------------------------------------ *
   *  SendMessage console
   * ------------------------------------------------------------------ */
  function sendMessage(obj, method, arg) {
    var gi = window.gameInstance;
    if (!gi || typeof gi.SendMessage !== 'function') return 'The game is still loading.';
    if (!obj || !method) return 'Enter an object and a method name.';
    try {
      if (arg === '' || arg == null) gi.SendMessage(obj, method);
      else gi.SendMessage(obj, method, isNaN(+arg) ? arg : +arg);
      return 'Sent ' + obj + '.' + method + (arg ? '(' + arg + ')' : '()');
    } catch (e) {
      return 'Failed: ' + (e && e.message ? e.message : e);
    }
  }

  /* ------------------------------------------------------------------ *
   *  UI
   * ------------------------------------------------------------------ */
  var CSS = [
    '#gdm-gear,#gdm-panel,#gdm-fps,#gdm-toast{font-family:"Arial Rounded MT Bold","Trebuchet MS",system-ui,sans-serif;box-sizing:border-box}',
    '#gdm-gear{position:fixed;top:8px;left:8px;z-index:2147483000;width:34px;height:34px;border-radius:9px;border:3px solid #06143a;background:#ffd60a;color:#06143a;font-size:18px;line-height:1;cursor:pointer;opacity:.45;transition:opacity .15s;padding:0}',
    '#gdm-gear:hover,#gdm-gear:focus-visible{opacity:1;outline:none}',
    '#gdm-panel{position:fixed;top:50px;left:8px;z-index:2147483000;width:272px;max-height:calc(100vh - 62px);overflow:auto;background:#0a1a4a;color:#fff;border:4px solid #06143a;border-radius:14px;box-shadow:0 0 0 2px #3de0ff,0 10px 30px rgba(0,0,0,.5);font-size:13px;display:none}',
    '#gdm-panel.open{display:block}',
    '#gdm-head{display:flex;align-items:center;justify-content:space-between;padding:9px 12px;background:linear-gradient(#1f6bff,#0a49c9);border-bottom:3px solid #06143a;cursor:move;user-select:none;font-size:15px}',
    '#gdm-head span{opacity:.75;font-size:11px}',
    '.gdm-sec{padding:10px 12px;border-bottom:2px solid #06143a}',
    '.gdm-sec:last-child{border-bottom:0}',
    '.gdm-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:6px 0}',
    '.gdm-row label{flex:1}',
    '.gdm-val{min-width:44px;text-align:right;color:#ffd60a}',
    '.gdm-title{font-size:13px;color:#3de0ff;margin-bottom:4px}',
    '#gdm-panel input[type=range]{width:100%;accent-color:#ffd60a;margin:2px 0}',
    '#gdm-panel select,#gdm-panel input[type=text]{background:#06143a;color:#fff;border:2px solid #3de0ff;border-radius:7px;padding:4px 6px;font:inherit;min-width:0}',
    '#gdm-panel input[type=text]{width:100%}',
    '.gdm-btn{flex:1;background:#1f6bff;color:#fff;border:3px solid #06143a;border-radius:9px;padding:6px 4px;font:inherit;cursor:pointer;box-shadow:inset 0 -3px 0 rgba(0,0,0,.25)}',
    '.gdm-btn:hover{filter:brightness(1.15)}',
    '.gdm-btn:active{transform:translateY(1px)}',
    '.gdm-btn.on{background:#ffd60a;color:#06143a}',
    '.gdm-btns{display:flex;gap:6px;margin:6px 0}',
    '#gdm-panel button:focus-visible,#gdm-panel select:focus-visible,#gdm-panel input:focus-visible{outline:2px solid #fff;outline-offset:1px}',
    '#gdm-panel details summary{cursor:pointer;color:#3de0ff}',
    '#gdm-out{margin-top:6px;color:#9db8ff;min-height:1.2em;word-break:break-word}',
    '.gdm-note{color:#9db8ff;font-size:11.5px;line-height:1.35;margin-top:6px}',
    '#gdm-fps{position:fixed;top:8px;right:8px;z-index:2147483000;background:rgba(6,20,58,.8);color:#ffd60a;border:2px solid #3de0ff;border-radius:8px;padding:3px 8px;font-size:12px;display:none;pointer-events:none}',
    '#gdm-toast{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);z-index:2147483000;background:#06143a;color:#fff;border:2px solid #3de0ff;border-radius:10px;padding:6px 14px;font-size:13px;display:none;pointer-events:none}',
    '@media (prefers-reduced-motion:reduce){#gdm-gear{transition:none}}'
  ].join('\n');

  var ui = {};

  function el(tag, attrs, html) {
    var n = document.createElement(tag);
    if (attrs) for (var a in attrs) n.setAttribute(a, attrs[a]);
    if (html != null) n.innerHTML = html;
    return n;
  }

  var toastTimer = null;
  function toast(msg) {
    if (!ui.toast) return;
    ui.toast.textContent = msg;
    ui.toast.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { ui.toast.style.display = 'none'; }, 1600);
  }

  function fmtSpeed() { return (state.paused ? 'Paused' : cfg.speed.toFixed(2) + 'x'); }

  function refreshUI() {
    if (!ui.panel) return;
    ui.speed.value = cfg.speed;
    ui.speedVal.textContent = fmtSpeed();
    ui.pause.classList.toggle('on', state.paused);
    ui.pause.textContent = state.paused ? 'Resume' : 'Pause';
    ui.step.disabled = !state.paused;
    ui.step.style.opacity = state.paused ? 1 : 0.5;
    ui.vol.value = cfg.volume;
    ui.volVal.textContent = Math.round(cfg.volume * 100) + '%';
    ui.input.value = cfg.input;
    ui.cps.value = cfg.cps;
    ui.cpsVal.textContent = cfg.cps + '/s';
    ui.hold.classList.toggle('on', state.auto === 'hold');
    ui.tap.classList.toggle('on', state.auto === 'tap');
    ui.fps.classList.toggle('on', cfg.fps);
    ui.fpsBox.style.display = cfg.fps ? 'block' : 'none';
  }

  function setSpeed(v) {
    cfg.speed = clamp(Math.round(v * 100) / 100, 0.1, 3);
    applyTime(); save(); refreshUI();
  }
  function setPaused(p) {
    state.paused = p;
    applyTime(); refreshUI();
  }
  function step() {
    if (!state.paused) return;
    perfClock.jump(1000 / 60);
    dateClock.jump(1000 / 60);
  }
  function toggleMenu(force) {
    var open = typeof force === 'boolean' ? force : !ui.panel.classList.contains('open');
    ui.panel.classList.toggle('open', open);
  }

  function buildUI() {
    var style = el('style', null, CSS);
    document.head.appendChild(style);

    ui.gear = el('button', { id: 'gdm-gear', title: 'Mod menu (`)', 'aria-label': 'Open mod menu' }, '&#9881;');

    ui.panel = el('div', { id: 'gdm-panel', role: 'dialog', 'aria-label': 'Mod menu' }, [
      '<div id="gdm-head">Mod menu <span>` to hide</span></div>',

      '<div class="gdm-sec">',
      '  <div class="gdm-title">Game speed</div>',
      '  <div class="gdm-row"><label for="gdm-speed">Speed</label><b class="gdm-val" id="gdm-speedval"></b></div>',
      '  <input id="gdm-speed" type="range" min="0.1" max="3" step="0.05">',
      '  <div class="gdm-btns">',
      '    <button class="gdm-btn" data-speed="0.25">0.25x</button>',
      '    <button class="gdm-btn" data-speed="0.5">0.5x</button>',
      '    <button class="gdm-btn" data-speed="1">1x</button>',
      '    <button class="gdm-btn" data-speed="2">2x</button>',
      '  </div>',
      '  <div class="gdm-btns">',
      '    <button class="gdm-btn" id="gdm-pause">Pause</button>',
      '    <button class="gdm-btn" id="gdm-step">Step frame</button>',
      '  </div>',
      '  <div class="gdm-note">Music keeps its normal pitch, so it drifts out of sync when speed is not 1x.</div>',
      '</div>',

      '<div class="gdm-sec">',
      '  <div class="gdm-title">Sound</div>',
      '  <div class="gdm-row"><label for="gdm-vol">Master volume</label><b class="gdm-val" id="gdm-volval"></b></div>',
      '  <input id="gdm-vol" type="range" min="0" max="1" step="0.05">',
      '</div>',

      '<div class="gdm-sec">',
      '  <div class="gdm-title">Auto input</div>',
      '  <div class="gdm-row"><label for="gdm-input">Press with</label>',
      '    <select id="gdm-input"><option value="Space">Space</option><option value="ArrowUp">Up arrow</option><option value="Click">Mouse click</option></select></div>',
      '  <div class="gdm-row"><label for="gdm-cps">Tap rate</label><b class="gdm-val" id="gdm-cpsval"></b></div>',
      '  <input id="gdm-cps" type="range" min="1" max="30" step="1">',
      '  <div class="gdm-btns">',
      '    <button class="gdm-btn" id="gdm-hold">Auto hold</button>',
      '    <button class="gdm-btn" id="gdm-tap">Auto tap</button>',
      '  </div>',
      '</div>',

      '<div class="gdm-sec">',
      '  <div class="gdm-title">Display</div>',
      '  <div class="gdm-btns">',
      '    <button class="gdm-btn" id="gdm-fps-btn">FPS counter</button>',
      '    <button class="gdm-btn" id="gdm-shot">Screenshot</button>',
      '    <button class="gdm-btn" id="gdm-full">Fullscreen</button>',
      '  </div>',
      '</div>',

      '<div class="gdm-sec">',
      '  <details><summary>Advanced: SendMessage</summary>',
      '    <div class="gdm-note">Calls a method on a Unity object by name. Only works if you know a real object and method in the game.</div>',
      '    <div class="gdm-row"><input id="gdm-obj" type="text" placeholder="Object name" autocomplete="off"></div>',
      '    <div class="gdm-row"><input id="gdm-meth" type="text" placeholder="Method name" autocomplete="off"></div>',
      '    <div class="gdm-row"><input id="gdm-arg" type="text" placeholder="Argument (optional)" autocomplete="off"></div>',
      '    <div class="gdm-btns"><button class="gdm-btn" id="gdm-send">Send</button></div>',
      '    <div id="gdm-out"></div>',
      '  </details>',
      '</div>',

      '<div class="gdm-sec">',
      '  <div class="gdm-btns"><button class="gdm-btn" id="gdm-reset">Reset all</button></div>',
      '  <div class="gdm-note">Keys: ` menu, [ pause, ] step frame, - and = change speed.</div>',
      '</div>'
    ].join(''));

    ui.fpsBox = el('div', { id: 'gdm-fps' }, '-- fps');
    ui.toast = el('div', { id: 'gdm-toast', role: 'status' });

    document.body.appendChild(ui.gear);
    document.body.appendChild(ui.panel);
    document.body.appendChild(ui.fpsBox);
    document.body.appendChild(ui.toast);

    var $ = function (id) { return ui.panel.querySelector('#' + id); };
    ui.speed = $('gdm-speed'); ui.speedVal = $('gdm-speedval');
    ui.pause = $('gdm-pause'); ui.step = $('gdm-step');
    ui.vol = $('gdm-vol'); ui.volVal = $('gdm-volval');
    ui.input = $('gdm-input'); ui.cps = $('gdm-cps'); ui.cpsVal = $('gdm-cpsval');
    ui.hold = $('gdm-hold'); ui.tap = $('gdm-tap');
    ui.fps = $('gdm-fps-btn');

    // Keep clicks and typing inside the menu from reaching the game.
    ['mousedown', 'mouseup', 'click', 'dblclick', 'touchstart', 'touchend', 'pointerdown', 'pointerup',
     'keydown', 'keyup', 'keypress', 'wheel', 'contextmenu'].forEach(function (t) {
      ui.panel.addEventListener(t, function (e) { e.stopPropagation(); });
      ui.gear.addEventListener(t, function (e) { e.stopPropagation(); });
    });

    ui.gear.addEventListener('click', function () { toggleMenu(); });

    ui.speed.addEventListener('input', function () { setSpeed(+ui.speed.value); });
    ui.panel.querySelectorAll('[data-speed]').forEach(function (b) {
      b.addEventListener('click', function () { setPaused(false); setSpeed(+b.getAttribute('data-speed')); });
    });
    ui.pause.addEventListener('click', function () { setPaused(!state.paused); });
    ui.step.addEventListener('click', step);

    ui.vol.addEventListener('input', function () {
      cfg.volume = +ui.vol.value; applyVolume(); save(); refreshUI();
    });

    ui.input.addEventListener('change', function () {
      var wasOn = state.auto;
      setAuto('off');
      cfg.input = ui.input.value; save();
      if (wasOn !== 'off') setAuto(wasOn);
    });
    ui.cps.addEventListener('input', function () {
      cfg.cps = +ui.cps.value; save();
      if (state.auto === 'tap') setAuto('tap'); else refreshUI();
    });
    ui.hold.addEventListener('click', function () { setAuto(state.auto === 'hold' ? 'off' : 'hold'); });
    ui.tap.addEventListener('click', function () { setAuto(state.auto === 'tap' ? 'off' : 'tap'); });

    ui.fps.addEventListener('click', function () { cfg.fps = !cfg.fps; save(); refreshUI(); });
    $('gdm-shot').addEventListener('click', function () { shotPending = true; });
    $('gdm-full').addEventListener('click', function () {
      var d = document, r = d.documentElement;
      if (d.fullscreenElement) d.exitFullscreen();
      else if (r.requestFullscreen) r.requestFullscreen();
    });

    $('gdm-send').addEventListener('click', function () {
      $('gdm-out').textContent = sendMessage($('gdm-obj').value.trim(), $('gdm-meth').value.trim(), $('gdm-arg').value.trim());
    });

    $('gdm-reset').addEventListener('click', function () {
      setAuto('off');
      for (var key in DEFAULTS) cfg[key] = DEFAULTS[key];
      state.paused = false;
      applyTime(); applyVolume(); save(); refreshUI();
      toast('Settings reset');
    });

    // Drag by the header.
    var head = $('gdm-head'), drag = null;
    head.addEventListener('mousedown', function (e) {
      var r = ui.panel.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      e.preventDefault();
    });
    window.addEventListener('mousemove', function (e) {
      if (!drag) return;
      ui.panel.style.left = clamp(e.clientX - drag.dx, 0, window.innerWidth - 60) + 'px';
      ui.panel.style.top = clamp(e.clientY - drag.dy, 0, window.innerHeight - 40) + 'px';
    });
    window.addEventListener('mouseup', function () { drag = null; });

    // FPS counter
    var last = frames, lastT = Date.now.call(Date);
    var realNow = performance.now.bind(performance);
    var t0 = realNow();
    setInterval(function () {
      if (!cfg.fps) return;
      var t1 = realNow();
      var fps = (frames - last) * 1000 / (t1 - t0);
      last = frames; t0 = t1;
      ui.fpsBox.textContent = Math.round(fps) + ' fps';
    }, 500);

    refreshUI();
  }

  /* ------------------------------------------------------------------ *
   *  Hotkeys
   * ------------------------------------------------------------------ */
  window.addEventListener('keydown', function (e) {
    if (!e.isTrusted || !ui.panel) return;
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    switch (e.key) {
      case '`': toggleMenu(); break;
      case '[': setPaused(!state.paused); break;
      case ']': step(); break;
      case '-': setPaused(false); setSpeed(cfg.speed - 0.25); toast('Speed ' + cfg.speed.toFixed(2) + 'x'); break;
      case '=': setPaused(false); setSpeed(cfg.speed + 0.25); toast('Speed ' + cfg.speed.toFixed(2) + 'x'); break;
    }
  }, true);

  /* ------------------------------------------------------------------ *
   *  Boot
   * ------------------------------------------------------------------ */
  applyTime();

  function boot() { if (!ui.panel) buildUI(); }
  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot);

  window.GDMod = {
    cfg: cfg,
    state: state,
    setSpeed: setSpeed,
    pause: function () { setPaused(true); },
    resume: function () { setPaused(false); },
    step: step,
    setAuto: setAuto,
    sendMessage: sendMessage
  };
})();
