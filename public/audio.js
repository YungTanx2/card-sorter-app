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
 *   "synth"              A double woodblock knock for accept, a low ringing bell for reject.
 *                        Nicer across a 250-card pile, and this rig HAS taught Sound Learn on
 *                        it — in which case these cues become the templates and the tone
 *                        settings stop applying. Everything sits between 300 and 941Hz; see
 *                        lowBell() for the nine-configuration log that got here.
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
    soundEnabled: true, soundVolume: 1, soundPack: 'synth',
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
  const BUILD = '2026-08-29-validated-defaults';

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
   * means the machine hears a decorative knock where it expected 2000Hz and mis-routes the card.
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
   * `attack` delays the peak, and every cue in the pack currently takes the 2ms default, which is
   * the point: a percussive voice must be at full level essentially instantly or it stops reading
   * as struck. The option exists because that is a real design axis rather than a constant — a
   * large plate BLOOMS, its upper modes barely present at contact and swelling in over the next
   * tenth of a second, and setting this to 100ms+ per partial is what produced that. A small solid
   * block does not, which is why block() leaves it alone.
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
   * The woodblock's modes: [ratio, level, decay scale].
   *
   * ═══ WHY THE TWO CUES ARE DELIBERATELY DIFFERENT KINDS OF OBJECT ═══
   *
   * This cue is the one thing in the pack the X1PRO has ever classified reliably, and the record
   * of what it has been paired with is the most useful evidence in this file:
   *
   *     accept cue        reject cue    Sound Learn    in-run
   *     ka-ching          thunk         REFUSED        -
   *     ka-ching          woodblock     accepted       accept misread ~50% of the time
   *     high woodblock    woodblock     REFUSED        -
   *
   * That last line refuted a plan rather than a detail. The accept cue had just been rebuilt as
   * this one transposed up — same three-mode structure, same two strikes, same envelope, durations
   * within 40ms, energy within 1% — on the theory that copying the cue that demonstrably works was
   * safer than guessing at the detector. Sound Learn rejected the pair as too similar without
   * being asked to run at all.
   *
   * So whatever its similarity check measures, it is NOT the fundamental: two cues differing only
   * in pitch are, to it, one sound. Register, contour, strike timing and mallet filter were all
   * separated and none of it counted. The pair it accepted was the one with the widest TIMBRAL
   * distance — a long inharmonic bell against a short dry knock.
   *
   * The accept cue is therefore a bell again, and the constraint on this file has inverted: the
   * two cues must NOT be built from the same parts. Mode ratios, envelope length and strike
   * filter are each held apart, and tone-config-test.js asserts all three.
   *
   * (A second reading of the same refusal is that 180ms was simply too short to characterise.
   * Both readings are addressed by the same change, since the bell runs 600ms.)
   *
   * Three modes, where a gong needed seven: a block is a small SOLID resonator, so few modes,
   * each dying fast, one carrying nearly all the energy.
   */
  const WOODBLOCK_MODES = [
    // ratio  level  decay
    [1.00,    1.00,  1.00],
    [3.45,    0.30,  0.40],
    [4.36,    0.15,  0.24],
  ];

  /**
   * A struck woodblock. `decay` is the body mode's ring; the upper modes scale off it.
   *
   * The body modes sit at 554-659Hz, inside the micro-speaker's mechanical resonance (~600-900Hz).
   * resonanceRisk() treats that band as a hazard and for the control tones it is one — but the
   * hazard is precisely that the speaker amplifies whatever lands there, and for a cue nobody is
   * measuring that is free level. Same physics, opposite sign. The 1913-2874Hz modes then sit
   * where the ear is most sensitive and supply the crack.
   *
   * DO NOT RETUNE THIS WITHOUT A REASON. It is the control in every experiment above.
   */
  function woodblock(c, at, hz, gain, decay) {
    // The mallet, not the block. Without a contact transient the modes fade in and read as a
    // short organ note; this is what makes it a knock rather than a beep. Highpassed at 3000Hz,
    // and the accept cue's mallet is a lowpass for exactly that reason — see SYNTH.accept.
    burst(c, { at: at, gain: gain * 0.72, decay: 0.016, filterType: 'highpass', cutoff: 3000 });
    for (let i = 0; i < WOODBLOCK_MODES.length; i++) {
      voice(c, {
        type: 'sine', freq: hz * WOODBLOCK_MODES[i][0], gain: gain * WOODBLOCK_MODES[i][1],
        at: at, decay: decay * WOODBLOCK_MODES[i][2],
      });
    }
  }

  /**
   * A struck low bell — the same bell() machinery, pitched UNDER the woodblock.
   *
   * ═══ WHY THE PARTNER IS NOW BELOW, AND WHY THAT IS THE POINT ═══
   *
   * The full log, which is worth reading before changing anything here:
   *
   *     accept cue      reject cue      teach      run              higher cue
   *     2000 sine       1000 sine       REFUSED    -                accept
   *     1750 sine       1100 sine       REFUSED    -                accept
   *     1477 sine        941 sine       accepted   1477 dropped     accept  <- failed
   *     ka-ching        thunk           REFUSED    -                accept
   *     ka-ching        woodblock       accepted   ka-ching ~50%    accept  <- failed
   *     high block      low block       REFUSED    -                accept
   *     bell Eb6/G6     woodblock       accepted   bell ~50%        accept  <- failed
   *     bell G5/A#5     woodblock       accepted   bell ~50%        accept  <- failed
   *     woodblock       low drum x3     REFUSED    -                accept
   *
   * Two facts fall out of it that no single row shows.
   *
   * ONE: in every pairing that taught, THE HIGHER CUE IS THE ONE THAT FAILED. Nine rows, no
   * exceptions, and never once the lower one. It is not absolute pitch either — 932Hz failed as
   * the higher cue of its pair while 941Hz worked as the lower cue of its. Nine hertz apart,
   * opposite outcomes. Whatever is wrong is about POSITION WITHIN THE PAIR.
   *
   * TWO: a percussive partner will not teach. Two blocks have been refused twice, the second time
   * differing in strike count, mode ratios, register and mallet. Whatever Sound Learn compares,
   * two struck objects are one sound to it however they are tuned. Only a ringing partner has
   * ever got past the teach step.
   *
   * ═══ SO THIS IS A TEST AS MUCH AS A FIX ═══
   *
   * The woodblock has been the LOWER cue in every experiment ever run here. That means "the
   * woodblock is reliable" and "the lower cue is reliable" fit all nine rows equally well, and
   * nothing yet distinguishes them. This build inverts it: a bell below the woodblock, so the
   * proven cue is the higher one for the first time.
   *
   *   the bell fails again    -> the fault belongs to the bell, and position was a coincidence
   *   the WOODBLOCK fails     -> the fault is positional, the woodblock was never special, and
   *                              the fix is level compensation on whichever cue sits higher
   *   both work               -> the bell was simply too high in all three previous attempts
   *
   * All three outcomes are worth a deploy, which has not been true of the last few rounds.
   *
   * G4/E4 puts the fundamentals at 392 and 330Hz, below the speaker's efficient band, so the
   * 2.76x partials at 1082 and 910Hz do the radiating — 910Hz sits inside the band. Its gain is
   * the higher of the two for the reason levelRisk() generalises: a
   * micro-speaker rolls off on BOTH sides of resonance, and this cue is the one further from it.
   */
  function lowBell(c, at, hz, gain, decay) {
    // A soft beater, opposite to the woodblock's hard tip. These two cues shared an onset once,
    // matched to under one percent, and the highpass/lowpass split exists to prevent that return.
    burst(c, { at: at, gain: gain * 0.30, decay: 0.026, filterType: 'lowpass', cutoff: 1200 });
    bell(c, at, hz, gain, decay);
  }



  // ═══════════════════════ THE SYNTH PACK ═══════════════════════
  // Each returns its approximate duration in seconds. Times are relative to a scheduling anchor
  // `t`, never to "now" mid-function — reading currentTime repeatedly inside one cue would let
  // the layers drift apart.

  const SYNTH = {
    /**
     * DOUBLE KNOCK — the proven cue, now carrying the ACCEPT decision.
     *
     * This is the woodblock, unchanged: the same E5/C#5, the same gains, the same 110ms spacing,
     * the same hard-tipped mallet it has had since it was written. It is the only sound this
     * machine has ever classified reliably, across every pairing it has been given, and it has
     * never once been misread in either role.
     *
     * It carries accept because keeper-into-bulk is the expensive error. A card wrongly sent to
     * the bulk pile is a card you have to find again by hand; a bulk card wrongly kept costs a
     * second of sorting. When one cue is reliable and the other is not, the reliable one belongs
     * on the decision you cannot afford to get wrong — the same argument that swapped the tones
     * pack's mapping in the first place.
     *
     * It is also, for the first time in this file's history, the HIGHER of the two cues — and
     * that is deliberate. In all nine configurations tried so far the woodblock has been the
     * lower one, which means "the woodblock is reliable" and "the lower cue is reliable" explain
     * the evidence equally well and nothing has ever separated them. lowBell() sets out what each
     * possible outcome of inverting it would prove.
     */
    accept: function (c, t) {
      woodblock(c, t,        659.25, 0.42, 0.075); // E5
      woodblock(c, t + 0.11, 554.37, 0.38, 0.085); // C#5, a minor third down
      return 0.22;
    },

    /**
     * DOUBLE KNOCK — two dry woodblock strikes, the second a minor third lower.
     *
     * Third cue in this slot. The original thunk was inaudible-adjacent by design; the gong that
     * replaced it was audible in principle and too weak in practice, for the reason woodblock()
     * documents at length. This one is loud where those were quiet, and the whole difference is
     * that its energy sits two octaves higher.
     *
     * ═══ WHY TWO KNOCKS, AND WHY THE SECOND IS LOWER ═══
     *
     * One knock is ambiguous — a single short thump reads as something bumping the table, which
     * is exactly the wrong reading for a cue that means a decision was made. Two deliberate
     * strikes read as intent. It is the same argument the ka-ching's two bells rest on: "ka-ching"
     * is heard as two syllables and a single bell reads as a doorbell.
     *
     * The fall from E5 to C#5 is doing the semantic work. The accept cue RISES a perfect fifth,
     * C6 to G6, because rising pitch reads as reward; this one drops a minor third, because
     * falling pitch reads as refusal in every musical tradition that has an opinion about it. The
     * two cues are therefore distinguishable by CONTOUR alone, which is what lets you tell them
     * apart from the next room without consciously listening — and they are a wide interval and
     * an octave apart in register besides, so there is no risk of hearing one as the other.
     *
     * ═══ SHORT ENOUGH TO HEAR THREE HUNDRED TIMES ═══
     *
     * The thunk's original design argument still stands and this cue honours it: everything is
     * over inside 200ms, with nothing ringing. That is the constraint the gong could not meet
     * without a returned duration that lied about its tail. This one returns its honest full
     * length — there is no tail to be honest about — and 220ms is comfortably inside the 800ms
     * settle, so it costs the run loop nothing.
     */
    /**
     * TRIPLE THUD — three descending strikes on a low drum, A4 / G4 / F4.
     *
     * ═══ WHY THREE STRIKES ═══
     *
     * Because it is the one difference this machine has never been offered. Every pair tried so
     * far has been two events against two events, and the only pair of BLOCKS tried was refused
     * as too similar. Strike count is categorical rather than a matter of degree, which is
     * exactly what a similarity check is likeliest to notice — and three descending thuds reads
     * as a flat "no" far better than a rising anything ever read as a yes.
     *
     * ═══ WHY THE GAIN IS HIGHER THAN THE ACCEPT CUE'S, WHICH LOOKS BACKWARDS ═══
     *
     * levelRisk() states the rule as "the higher cue must be the louder one", and that was always
     * a special case of something more general: a micro-speaker is efficient only near its
     * ~600-900Hz resonance and rolls off on BOTH sides of it. Steeply above, which is what has
     * killed every high cue this rig has been given. Just as surely below, which is what killed
     * the 98Hz gong. This drum's fundamentals sit at 349-440Hz, under the band, so it is the cue
     * that arrives quieter and it is the cue that needs the gain — even though it is the lower of
     * the two. The rule is distance from the band, not pitch.
     *
     * Its 2.20x and 2.90x modes land at 768-1276Hz, inside the efficient band, which is the other
     * half of the same compensation: the fundamental supplies the weight and the modes supply the
     * level.
     *
     * 0.54 x the 1.52 summed across three modes is 0.82, and the beater adds ~0.14 by the time the
     * modes peak. At soundVolume 1 that has to stay under unity or the cue clips before it reaches
     * the speaker.
     */
    reject: function (c, t) {
      lowBell(c, t,        392.00, 0.50, 0.42); // G4
      lowBell(c, t + 0.10, 329.63, 0.44, 0.50); // E4, a minor third down, rings longer
      return 0.62;
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
   * This matters more than it looks. Falling back from the machine pack to the synth cues is the
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
   * 1. A cue must measure the same no matter WHEN it is sampled. The synth pack's cues at the
   *    time were a ka-ching and a thunk: six oscillators starting at two different times and
   *    decaying at six different rates, so "what frequency is this?" answered ~3000Hz, then
   *    1047Hz, then 1568Hz over one cue's life. A steady sine has no such phase.
   *
   *    That reasoning turned out to be too coarse, and the current synth pack is the evidence:
   *    sliding a 150ms window across the two struck blocks, the LOW one's spectral centroid
   *    swings twice as far as the ka-ching's did (24% vs 12%), and it classifies perfectly. What
   *    matters is not whether a cue varies but whether the variation stays inside the window, and
   *    whether the two cues vary into each other's range. A steady sine simply satisfies both
   *    conditions for free, which is still the argument for this pack.
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
   * THE SYNTH PACK LATER CONFIRMED THIS INDEPENDENTLY, on a completely unrelated sound design: a
   * 554/659Hz woodblock classified perfectly while a 1244/1568Hz bell was wrong about half the
   * time, and swapping which cue carried which DECISION moved nothing — the high cue failed in
   * both roles. Two designs, one verdict. Treat ~941Hz as this rig's practical ceiling for
   * anything the machine has to hear across a room, and see SYNTH.accept.
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
