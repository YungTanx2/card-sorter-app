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
 *   "synth"              Ka-ching / low gong, synthesized here. Nicer to listen to across a
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
    // Defaults for the "tones" pack — see TONES, resonanceRisk() and levelRisk() for the numbers.
    // 941/1477 is the ONE pair Sound Learn has ever accepted on this rig; 80ms is a real 80ms now
    // that the fade is a raised cosine. ACCEPT IS THE LOWER TONE ON PURPOSE — see levelRisk().
    toneAcceptHz: 941, toneRejectHz: 1477, toneDurationMs: 600, toneRampMs: 80,
    // Per-cue level and length, because the speaker's output is not flat and the two cues do not
    // arrive at the machine's microphone equally loud even though they leave here equally loud.
    toneAcceptGain: 0.40, toneRejectGain: 0.80,
    toneAcceptMs: 600, toneRejectMs: 600,
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
  const BUILD = '2026-08-28-gong-reject';

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
    if (Number.isFinite(settings.toneAcceptMs)) config.toneAcceptMs = clamp(settings.toneAcceptMs, 120, 3000);
    if (Number.isFinite(settings.toneRejectMs)) config.toneRejectMs = clamp(settings.toneRejectMs, 120, 3000);
    // Floor of 0.05 rather than 0: a cue trimmed to silence is a card the machine never routes,
    // and it would look identical to the audio being broken.
    if (Number.isFinite(settings.toneAcceptGain)) config.toneAcceptGain = clamp(settings.toneAcceptGain, 0.05, 1);
    if (Number.isFinite(settings.toneRejectGain)) config.toneRejectGain = clamp(settings.toneRejectGain, 0.05, 1);
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
   *
   * `attack` delays the peak. It defaults to that same 2ms click-guard, but gong() sets it as
   * high as 180ms per partial, which is how a struck plate BLOOMS: the upper modes are barely
   * present at the instant of contact and swell in afterwards as the strike energy couples into
   * them. Note that the exponential rise is heavily back-loaded — scheduleFlatEnvelope() below
   * measures it sitting at 1.4% of full amplitude halfway through — and here that is exactly the
   * shape wanted, a partial that stays out of the way and then rushes in.
   */
  function voice(c, opts) {
    const at = opts.at;
    const decay = opts.decay;
    // Never let the swell outlast the note it belongs to; a bloom longer than the decay would
    // schedule the release before the peak and the partial would simply never sound.
    const attack = Math.min(Math.max(opts.attack || 0.002, 0.002), decay * 0.6);
    const osc = c.createOscillator();
    const gain = c.createGain();

    osc.type = opts.type || 'sine';
    osc.frequency.setValueAtTime(opts.freq, at);
    if (opts.sweepTo) osc.frequency.exponentialRampToValueAtTime(opts.sweepTo, at + (opts.sweepTime || 0.06));

    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, opts.gain), at + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);

    osc.connect(gain).connect(master);
    osc.start(at);
    // Stop slightly past the envelope's end so the node is released rather than left running for
    // the life of the page — a 250-card run schedules a few thousand of these.
    osc.stop(at + attack + decay + 0.02);
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

  /**
   * The gong's mode stack: [ratio, level, decay scale, bloom scale].
   *
   * A bell and a gong are both struck metal, so why not just call bell() an octave down? Because
   * three partials is a bell and seven is a plate. bell()'s 2.76x / 5.40x pair is the classic
   * minor-third BELL spectrum — sparse, and sparse enough that the ear locks onto a definite
   * pitch. A gong is a large flat disc with many closely-spaced modes, so it reads as a
   * *sonority* rather than a note, and thinning it out is what makes cheap synth gongs sound
   * like doorbells.
   *
   * The ratios are deliberately irregular and deliberately NOT integers — 2.07 rather than 2.00,
   * because a clean octave partial is what turns struck metal into an organ stop. Two of them
   * (2.76x, 5.40x-adjacent) are inherited from bell() so the pack keeps a family resemblance.
   *
   * The bloom column is the identifying feature. On a real gong the high modes are almost absent
   * at the instant of contact and swell in over the following fraction of a second as the strike
   * energy couples upward through the plate. Take the bloom away and you have a bell; that one
   * column is most of the difference.
   *
   * ═══ EVERY PARTIAL IS BELOW 700Hz, AND THAT IS A CONSTRAINT, NOT AN ACCIDENT ═══
   *
   * Same rule the `done` cue documents: this pack plays into the same room as the X1PRO's
   * microphone, so nothing here may stray near a frequency the machine listens for. The top
   * partial lands at 619Hz against an accept cue at 941Hz — a 34% margin, wider than the 3%
   * window harmonicRisk() considers dangerous. `synth` is still a no-machine-listening pack for
   * the reasons in the header, but a decorative cue should not be the thing that breaks that.
   */
  const GONG_MODES = [
    // ratio  level  decay  bloom
    [1.00,    1.00,  1.00,  0.00],
    [1.52,    0.55,  0.72,  0.18],
    [2.07,    0.42,  0.60,  0.30],
    [2.76,    0.34,  0.48,  0.45],
    [3.71,    0.24,  0.34,  0.65],
    [4.86,    0.16,  0.24,  0.85],
    [6.32,    0.10,  0.21,  1.00],
  ];

  /**
   * How far the doubled partials are detuned, as a fraction. At these frequencies it produces
   * beats of roughly 1-2Hz — about one slow pulse over the cue's life, which is the difference
   * between metal and a synth pad. A real gong is never perfectly circular and its modes are
   * never exactly degenerate; this is that asymmetry, faked.
   */
  const GONG_DETUNE = 0.007;

  /** A struck gong. `decay` is the fundamental's ring; every mode scales off it. */
  function gong(c, at, fundamental, gain, decay, bloom) {
    for (let i = 0; i < GONG_MODES.length; i++) {
      const ratio = GONG_MODES[i][0];
      const level = GONG_MODES[i][1];
      const hz = fundamental * ratio;
      voice(c, {
        type: 'sine', freq: hz, gain: gain * level, at: at,
        decay: decay * GONG_MODES[i][2], attack: bloom * GONG_MODES[i][3],
      });
      // Doubling only the low-mid modes: up top the partials are quiet and short enough that a
      // beat never completes, so the extra oscillators would cost nodes and buy nothing.
      if (i >= 1 && i <= 3) {
        voice(c, {
          type: 'sine', freq: hz * (1 + GONG_DETUNE), gain: gain * level * 0.5, at: at,
          decay: decay * GONG_MODES[i][2] * 0.85, attack: bloom * GONG_MODES[i][3],
        });
      }
    }
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

    /**
     * LOW GONG — a soft-mallet thud, then a G2 plate blooming underneath it.
     *
     * Replaces a 0.28s thunk, and the tradeoff is worth stating plainly: the thunk's whole design
     * argument was that you hear this cue a few hundred times per pile, so anything with a tail
     * would be unbearable by card fifty. A gong is nothing but tail. Three things keep it from
     * becoming that:
     *
     *   - It is SHORT FOR A GONG. The fundamental rings 1.5s where a real one goes 20s, and the
     *     bright modes are gone inside half a second, so what is left after ~0.6s is a quiet low
     *     hum rather than a sound competing for attention.
     *   - It is DARK. Everything is under 620Hz and most of the energy is under 300Hz, so it sits
     *     in a band the ka-ching does not use at all. Alternating the two reads as two different
     *     objects rather than two settings of one instrument.
     *   - It is QUIET where it lasts. The long modes are the low ones and they carry the least
     *     level, so the tail decays out of notice well before it decays into silence.
     *
     * ═══ WHY 98Hz WHEN THE HEADER SAYS THE SPEAKER DIES BELOW 300Hz ═══
     *
     * It does, and the fundamental will be largely inaudible on a phone. That is fine and is the
     * reason for seven modes rather than three: 149, 203, 270 and 364Hz all radiate, they are
     * spaced as the partials OF a 98Hz plate, and the ear supplies the missing fundamental from
     * that spacing. The cue reads as low even on hardware that cannot produce the low note. On a
     * laptop or a desk speaker the real 98Hz arrives too and it simply gets weightier.
     *
     * G2 also puts it exactly two octaves under the `done` cue's opening G4, so the pack has one
     * tonal centre rather than three unrelated ones.
     *
     * ═══ THE RETURN VALUE IS SHORTER THAN THE SOUND, DELIBERATELY ═══
     *
     * ToneEmitter waits `max(toneSettleMs, returned + 150ms)` before re-arming, so this number
     * directly lengthens the run loop — returning the true 1.5s acoustic length would add ~850ms
     * to every bulk card, which is over three minutes on a 250-card pile, to protect a tail
     * nothing is listening to. What must not be interrupted is the part that carries the
     * DECISION, and that is over once the bloom has peaked and started down. So 0.65s, which is
     * under the 800ms settle and therefore costs the loop nothing. The tail rings on into the
     * next card's cue, which is what a gong does anyway.
     *
     * This is only safe because `synth` is a no-machine-listening pack (see the header). The
     * tones pack returns its honest full length and must keep doing so.
     */
    reject: function (c, t) {
      // Soft mallet, not a stick: lowpassed hard and gone in 90ms. It exists to give the strike
      // a physical contact point — without it the gong fades in and reads as a synth swell.
      burst(c, { at: t, gain: 0.26, decay: 0.09, filterType: 'lowpass', cutoff: 420 });
      // 0.28 against the ka-ching's 0.34-0.40 looks like the gong is louder than it is. It is
      // not: equal-loudness contours mean a tone near 100Hz needs roughly 20dB more amplitude
      // than one near 1kHz to be heard as equally loud, and the ka-ching lives at 1046/1568Hz
      // where the ear is at its most sensitive. Matching the numbers would leave the gong
      // sounding markedly weaker than the cue it alternates with. Most of the perceived level
      // comes from the 203-476Hz modes, which need less compensation than the fundamental does.
      gong(c, t, 98.00, 0.28, 1.50, 0.18); // G2
      return 0.65;
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
  /** Per-cue length, falling back to the shared toneDurationMs when no override is set. */
  function cueSeconds(cue) {
    const per = cue === 'accept' ? config.toneAcceptMs : config.toneRejectMs;
    return (Number.isFinite(per) && per > 0 ? per : config.toneDurationMs) / 1000;
  }

  /** Per-cue level. See levelRisk() for why these are not equal. */
  function cueGain(cue) {
    return cue === 'accept' ? config.toneAcceptGain : config.toneRejectGain;
  }

  const TONES = {
    accept: function (c, t) {
      return steadyTone(c, config.toneAcceptHz, t, cueSeconds('accept'), cueGain('accept'),
        config.toneRampMs / 1000);
    },
    reject: function (c, t) {
      return steadyTone(c, config.toneRejectHz, t, cueSeconds('reject'), cueGain('reject'),
        config.toneRampMs / 1000);
    },
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
   * A raised-cosine onset at least this long is taken to suppress the resonance transient, which
   * makes a tone inside the band usable again. See resonanceRisk().
   */
  const RESONANCE_SAFE_RAMP_MS = 60;

  /**
   * Flags a tone sitting in the phone micro-speaker's mechanical resonance band — but only when
   * the onset is abrupt enough for that band to matter.
   *
   * WHY THIS EXISTS — harmonicRisk() compares the two tones to EACH OTHER, but the speaker is a
   * third frequency in the system and neither tone was ever checked against it. A micro-speaker
   * driven from rest does not instantly radiate a pure sine: the cone accelerates, and that onset
   * transient rings near the driver's resonance (~600-900Hz) whatever frequency was requested. So
   * every cue begins with a burst of energy in that band, and a detector that latches early hears
   * the transient rather than the tone — on BOTH cues.
   *
   * The observed symptom matched, and was tellingly ASYMMETRIC: accept misheard as reject, never
   * the reverse, because the transient resembles the low tone no matter which cue is playing. A
   * "the two tones are too close together" fault would fail in both directions.
   *
   * ═══ WHY IT NOW DEPENDS ON THE RAMP ═══
   *
   * The first version of this guard flagged any cue below 1000Hz unconditionally, and that
   * recommendation steered the rig OFF 941Hz. The Sound Learn results then said the opposite of
   * what the guard assumed:
   *
   *     1000/2000   low tone at the band edge   REJECTED (also an octave — two faults)
   *     941/1477    low tone INSIDE the band    ACCEPTED
   *     1100/1750   low tone clear of the band  REJECTED
   *
   * The likeliest reading is that the band cuts both ways: resonance amplifies the low cue, which
   * makes it loud and easy to CHARACTERISE at teaching time, while the same amplification is what
   * contaminates the high cue's onset at detection time. One mechanism, both symptoms. Avoiding
   * the band therefore trades teachability for something a gentle onset gives you for free.
   *
   * So the mitigation is the envelope, not the frequency, and the risk is conditional on it.
   * The threshold assumes the raised-cosine envelope in scheduleFlatEnvelope() — under the old
   * exponential ramp a nominal 60ms was an effective 15ms and would not have earned this pass.
   * That is why the curve change and the return to 941/1477 shipped together.
   *
   * Called with no ramp, it assumes the worst and flags, so an unqualified frequency check keeps
   * its old meaning.
   */
  function resonanceRisk(hz, rampMs) {
    if (hz >= 1000) return null;
    if (Number.isFinite(rampMs) && rampMs >= RESONANCE_SAFE_RAMP_MS) return null;
    return Math.round(hz) + 'Hz is in the speaker resonance band (~600-900Hz) and the '
      + (Number.isFinite(rampMs) ? Math.round(rampMs) + 'ms' : 'current')
      + ' onset is too abrupt to suppress the transient — an early-latching detector will hear '
      + 'this tone on BOTH cues. Raise toneRampMs to at least ' + RESONANCE_SAFE_RAMP_MS + 'ms.';
  }

  /**
   * Flags a configuration where the HIGHER-frequency cue is not the louder one.
   *
   * ═══ THE THIRD GUARD, AND THE ONE THE RIG ACTUALLY NEEDED ═══
   *
   * harmonicRisk() asks whether the two cues can be told apart. resonanceRisk() asks whether the
   * onset is clean. Neither asks the question that every observed failure has actually turned on:
   * IS EACH CUE LOUD ENOUGH AT THE MICROPHONE TO BE DETECTED AT ALL?
   *
   * The full failure record on this rig, over five configurations:
   *
   *     accept  reject   teaches?   in-run
   *      2000    1000      no         -
   *      1750    1100      no         -
   *      1750    1100      no         -        (ramp 25 as well as 60)
   *      1477     941     yes        occasional dropout on the ACCEPT cue
   *      1477     941     yes        occasional dropout on the ACCEPT cue  (80ms raised cosine)
   *
   * Every failure, teaching and detection alike, is a failure to hear the HIGH tone. Nothing has
   * ever gone wrong with the low one, and the in-run error has never once gone the other way. A
   * "the two tones are too similar" fault would be symmetric; this is not a discrimination problem
   * at all, it is a detectability problem on one specific cue. That is why four rounds of
   * frequency-pair tuning changed nothing: separation was never the variable.
   *
   * Four effects all push the same direction:
   *   - a micro-speaker's output falls off steeply above its resonance, and 941Hz sits IN that
   *     resonance while 1477Hz is well past it;
   *   - 941Hz's harmonics (1882, 2823Hz) land in-band, giving it a rich spectral signature, while
   *     1477Hz's (2954, 4431Hz) are at or past the edge of what the speaker radiates — the high cue
   *     arrives as a lone thin peak;
   *   - a cheap electret mic with AGC rolls off high too;
   *   - so an unsure detector falls toward the better-characterised template, which is always 941.
   *
   * The compensation is per-cue GAIN, and it belongs to the FREQUENCY, not to the semantic cue.
   * Swap which tone carries which decision and the gains must swap with them, or the boost lands on
   * the cue that never needed it. That mistake is invisible from the settings screen, which is why
   * it is a guard rather than a comment.
   */
  function levelRisk(acceptHz, acceptGain, rejectHz, rejectGain) {
    if (acceptHz === rejectHz) return null;
    const acceptIsHigh = acceptHz > rejectHz;
    const highGain = acceptIsHigh ? acceptGain : rejectGain;
    const lowGain = acceptIsHigh ? rejectGain : acceptGain;
    if (!Number.isFinite(highGain) || !Number.isFinite(lowGain)) return null;
    if (highGain > lowGain) return null;
    return 'the higher cue (' + Math.round(acceptIsHigh ? acceptHz : rejectHz) + 'Hz, '
      + (acceptIsHigh ? 'accept' : 'reject') + ') is at gain ' + highGain + ' but the lower one is '
      + 'at ' + lowGain + ' — the speaker radiates less as frequency rises, so the high cue reaches '
      + 'the machine weakest and is the one it drops. Give the higher tone the higher gain.';
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
   * Number of points in a fade curve. Web Audio interpolates LINEARLY between them, so this is
   * how finely the smooth curve is approximated — at the 80ms default that is ~0.6ms per segment,
   * far below anything a speaker cone can follow.
   */
  const RAMP_POINTS = 128;

  /**
   * A raised-cosine (Hann) fade from `from` to `to`, as a Web Audio value curve.
   *
   * Cached because gain is the same 0.5 on every cue, so a 250-card run reuses two arrays instead
   * of allocating a few thousand.
   */
  const curveCache = {};
  function raisedCosine(from, to) {
    const key = from + '>' + to;
    if (curveCache[key]) return curveCache[key];
    const curve = new Float32Array(RAMP_POINTS);
    for (let i = 0; i < RAMP_POINTS; i++) {
      const x = i / (RAMP_POINTS - 1);
      curve[i] = from + (to - from) * 0.5 * (1 - Math.cos(Math.PI * x));
    }
    curveCache[key] = curve;
    return curve;
  }

  /**
   * Schedules the flat-topped envelope: fade up over `r`, hold, fade down over `r`.
   *
   * ═══ WHY THIS IS A CURVE AND NOT exponentialRampToValueAtTime ═══
   *
   * It used to be an exponential ramp from 0.0001 to `gain`, and that quietly defeated the entire
   * purpose of having a ramp setting. An exponential is violently back-loaded: over a factor of
   * 5000 it sits at 1.4% of full amplitude at the ramp's HALFWAY point and then rushes. Measured
   * on the shipped envelope:
   *
   *     nominal ramp   effective 10-90% rise   peak slope vs. an equivalent linear fade
   *         25ms              6.4ms                        8.5x
   *         60ms             15.5ms                        8.5x
   *
   * So `toneRampMs` was delivering about a quarter of the fade it advertised, and raising it
   * 25 -> 60ms — a change made specifically to stop the machine latching onto the onset — bought
   * only 9ms of real softening. Four tone-pair trials were spent tuning frequencies while the
   * variable that actually governs the onset was throttled by a hardcoded curve type.
   *
   * A raised cosine has ZERO SLOPE AT BOTH ENDS, which is the property that matters: the speaker
   * cone is never asked to accelerate from rest, so it has far less reason to ring at its own
   * mechanical resonance (~600-900Hz). That ring is the same signal on BOTH cues — it belongs to
   * the driver, not the tone — which is why an early-latching detector confuses them, and why the
   * observed failure was asymmetric (accept heard as reject, never the reverse).
   *
   * Peak slope, gain 0.5: exponential@25ms 170/s, linear@25ms 20/s, raised-cosine@80ms 9.8/s.
   *
   * NOTE this is a hypothesis about hardware nobody here has put a microphone to. If the misroutes
   * survive a genuinely gentle onset, the transient is not the mechanism and the next step is to
   * record both cues off the phone speaker and look at the first 50ms rather than reason about it.
   */
  function scheduleFlatEnvelope(param, at, seconds, gain, r) {
    // setValueCurveAtTime throws if two curves overlap on one param. steadyTone() clamps r to
    // seconds/3, so the attack always ends before the release begins — but the two spans are
    // scheduled adjacently here to keep that precondition visible in one place.
    if (typeof param.setValueCurveAtTime === 'function') {
      try {
        param.setValueCurveAtTime(raisedCosine(0, gain), at, r);
        param.setValueCurveAtTime(raisedCosine(gain, 0), at + seconds - r, r);
        return 'curve';
      } catch (err) {
        // Half-scheduled automation would collide with the fallback below, so clear it first.
        if (typeof param.cancelScheduledValues === 'function') {
          try { param.cancelScheduledValues(at); } catch (e) { /* nothing more to do */ }
        }
        console.warn('[audio] value-curve envelope rejected, using a linear fade:',
          err && err.message ? err.message : err);
      }
    }
    // Linear, deliberately NOT exponential. It keeps a slope discontinuity at each corner, so it
    // is the worse option — but it still honours `r` literally, which is the whole point.
    param.setValueAtTime(0, at);
    param.linearRampToValueAtTime(gain, at + r);
    param.setValueAtTime(gain, at + seconds - r);
    param.linearRampToValueAtTime(0, at + seconds);
    return 'linear';
  }

  /**
   * A flat-topped tone, unlike voice()'s percussive decay — a detector integrating over a window
   * wants sustain, and the whole point of the tones pack is that every sampling instant measures
   * the same thing.
   *
   * The frequency is set once and never swept, so there is no pitch startup: sample one is already
   * the requested tone. All of the "startup" lives in the amplitude envelope, which is why
   * scheduleFlatEnvelope() carries the long explanation.
   */
  function steadyTone(c, hz, at, seconds, gain, ramp) {
    const r = Math.min(ramp || 0.005, seconds / 3);
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(hz, at);
    // A GainNode defaults to 1. The oscillator does not start until `at` and the envelope takes
    // over at the same instant, but leaving the default in place means any scheduling slop is a
    // full-volume click rather than silence.
    g.gain.value = 0;
    scheduleFlatEnvelope(g.gain, at, seconds, gain, r);
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
    levelRisk: levelRisk,
    toneConfig: function () {
      return {
        pack: config.soundPack,
        acceptHz: config.toneAcceptHz,
        rejectHz: config.toneRejectHz,
        durationMs: config.toneDurationMs,
        rampMs: config.toneRampMs,
        acceptGain: config.toneAcceptGain,
        rejectGain: config.toneRejectGain,
        acceptMs: Math.round(cueSeconds('accept') * 1000),
        rejectMs: Math.round(cueSeconds('reject') * 1000),
        // The guard that matters on this rig: every failure so far has been the high cue arriving
        // too weak, never the two cues being confusable.
        level: levelRisk(config.toneAcceptHz, config.toneAcceptGain,
          config.toneRejectHz, config.toneRejectGain),
        ratio: Math.round((Math.max(config.toneAcceptHz, config.toneRejectHz)
          / Math.min(config.toneAcceptHz, config.toneRejectHz)) * 1000) / 1000,
        risk: harmonicRisk(config.toneAcceptHz, config.toneRejectHz),
        // Reported per cue: unlike harmonics, this is a property of ONE frequency, not the pair —
        // and of the ramp, since a gentle onset is what makes the band survivable.
        resonance: resonanceRisk(config.toneRejectHz, config.toneRampMs)
          || resonanceRisk(config.toneAcceptHz, config.toneRampMs),
      };
    },
    PACKS: PACKS,
    CUE_NAMES: ['accept', 'reject', 'alert', 'done'],
    DEFAULTS: DEFAULTS,
  };
})();
