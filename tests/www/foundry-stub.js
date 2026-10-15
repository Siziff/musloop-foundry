// Minimal Foundry VTT client stub — just enough of the v13 API surface that
// musslop-foundry touches, so the real module code can run in a plain page.
// NOT Foundry: behaviour follows the documented API (see test report).
//
//   ?user=gm|player   -> game.user.isGM
//   ?v=13|12          -> scene-controls shape (Record vs Array), FilePicker path
//   ?jszip=0          -> no global JSZip (to see the module's error path)
//
// Socket: BroadcastChannel between tabs of the same origin; the sender does
// NOT receive its own messages (as in Foundry).
// FilePicker: talks to the test server (/fp/browse, /fp/mkdir, /fp/upload)
// which maps the "data" source to a temp folder served at /data/...
(() => {
  const qs = new URLSearchParams(location.search);
  const isGM = (qs.get("user") || "gm") === "gm";
  const V = +(qs.get("v") || 13);
  const uid = isGM ? "gm0000000000000" : "pl" + Math.random().toString(36).slice(2, 15);
  const log = (...a) => (window.__stubLog = window.__stubLog || []).push(a.map(String).join(" "));

  // ---- hooks
  const hooks = {};
  const Hooks = {
    on: (n, fn) => ((hooks[n] = hooks[n] || []).push({ fn, once: false }), fn),
    once: (n, fn) => ((hooks[n] = hooks[n] || []).push({ fn, once: true }), fn),
    callAll: (n, ...a) => { for (const h of (hooks[n] || []).slice()) { h.fn(...a); if (h.once) hooks[n] = hooks[n].filter(x => x !== h); } return true; },
    async callAllAsync(n, ...a) { for (const h of (hooks[n] || []).slice()) { await h.fn(...a); if (h.once) hooks[n] = hooks[n].filter(x => x !== h); } },
  };

  // ---- i18n: translations load AFTER init (as in Foundry: i18nInit)
  const i18n = {
    translations: {}, _ready: false,
    localize(k) { return this.translations[k] ?? k; },
    format(k, d = {}) { let s = this.localize(k); for (const [x, v] of Object.entries(d)) s = s.replace(`{${x}}`, v); return s; },
  };

  // ---- settings
  const settingsDef = {}, settingsVal = {};
  const settings = {
    register(ns, key, cfg) { settingsDef[`${ns}.${key}`] = cfg; if (!(`${ns}.${key}` in settingsVal)) settingsVal[`${ns}.${key}`] = cfg.default; },
    get(ns, key) { const k = `${ns}.${key}`; if (!(k in settingsDef)) throw new Error(`Setting ${k} is not registered`); return settingsVal[k]; },
    async set(ns, key, v) { const k = `${ns}.${key}`; settingsVal[k] = v; settingsDef[k]?.onChange?.(v); return v; },
  };

  // ---- keybindings (must be registered before "ready")
  const keybinds = {}; let kbLocked = false;
  const keybindings = {
    register(ns, action, cfg) {
      if (kbLocked) throw new Error("You cannot register a Keybinding after the init hook");
      keybinds[`${ns}.${action}`] = cfg;
    },
    _all: keybinds,
  };
  document.addEventListener("keydown", ev => {
    for (const [k, cfg] of Object.entries(keybinds)) {
      for (const b of cfg.editable || []) {
        const mods = b.modifiers || [];
        if (ev.code === b.key && !!ev.altKey === mods.includes("Alt") && !!ev.shiftKey === mods.includes("Shift")
            && !!ev.ctrlKey === mods.includes("Control")) {
          if (cfg.restricted && !isGM) continue;
          if (cfg.onDown?.() === true) { ev.preventDefault(); return; }
        }
      }
    }
  });

  // ---- users
  const users = new Map();
  const me = { id: uid, name: isGM ? "GM" : "Player", isGM, active: true };
  users.set(uid, me);
  users.set("gm0000000000000", { id: "gm0000000000000", name: "GM", isGM: true, active: true });
  const usersApi = {
    get: id => users.get(id) || (id && id.startsWith("pl") ? { id, isGM: false, active: true } : null),
    filter: fn => [...users.values()].filter(fn),
  };

  // ---- socket
  const bc = new BroadcastChannel("foundry-stub-socket");
  const socketHandlers = {};
  const socket = {
    on: (ev, fn) => ((socketHandlers[ev] = socketHandlers[ev] || []).push(fn)),
    emit: (ev, data) => { log("emit", ev, JSON.stringify(data)); bc.postMessage({ ev, data, sender: uid }); },
  };
  bc.onmessage = e => {
    const { ev, data, sender } = e.data;
    if (sender === uid) return;
    if (sender.startsWith("pl")) users.set(sender, { id: sender, isGM: false, active: true });
    (window.__recv = window.__recv || []).push(data);
    for (const fn of socketHandlers[ev] || []) fn(data);
  };

  // ---- audio: three contexts, music context created on first unlock (gesture)
  const audio = {
    music: undefined, environment: undefined, interface: undefined,
    get context() { return this.music; },
    locked: true,
  };
  audio.unlock = new Promise(res => {
    const go = () => {
      if (!audio.locked) return;
      for (const n of ["music", "environment", "interface"]) {
        const ctx = new AudioContext();
        ctx.gainNode = ctx.createGain(); ctx.gainNode.connect(ctx.destination);   // core volume node
        ctx.gainNode.gain.value = 0.5;                                           // "Music" slider at 50%
        audio[n] = ctx;
      }
      audio.locked = false; res();
      document.removeEventListener("pointerdown", go, true);
      document.removeEventListener("keydown", go, true);
    };
    document.addEventListener("pointerdown", go, true);
    document.addEventListener("keydown", go, true);
    window.__unlockAudio = go;
  });

  // ---- notifications
  const notes = [];
  const ui = { notifications: {
    _push(type, m, o) { const n = { id: notes.length + 1, type, message: m, ...o }; notes.push(n); log("notify", type, m); return n; },
    info(m, o) { return this._push("info", m, o); }, warn(m, o) { return this._push("warn", m, o); },
    error(m, o) { return this._push("error", m, o); }, remove(n) { n && (n.removed = true); },
    _all: notes,
  } };

  // ---- FilePicker (server-backed)
  class FilePicker {
    static get implementation() { return FilePicker; }
    static async browse(source, target) {
      const r = await fetch(`/fp/browse?target=${encodeURIComponent(target)}`);
      if (!r.ok) throw new Error(`Directory ${target} does not exist`);
      return r.json();
    }
    static async createDirectory(source, target) {
      const r = await fetch(`/fp/mkdir?target=${encodeURIComponent(target)}`, { method: "POST" });
      const j = await r.json();
      if (j.error) throw new Error(j.error);
      return j;
    }
    static async upload(source, path, file, body = {}, { notify = true } = {}) {
      const fd = new FormData(); fd.append("target", path); fd.append("upload", file, file.name);
      const r = await fetch("/fp/upload", { method: "POST", body: fd });
      const j = await r.json();
      if (j.error) { if (notify) ui.notifications.error(j.error); return false; }   // Foundry returns false, no throw
      return j;
    }
  }

  // ---- ApplicationV2 + HandlebarsApplicationMixin (tiny subset)
  const tplCache = {};
  Handlebars.registerHelper("localize", (k, opts) => i18n.format(k, opts?.hash || {}));
  class ApplicationV2 {
    static DEFAULT_OPTIONS = {};
    constructor(opts = {}) { this.options = foundry.utils.mergeObject(foundry.utils.deepClone(this.constructor.DEFAULT_OPTIONS), opts); this.rendered = false; this.element = null; }
    get id() { return this.options.id; }
    async render(opts) {
      if (opts === true) opts = { force: true };
      if (!this.rendered && !opts?.force) return this;
      if (!this.element) {
        const w = document.createElement("div");
        w.className = "application " + (this.options.classes || []).join(" ");
        w.id = this.options.id;
        w.innerHTML = `<header class="window-header"><h1>${i18n.localize(this.options.window?.title || "")}</h1></header><section class="window-content"></section>`;
        document.body.appendChild(w);
        this.element = w;
        w.addEventListener("click", ev => {
          const t = ev.target.closest("[data-action]");
          if (!t || !w.contains(t) || t.disabled) return;
          const fn = this.constructor.DEFAULT_OPTIONS.actions?.[t.dataset.action];
          if (fn) fn.call(this, ev, t);
        });
      }
      const ctx = await this._prepareContext(opts);
      await this._renderHTML(ctx, opts);
      this.rendered = true;
      await this._onRender?.(ctx, opts);
      return this;
    }
    async close() { this.element?.remove(); this.element = null; this.rendered = false; return this; }
  }
  const HandlebarsApplicationMixin = Base => class extends Base {
    async _renderHTML(ctx) {
      const parts = this.constructor.PARTS || {};
      let html = "";
      for (const [, part] of Object.entries(parts)) {
        if (!tplCache[part.template]) {
          const r = await fetch("/" + part.template);
          if (!r.ok) throw new Error(`template ${part.template}: ${r.status}`);
          tplCache[part.template] = Handlebars.compile(await r.text());
        }
        html += tplCache[part.template](ctx);
        if (part.scrollable !== undefined && !Array.isArray(part.scrollable)) log("WARN PARTS.scrollable must be string[]");
      }
      this.element.querySelector(".window-content").innerHTML = html;
    }
  };

  // ---- foundry namespace
  const deepClone = o => JSON.parse(JSON.stringify(o, (k, v) => typeof v === "function" ? undefined : v));
  window.foundry = {
    utils: {
      deepClone: o => { const c = deepClone(o); if (o && o.actions) c.actions = o.actions; return c; },
      mergeObject: (a, b) => Object.assign(a, b),
    },
    applications: { api: { ApplicationV2, HandlebarsApplicationMixin }, apps: V >= 13 ? { FilePicker } : {} },
  };
  if (V < 13) window.FilePicker = FilePicker;
  window.Hooks = Hooks;
  window.ui = ui;
  window.game = {
    user: me, users: usersApi, settings, keybindings, socket, audio, i18n,
    modules: new Map(),
    version: V >= 13 ? "13.351" : "12.331",
  };

  // ---- boot: load module.json, translations, the module's esmodules, run the hook sequence
  window.__boot = async () => {
    const mod = await (await fetch("/modules/musslop-foundry/module.json")).json();
    game.modules.set(mod.id, { id: mod.id, active: true, ...mod });
    for (const css of mod.styles || []) { const l = document.createElement("link"); l.rel = "stylesheet"; l.href = `/modules/${mod.id}/${css}`; document.head.appendChild(l); }
    for (const js of mod.esmodules) await import(`/modules/${mod.id}/${js}`);
    Hooks.callAll("init");
    const lang = (mod.languages || []).find(l => l.lang === (qs.get("lang") || "en"));
    i18n.translations = await (await fetch(`/modules/${mod.id}/${lang.path}`)).json();
    Hooks.callAll("i18nInit");
    Hooks.callAll("setup");
    kbLocked = true;
    // scene controls (v13 Record / v12 Array)
    const controls = V >= 13
      ? { tokens: { name: "tokens", tools: { select: {} } }, sounds: { name: "sounds", tools: { sound: {}, preview: {} } } }
      : [{ name: "token", tools: [] }, { name: "sounds", tools: [] }];
    Hooks.callAll("getSceneControlButtons", controls);
    window.__controls = controls;
    await Hooks.callAllAsync("ready");
    return { keybindings: Object.fromEntries(Object.entries(keybinds).map(([k, c]) => [k, c.name])) };
  };
})();
