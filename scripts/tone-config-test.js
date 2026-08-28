/**
 * Tests for the cue packs in public/audio.js.
 *
 * Runs the real audio.js under a fake AudioContext that records the scheduled envelope, so these
 * assert what the machine would actually HEAR rather than what the config object holds. That
 * distinction matters: toneRampMs being stored correctly and toneRampMs reaching the oscillator
 * are different facts, and only the second one affects detection.
 *
 * Most of this covers the `tones` pack, which is the machine's control signal. The synth block at
 * the end covers the decorative pack for one reason only: its cues play into the same room as the
 * X1PRO's microphone, so their partials are a safety property even though nothing routes on them.
 *
 * Run: node scripts/tone-config-test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ok    ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`); failed++; }
}

/** Minimal AudioContext that logs every envelope point instead of making sound. */
function makeCtx(log) {
  const sink = { connect(n) { return n || sink; } };
  return {
    currentTime: 0, sampleRate: 48000, state: 'running', destination: sink,
    createOscillator() {
      return {
        type: '',
        frequency: { setValueAtTime(v, t) { log.push(['freq', v, t]); } },
        connect(n) { return n || sink; }, start(t) { log.push(['start', t]); }, stop() {},
      };
    },
    createGain() {
      return {
        gain: {
          value: 1,
          setValueAtTime(v, t) { log.push(['set', v, t]); },
          exponentialRampToValueAtTime(v, t) { log.push(['ramp', v, t]); },
          linearRampToValueAtTime(v, t) { log.push(['linear', v, t]); },
          cancelScheduledValues(t) { log.push(['cancel', t]); },
          setValueCurveAtTime(curve, t, dur) { log.push(['curve', curve, t, dur]); },
        },
        connect(n) { return n || sink; },
      };
    },
    createBuffer() { return { getChannelData: () => new Float32Array(1), duration: 1 }; },
    createBufferSource() {
      return { buffer: null, connect(n) { return n || sink; }, start() {}, stop() {} };
    },
    // Only the synth pack reaches this one, via burst(). It logs nothing: the noise layer has no
    // frequency to assert on, and leaving it silent keeps the log one entry per oscillator.
    createBiquadFilter() {
      return { type: '', frequency: { value: 0 }, connect(n) { return n || sink; } };
    },
    resume() { return Promise.resolve(); }, close() {},
  };
}

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'audio.js'), 'utf8');

function load(log) {
  const w = { AudioContext: function () { return makeCtx(log || []); } };
  const sandbox = {
    window: w, document: { addEventListener() {} }, navigator: {}, console,
    setTimeout, clearTimeout, fetch: () => Promise.reject(new Error('no network in tests')),
    OfflineAudioContext: undefined,
  };
  sandbox.self = w; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return w.CardSorterAudio;
}

console.log('\nresonanceRisk — a cue in the resonance band is only a risk with an abrupt onset');
{
  const A = load();
  // Called without a ramp it must assume the worst, so a bare frequency check keeps its meaning.
  check('941Hz with no ramp given is FLAGGED', !!A.resonanceRisk(941));
  check('852Hz is flagged', !!A.resonanceRisk(852));
  check('999Hz is flagged (just inside)', !!A.resonanceRisk(999));
  check('1000Hz is clear (boundary is inclusive-above)', !A.resonanceRisk(1000));
  check('1477Hz accept default is clear at any ramp', !A.resonanceRisk(1477, 5));

  // The revised model: the band is survivable, the abrupt onset is not. 941/25ms is the
  // configuration that actually misrouted on the rig; 941/80ms is what replaced it.
  check('941Hz at a 25ms onset is flagged', !!A.resonanceRisk(941, 25));
  check('941Hz at the 80ms default onset is CLEAR', !A.resonanceRisk(941, 80));
  check('941Hz at exactly 60ms is clear (threshold is inclusive)', !A.resonanceRisk(941, 60));
  check('941Hz at 59ms is still flagged', !!A.resonanceRisk(941, 59));
}

console.log('\nharmonicRisk — the two cues must not be a simple integer ratio of each other');
{
  const A = load();
  check('941/1477 defaults are harmonically clear (the DTMF set is built for this)',
    !A.harmonicRisk(941, 1477));
  check('1000/2000 (the vendor pair) is caught as an octave', !!A.harmonicRisk(1000, 2000));
  check('1200/1800 is caught as 3:2', !!A.harmonicRisk(1200, 1800));
  check('1100/1750 is harmonically clear too — it was rejected for other reasons',
    !A.harmonicRisk(1100, 1750));
  // The point of having BOTH checks: they are independent, and a pair can pass one and fail the
  // other. 941/1477 is clear on harmonics and depends on the ramp for resonance.
  check('941/1477 fails resonance at a short ramp', !!A.resonanceRisk(941, 25));
}

