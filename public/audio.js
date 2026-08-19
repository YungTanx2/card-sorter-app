/**
 * Audio cues for capture-driven runs — the "Phase 2 seam" both mode pages were built around.
 *
 * There are two sound packs, chosen by the `soundPack` setting:
 *
 *   "machine" (default)  The X1PRO's OWN tones, lifted from the vendor's operating-instructions
 *                        page where they're served as base64 M4A for teaching the machine
 *                        ("Sound Learn"). Measured: HIGH VALUE is a pure 2000Hz sine, NORMAL a
 *                        pure 1000Hz sine, both ~0.6s, every other frequency <=4% of peak.
 *                        Exactly one octave apart with no harmonic clutter — about the easiest
 *                        pair a cheap mic plus threshold detector could be asked to separate.
 *   "synth"              Ka-ching / thunk, synthesized here. Nicer to listen to across a
 *                        250-card pile, but NOT what the machine was taught.
 *
 * Which to use is a real decision, not a preference. In Phase 2 the tone stops being operator
 * feedback and becomes the machine's control signal, and a decorative sound layered onto a
 * control tone is exactly the kind of thing that makes a naive detector misfire. Default to the
 * machine's own tones; switch to "synth" only while no machine is listening.
 *
 * Cue names are SEMANTIC (accept / reject / alert) rather than descriptive, because one
 * semantic now maps to two different noises depending on the pack. Each page keeps its own
 * vocabulary on top: the price sorter routes keeper/bulk, Set Builder routes needed/extra.
 *
 * Plain script (not an ESM module) exposing one global, matching capture.js's convention.
 */
