/*
 * Thalassa audio — everything synthesized at runtime with the Web Audio API.
 * No sound files (the deploy proxy blocks audio hosts, and procedural audio is
 * license-clean and tiny). An ambient lyre soundtrack in D-Dorian over a soft
 * pad and a sea-noise bed, plus a set of event SFX.
 *
 *   audio.init()            create/resume the context (call on a user gesture)
 *   audio.startMusic()      begin the ambient scheduler (idempotent)
 *   audio.toggleMuted()     → bool; audio.setMuted(bool); audio.isMuted()
 *   audio.duck(bool)        lower the music under a question card
 *   audio.sfx.<name>()      dice · sail · correct · wrong · laurel · build ·
 *                           oracle · turn · victory · click · join
 */

const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

// D-Dorian progression. Each chord: soft pad `notes` (low) + lyre `pool` (high).
const DORIAN = [
  { notes: [50, 53, 57], pool: [62, 65, 69, 72, 74] },   // Dm
  { notes: [53, 57, 60], pool: [65, 69, 72, 77] },        // F
  { notes: [48, 52, 55], pool: [60, 64, 67, 72] },        // C
  { notes: [55, 59, 62], pool: [67, 71, 74, 79] },        // G
];
const BAR = 3.6;          // seconds per chord

class ThalassaAudio {
  constructor() {
    this.ctx = null;
    this.enabled = false;
    this.muted = localStorage.getItem('thalassa_muted') === '1';
    this.musicOn = false;
    this._ksCache = new Map();
    this._nextBar = 0;
    this._barIdx = 0;
    this._timer = null;
    this.sfx = this._makeSfxApi();
  }