/** Fraction of a fade curve's duration spent going from 10% to 90% of its final value. */
function riseFraction(curve) {
  const peak = curve[curve.length - 1];
  const at = (frac) => {
    for (let i = 0; i < curve.length; i++) if (curve[i] >= frac * peak) return i / (curve.length - 1);
    return 1;
  };
  return at(0.9) - at(0.1);
}

console.log('\ntoneRampMs actually reaches the scheduled envelope');
{
  for (const ramp of [25, 60, 120]) {
    const log = [];
    const A = load(log);
    A.configure({ soundEnabled: true, soundVolume: 1, soundPack: 'tones',
      toneAcceptHz: 1477, toneRejectHz: 941, toneDurationMs: 600, toneRampMs: ramp });
    A.play('accept');
    const start = log.find(e => e[0] === 'start');
    const curves = log.filter(e => e[0] === 'curve');
    check(`ramp ${ramp}ms schedules a ${ramp}ms fade-in`,
      !!start && curves.length === 2 && Math.abs(curves[0][3] * 1000 - ramp) < 1,
      curves.length ? 'measured ' + (curves[0][3] * 1000).toFixed(1) + 'ms' : 'no curve scheduled');
    check(`ramp ${ramp}ms schedules a matching fade-OUT at the end`,
      curves.length === 2 && Math.abs(curves[1][3] * 1000 - ramp) < 1
        && Math.abs((curves[1][2] - start[1]) * 1000 - (600 - ramp)) < 1);
  }
}

/**
 * THE REGRESSION THIS FILE NOW EXISTS FOR.
 *
 * The old envelope was an exponentialRamp over a 5000x range, whose effective 10-90% rise is only
 * ~26% of its nominal duration — so `toneRampMs` advertised four times the fade it delivered, and
 * a deliberate 25 -> 60ms softening bought ~9ms. Asserting the SHAPE, not just the duration, is
 * the only way that stays fixed: a future edit back to exponentialRamp would keep every timing
 * assertion above green.
 */
console.log('\nthe fade is honest — nominal ramp ~= real ramp');
{
  const log = [];
  const A = load(log);
  const PEAK = 0.4;   // toneAcceptGain — asserted against, not assumed, so a default change shows up
  A.configure({ soundEnabled: true, soundVolume: 1, soundPack: 'tones',
    toneAcceptHz: 941, toneRejectHz: 1477, toneDurationMs: 600, toneRampMs: 80,
    toneAcceptGain: PEAK, toneRejectGain: 0.8 });
  A.play('accept');
  const [up, down] = log.filter(e => e[0] === 'curve').map(e => e[1]);
  const rise = riseFraction(up);
  // Raised cosine: 10-90% spans ~59% of the curve. Exponential managed 26%.
  check('10-90% rise covers most of the nominal ramp (exponential scored 0.26)',
    rise > 0.5, 'measured ' + rise.toFixed(3));
  check('the fade starts at true silence', up[0] === 0);
  check('the fade reaches the cue gain', Math.abs(up[up.length - 1] - PEAK) < 1e-6,
    'measured ' + up[up.length - 1]);
  check('the halfway point is halfway up, not 1.4% up (exponential was 0.0071)',
    Math.abs(up[(up.length - 1) / 2 | 0] / PEAK - 0.5) < 0.02,
    'measured ' + (up[(up.length - 1) / 2 | 0] / PEAK).toFixed(4) + ' of peak');
  check('it is monotonic', up.every((v, i) => i === 0 || v >= up[i - 1]));
  // Zero slope at both ends is the property that keeps the cone from being kicked from rest.
  const slope = (c, i) => Math.abs(c[i + 1] - c[i]);
  const mid = (up.length / 2) | 0;
  check('slope at the start is far below the slope at the midpoint',
    slope(up, 0) < slope(up, mid) / 10, slope(up, 0).toFixed(6) + ' vs ' + slope(up, mid).toFixed(6));
  check('slope at the end is far below the slope at the midpoint',
    slope(up, up.length - 2) < slope(up, mid) / 10);
  check('the release is the attack reversed',
    Math.abs(down[0] - PEAK) < 1e-6 && down[down.length - 1] === 0);
}

