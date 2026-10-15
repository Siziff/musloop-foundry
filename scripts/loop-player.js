/**
 * musloop loop player for Foundry VTT — a port of musloop's LoopPlayer.
 *
 * Plays a track exported by musloop (manifest.json + WAV loops) as adaptive
 * music: every loop pass is a separately scheduled AudioBufferSourceNode on
 * the audio clock, so repeats are sample-accurate and transitions can be
 * planned for a musical boundary.
 *
 *   cue(target, mode)  mode: "natural" (end of the current loop pass)
 *                            "soon"    (next phrase boundary from manifest)
 *                            "now"     (short equal-power crossfade)
 *
 * The player is deterministic given (loopIndex, startAtCtxTime, cue events),
 * which is what lets the GM and the players stay in sync: the GM broadcasts
 * the *decisions*, every client renders them on its own AudioContext.
 */

const FADE = 0.006;        // micro-fade at every seam (clicks)
const LOOKAHEAD = 0.35;    // schedule the next chunk this far ahead
const TAIL_GAIN = 0.9;

export class MusloopPlayer {
  /**
   * @param {AudioContext} ctx       Foundry's music context (game.audio.music)
   * @param {object}  opts
   * @param {GainNode} [opts.destination]  where to connect (default ctx.destination)
   */
  constructor(ctx, { destination = null } = {}) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 1;
    this._dest = destination || ctx.destination;
    this.master.connect(this._dest);

    this.track = null;        // { slug, root, manifest, buffers: Map(file -> AudioBuffer) }
    this.loops = [];          // manifest.loops
    this.playing = false;
    this.loopIndex = 0;
    this.loopCount = 0;
    this.crossfade = 0;       // sec (section changes)
    this.tails = true;
    this.transitionMode = "natural";
    this.phraseBarsFallback = 4;

