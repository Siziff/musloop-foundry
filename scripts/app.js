/**
 * The musloop desk — ApplicationV2 window for the GM (read-only for players).
 */
import { MODULE_ID, i18n, log } from "./const.js";
import { controller } from "./sync.js";
import { importZip } from "./library.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const fmt = s => { if (s == null || isNaN(s)) return "–"; const m = Math.floor(s / 60), r = s % 60; return `${m}:${r.toFixed(0).padStart(2, "0")}`; };
const COLORS = ["#6a8dff", "#34d399", "#ffb84f", "#ff5b8a", "#a06bff", "#4fd6ff", "#c9e04f", "#ff8a4f", "#5bffb0", "#fb6a6a", "#8a9bff", "#ffd75b"];

export class MusloopDesk extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "musloop-desk",
    tag: "div",
    classes: ["musloop"],
    window: { title: "MUSLOOP.Title", icon: "fa-solid fa-music", resizable: true },
    position: { width: 560, height: 640 },
    actions: {
      selectTrack: MusloopDesk.#onSelectTrack,
      importZip: MusloopDesk.#onImportZip,
      refresh: MusloopDesk.#onRefresh,
      play: MusloopDesk.#onPlay,
      stop: MusloopDesk.#onStop,
      next: MusloopDesk.#onNext,
      cancel: MusloopDesk.#onCancel,
      fade: MusloopDesk.#onFade,
      mode: MusloopDesk.#onMode,
      part: MusloopDesk.#onPart,
      scene: MusloopDesk.#onScene,
      togglePacks: MusloopDesk.#onTogglePacks,
      installTrack: MusloopDesk.#onInstallTrack,
    },
  };

  static PARTS = { main: { template: `modules/${MODULE_ID}/templates/desk.hbs`, scrollable: [".musloop-body"] } };

  constructor(...args) {
    super(...args);
    this._unsub = controller.onChange(() => this._throttledRender());
    this._eta = null;
    this.packsOpen = false;
  }

  _throttledRender() {
    if (this._rt) return;
    this._rt = setTimeout(() => { this._rt = null; if (this.rendered) this.render(); }, 80);
  }

  async _prepareContext() {
    const p = controller.player;
    const t = controller.track;
    const loops = t?.manifest.loops || [];
    const scenes = t?.manifest.scenes || [];
    const playing = !!p?.playing;
    const cur = playing ? loops[p.loopIndex] : null;
    const pending = p ? p.pendingTarget() : null;
    const eta = p ? p.transitionEta() : null;
    const colorOf = i => COLORS[i % COLORS.length];
    return {
      isGM: game.user.isGM,
      tracks: controller.tracks.map(x => ({ slug: x.slug, name: x.name, n: x.manifest.loops.length, bpm: x.manifest.bpm, active: x.slug === t?.slug })),
      hasTrack: !!t,
      trackName: t?.name,
      loading: controller.loading,
      playing,
      nowLabel: cur ? cur.name : (loops[p?.loopIndex || 0]?.name || "—"),
      pass: playing ? p.loopCount : null,
      next: pending != null && loops[pending] ? loops[pending].name : null,
      etaText: eta != null ? `${i18n("MUSLOOP.In")} ${Math.max(0, eta).toFixed(0)} s` : (pending != null ? i18n("MUSLOOP.AtBoundary") : i18n("MUSLOOP.Pick")),
      modes: ["natural", "soon", "now"].map(m => ({ id: m, label: i18n(`MUSLOOP.Mode${m[0].toUpperCase()}${m.slice(1)}`), on: controller.mode === m })),
      scenes: scenes.map((s, k) => ({
        ...s, k, hotkey: s.hotkey, partName: loops[s.loop_index]?.name,
        on: playing && p.loopIndex === s.loop_index, queued: pending === s.loop_index,
        color: colorOf(s.loop_index ?? k),
      })),
      parts: loops.map((L, i) => ({
        i, name: L.name, dur: fmt(L.duration_sec), oneShot: L.loop === false, key: i < 10 ? String((i + 1) % 10) : null,
        on: playing && p.loopIndex === i, queued: pending === i, color: colorOf(i),
      })),
      players: game.users.filter(u => u.active && !u.isGM).length,
      packsOpen: this.packsOpen,
      packsLoading: this.packsOpen && controller.packs === null,
      packs: (controller.packs || []).map(pk => {
        const installed = controller.installedSlugs();
        return { ...pk, tracks: (pk.tracks || []).map(tr => ({
          ...tr, installed: installed.has(tr.slug),
          installing: controller.installing?.slug === tr.slug ? controller.installing : null,
          pct: controller.installing?.slug === tr.slug && controller.installing.total ? Math.round(controller.installing.done / controller.installing.total * 100) : null,
        })) };
      }),
      installingAny: !!controller.installing,
      volume: Math.round(game.settings.get(MODULE_ID, "volume") * 100),
    };
  }

  async _onRender(ctx, opts) {
    const el = this.element;
    el.querySelector("input[name=volume]")?.addEventListener("input", ev => {
      const v = +ev.target.value / 100;
      game.settings.set(MODULE_ID, "volume", v);
      controller.player?.setVolume(v);
      el.querySelector(".musloop-vol-num").textContent = `${Math.round(v * 100)}%`;
    });
    el.querySelector("input[name=zip]")?.addEventListener("change", ev => this._importFile(ev.target.files?.[0]));
    // ETA ticker while a transition is pending
    clearInterval(this._eta);
    this._eta = setInterval(() => { if (controller.player?.pendingTarget() != null) this._throttledRender(); }, 1000);
  }

  async close(options) { clearInterval(this._eta); this._unsub?.(); return super.close(options); }

  async _importFile(file) {
    if (!file) return;
    const note = ui.notifications.info(i18n("MUSLOOP.Importing", { name: file.name }), { permanent: true });
    try {
      const res = await importZip(file, (d, n, name) => log.info(`upload ${d}/${n} ${name}`));
      ui.notifications.remove?.(note);
      ui.notifications.info(i18n("MUSLOOP.Imported", { name: res.slug, n: res.files }));
      await controller.refreshLibrary();
      await controller.loadTrack(res.slug);
    } catch (e) {
      ui.notifications.remove?.(note);
      ui.notifications.error(i18n("MUSLOOP.ImportFailed", { error: e.message || e }));
      log.error(e);
    }
  }

  // ---- actions (this = app)
  static async #onSelectTrack(ev, el) { if (game.user.isGM) await controller.loadTrack(el.dataset.slug); }
  static #onImportZip() { this.element.querySelector("input[name=zip]")?.click(); }
  static async #onRefresh() { await controller.refreshLibrary(); if (this.packsOpen) await controller.refreshPacks(); }
  static async #onTogglePacks() {
    this.packsOpen = !this.packsOpen;
    this.render();
    if (this.packsOpen && controller.packs === null) await controller.refreshPacks();
  }
  static async #onInstallTrack(ev, el) {
    const pk = controller.packs?.find(p => p.id === el.dataset.pack);
    const tr = pk?.tracks?.find(t => t.slug === el.dataset.slug);
    if (tr) await controller.installTrack(tr);
  }
  static #onPlay() { controller.play(controller.player?.loopIndex || 0); }
  static #onStop() { controller.stop(); }
  static #onNext() { controller.advance(); }
  static #onCancel() { controller.cancel(); }
  static #onFade() { controller.fade(2.5); }
  static #onMode(ev, el) { controller.setMode(el.dataset.mode); }
  static #onPart(ev, el) {
    const i = +el.dataset.index;
    const p = controller.player;
    if (!p?.playing) controller.play(i);
    else controller.cue(i, controller.mode);
  }
  static #onScene(ev, el) {
    const sc = controller.track?.manifest.scenes?.[+el.dataset.k];
    if (sc) controller.applyScene(sc);
  }
}

let desk = null;
export function toggleDesk() {
  if (desk?.rendered) { desk.close(); return; }
  desk = desk || new MusloopDesk();
  desk.render({ force: true });
}
export function getDesk() { return desk; }