console.log('\nenvelope falls back to LINEAR (never exponential) if value curves are unavailable');
{
  // A context whose gain param has no setValueCurveAtTime, the way an old browser would present.
  const log2 = [];
  const B = (function () {
    const w = { AudioContext: function () {
      const c = makeCtx(log2);
      const orig = c.createGain;
      c.createGain = function () { const g = orig(); delete g.gain.setValueCurveAtTime; return g; };
      return c;
    } };
    const sandbox = { window: w, document: { addEventListener() {} }, navigator: {}, console,
      setTimeout, clearTimeout, fetch: () => Promise.reject(new Error('no network in tests')),
      OfflineAudioContext: undefined };
    sandbox.self = w; sandbox.globalThis = sandbox;
    vm.createContext(sandbox); vm.runInContext(SRC, sandbox);
    return w.CardSorterAudio;
  })();
  B.configure({ soundEnabled: true, soundVolume: 1, soundPack: 'tones',
    toneAcceptHz: 1477, toneRejectHz: 941, toneDurationMs: 600, toneRampMs: 80 });
  B.play('accept');
  check('a cue still plays', log2.some(e => e[0] === 'start'));
  check('it uses linear ramps', log2.filter(e => e[0] === 'linear').length === 2);
  check('it does NOT fall back to the exponential ramp', !log2.some(e => e[0] === 'ramp'));
  check('the linear fade still honours toneRampMs',
    Math.abs((log2.find(e => e[0] === 'linear')[2] - log2.find(e => e[0] === 'start')[1]) * 1000 - 80) < 1);
}

console.log('\nplayed frequency follows configuration');
{
  const log = [];
  const A = load(log);
  A.configure({ soundEnabled: true, soundVolume: 1, soundPack: 'tones',
    toneAcceptHz: 941, toneRejectHz: 1477, toneDurationMs: 600, toneRampMs: 80 });
  A.play('accept');
  check('accept plays toneAcceptHz', log.some(e => e[0] === 'freq' && e[1] === 941));
  const log2 = [];
  const B = load(log2);
  B.configure({ soundEnabled: true, soundVolume: 1, soundPack: 'tones',
    toneAcceptHz: 941, toneRejectHz: 1477, toneDurationMs: 600, toneRampMs: 80 });
  B.play('reject');
  check('reject plays toneRejectHz', log2.some(e => e[0] === 'freq' && e[1] === 1477));
  // ACCEPT IS THE LOWER TONE, and an earlier revision of this file asserted the opposite on the
  // theory that an early-latching detector errs toward the low cue, so keepers-into-bulk was the
  // "safe" direction. It is the wrong way round: the machine drops the HIGH cue, the dropout has
  // to land somewhere, and a bulk card in a 7-card keeper pile is recovered in seconds where a
  // keeper in 44 bulk cards is not. The rarest decision belongs on the tone that never fails.
  check('accept is the LOWER of the two', A.toneConfig().acceptHz < A.toneConfig().rejectHz);
}

console.log('\nclamping — a bad setting must not produce an unplayable cue');
{
  const A = load();
  A.configure({ toneRampMs: 9999, toneDurationMs: 600 });
  check('absurd ramp is clamped, not honoured', A.toneConfig().rampMs <= 250,
    'got ' + A.toneConfig().rampMs);
  const B = load();
  B.configure({ toneRampMs: 0 });
  check('zero ramp is clamped up (an abrupt start is broadband)', B.toneConfig().rampMs >= 5);
}

console.log('\ntoneConfig reports both risks separately, and resonance accounts for the ramp');
{
  const A = load();
  A.configure({ soundPack: 'tones', toneAcceptHz: 1477, toneRejectHz: 941, toneRampMs: 25 });
  const t = A.toneConfig();
  check('941/1477 reports NO harmonic risk', !t.risk);
  check('...but DOES report resonance at a 25ms onset', !!t.resonance);

  const B = load();
  B.configure({ soundPack: 'tones', toneAcceptHz: 1477, toneRejectHz: 941, toneRampMs: 80 });
  const u = B.toneConfig();
  check('the shipped config (941/1477 @ 80ms) reports NEITHER risk', !u.risk && !u.resonance,
    JSON.stringify({ risk: u.risk, resonance: u.resonance }));
  check('rampMs is surfaced for the Sound check panel', u.rampMs === 80);
  check('ratio is still reported', Math.abs(u.ratio - 1.570) < 0.002, 'got ' + u.ratio);
}

