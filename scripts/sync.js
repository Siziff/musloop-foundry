/**
 * Shared playback controller: one MusslopPlayer per client, driven either by
 * the local GM's actions or by messages from the GM over the module socket.
 *
 * Protocol (GM -> everyone):
 *   {op:"load",  slug}                          load this track (players fetch files themselves)
 *   {op:"play",  slug, index, at}               start looping part `index`; `at` = GM audio-clock
 *                                                time is NOT portable, so players start "now"
 *                                                and the GM's later snapshot keeps drift small
 *   {op:"cue",   decision}                      decision from MusslopPlayer.cue()
 *   {op:"cancel"} / {op:"stop"} / {op:"fade", sec}
 *   {op:"mode",  mode} / {op:"crossfade", sec}
 *   {op:"state", snapshot, slug}                periodic + on request: full state for late joiners
 * Player -> GM:
 *   {op:"hello"}                                "send me the state"
 */
import { MODULE_ID, SOCKET, log, i18n } from "./const.js";
import { MusslopPlayer } from "./loop-player.js";
import { scanLibrary, fetchTrackFile, fetchPackIndexes, installPackTrack, DEFAULT_PACK_INDEX } from "./library.js";

class Controller {
  constructor() {
    this.player = null;
    this.tracks = [];            // library entries
    this.track = null;           // currently loaded entry
    this.loading = null;         // {done,total} while loading buffers
    this.packs = null;           // pack index entries (null = not fetched yet)
    this.installing = null;      // {slug, phase, done, total}
    this.mode = "natural";
    this.listeners = new Set();
    this._stateTimer = null;
  }

  get isGM() { return game.user.isGM; }

  /**
   * Lazily create the player on Foundry's music context. The context only
   * exists after the browser allowed audio (first click/key in Foundry), so
   * callers that may run before that await `readyPlayer()` instead.
   */
  ensurePlayer() {
    if (this.player) return this.player;
    const ctx = game.audio.music || game.audio.context;
    if (!ctx) throw new Error("audio is locked until the first click in Foundry");
    // connect through Foundry's music gain node so the core "Music" volume slider applies
    this.player = new MusslopPlayer(ctx, { destination: ctx.gainNode || null });
    this.player.setVolume(game.settings.get(MODULE_ID, "volume"));
    this.player.tails = game.settings.get(MODULE_ID, "tails");
    this.player.transitionMode = this.mode;
    this.player.onState = () => this.emit();
    return this.player;
  }

