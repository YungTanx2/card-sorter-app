/**
 * Audio cues for capture-driven runs — the "Phase 2 seam" both mode pages were built around.
 *
 * Every sound here is SYNTHESIZED, not loaded from a file. Two reasons, and the second is the
 * one that matters: no binary assets to commit or preload, and — because the X1PRO routes on an
 * audio cue it has been taught ("Sound Learn") — these tones may eventually stop being mere
 * operator feedback and become the actual machine control signal. Tuning a number is a one-line
 * experiment; re-recording a sample is not.
 *
 * That future is also why the two decision cues sit at opposite ends of the spectrum: a bright
 * ~1-1.6kHz bell against a dull ~55-165Hz thud is trivially separable by a naive amplitude/band
 * detector. Two mid-range beeps would sound fine to a human and be much harder for the machine.
 *
 * Cues are named for the SOUND (kaching / thunk / alert), never for the decision, because the
 * price sorter routes keeper/bulk while Set Builder routes needed/extra and both map onto the
 * same pair. Each page owns its own vocabulary; this module owns noises.
 *
 * Plain script (not an ESM module) exposing one global, matching capture.js's convention.
 */
window.CardSorterAudio = (function () {
  'use strict';

  const DEFAULTS = { soundEnabled: true, soundVolume: 0.6 };

  let ctx = null;
  let master = null;
  let noiseBuffer = null;
  let unavailable = false;
  const config = Object.assign({}, DEFAULTS);

  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  function AudioCtor() {
    return window.AudioContext || window.webkitAudioContext || null;
  }

  function isSupported() {
    return !!AudioCtor();
  }

  /** One second of white noise, built once and replayed. This is the percussive "body" under
   *  both decision cues — the metallic scrape of a cash drawer, the slap of a card landing.
   *  Pure oscillators alone read as synthetic chimes; a noise transient is what makes a sound
   *  register as an *impact*. */
  function buildNoiseBuffer(c) {
    const buf = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  /**
   * Built lazily rather than at load time: on iOS an AudioContext constructed outside a user
   * gesture starts suspended and can stay that way for the life of the page, so the first thing
   * that touches it should be a real tap (see unlock()).
   */
  function ensureContext() {
    if (unavailable) return null;
    if (ctx) return ctx;
    const Ctor = AudioCtor();
    if (!Ctor) { unavailable = true; return null; }
    try {
      ctx = new Ctor();
      master = ctx.createGain();
      master.gain.value = config.soundVolume;
      master.connect(ctx.destination);
      noiseBuffer = buildNoiseBuffer(ctx);
    } catch (err) {
      // Audio is feedback, never part of a routing decision — a browser without Web Audio runs
      // the pile silently rather than failing the run.
      console.warn('[audio] Web Audio unavailable:', err && err.message ? err.message : err);
      unavailable = true;
      ctx = null;
    }
    return ctx;
  }

  /**
   * Must be called from inside a real user gesture (the Start Run tap) or every cue after it is
   * silent with no error anywhere — browsers suspend audio started without one, and a run where
   * the sounds simply never play is a confusing failure to diagnose from across the room.
   */
  async function unlock() {
    const c = ensureContext();
    if (!c) return false;
    if (c.state === 'suspended') {
      try { await c.resume(); } catch (err) { return false; }
    }
    return c.state === 'running';
  }

  function configure(settings) {
    if (!settings) return;
    if (typeof settings.soundEnabled === 'boolean') config.soundEnabled = settings.soundEnabled;
    if (Number.isFinite(settings.soundVolume)) config.soundVolume = clamp(settings.soundVolume, 0, 1);
    if (master) master.gain.value = config.soundVolume;
  }

  // ═══════════════════════ SYNTHESIS PRIMITIVES ═══════════════════════

  /**
   * One decaying oscillator voice.
   *
   * The 2ms attack ramp is not decoration: jumping gain from 0 to full in a single sample is a
   * step discontinuity, and it is audible as a click layered on top of whatever you meant to
   * play. Every envelope point also uses 0.0001 rather than 0, because exponentialRamp to zero
   * is a documented Web Audio error — the curve is undefined at 0.
   *
   * `sweepTo` bends the pitch downward over `sweepTime`. That falling pitch is the entire
   * difference between "a low note" and "something hit the table".
   */
  function voice(c, opts) {
    const at = opts.at;
    const decay = opts.decay;
    const osc = c.createOscillator();
    const gain = c.createGain();

    osc.type = opts.type || 'sine';
    osc.frequency.setValueAtTime(opts.freq, at);
    if (opts.sweepTo) osc.frequency.exponentialRampToValueAtTime(opts.sweepTo, at + (opts.sweepTime || 0.06));

    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, opts.gain), at + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + decay);

    osc.connect(gain).connect(master);
    osc.start(at);
    // Stop slightly past the envelope's end so the node is released rather than left running for
    // the life of the page — a 250-card run schedules a few thousand of these.
    osc.stop(at + decay + 0.02);
  }

  /** A filtered burst of the shared noise buffer — the transient/impact layer. */
  function burst(c, opts) {
    const at = opts.at;
    const decay = opts.decay;
    const src = c.createBufferSource();
    src.buffer = noiseBuffer;

    const filter = c.createBiquadFilter();
    filter.type = opts.filterType;
    filter.frequency.value = opts.cutoff;

    const gain = c.createGain();
    gain.gain.setValueAtTime(Math.max(0.0002, opts.gain), at);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + decay);

    src.connect(filter).connect(gain).connect(master);
    src.start(at);
    src.stop(at + decay + 0.02);
  }

  /**
   * A struck-bell voice: a fundamental plus INHARMONIC partials at 2.76x and 5.4x.
   *
   * Those ratios are the classic approximation of a real bell's modes, and they are the whole
   * trick — stacking integer harmonics (2x, 3x) produces something that reads as an organ or a
   * flute, because integer ratios are what pitched *tonal* instruments produce. Non-integer
   * ratios are what struck metal produces, and metal is what a cash register drawer is made of.
   */
  function bell(c, at, fundamental, gain, decay) {
    voice(c, { type: 'sine', freq: fundamental,        gain: gain,        at: at, decay: decay });
    voice(c, { type: 'sine', freq: fundamental * 2.76, gain: gain * 0.42, at: at, decay: decay * 0.6 });
    voice(c, { type: 'sine', freq: fundamental * 5.40, gain: gain * 0.16, at: at, decay: decay * 0.35 });
  }

  // ═══════════════════════ THE CUES ═══════════════════════
  // Each returns its approximate duration in seconds, so a caller can pace around it if it ever
  // needs to. Times are all relative to a scheduling anchor `t`, never to "now" mid-function —
  // reading currentTime repeatedly inside one cue would let the layers drift apart.

  const CUES = {
    /** KA-CHING — a good card. Metal transient, then two ascending bell strikes (C6 -> G6, a
     *  perfect fifth). Two strikes rather than one because "ka-ching" is heard as two syllables;
     *  a single bell reads as a doorbell, and rising pitch is what makes it read as a reward. */
    kaching: function (c, t) {
      burst(c, { at: t, gain: 0.30, decay: 0.05, filterType: 'highpass', cutoff: 3000 });
      bell(c, t + 0.015, 1046.50, 0.34, 0.45); // C6 — the "ka"
      bell(c, t + 0.105, 1567.98, 0.40, 0.70); // G6 — the "ching", rings longer
      return 0.80;
    },

    /** THUNK — a bulk card. A short lowpassed body-slap plus a triangle whose pitch collapses
     *  165Hz -> 52Hz in 85ms. Deliberately dead and over fast: this is the sound you'll hear a
     *  few hundred times per pile, so anything with a ring or a tail would be unbearable by
     *  card fifty. Its shortness is a feature, not an economy. */
    thunk: function (c, t) {
      burst(c, { at: t, gain: 0.22, decay: 0.06, filterType: 'lowpass', cutoff: 260 });
      voice(c, { type: 'triangle', freq: 165, sweepTo: 52, sweepTime: 0.085, gain: 0.55, at: t, decay: 0.22 });
      return 0.28;
    },

    /** ALERT — the run stalled and needs hands. Three alternating square pulses.
     *  Repetition is the discriminator here, not pitch: it is the only cue that repeats, so it
     *  still reads as "come here" even if you catch only the tail of it from another room. That
     *  matters more than timbre, since the entire point of this feature is walking away. */
    alert: function (c, t) {
      for (let i = 0; i < 3; i++) {
        voice(c, {
          type: 'square', freq: i % 2 === 0 ? 880 : 660,
          gain: 0.14, at: t + i * 0.19, decay: 0.11,
        });
      }
      return 0.60;
    },
  };

  /**
   * Fires a cue. Returns its duration in seconds (0 if nothing played).
   *
   * Never throws and never awaits: a scan loop driving a physical machine must not block on, or
   * be broken by, the audio subsystem. A suspended context is nudged with resume() but not
   * waited on — if it's still suspended this cue is lost, and the next one will play.
   */
  function play(cueName) {
    if (!config.soundEnabled) return 0;
    const c = ensureContext();
    if (!c) return 0;
    const cue = CUES[cueName];
    if (!cue) { console.warn('[audio] unknown cue:', cueName); return 0; }
    if (c.state === 'suspended') c.resume().catch(function () {});
    try {
      // Small lead so the first node is never scheduled in the past, which some browsers
      // interpret as "play immediately" and others drop entirely.
      return cue(c, c.currentTime + 0.01);
    } catch (err) {
      console.warn('[audio] cue failed:', err && err.message ? err.message : err);
      return 0;
    }
  }

  return {
    isSupported: isSupported,
    unlock: unlock,
    configure: configure,
    play: play,
    CUE_NAMES: Object.keys(CUES),
    DEFAULTS: DEFAULTS,
  };
})();