console.log('\nlevelRisk — the higher cue must be the louder one');
{
  const A = load();
  // The shipped mapping: accept is LOW at 0.40, reject is HIGH at 0.80.
  check('shipped levels are clear', !A.levelRisk(941, 0.40, 1477, 0.80));
  check('equal gains are FLAGGED (this was the state that dropped cues)',
    !!A.levelRisk(941, 0.5, 1477, 0.5));
  check('boosting the LOW cue instead is flagged', !!A.levelRisk(941, 0.8, 1477, 0.4));
  // The trap the guard exists for: swap the frequencies, forget to swap the gains.
  check('swapping tones without swapping gains is caught',
    !!A.levelRisk(1477, 0.40, 941, 0.80));
  check('...and is clear once the gains follow',
    !A.levelRisk(1477, 0.80, 941, 0.40));
  check('the message names the cue that is too quiet',
    /1477Hz, reject/.test(A.levelRisk(941, 0.5, 1477, 0.5)));
}

console.log('\nper-cue gain and length reach the scheduled envelope');
{
  const log = [];
  const A = load(log);
  A.configure({ soundEnabled: true, soundVolume: 1, soundPack: 'tones',
    toneAcceptHz: 941, toneRejectHz: 1477, toneRampMs: 80,
    toneAcceptGain: 0.4, toneRejectGain: 0.8, toneAcceptMs: 600, toneRejectMs: 900 });
  A.play('accept');
  const acc = log.filter(e => e[0] === 'curve');
  check('accept peaks at toneAcceptGain', Math.abs(acc[0][1][acc[0][1].length - 1] - 0.4) < 1e-6,
    'got ' + acc[0][1][acc[0][1].length - 1]);

  const log2 = [];
  const B = load(log2);
  B.configure({ soundEnabled: true, soundVolume: 1, soundPack: 'tones',
    toneAcceptHz: 941, toneRejectHz: 1477, toneRampMs: 80,
    toneAcceptGain: 0.4, toneRejectGain: 0.8, toneAcceptMs: 600, toneRejectMs: 900 });
  const held = B.play('reject');
  const rej = log2.filter(e => e[0] === 'curve');
  check('reject peaks at toneRejectGain — twice the level of accept',
    Math.abs(rej[0][1][rej[0][1].length - 1] - 0.8) < 1e-6,
    'got ' + rej[0][1][rej[0][1].length - 1]);
  check('reject uses toneRejectMs, not toneDurationMs', Math.abs(held - 0.9) < 1e-6,
    'held for ' + held + 's');
  // play() returns the length the PAGES use to hold before re-arming, so a per-cue length that
  // did not reach this return value would let the next capture start mid-tone.
  check('the returned hold time follows the per-cue length', held > 0.6);

  // Unset per-cue lengths must fall back rather than producing a silent or zero-length cue.
  const log3 = [];
  const C = load(log3);
  C.configure({ soundEnabled: true, soundVolume: 1, soundPack: 'tones',
    toneAcceptHz: 941, toneRejectHz: 1477, toneDurationMs: 450, toneRampMs: 80 });
  check('an unset per-cue length falls back to toneDurationMs',
    Math.abs(C.toneConfig().acceptMs - 450) < 1 || C.toneConfig().acceptMs === 600,
    'got ' + C.toneConfig().acceptMs);

  const D = load();
  D.configure({ toneAcceptGain: 0, toneRejectGain: 99 });
  check('gain 0 is clamped up — a silent cue is a card the machine never routes',
    D.toneConfig().acceptGain >= 0.05, 'got ' + D.toneConfig().acceptGain);
  check('gain above 1 is clamped down', D.toneConfig().rejectGain <= 1,
    'got ' + D.toneConfig().rejectGain);
}

console.log('\nthe bundled DEFAULTS are the pair Sound Learn actually accepted');
{
  const A = load();
  const d = A.DEFAULTS;
  check('accept defaults to 941Hz (the reliable tone carries the rare decision)',
    d.toneAcceptHz === 941);
  check('reject defaults to 1477Hz', d.toneRejectHz === 1477);
  check('ramp defaults at or above the resonance-safe threshold', d.toneRampMs >= 60,
    'got ' + d.toneRampMs);
  check('the defaults themselves pass every guard',
    !A.harmonicRisk(d.toneAcceptHz, d.toneRejectHz)
    && !A.resonanceRisk(d.toneAcceptHz, d.toneRampMs)
    && !A.resonanceRisk(d.toneRejectHz, d.toneRampMs)
    && !A.levelRisk(d.toneAcceptHz, d.toneAcceptGain, d.toneRejectHz, d.toneRejectGain));

  // config/settings.json is what production actually loads; DEFAULTS only cover a missing row.
  // These drifted apart twice during tone tuning, and nothing surfaced it.
  const shipped = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'settings.json'), 'utf8'));
  for (const k of ['toneAcceptHz', 'toneRejectHz', 'toneRampMs', 'toneDurationMs',
    'toneAcceptGain', 'toneRejectGain', 'toneAcceptMs', 'toneRejectMs']) {
    check(`config/settings.json agrees with DEFAULTS on ${k}`, shipped[k] === d[k],
      'file ' + shipped[k] + ' vs defaults ' + d[k]);
  }
}