  /** Wait until the browser unlocked audio (Foundry: game.audio.unlock), then return the player. */
  async readyPlayer() {
    if (this.player) return this.player;
    if (!(game.audio.music || game.audio.context)) {
      if (!this._unlockNoted && !this.isGM) {
        this._unlockNoted = true;
        ui.notifications?.info(i18n("MUSSLOP.ClickToHear"));
      }
      await game.audio.unlock;
    }
    return this.ensurePlayer();
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) { try { fn(); } catch (e) { log.error(e); } } }

  async refreshLibrary() {
    this.tracks = await scanLibrary();
    this.emit();
    return this.tracks;
  }

  // ------------------------------------------------------------ packs
  packSources() {
    const extra = (game.settings.get(MODULE_ID, "packSources") || "").split(/\s+/).filter(Boolean);
    return [DEFAULT_PACK_INDEX, ...extra];
  }
  async refreshPacks() {
    this.packs = await fetchPackIndexes(this.packSources());
    this.emit();
    return this.packs;
  }
  installedSlugs() { return new Set(this.tracks.map(t => t.slug)); }
  async installTrack(track) {
    if (this.installing) return;
    this.installing = { slug: track.slug, phase: "download", done: 0, total: 0 };
    this.emit();
    try {
      await installPackTrack(track, (phase, done, total) => { this.installing = { slug: track.slug, phase, done, total }; this.emit(); });
      await this.refreshLibrary();
      ui.notifications?.info(`musslop: ${track.name} installed`);
    } catch (e) {
      ui.notifications?.error(`musslop: ${track.name} — ${e.message || e}`);
      log.error(e);
    } finally { this.installing = null; this.emit(); }
  }

  // ------------------------------------------------------------ actions (GM or replay)
  async loadTrack(slug, { broadcast = true } = {}) {
    if (!this.tracks.length) await this.refreshLibrary();
    const entry = this.tracks.find(t => t.slug === slug);
    if (!entry) { ui.notifications?.warn(`musslop: track "${slug}" not found in Data/musslop`); return null; }
    const p = await this.readyPlayer();
    this.loading = { done: 0, total: 1 };
    this.emit();
    try {
      await p.load(entry.manifest, f => fetchTrackFile(entry, f), {
        onProgress: (d, n) => { this.loading = { done: d, total: n }; this.emit(); },
      });
      this.track = entry;
    } finally { this.loading = null; this.emit(); }
    if (broadcast && this.isGM) this.send({ op: "load", slug });
    return entry;
  }

  play(index, { broadcast = true } = {}) {
    const p = this.ensurePlayer();
    if (!p.loaded) return;
    p.play(index);
    if (broadcast && this.isGM) { this.send({ op: "play", slug: this.track?.slug, index }); this._scheduleState(); }
  }

  cue(target, mode = this.mode, { broadcast = true } = {}) {
    const p = this.ensurePlayer();
    const d = p.cue(target, mode);
    if (d && broadcast && this.isGM) this.send({ op: "cue", decision: d });
    return d;
  }

  advance() { if (this.player?.playing) this.cue(this.player.loopIndex + 1, this.mode); }

  cancel({ broadcast = true } = {}) {
    this.player?.cancelCue();
    if (broadcast && this.isGM) this.send({ op: "cancel" });
  }

  stop({ broadcast = true } = {}) {
    this.player?.stop();
    if (broadcast && this.isGM) this.send({ op: "stop" });
  }

  fade(sec = 2.5, { broadcast = true } = {}) {
    this.player?.fadeOut(sec);
    if (broadcast && this.isGM) this.send({ op: "fade", sec });
  }

  setMode(mode, { broadcast = true } = {}) {
    this.mode = mode;
    if (this.player) this.player.transitionMode = mode;
    this.emit();
    if (broadcast && this.isGM) this.send({ op: "mode", mode });
  }

  setCrossfade(sec, { broadcast = true } = {}) {
    if (this.player) this.player.crossfade = sec;
    this.emit();
    if (broadcast && this.isGM) this.send({ op: "crossfade", sec });
  }

  /** Scenes come from the manifest; applying one = cue its loop with its mode. */
  applyScene(scene) {
    const p = this.ensurePlayer();
    if (!p.loaded) return;
    const idx = scene.loop_index;
    if (!p.playing) { this.play(idx); return; }
    this.cue(idx, scene.cue || this.mode);
  }

  // ------------------------------------------------------------ socket
  send(msg) {
    game.socket.emit(SOCKET, { ...msg, from: game.user.id });
  }

  _scheduleState() {
    // a snapshot a moment after play, then every ~20 s while playing
    clearInterval(this._stateTimer);
    const tick = () => {
      if (!this.player?.playing) { clearInterval(this._stateTimer); this._stateTimer = null; return; }
      this.send({ op: "state", slug: this.track?.slug, snapshot: this.player.snapshot(), mode: this.mode });
    };
    setTimeout(tick, 1500);
    this._stateTimer = setInterval(tick, 20000);
  }

  /** Socket entry point: process GM messages strictly in order (a "state" must
   * not overtake a "play" that is still loading the track). */
  handle(msg) {
    if (!msg || msg.from === game.user.id) return;
    msg._recv = performance.now();
    this._queue = (this._queue || Promise.resolve()).then(() => this._handle(msg)).catch(e => log.error(e));
    return this._queue;
  }

  async _handle(msg) {
    // only the active GM's messages drive playback
    const sender = game.users.get(msg.from);
    if (msg.op === "hello") {
      if (this.isGM && this.player?.playing) this.send({ op: "state", slug: this.track?.slug, snapshot: this.player.snapshot(), mode: this.mode });
      return;
    }
    if (!sender?.isGM || this.isGM) return;
    try {
      switch (msg.op) {
        case "load": await this.loadTrack(msg.slug, { broadcast: false }); break;
        case "play": {
          const t0 = performance.now();
          if (this.track?.slug !== msg.slug) await this.loadTrack(msg.slug, { broadcast: false });
          this.play(msg.index, { broadcast: false });
          // loading (or waiting for the player's first click) took a while: the GM is
          // already ahead — ask for a snapshot now instead of waiting for the next one
          if (performance.now() - t0 > 400) this.hello();
          break;
        }
        case "cue": (await this.readyPlayer()).applyCue(msg.decision); break;
        case "cancel": this.cancel({ broadcast: false }); break;
        case "stop": this.stop({ broadcast: false }); break;
        case "fade": this.fade(msg.sec, { broadcast: false }); break;
        case "mode": this.setMode(msg.mode, { broadcast: false }); break;
        case "crossfade": this.setCrossfade(msg.sec, { broadcast: false }); break;
        case "state": await this._applyState(msg); break;
      }
    } catch (e) { log.error("socket op failed", msg.op, e); }
  }

  /** Late join / drift correction from the GM's snapshot. */
  async _applyState(msg) {
    let snap = msg.snapshot;
    if (msg.mode) this.setMode(msg.mode, { broadcast: false });
    if (!snap?.playing) { if (this.player?.playing) this.stop({ broadcast: false }); return; }
    if (this.track?.slug !== msg.slug) await this.loadTrack(msg.slug, { broadcast: false });
    const p = await this.readyPlayer();
    if (snap.crossfade != null) p.crossfade = snap.crossfade;
    // the snapshot may have waited (track loading, audio unlock): move it forward by that time
    const waited = msg._recv ? (performance.now() - msg._recv) / 1000 : 0;
    const cur = p.loops[snap.loopIndex];
    if (waited > 0 && snap.pos != null && cur) {
      const len = cur.duration_sec, ls = (cur.loop_start_sample || 0) / (cur.sample_rate || 44100);
      let pos = snap.pos + waited;
      if (pos >= len && cur.loop !== false && len - ls > 0.5) pos = ls + ((pos - ls) % (len - ls));
      snap = { ...snap, pos: Math.min(pos, len - 0.05) };
    }
    const localPos = p.playing && p.loopIndex === snap.loopIndex ? p.position() : null;
    // only re-sync when we are off by more than 400 ms (or not playing the same part)
    if (localPos == null || Math.abs(localPos - snap.pos) > 0.4) p.resumeFrom(snap);
    else if (snap.pending != null && p.pendingTarget() == null) p.applyCue({ target: snap.pending, mode: "natural", atPos: null });
  }

  hello() { if (!this.isGM) this.send({ op: "hello" }); }
}

export const controller = new Controller();