  // ── setup ──────────────────────────────────────────────────────────────
  init() {
    if (this.enabled) { this._resume(); return; }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      this.ctx = ctx;

      const comp = ctx.createDynamicsCompressor();     // glue + clip guard
      comp.threshold.value = -14; comp.ratio.value = 3;
      comp.connect(ctx.destination);

      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.9;
      this.master.connect(comp);

      this.musicBus = ctx.createGain();
      this.musicBus.gain.value = 0.5;
      this.musicBus.connect(this.master);

      this.sfxBus = ctx.createGain();
      this.sfxBus.gain.value = 0.75;
      this.sfxBus.connect(this.master);

      // a small procedural reverb for space
      this.reverb = ctx.createConvolver();
      this.reverb.buffer = this._impulse(1.8, 2.6);
      const wet = ctx.createGain();
      wet.gain.value = 0.85;
      this.reverb.connect(wet);
      wet.connect(this.master);

      this._startSea();
      this.enabled = true;
      this._resume();
    } catch (e) {
      this.enabled = false;
    }
  }

  _resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  isMuted() { return this.muted; }
  setMuted(m) {
    this.muted = m;
    localStorage.setItem('thalassa_muted', m ? '1' : '0');
    if (this.master) this._ramp(this.master.gain, m ? 0 : 0.9, 0.2);
  }
  toggleMuted() { this.setMuted(!this.muted); return this.muted; }

  duck(on) {
    if (this.musicBus) this._ramp(this.musicBus.gain, on ? 0.16 : 0.5, 0.6);
  }

  /* one clear tone per Simon tile — a pentatonic scale across two octaves */
  simonTone(i) {
    if (!this.enabled) return;
    this._resume();
    const freqs = [261.6, 293.7, 329.6, 392.0, 440.0, 523.3, 587.3, 659.3, 784.0];
    const t = this.ctx.currentTime;
    this._tone(freqs[i % 9], t, 0.34, 0.16, 'triangle', this.sfxBus, 0.25);
    this._tone(freqs[i % 9] * 2, t, 0.2, 0.05, 'sine', this.sfxBus, 0.2);
  }

  // ── low-level helpers ──────────────────────────────────────────────────
  _ramp(param, to, t) {
    const now = this.ctx.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(to, now + t);
  }

  _impulse(dur, decay) {
    const sr = this.ctx.sampleRate;
    const len = Math.round(sr * dur);
    const buf = this.ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  _noiseBuffer(dur) {
    const sr = this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(1, Math.round(sr * dur), sr);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) {           // brown-ish noise
      last = (last + (Math.random() * 2 - 1) * 0.35) * 0.96;
      d[i] = last;
    }
    return buf;
  }

  // Karplus–Strong plucked string, cached per note — sounds like a lyre/harp.
  _ksBuffer(midi) {
    if (this._ksCache.has(midi)) return this._ksCache.get(midi);
    const freq = midiToFreq(midi);
    const sr = this.ctx.sampleRate;
    const dur = 2.4;
    const total = Math.round(sr * dur);
    const N = Math.max(2, Math.round(sr / freq));
    const buf = this.ctx.createBuffer(1, total, sr);
    const out = buf.getChannelData(0);
    const ring = new Float32Array(N);
    for (let i = 0; i < N; i++) ring[i] = Math.random() * 2 - 1;
    let idx = 0;
    for (let i = 0; i < total; i++) {
      const cur = ring[idx];
      const nxt = ring[(idx + 1) % N];
      out[i] = cur;
      ring[idx] = 0.5 * (cur + nxt) * 0.9955;        // decay
      idx = (idx + 1) % N;
    }
    const fade = Math.round(sr * 0.15);              // avoid tail click
    for (let i = 0; i < fade; i++) out[total - 1 - i] *= i / fade;
    this._ksCache.set(midi, buf);
    return buf;
  }

  _voice(node, bus, wet = 0.14) {
    node.connect(bus);
    if (wet > 0 && this.reverb) {
      const s = this.ctx.createGain();
      s.gain.value = wet;
      node.connect(s);
      s.connect(this.reverb);
    }
  }

  _pluck(midi, t, gain = 0.16, wet = 0.18) {
    const src = this.ctx.createBufferSource();
    src.buffer = this._ksBuffer(midi);
    const g = this.ctx.createGain();
    g.gain.value = gain * (0.8 + Math.random() * 0.4);
    src.connect(g);
    this._voice(g, this.musicBus, wet);
    src.start(t);
    src.stop(t + 2.4);
  }

  _tone(freq, t, dur, gain, type = 'sine', bus = this.sfxBus, wet = 0.2, glideTo = null) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.03, dur * 0.3));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    this._voice(g, bus, wet);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  _noise(t, dur, gain, { type = 'lowpass', freq = 1200, q = 1, sweepTo = null } = {}) {
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer(dur + 0.05);
    const f = this.ctx.createBiquadFilter();
    f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + dur * 0.15);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g);
    this._voice(g, this.sfxBus, 0.12);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  // ── ambient music ──────────────────────────────────────────────────────
  _startSea() {
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer(6);
    src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 480;
    const g = this.ctx.createGain();
    g.gain.value = 0.05;
    const lfo = this.ctx.createOscillator();          // slow swell = waves
    lfo.frequency.value = 0.09;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 0.03;
    lfo.connect(lfoGain); lfoGain.connect(g.gain);
    src.connect(f); f.connect(g); g.connect(this.musicBus);
    src.start(); lfo.start();
  }

  /* ── soundtrack director ─────────────────────────────────────────────────
   * Five scenes, five files in /static/music/. Crossfades between scenes;
   * falls back to the procedural lyre if the files can't load/decode. */
  startMusic() {
    if (!this.enabled || this.musicOn) return;
    this.musicOn = true;
    this.setScene(this._pendingScene || 'lobby');
  }

  _track(name) {
    if (!this._tracks) this._tracks = {};
    if (this._tracks[name]) return this._tracks[name];
    const el = new Audio(`/static/music/${name}.mp3`);
    el.loop = true;
    el.preload = 'auto';
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    const t = { el, gain, failed: false, started: false };
    el.addEventListener('error', () => { t.failed = true; this._musicFallback(); });
    try {
      const src = this.ctx.createMediaElementSource(el);
      src.connect(gain);
      gain.connect(this.musicBus);
    } catch (e) {
      t.failed = true;
    }
    this._tracks[name] = t;
    return t;
  }

  _musicFallback() {
    // every scene track broken? sing the procedural lyre instead (once)
    const tracks = Object.values(this._tracks || {});
    if (tracks.length && tracks.every((t) => t.failed) && !this._procOn) {
      this._procOn = true;
      this._nextBar = this.ctx.currentTime + 0.3;
      this._loop();
    }
  }

  setScene(name) {
    this._pendingScene = name;
    if (!this.enabled || !this.musicOn || this._procOn) return;
    if (this._scene === name) return;
    this._scene = name;
    const FADE = 1.4;
    for (const [n, t] of Object.entries(this._tracks || {})) {
      if (n !== name && t.started) this._ramp(t.gain.gain, 0, FADE);
    }
    const t = this._track(name);
    if (t.failed) {                       // missing file → keep the game bed
      if (name !== 'game') this.setSceneForce('game');
      else this._musicFallback();
      return;
    }
    if (!t.started) {
      t.started = true;
      t.el.play().then(() => {}).catch(() => { t.failed = true; this._musicFallback(); });
    } else if (t.el.paused) {
      t.el.play().catch(() => {});
    }
    this._ramp(t.gain.gain, 1.0, FADE);
  }

  setSceneForce(name) {
    this._scene = null;
    this.setScene(name);
  }

  _loop() {
    if (!this.musicOn) return;
    while (this._nextBar < this.ctx.currentTime + 0.4) {
      this._scheduleBar(DORIAN[this._barIdx % DORIAN.length], this._nextBar);
      this._nextBar += BAR;
      this._barIdx++;
    }
    this._timer = setTimeout(() => this._loop(), 80);
  }

  _scheduleBar(chord, t) {
    // soft sustained pad on the chord tones
    for (const m of chord.notes) {
      const o = this.ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = midiToFreq(m);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.05, t + 0.8);
      g.gain.linearRampToValueAtTime(0.0001, t + BAR);
      o.connect(g); this._voice(g, this.musicBus, 0.25);
      o.start(t); o.stop(t + BAR + 0.05);
    }
    // low drone on the root
    this._tone(midiToFreq(chord.notes[0] - 12), t, BAR, 0.05, 'sine', this.musicBus, 0.2);

    // lyre arpeggio across the bar, skipping a beat now and then
    const steps = 6;
    for (let i = 0; i < steps; i++) {
      if (Math.random() < 0.22) continue;
      const m = chord.pool[Math.floor(Math.random() * chord.pool.length)]
              + (Math.random() < 0.18 ? 12 : 0);
      const when = t + (i / steps) * BAR + (Math.random() - 0.5) * 0.06;
      this._pluck(m, when, 0.14);
    }
  }

  // ── SFX ────────────────────────────────────────────────────────────────
  _makeSfxApi() {
    const A = this;
    const at = () => A.ctx.currentTime;
    const guard = (fn) => () => { if (A.enabled) { A._resume(); try { fn(); } catch (e) {} } };
    return {
      click: guard(() => A._tone(660, at(), 0.05, 0.06, 'sine', A.sfxBus, 0.1)),

      turn: guard(() => {                              // gentle two-note "you're up"
        const t = at();
        A._tone(midiToFreq(69), t, 0.5, 0.12, 'triangle', A.sfxBus, 0.3);
        A._tone(midiToFreq(76), t + 0.14, 0.6, 0.11, 'triangle', A.sfxBus, 0.3);
      }),

      dice: guard(() => {                              // rattle → settle
        const t = at();
        for (let i = 0; i < 7; i++) {
          A._noise(t + i * 0.055 + Math.random() * 0.02, 0.05, 0.14,
            { type: 'bandpass', freq: 1400 + Math.random() * 1600, q: 2 });
        }
        A._noise(t + 0.5, 0.12, 0.16, { type: 'lowpass', freq: 900 });
        A._tone(150, t + 0.5, 0.14, 0.14, 'sine', A.sfxBus, 0.1, 90);   // thunk
      }),

      sail: guard(() => {                              // watery whoosh
        const t = at();
        A._noise(t, 0.7, 0.13, { type: 'lowpass', freq: 500, sweepTo: 1500 });
        A._noise(t + 0.15, 0.6, 0.08, { type: 'bandpass', freq: 700, q: 0.7, sweepTo: 300 });
      }),

      correct: guard(() => {                           // bright rising arpeggio
        const t = at();
        [60, 64, 67, 72].forEach((m, i) =>
          A._tone(midiToFreq(m), t + i * 0.08, 0.35, 0.13, 'triangle', A.sfxBus, 0.25));
      }),

      wrong: guard(() => {                             // low descending buzz
        const t = at();
        A._tone(200, t, 0.28, 0.14, 'sawtooth', A.sfxBus, 0.15, 150);
        A._tone(150, t + 0.16, 0.32, 0.12, 'sawtooth', A.sfxBus, 0.15, 110);
      }),

      laurel: guard(() => {                            // triumphant flourish
        const t = at();
        [65, 69, 72, 77, 81].forEach((m, i) =>
          A._pluck(m, t + i * 0.09, 0.2, 0.3));
        A._tone(midiToFreq(53), t, 1.2, 0.08, 'sine', A.sfxBus, 0.3);
      }),

      build: guard(() => {                             // woody double thunk
        const t = at();
        A._noise(t, 0.12, 0.16, { type: 'lowpass', freq: 700 });
        A._tone(120, t, 0.16, 0.16, 'sine', A.sfxBus, 0.1, 80);
        A._noise(t + 0.14, 0.1, 0.12, { type: 'lowpass', freq: 600 });
        A._tone(110, t + 0.14, 0.14, 0.13, 'sine', A.sfxBus, 0.1, 75);
      }),

      oracle: guard(() => {                            // mystical shimmer
        const t = at();
        [72, 76, 79, 83, 88].forEach((m, i) =>
          A._tone(midiToFreq(m) * (1 + (Math.random() - 0.5) * 0.01),
            t + i * 0.06, 1.4 - i * 0.1, 0.06, 'sine', A.sfxBus, 0.5));
      }),

      hit: guard(() => {                               // your blade lands
        const t = at();
        A._noise(t, 0.09, 0.2, { type: 'highpass', freq: 2400 });
        A._tone(660, t, 0.07, 0.1, 'square', A.sfxBus, 0.1, 440);
        A._tone(180, t + 0.02, 0.16, 0.16, 'sine', A.sfxBus, 0.1, 90);
      }),

      hurt: guard(() => {                              // the monster strikes you
        const t = at();
        A._tone(140, t, 0.3, 0.18, 'sawtooth', A.sfxBus, 0.2, 70);
        A._noise(t, 0.28, 0.16, { type: 'lowpass', freq: 500, sweepTo: 160 });
      }),

      roar: guard(() => {                              // a guardian appears
        const t = at();
        A._tone(90, t, 0.7, 0.16, 'sawtooth', A.sfxBus, 0.3, 55);
        A._tone(135, t + 0.05, 0.6, 0.1, 'square', A.sfxBus, 0.3, 80);
        A._noise(t, 0.65, 0.12, { type: 'bandpass', freq: 300, q: 1.2, sweepTo: 120 });
      }),

      victory: guard(() => {                           // full fanfare
        const t = at();
        const chords = [[57, 60, 64], [59, 62, 67], [60, 64, 69], [62, 65, 72]];
        chords.forEach((c, i) => c.forEach((m) =>
          A._pluck(m, t + i * 0.28, 0.2, 0.35)));
        A._tone(midiToFreq(38), t, 2.0, 0.09, 'sine', A.sfxBus, 0.3);
      }),

      join: guard(() => {                              // soft welcome
        const t = at();
        A._pluck(62, t, 0.16);
        A._pluck(69, t + 0.12, 0.16);
        A._pluck(74, t + 0.24, 0.16);
      }),
    };
  }
}

export const audio = new ThalassaAudio();