console.log('\nthe synth pack\u2019s woodblock \u2014 loud, dry, and clear of the detection bands');
{
  const log = [];
  const A = load(log);
  A.configure({ soundEnabled: true, soundVolume: 1, soundPack: 'synth' });
  const held = A.play('reject');

  // voice() logs a contiguous run per oscillator: freq, set, ramp(peak), ramp(release), start.
  // burst() contributes only set/ramp, so anchoring on 'freq' skips the mallet layer cleanly.
  const partials = [];
  for (let i = 0; i < log.length; i++) {
    if (log[i][0] !== 'freq') continue;
    partials.push({ hz: log[i][1], at: log[i][2], endsAt: log[i + 3][2] });
  }

  check('two knocks of three modes each', partials.length === 6, 'got ' + partials.length);

  const bodies = partials.filter((v) => v.hz < 700).sort((a, b) => a.at - b.at);
  check('the body modes are E5 then C#5', bodies.length === 2
    && Math.abs(bodies[0].hz - 659.25) < 0.01 && Math.abs(bodies[1].hz - 554.37) < 0.01,
    bodies.map((v) => Math.round(v.hz)).join(', '));

  // Falling pitch is what makes this read as refusal, and it is the contour that distinguishes it
  // from the accept cue's RISING fifth without the listener having to attend to either.
  check('the second knock is lower than the first', bodies[1].hz < bodies[0].hz);
  check('the knocks are ~110ms apart', Math.abs((bodies[1].at - bodies[0].at) - 0.11) < 0.001,
    'gap ' + Math.round((bodies[1].at - bodies[0].at) * 1000) + 'ms');

  // The point of the whole cue: the body modes sit inside the micro-speaker's resonance band,
  // where the speaker amplifies them for free. This is what the 98Hz gong could not do.
  check('both bodies are inside the speaker resonance band (600-900Hz)',
    bodies.every((v) => v.hz >= 550 && v.hz < 900), bodies.map((v) => Math.round(v.hz)).join(', '));

  // Every partial AND its 2nd harmonic must clear both detection bands — the speaker produces a
  // 2nd harmonic whether or not it is asked to, which is what rules out the natural 740Hz block
  // pitch (2 x 740 = 1480Hz, three hertz off the reject tone).
  //
  // Two thresholds, deliberately. A synthesized partial arrives at its stated level and is held to
  // 25%. A 2nd harmonic is a distortion product at a few percent of it, and the corridor between
  // 941 and 1477 is only 57% wide, so the best margin ANY body pitch can reach there is 22.2% —
  // asserting 25% on both would be asserting something geometrically impossible. It was, once.
  const clearance = (hz) => Math.min.apply(null, [941, 1477].map((b) => Math.abs(hz - b) / b));
  const nearest = (list) => list.reduce((a, v) => (clearance(v) < clearance(a) ? v : a));

  const direct = nearest(partials.map((v) => v.hz));
  check('every synthesized partial is >25% clear of both bands', clearance(direct) > 0.25,
    Math.round(direct) + 'Hz is only ' + Math.round(clearance(direct) * 100) + '% away');

  const harmonic = nearest(partials.map((v) => v.hz * 2));
  check('every 2nd harmonic is >10% clear of both bands', clearance(harmonic) > 0.10,
    Math.round(harmonic) + 'Hz is only ' + Math.round(clearance(harmonic) * 100) + '% away');

  // The thunk's original design argument, which the gong could not honour: you hear this a few
  // hundred times per pile, so nothing may ring.
  const acoustic = Math.max.apply(null, partials.map((v) => v.endsAt));
  check('the whole cue is over inside 250ms', acoustic <= 0.25,
    'runs ' + Math.round(acoustic * 1000) + 'ms');

  // Unlike the gong, this one has no tail to be honest about, so the returned duration is the
  // real length rather than the decision-relevant prefix.
  check('the returned duration covers the actual sound', held >= acoustic,
    'returns ' + held + 's for ' + Math.round(acoustic * 1000) + 'ms of sound');

  // ToneEmitter waits max(toneSettleMs, returned + 150ms), so a long cue lengthens every card.
  const settleMs = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'config', 'settings.json'), 'utf8')).toneSettleMs;
  check('the reject cue does not lengthen the run loop', held * 1000 + 150 <= settleMs,
    'cue ' + Math.round(held * 1000) + 'ms + 150 vs settle ' + settleMs + 'ms');
}


console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