    this._queue = [];         // [{t0, t1, loopIndex, from, isRepeat}]
    this._sources = [];       // live nodes [{srcs:[], g, stopAll}]
    this._nextTime = 0;
    this._lastPlanned = 0;
    this._armed = false;      // transition armed for the loop end
    this._target = null;      // armed target index
    this._timer = null;
    this.onState = () => {};
  }

  // ------------------------------------------------------------ loading
  /**
   * Load a musloop export. `fetchBuffer(file)` must return an ArrayBuffer for
   * a file name from the manifest (the caller knows where the files live).
   */
  async load(manifest, fetchBuffer, { onProgress } = {}) {
    this.stop(false);
    const buffers = new Map();
    const files = [];
    for (const L of manifest.loops) {
      files.push(L.file);
      if (L.tail_file) files.push(L.tail_file);
    }
    let done = 0;
    for (const f of files) {
      const ab = await fetchBuffer(f);
      buffers.set(f, await this.ctx.decodeAudioData(ab.slice(0)));
      done++;
      onProgress?.(done, files.length);
    }
    this.track = { manifest, buffers };
    this.loops = manifest.loops;
    this.loopIndex = 0;
    this.loopCount = 0;
    this.onState();
    return this;
  }

  get loaded() { return !!this.track; }
  get current() { return this.loops[this.loopIndex] || null; }

  // ------------------------------------------------------------ transport
  /** Start looping `index` at ctx time `when` (default: now). */
  play(index = 0, when = null) {
    if (!this.track) return;
    this.stop(false);
    if (this.ctx.state !== "running") this.ctx.resume?.();
    this.playing = true;
    this.loopIndex = Math.max(0, Math.min(index, this.loops.length - 1));
    this.loopCount = 1;
    this._armed = false; this._target = null;
    const t0 = when != null ? Math.max(when, this.ctx.currentTime + 0.02) : this.ctx.currentTime + 0.06;
    this._lastPlanned = this.loopIndex;
    this._nextTime = t0;
    this._planChunk(this.loopIndex, false, 0.03);
    this._queue[0].t0 = t0;
    this._timer = setInterval(() => this._tick(), 60);
    this.onState();
  }

  stop(notify = true) {
    this.playing = false;
    this._armed = false; this._target = null;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    for (const s of this._sources) { try { s.stopAll(); } catch (e) {} }
    this._sources = [];
    this._queue = [];
    if (notify) this.onState();
  }

  /** Smooth fade out, then stop. */
  fadeOut(sec = 2.5) {
    if (!this.playing) return;
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.master.gain.value, now);
    this.master.gain.linearRampToValueAtTime(0.0001, now + sec);
    this._armed = false; this._target = null;
    this.onState();
    setTimeout(() => {
      this.stop();
      const t = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setValueAtTime(this._volume ?? 1, t);
    }, sec * 1000 + 50);
  }

  setVolume(v) {
    this._volume = v;
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.master.gain.value, now);
    this.master.gain.linearRampToValueAtTime(v, now + 0.03);
  }

  /** "Next": the following part with the global mode. */
  advance() { if (this.playing) this.cue(this.loopIndex + 1, this.transitionMode); }

  /**
   * Queue a transition into part `target`.
   * Returns a description of the decision so the GM can broadcast it:
   *   {target, mode, atPos}  atPos = track position (sec, inside the current
   *   loop file) where the switch lands for "soon"/"now"; null for "natural".
   */
  cue(target, mode = "natural") {
    if (!this.playing || target == null || target < 0 || target >= this.loops.length) return null;
    if (target === this.loopIndex && mode !== "now") { this.cancelCue(); return { cancel: true }; }
    if (mode === "now") {
      const pos = this.position();
      this._transitionAt(target, pos, Math.max(this.crossfade, 0.25));
      this.onState();
      return { target, mode, atPos: pos };
    }
    if (mode === "soon") {
      const at = this._nextPhraseBoundary();
      if (at != null) {
        this._transitionAt(target, at, Math.max(this.crossfade, 0.03));
        this.onState();
        return { target, mode, atPos: at };
      }
    }
    this._armed = true; this._target = target;
    this.onState();
    return { target, mode: "natural", atPos: null };
  }

  /** Apply a decision received from the GM (same shape cue() returns). */
  applyCue(d) {
    if (!this.playing) return;
    if (d.cancel) { this.cancelCue(); return; }
    if (d.atPos != null) {
      // land at the same track position the GM chose; if we are already past
      // it (latency), go right away with a short fade
      const pos = this.position();
      const at = d.atPos > pos + 0.05 ? d.atPos : pos;
      this._transitionAt(d.target, at, Math.max(this.crossfade, d.mode === "now" ? 0.25 : 0.03));
    } else {
      this._armed = true; this._target = d.target;
    }
    this.onState();
  }

  cancelCue() {
    if (!this.playing) return;
    const had = this._armed || this.pendingTarget() != null;
    this._armed = false; this._target = null;
    const last = this._queue[this._queue.length - 1];
    if (last && last.loopIndex !== this.loopIndex) {
      // the lookahead already planned the target: hand over to the current
      // part from the same position
      const pos = this.position();
      const L = this.current;
      if (pos != null && L && pos >= 0 && pos < L.duration_sec) {
        const lc = this.loopCount;
        this._softRestartAt(pos);
        this.loopCount = lc;
      }
    }
    if (had) this.onState();
  }

  pendingTarget() {
    if (!this.playing) return null;
    const last = this._queue[this._queue.length - 1];
    if (last && last.loopIndex !== this.loopIndex) return last.loopIndex;
    if (this._armed) return this._target != null ? this._target : this.loopIndex + 1;
    return null;
  }

  transitionEta() {
    if (!this.playing) return null;
    const last = this._queue[this._queue.length - 1];
    if (!last) return null;
    const now = this.ctx.currentTime;
    if (last.loopIndex !== this.loopIndex) return Math.max(0, last.t0 - now);
    if (this._armed) return Math.max(0, last.t1 - now);
    return null;
  }

  /** Position (sec) inside the current loop file, or null. */
  position() {
    if (!this.playing || !this._queue.length) return null;
    const now = this.ctx.currentTime;
    let cur = this._queue[0];
    for (const q of this._queue) if (q.t0 <= now) cur = q;
    if (now < cur.t0) return cur.from;
    return cur.from + (now - cur.t0);
  }

  /** Snapshot for late joiners: enough to reproduce the current state. */
  snapshot() {
    if (!this.playing) return { playing: false };
    const now = this.ctx.currentTime;
    let cur = this._queue[0];
    for (const q of this._queue) if (q.t0 <= now) cur = q;
    return {
      playing: true,
      loopIndex: this.loopIndex,
      // where inside the loop we are right now, in file seconds
      pos: this.position(),
      loopCount: this.loopCount,
      pending: this.pendingTarget(),
      pendingEta: this.transitionEta(),
      crossfade: this.crossfade,
    };
  }

  /** Resume from a snapshot (late join): start mid-loop at `pos`. */
  resumeFrom(snap) {
    if (!this.track || !snap?.playing) return;
    this.stop(false);
    this.playing = true;
    this.loopIndex = snap.loopIndex;
    this.loopCount = snap.loopCount || 1;
    this._timer = setInterval(() => this._tick(), 60);
    this._softRestartAt(Math.max(0, snap.pos || 0));
    if (snap.pending != null && snap.pending !== this.loopIndex) {
      this._armed = true; this._target = snap.pending;
    }
    this.onState();
  }

  // ------------------------------------------------------------ internals
  _buf(file) { return this.track?.buffers.get(file) || null; }

  _tick() {
    if (!this.playing) return;
    const now = this.ctx.currentTime;
    while (this._queue.length > 1 && this._queue[1].t0 <= now) {
      this._queue.shift();
      const cur = this._queue[0];
      if (cur.isRepeat) this.loopCount++; else this.loopCount = 1;
      this.loopIndex = cur.loopIndex;
      this.onState();
    }
    while (this._nextTime - now < LOOKAHEAD) {
      if (!this.loops.length) break;
      let idx = this._lastPlanned;
      let isRepeat = true;
      const L = this.loops[idx];
      const oneShot = L && L.loop === false;
      if (this._armed || oneShot) {
        const want = this._armed && this._target != null ? this._target : idx + 1;
        if (want >= 0 && want < this.loops.length) { idx = want; isRepeat = false; }
        else { this.stop(); return; }
        this._armed = false; this._target = null;
        this.onState();
      }
      this._planChunk(idx, isRepeat);
    }
  }

  /** Schedule one chunk of loop `idx` at this._nextTime. */
  _planChunk(idx, isRepeat, fadeIn = null) {
    const L = this.loops[idx];
    const buf = this._buf(L.file);
    if (!buf) { this.stop(); return; }
    const sr = L.sample_rate || buf.sampleRate;
    const from = isRepeat && L.loop_start_sample > 0 ? L.loop_start_sample / sr : 0;
    const to = Math.min(buf.duration, (L.loop_end_sample || buf.length) / sr);
    const dur = to - from;
    const xf = this.crossfade > 0.02 ? Math.min(this.crossfade, dur / 3) : 0;
    const isChange = !isRepeat && this._lastPlanned !== idx;
    const when = this._nextTime;
    const rec = this._scheduleRange(buf, from, to, when,
      fadeIn != null ? fadeIn : (xf > 0 ? xf : null), xf > 0 ? xf : null, { linear: !isChange });
    if (isChange) {
      const prev = this.loops[this._lastPlanned];
      if (prev && this.tails) this._scheduleTail(prev, when);
      if (L.stinger) this._playStinger(L.stinger, when);
    }
    this._queue.push({ t0: when, t1: when + dur, loopIndex: idx, from, isRepeat: isRepeat && this._lastPlanned === idx });
    this._lastPlanned = idx;
    this._nextTime = when + dur - xf;
    return rec;
  }

  _scheduleRange(buf, from, to, when, fadeIn, fadeOut, { linear = false } = {}) {
    const dur = to - from;
    if (dur <= 0.01) return null;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    const fi = Math.min(fadeIn != null ? fadeIn : FADE, dur / 2);
    const fo = Math.min(fadeOut != null ? fadeOut : FADE, dur / 2);
    g.gain.setValueAtTime(0, when);
    if (fi > 0.02 && !linear) {
      for (let k = 1; k <= 8; k++) g.gain.linearRampToValueAtTime(Math.sin((k / 8) * Math.PI / 2), when + fi * k / 8);
    } else g.gain.linearRampToValueAtTime(1, when + fi);
    g.gain.setValueAtTime(1, when + dur - fo);
    if (fo > 0.02 && !linear) {
      for (let k = 1; k <= 8; k++) g.gain.linearRampToValueAtTime(Math.cos((k / 8) * Math.PI / 2), when + dur - fo + fo * k / 8);
    } else g.gain.linearRampToValueAtTime(0, when + dur);
    g.connect(this.master);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(g);
    src.start(when, from, dur);
    const rec = { srcs: [src], g, when, stopAll: (t) => { try { t != null ? src.stop(t) : src.stop(); } catch (e) {} } };
    this._sources.push(rec);
    src.onended = () => { this._sources = this._sources.filter(s => s !== rec); };
    return rec;
  }

  _scheduleTail(prevLoop, when) {
    const buf = prevLoop.tail_file ? this._buf(prevLoop.tail_file) : null;
    if (!buf) return;
    const dur = buf.duration;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(TAIL_GAIN, when);
    for (let k = 1; k <= 8; k++) g.gain.linearRampToValueAtTime(TAIL_GAIN * Math.cos((k / 8) * Math.PI / 2), when + dur * k / 8);
    g.connect(this.master);
    const src = this.ctx.createBufferSource();
    src.buffer = buf; src.connect(g); src.start(when);
    const rec = { srcs: [src], g, when, stopAll: (t) => { try { t != null ? src.stop(t) : src.stop(); } catch (e) {} } };
    this._sources.push(rec);
    src.onended = () => { this._sources = this._sources.filter(s => s !== rec); };
  }

  _playStinger(name, when) {
    const buf = this.stingers?.[name];
    if (!buf) return;
    const g = this.ctx.createGain(); g.gain.value = 0.9; g.connect(this.master);
    const src = this.ctx.createBufferSource(); src.buffer = buf; src.connect(g);
    src.start(name === "riser" ? Math.max(this.ctx.currentTime, when - buf.duration) : when);
  }

  _softRestartAt(pos) {
    const now = this.ctx.currentTime;
    for (const r of this._sources) {
      try {
        if (r.when > now + 0.005) { r.stopAll(now); continue; }
        r.g.gain.cancelScheduledValues(now);
        r.g.gain.setValueAtTime(r.g.gain.value, now);
        r.g.gain.linearRampToValueAtTime(0, now + 0.05);
        r.stopAll(now + 0.06);
      } catch (e) {}
    }
    this._sources = [];
    const L = this.current;
    const buf = this._buf(L.file);
    if (!buf) return;
    const from = Math.max(0, Math.min(pos, buf.duration - 0.05));
    this._lastPlanned = this.loopIndex;
    this._nextTime = now + 0.06;
    const dur = buf.duration - from;
    this._scheduleRange(buf, from, buf.duration, this._nextTime, 0.03, null, { linear: true });
    this._queue = [{ t0: this._nextTime, t1: this._nextTime + dur, loopIndex: this.loopIndex, from, isRepeat: false }];
    this._nextTime += dur;
    this.onState();
  }

  /** Next phrase boundary ahead of the playhead (file seconds) or null. */
  _nextPhraseBoundary() {
    const pos = this.position();
    const L = this.current;
    if (pos == null || !L) return null;
    const pts = (L.transition_points_sec && L.transition_points_sec.length)
      ? L.transition_points_sec
      : (L.downbeats_sec || []).filter((_, i) => i % this.phraseBarsFallback === 0);
    for (const p of pts) if (p > pos + 0.12) return p;
    return null;
  }

  /** Hard transition into `target` when the playhead reaches `atPos`. */
  _transitionAt(target, atPos, xf) {
    const pos = this.position();
    if (pos == null) return;
    const now = this.ctx.currentTime;
    const Tt = now + Math.max(0, atPos - pos);
    const L = this.loops[target];
    const buf = L && this._buf(L.file);
    if (!buf) return;
    for (const { g } of this._sources) {
      try {
        g.gain.cancelScheduledValues(Tt);
        g.gain.setValueAtTime(g.gain.value, Tt);
        for (let k = 1; k <= 6; k++) g.gain.linearRampToValueAtTime(Math.cos((k / 6) * Math.PI / 2), Tt + xf * k / 6);
      } catch (e) {}
    }
    const olds = this._sources.slice();
    setTimeout(() => olds.forEach(s => { try { s.stopAll(); } catch (e) {} }), (Tt - now + xf + 0.1) * 1000);
    this._sources = [];
    const prev = this.current;
    this._nextTime = Tt;
    const to = Math.min(buf.duration, (L.loop_end_sample || buf.length) / (L.sample_rate || buf.sampleRate));
    this._scheduleRange(buf, 0, to, Tt, xf >= 0.2 || this.crossfade > 0.02 ? xf : null, null, { linear: false });
    if (prev && this.tails) this._scheduleTail(prev, Tt);
    if (L.stinger) this._playStinger(L.stinger, Tt);
    this._queue = [
      { t0: now, t1: Tt, loopIndex: this.loopIndex, from: pos, isRepeat: false },
      { t0: Tt, t1: Tt + to, loopIndex: target, from: 0, isRepeat: false },
    ];
    this._armed = false; this._target = null;
    this._lastPlanned = target;
    this._nextTime = Tt + to;
  }
}