window.CardSorterAudio = (function () {
  'use strict';

  const DEFAULTS = { soundEnabled: true, soundVolume: 0.6, soundPack: 'machine' };

  // The vendor's tones, extracted and verified byte-for-byte against the source page.
  const SAMPLES = {
    accept: '/sounds/x1pro-high-value.m4a', // 2000Hz, OLED "HIGH VALUE"
    reject: '/sounds/x1pro-normal.m4a',     // 1000Hz, OLED "NORMAL"
  };

  /**
   * Bump on any change to how the tones load. Surfaced by diagnostics() so a device reporting
   * the wrong pack can be told apart from a device running stale cached JS — the two look
   * identical from the outside, and chasing the wrong one costs a deploy cycle each time.
   */
  const BUILD = '2026-08-18-offline-decode';

  let ctx = null;
  let master = null;
  let noiseBuffer = null;
  let unavailable = false;
  const config = Object.assign({}, DEFAULTS);
  const sampleBuffers = {};   // cue -> decoded AudioBuffer
  const status = {};          // cue -> why it is or isn't usable, for diagnostics()
  let decodeStarted = false;
  let readyPromise = null;

  /**
   * Download AND decode both start at script load, NOT at unlock.
   *
   * Neither step actually needs a gesture — fetching obviously doesn't, and decoding only needs
   * *some* context, which decodeTarget() supplies offline. Tying either to unlock() cost us the
   * same bug twice: the tones were still in flight (or still undecoded) when the first cue fired,
   * play() fell back to synth, and the pack silently disagreed with the setting. In Phase 2 that
   * means the machine hears a ka-ching where it expected 2000Hz and mis-routes the card.
   *
   * The first miss was the first card of a run; the second was every first Sound check click
   * after a page load, which is what an operator naturally tests. whenReady() is still the
   * correct thing to await before either — this just makes it resolve almost immediately.
   */
  const sampleBytes = {};
  Object.keys(SAMPLES).forEach(function (cue) {
    status[cue] = { fetch: 'pending', bytes: 0, decode: 'pending', seconds: 0, error: null };
    sampleBytes[cue] = fetch(SAMPLES[cue])
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + r.statusText);
        return r.arrayBuffer();
      })
      .then(function (ab) {
        status[cue].fetch = 'ok';
        status[cue].bytes = ab.byteLength;
        return ab;
      })
      .catch(function (err) {
        status[cue].fetch = 'failed';
        status[cue].error = String((err && err.message) || err);
        console.warn('[audio] could not fetch machine tone "' + cue + '":', status[cue].error);
        return null;
      });
  });

  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  function AudioCtor() {
    return window.AudioContext || window.webkitAudioContext || null;
  }

  function isSupported() {
    return !!AudioCtor();
  }

  /** One second of white noise, built once and replayed — the percussive body under the synth
   *  pack's cues. Pure oscillators alone read as synthetic chimes; a noise transient is what
   *  makes a sound register as an *impact*. */
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
   * Something that can decode audio, WITHOUT forcing a live AudioContext into existence.
   *
   * An OfflineAudioContext can be constructed with no user gesture and carries none of the
   * autoplay baggage, so the tones can be decoded the instant the page loads rather than waiting
   * for a tap. The AudioBuffers it produces are usable from any context — if its sample rate
   * differs from the live context's, playback resamples them, which preserves pitch.
   *
   * Returns null rather than falling back to ensureContext(): creating the real context here
   * would defeat the lazy construction unlock() depends on.
   */
  function decodeTarget() {
    if (ctx) return ctx;
    const Off = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Off) return null;
    try {
      return new Off(1, 1, 44100);
    } catch (err) {
      return null;
    }
  }

  /**
   * Decodes the already-downloaded tones into AudioBuffers. Idempotent, and safe to call from
   * anywhere. Normally runs at page load via the offline decoder; if this browser has no
   * OfflineAudioContext it returns null and the next unlock() retries it against the live one.
   */
  function preloadSamples() {
    if (decodeStarted) return readyPromise;
    const c = decodeTarget();
    if (!c) return null;
    decodeStarted = true;

    readyPromise = Promise.all(Object.keys(SAMPLES).map(function (cue) {
      return sampleBytes[cue]
        .then(function (ab) {
          if (!ab) { status[cue].decode = 'skipped (no bytes)'; return null; }
          // decodeAudioData detaches the ArrayBuffer it's given, so hand it a copy — otherwise a
          // second decode attempt (a reconnect, a re-unlock) silently gets an empty buffer.
          const p = c.decodeAudioData(ab.slice(0));
          // Safari before 14.1 only had the callback form, which returns undefined. Calling
          // .then() on that would throw and look like a decode failure, so name it as its own
          // outcome — a browser that can't do promise decode needs a different fix than one
          // that can't do AAC.
          if (!p || typeof p.then !== 'function') {
            status[cue].decode = 'failed (callback-only decodeAudioData)';
            return null;
          }
          return p;
        })
        .then(function (buf) {
          if (!buf) return;
          sampleBuffers[cue] = buf;
          status[cue].decode = 'ok';
          status[cue].seconds = Math.round(buf.duration * 1000) / 1000;
        })
        .catch(function (err) {
          status[cue].decode = 'failed';
          status[cue].error = String((err && err.message) || err);
          console.warn('[audio] machine tone "' + cue + '" unusable, falling back to synth:',
            status[cue].error);
        });
    }));
    return readyPromise;
  }

  /**
   * Resolves once the machine tones are decoded and ready (or have definitively failed, in which
   * case the synth pack covers for them). Await this before arming a run so the FIRST card gets
   * the same tone as every other one — never inside the scan loop itself, which must not block
   * on audio.
   */
  function whenReady() {
    return preloadSamples() || Promise.resolve();
  }

  /**
   * Must be called from inside a real user gesture (the Start Run tap) or every cue after it is
   * silent with no error anywhere — browsers suspend audio started without one, and a run where
   * the sounds simply never play is a confusing failure to diagnose from across the room.
   */
  async function unlock() {
    const c = ensureContext();
    if (!c) return false;
    preloadSamples();
    if (c.state === 'suspended') {
      try { await c.resume(); } catch (err) { return false; }
    }
    return c.state === 'running';
  }

  function configure(settings) {
    if (!settings) return;
    if (typeof settings.soundEnabled === 'boolean') config.soundEnabled = settings.soundEnabled;
    if (Number.isFinite(settings.soundVolume)) config.soundVolume = clamp(settings.soundVolume, 0, 1);
    if (settings.soundPack === 'machine' || settings.soundPack === 'synth') config.soundPack = settings.soundPack;
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
   * Those ratios approximate a real bell's modes, and they are the whole trick — stacking
   * integer harmonics (2x, 3x) produces something that reads as an organ or a flute, because
   * integer ratios are what pitched *tonal* instruments produce. Non-integer ratios are what
   * struck metal produces, and metal is what a cash register drawer is made of.
   */
  function bell(c, at, fundamental, gain, decay) {
    voice(c, { type: 'sine', freq: fundamental,        gain: gain,        at: at, decay: decay });
    voice(c, { type: 'sine', freq: fundamental * 2.76, gain: gain * 0.42, at: at, decay: decay * 0.6 });
    voice(c, { type: 'sine', freq: fundamental * 5.40, gain: gain * 0.16, at: at, decay: decay * 0.35 });
  }

  // ═══════════════════════ THE SYNTH PACK ═══════════════════════
  // Each returns its approximate duration in seconds. Times are relative to a scheduling anchor
  // `t`, never to "now" mid-function — reading currentTime repeatedly inside one cue would let
  // the layers drift apart.

  const SYNTH = {
    /** KA-CHING — metal transient, then two ascending bell strikes (C6 -> G6, a perfect fifth).
     *  Two strikes because "ka-ching" is heard as two syllables; a single bell reads as a
     *  doorbell, and the rising pitch is what makes it read as a reward. */
    accept: function (c, t) {
      burst(c, { at: t, gain: 0.30, decay: 0.05, filterType: 'highpass', cutoff: 3000 });
      bell(c, t + 0.015, 1046.50, 0.34, 0.45); // C6 — the "ka"
      bell(c, t + 0.105, 1567.98, 0.40, 0.70); // G6 — the "ching", rings longer
      return 0.80;
    },

    /** THUNK — a lowpassed body-slap plus a triangle whose pitch collapses 165Hz -> 52Hz in
     *  85ms. Deliberately dead and over fast: you'll hear this a few hundred times per pile, so
     *  any ring or tail would be unbearable by card fifty. Its shortness is a feature. */
    reject: function (c, t) {
      burst(c, { at: t, gain: 0.22, decay: 0.06, filterType: 'lowpass', cutoff: 260 });
      voice(c, { type: 'triangle', freq: 165, sweepTo: 52, sweepTime: 0.085, gain: 0.55, at: t, decay: 0.22 });
      return 0.28;
    },

    /** ALERT — the run stalled and needs hands. Three alternating square pulses, and the only
     *  cue in either pack that repeats, so it still reads as "come here" if you catch just the
     *  tail of it from another room. There is no machine equivalent: the X1PRO has no "fetch the
     *  operator" tone, so this one is always synthesized regardless of pack. */
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
   * The measured frequencies of the two vendor tones, so they can be REGENERATED if the sample
   * files can't be used on some device.
   *
   * This matters more than it looks. Falling back from the machine pack to the ka-ching is the
   * worst available failure: in Phase 2 the tone is the machine's control signal, so a device
   * that can't decode AAC would route every card wrongly while sounding perfectly pleasant. A
   * synthesized 2000Hz sine is not a decoration of the real tone — for a threshold detector it
   * IS the real tone, since the vendor's own files are pure sines with <4% of peak anywhere else.
   * So the fallback preserves the function and drops only the exact timbre.
   */
  const MACHINE_HZ = { accept: 2000, reject: 1000 };
  const MACHINE_SECONDS = 0.6;

  /** A flat-topped tone, unlike voice()'s percussive decay — the vendor tones hold steady for
   *  their whole length, and a detector integrating over a window wants that sustain. */
  function steadyTone(c, hz, at, seconds, gain) {
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(hz, at);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + 0.005);
    g.gain.setValueAtTime(gain, at + seconds - 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, at + seconds);
    osc.connect(g).connect(master);
    osc.start(at);
    osc.stop(at + seconds + 0.02);
    return seconds;
  }

  /** Plays a decoded machine tone through the same master gain as the synth pack, so one volume
   *  setting governs both. */
  function playSample(c, buf, t) {
    const src = c.createBufferSource();
    src.buffer = buf;
    src.connect(master);
    src.start(t);
    return buf.duration;
  }

  /**
   * Fires a cue: 'accept', 'reject' or 'alert'. Returns its duration in seconds (0 if nothing
   * played).
   *
   * Never throws and never awaits. A suspended context is nudged with resume() but not waited
   * on — if it's still suspended this cue is lost and the next one will play, which is a far
   * better failure than a scan loop blocked on audio.
   */
  function play(cue) {
    if (!config.soundEnabled) return 0;
    const c = ensureContext();
    if (!c) return 0;
    if (c.state === 'suspended') c.resume().catch(function () {});
    preloadSamples();

    // Small lead so the first node is never scheduled in the past, which some browsers treat as
    // "play immediately" and others drop entirely.
    const t = c.currentTime + 0.01;

    try {
      if (config.soundPack === 'machine') {
        if (sampleBuffers[cue]) return playSample(c, sampleBuffers[cue], t);
        // Sample unusable on this device — regenerate the frequency rather than dropping to a
        // sound the machine was never taught. See MACHINE_HZ.
        if (MACHINE_HZ[cue]) return steadyTone(c, MACHINE_HZ[cue], t, MACHINE_SECONDS, 0.5);
      }
      const fn = SYNTH[cue];
      if (!fn) { console.warn('[audio] unknown cue:', cue); return 0; }
      return fn(c, t);
    } catch (err) {
      console.warn('[audio] cue failed:', err && err.message ? err.message : err);
      return 0;
    }
  }

  /** Which pack a given cue would actually use right now — the Sound check panel reports this,
   *  since "machine" silently degrades to synth until the samples finish decoding. */
  function packFor(cue) {
    if (config.soundPack === 'machine' && cue !== 'alert') {
      if (sampleBuffers[cue]) return 'machine';
      // Right frequency, wrong timbre — correct for the machine, audibly a plain beep. Named
      // distinctly so "the sample didn't load" never hides behind a green-looking report.
      if (MACHINE_HZ[cue]) return 'machine-synthesized (' + MACHINE_HZ[cue] + 'Hz)';
    }
    return 'synth';
  }

  /**
   * Everything needed to explain why a given device is on a given pack, in one object.
   *
   * Exists because "the phone plays synth, the laptop plays machine" has several causes that are
   * indistinguishable from the outside — stale cached JS, a browser with no OfflineAudioContext,
   * a browser that can't decode AAC, or a fetch that 404'd — and each wants a different fix.
   * `build` settles the stale-cache question on its own.
   */
  function diagnostics() {
    const Off = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const cues = {};
    Object.keys(status).forEach(function (cue) {
      cues[cue] = Object.assign({ playsAs: packFor(cue) }, status[cue]);
    });
    return {
      build: BUILD,
      soundPack: config.soundPack,
      soundEnabled: config.soundEnabled,
      offlineAudioContext: !!Off,
      liveAudioContext: !!AudioCtor(),
      decodeStarted: decodeStarted,
      contextState: ctx ? ctx.state : 'not created',
      contextSampleRate: ctx ? ctx.sampleRate : null,
      cues: cues,
      userAgent: navigator.userAgent,
    };
  }

  // Decode now, while the page is still loading and nothing is waiting on it.
  preloadSamples();

  return {
    isSupported: isSupported,
    diagnostics: diagnostics,
    unlock: unlock,
    configure: configure,
    whenReady: whenReady,
    play: play,
    packFor: packFor,
    CUE_NAMES: ['accept', 'reject', 'alert'],
    DEFAULTS: DEFAULTS,
  };
})();
