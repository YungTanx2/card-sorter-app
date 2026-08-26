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
 * Cue names are SEMANTIC (accept / reject / alert / done) rather than descriptive, because one
 * semantic now maps to two different noises depending on the pack. Each page keeps its own
 * vocabulary on top: the price sorter routes keeper/bulk, Set Builder routes needed/extra.
 *
 * Plain script (not an ESM module) exposing one global, matching capture.js's convention.
 */
window.CardSorterAudio = (function () {
  'use strict';

  const DEFAULTS = {
    soundEnabled: true, soundVolume: 0.6, soundPack: 'machine',
    // Defaults for the "tones" pack — see TONES and resonanceRisk() below for why these numbers.
    toneAcceptHz: 1750, toneRejectHz: 1100, toneDurationMs: 600, toneRampMs: 60,
  };

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
  const BUILD = '2026-08-26-resonance-clear';

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
    if (PACKS.indexOf(settings.soundPack) >= 0) config.soundPack = settings.soundPack;
    // Clamped to a range a phone speaker can actually produce and a small mic can hear: below
    // ~300Hz a micro-speaker has essentially no output, above ~5kHz you are fighting hiss.
    if (Number.isFinite(settings.toneAcceptHz)) config.toneAcceptHz = clamp(settings.toneAcceptHz, 300, 5000);
    if (Number.isFinite(settings.toneRejectHz)) config.toneRejectHz = clamp(settings.toneRejectHz, 300, 5000);
    if (Number.isFinite(settings.toneDurationMs)) config.toneDurationMs = clamp(settings.toneDurationMs, 120, 3000);
    // Upper bound is a third of the tone so a long ramp can never eat the steady-state section
    // the detector is supposed to measure; steadyTone() clamps again for the same reason.
    if (Number.isFinite(settings.toneRampMs)) config.toneRampMs = clamp(settings.toneRampMs, 5, 250);
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

    /** DONE — the set closed and the run stopped itself. A rising G4-C5-E5 arpeggio with a bell
     *  on the last note, so it reads as an ending rather than another card going by.
     *
     *  Every partial sits below 660Hz, deliberately clear of the 1000/2000Hz the machine listens
     *  for. This cue plays into the same room as the X1PRO's microphone, and a sound straying
     *  into either detection band would route a card nobody scanned. That rules out bell() here
     *  despite it being the nicer timbre: its 2.76x partial on an E5 lands at 1819Hz, close
     *  enough to the 2000Hz accept tone to be a real risk. Plain sines only. Like `alert` it is
     *  always synthesized — the vendor has no "finished" tone. */
    done: function (c, t) {
      voice(c, { type: 'sine', freq: 392.00, gain: 0.30, at: t,        decay: 0.22 }); // G4
      voice(c, { type: 'sine', freq: 523.25, gain: 0.32, at: t + 0.11, decay: 0.24 }); // C5
      voice(c, { type: 'sine', freq: 659.25, gain: 0.36, at: t + 0.22, decay: 0.75 }); // E5, rings
      return 1.00;
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

  /**
   * ═══ THE "tones" PACK — steady, non-harmonic, operator-tunable ═══
   *
   * Built after Sound Learn rejected BOTH other packs as "too close", the vendor's own tones
   * being the worse of the two. Two things were wrong, and this pack fixes both.
   *
   * 1. A cue must measure the same no matter WHEN it is sampled. The synth ka-ching is six
   *    oscillators starting at two different times and decaying at six different rates, so
   *    "what frequency is this?" answers ~3000Hz, then 1047Hz, then 1568Hz over its life.
   *    Sound Learn samples a short window, so repeated presses of one button measured different
   *    things and classified randomly. A steady sine has no such phase.
   *
   * 2. The two cues must not be HARMONICALLY RELATED. The vendor pair is 1000 and 2000Hz —
   *    exactly an octave, which is the single worst choice available here. A phone speaker at
   *    volume runs several percent THD dominated by the 2nd harmonic, so playing 1000Hz makes
   *    the speaker itself emit 2000Hz: the NORMAL tone physically contains the HIGH VALUE tone.
   *    Octave errors are also the classic failure of autocorrelation pitch detection, and Sound
   *    Learn must use something general since it learns arbitrary sounds.
   *
   * The defaults are DTMF frequencies (941 and 1477Hz), chosen because the DTMF set was designed
   * so no frequency is an integer multiple of another — precisely to survive harmonic distortion
   * in cheap hardware. 2 x 941 = 1882Hz, a long way from 1477Hz.
   *
   * Frequencies are SETTINGS, not constants: two successive frequency recommendations were
   * refuted by this rig, so retuning must not require a deploy. harmonicRisk() below guards the
   * one mistake that is easy to make when retuning.
   */
  const TONES = {
    accept: function (c, t) { return steadyTone(c, config.toneAcceptHz, t, config.toneDurationMs / 1000, 0.5, config.toneRampMs / 1000); },
    reject: function (c, t) { return steadyTone(c, config.toneRejectHz, t, config.toneDurationMs / 1000, 0.5, config.toneRampMs / 1000); },
  };

  const PACKS = ['machine', 'synth', 'tones'];

  /**
   * Whether two cue frequencies are close to a simple integer ratio, i.e. whether speaker
   * distortion of one will land on the other. Returns null when the pair is safe.
   *
   * Encoded rather than left to judgement because this is exactly the trap the vendor pair fell
   * into, and it is invisible until a machine refuses to learn the pair.
   */
  /**
   * Flags a tone sitting in the phone micro-speaker's mechanical resonance band.
   *
   * WHY THIS EXISTS — it is the check whose absence caused the 941Hz reject tone to be
   * misdetected. harmonicRisk() compares the two tones to EACH OTHER, but the speaker itself is a
   * third frequency in the system, and neither tone was ever checked against it.
   *
   * A micro-speaker driven from rest does not instantly radiate a pure sine. The cone accelerates,
   * and that onset transient rings near the driver's resonance (~600-900Hz) regardless of which
   * frequency was requested. So EVERY cue begins with a burst of energy in that band. Put a cue
   * there and the machine's detector, if it latches early, hears the transient rather than the
   * tone — and it hears it on both cues.
   *
   * The observed symptom was exactly this and, tellingly, ASYMMETRIC: accept was misheard as
   * reject, never the reverse, because the transient always resembles the low tone no matter which
   * cue is playing. A "the tones are too close together" fault would fail in both directions.
   *
   * 1000Hz rather than 900 as the floor: the resonance has a skirt, and the point is to keep cues
   * clear of it rather than to sit just outside.
   */
  function resonanceRisk(hz) {
    if (hz >= 1000) return null;
    return Math.round(hz) + 'Hz is in the speaker resonance band (~600-900Hz) — the onset '
      + 'transient of every cue rings here, so an early-latching detector hears this tone on BOTH cues';
  }

  function harmonicRisk(a, b) {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const ratios = [[2, 1], [3, 1], [4, 1], [3, 2], [4, 3], [5, 2], [5, 3], [5, 4]];
    for (let i = 0; i < ratios.length; i++) {
      const n = ratios[i][0];
      const d = ratios[i][1];
      const target = (lo * n) / d;
      // 3% window: wide enough to catch a pair that distortion will smear together, narrow
      // enough not to condemn genuinely unrelated frequencies.
      if (Math.abs(hi - target) / target < 0.03) {
        return n + ':' + d + ' — distortion of ' + Math.round(lo) + 'Hz lands on ' + Math.round(hi) + 'Hz';
      }
    }
    return null;
  }

  /**
   * A flat-topped tone, unlike voice()'s percussive decay — a detector integrating over a window
   * wants sustain, and the whole point of the tones pack is that every sampling instant measures
   * the same thing.
   *
   * `ramp` is the fade in/out, and it is not cosmetic. Switching a sine on abruptly is a step
   * discontinuity, which is broadband in the frequency domain — it sprays energy across the
   * spectrum including wherever the OTHER cue lives. A 25ms ramp keeps the cue spectrally clean;
   * 5ms is fine for the vendor-tone fallback, which only needs to be recognisable.
   */
  function steadyTone(c, hz, at, seconds, gain, ramp) {
    const r = Math.min(ramp || 0.005, seconds / 3);
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(hz, at);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + r);
    g.gain.setValueAtTime(gain, at + seconds - r);
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
      if (config.soundPack === 'tones' && TONES[cue]) return TONES[cue](c, t);
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
    if (config.soundPack === 'tones' && TONES[cue]) {
      const hz = cue === 'accept' ? config.toneAcceptHz : config.toneRejectHz;
      return 'tones (' + Math.round(hz) + 'Hz)';
    }
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
    harmonicRisk: harmonicRisk,
    resonanceRisk: resonanceRisk,
    toneConfig: function () {
      return {
        pack: config.soundPack,
        acceptHz: config.toneAcceptHz,
        rejectHz: config.toneRejectHz,
        durationMs: config.toneDurationMs,
        rampMs: config.toneRampMs,
        ratio: Math.round((Math.max(config.toneAcceptHz, config.toneRejectHz)
          / Math.min(config.toneAcceptHz, config.toneRejectHz)) * 1000) / 1000,
        risk: harmonicRisk(config.toneAcceptHz, config.toneRejectHz),
        // Reported per cue: unlike harmonics, this is a property of ONE frequency, not the pair.
        resonance: resonanceRisk(config.toneRejectHz) || resonanceRisk(config.toneAcceptHz),
      };
    },
    PACKS: PACKS,
    CUE_NAMES: ['accept', 'reject', 'alert', 'done'],
    DEFAULTS: DEFAULTS,
  };
})();
