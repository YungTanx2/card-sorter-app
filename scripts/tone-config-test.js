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
    // Only the synth pack reaches this one, via burst(). The node is logged rather than its
    // settings, because burst() ASSIGNS type and frequency after construction — read them back
    // once the cue has finished scheduling. The strike transients are the one thing the two synth
    // cues must not have in common, so they need asserting.
    createBiquadFilter() {
      const f = { type: '', frequency: { value: 0 }, connect(n) { return n || sink; } };
      log.push(['filter', f]);
      return f;
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

console.log('\nthe synth pack — two struck blocks, and everything that separates them');
{
  const log = [];
  const A = load(log);
  A.configure({ soundEnabled: true, soundVolume: 1, soundPack: 'synth' });

  // voice() logs a contiguous run per oscillator: freq, set, ramp(peak), ramp(release), start.
  // burst() logs its filter node plus set/ramp, so anchoring on 'freq' skips the mallet layer.
  const cue = (name) => {
    log.length = 0;
    const held = A.play(name);
    const partials = [], strikes = [];
    for (let i = 0; i < log.length; i++) {
      if (log[i][0] === 'filter') {
        strikes.push({ type: log[i][1].type, cutoff: log[i][1].frequency.value });
      }
      if (log[i][0] !== 'freq') continue;
      partials.push({ hz: log[i][1], at: log[i][2], lvl: log[i + 2][1], endsAt: log[i + 3][2] });
    }
    const at = [...new Set(partials.map((v) => v.at))].sort((a, b) => a - b);
    const groups = at.map((t) => partials.filter((v) => v.at === t).sort((a, b) => a.hz - b.hz));
    return { held, partials, strikes, groups,
      pitches: groups.map((g) => g[0].hz),
      ratios: groups[0].map((v) => v.hz / groups[0][0].hz),
      acoustic: Math.max.apply(null, partials.map((v) => v.endsAt)),
      loudest: Math.max.apply(null, partials.map((v) => v.lvl)) };
  };

  const acc = cue('accept'), rej = cue('reject');

  // ═══ THE ACCEPT CUE IS THE PROVEN ONE, AND IT CARRIES THE EXPENSIVE DECISION ═══
  //
  // The woodblock is the only sound this machine has ever classified reliably, in either role,
  // across every partner it has been given. Keeper-into-bulk is the error that costs you a card,
  // so the reliable cue belongs on accept. Its numbers must not drift.
  check('accept is the unchanged woodblock — E5 then C#5',
    acc.groups.length === 2
    && Math.abs(acc.pitches[0] - 659.25) < 0.01 && Math.abs(acc.pitches[1] - 554.37) < 0.01,
    acc.pitches.map(Math.round).join(', '));
  check('accept keeps its 110ms strike spacing',
    Math.abs((acc.groups[1][0].at - acc.groups[0][0].at) - 0.11) < 0.001);
  check('accept keeps its 0.42/0.38 gains',
    Math.abs(acc.groups[0][0].lvl - 0.42) < 0.001 && Math.abs(acc.groups[1][0].lvl - 0.38) < 0.001,
    acc.groups.map((g) => g[0].lvl).join(', '));

  check('reject is a low bell — G4 then E4',
    rej.groups.length === 2
    && Math.abs(rej.pitches[0] - 392.00) < 0.01 && Math.abs(rej.pitches[1] - 329.63) < 0.01,
    rej.pitches.map(Math.round).join(', '));

  // ═══ THE INVERSION, WHICH IS THE POINT OF THIS BUILD ═══
  //
  // In all nine configurations tried on this rig, the HIGHER cue of the pair is the one that
  // failed — no exceptions — and the woodblock has been the LOWER cue every single time. So
  // "the woodblock is reliable" and "the lower cue is reliable" explain the evidence equally
  // well, and nothing has ever separated them. The partner is now BELOW, so the proven cue is
  // the higher one for the first time. If this assertion ever flips back, that experiment has
  // been silently undone.
  check('the proven cue is the HIGHER of the pair, for the first time',
    Math.max.apply(null, acc.pitches) > Math.max.apply(null, rej.pitches),
    'accept tops out at ' + Math.round(Math.max.apply(null, acc.pitches))
    + 'Hz, reject at ' + Math.round(Math.max.apply(null, rej.pitches)) + 'Hz');

  // ═══ THE BAND ═══
  //
  // A micro-speaker is efficient near its ~600-900Hz resonance and rolls off on both sides. Above
  // it killed every high cue this rig has been given: 1477Hz on the tones pack, then 1046/1568,
  // 1244/1568 and 784/932 on the synth pack — that last within 1% of a frequency the machine has
  // never had trouble with, which is what ruled out a simple ceiling. Below it killed the 98Hz
  // gong, inaudible across a room. Everything has to sit in between.
  const FLOOR = 300, CEILING = 941;
  for (const nm of ['accept', 'reject']) {
    const m = nm === 'accept' ? acc : rej;
    check(nm + ' pitches stay between ' + FLOOR + ' and ' + CEILING + 'Hz',
      m.pitches.every((hz) => hz >= FLOOR && hz <= CEILING),
      m.pitches.map(Math.round).join(', ') + 'Hz');
  }

  // The general form of levelRisk()'s rule. "The higher cue must be louder" was a special case of
  // "the cue further from the efficient band arrives quieter", which is why the reject cue here is
  // the louder one despite being the lower one — its fundamentals are furthest from the band.
  const dist = (hz) => (hz >= 600 && hz <= 900 ? 0 : (hz < 600 ? 600 - hz : hz - 900));
  const accFar = Math.max.apply(null, acc.pitches.map(dist));
  const rejFar = Math.max.apply(null, rej.pitches.map(dist));
  const far = accFar > rejFar ? acc : rej, near = accFar > rejFar ? rej : acc;
  check('the cue further from the efficient band is the louder one', far.loudest > near.loudest,
    'far peaks ' + far.loudest + ', near peaks ' + near.loudest);

  // ═══ WHAT SEPARATES TWO CUES THAT ARE NOW THE SAME KIND OF OBJECT ═══
  //
  // Two blocks have been refused once already, as too similar. That pair differed only in pitch:
  // mode ratios 3.30/3.95 against 3.45/4.36, identical envelopes, durations within 40ms, energy
  // within 1%. These four assertions are the deliberate answer to that refusal.

  // 1. One cue rings and the other does not. This is the difference that has ALWAYS been present
  //    in a pairing Sound Learn accepted, and always absent from one it refused: two struck
  //    blocks have now been rejected twice, the second time differing in strike count, mode
  //    ratios, register and mallet. Whatever it compares, two percussive objects are one sound to
  //    it however they are tuned. Only a ringing partner has ever got past the teach step.
  check('one cue rings and the other does not (>2x length)', acc.acoustic * 2 < rej.acoustic,
    Math.round(acc.acoustic * 1000) + 'ms vs ' + Math.round(rej.acoustic * 1000) + 'ms');

  // 2. Mode structure: bell ratios 2.76x/5.40x against block ratios 3.45x/4.36x.
  let closestRatio = 9;
  for (const a of acc.ratios.slice(1))
    for (const r of rej.ratios.slice(1))
      closestRatio = Math.min(closestRatio, Math.abs(a - r) / Math.min(a, r));
  check('the two cues do not share a mode structure', closestRatio > 0.15,
    'closest mode ratios are ' + Math.round(closestRatio * 100) + '% apart');

  // 3. Strike transient. These were once identical — highpass/3000 at gains 0.302 and 0.300,
  //    matched on purpose so the pack would sound like one instrument.
  const accF = acc.strikes.map((f) => f.type + '/' + f.cutoff);
  const rejF = rej.strikes.map((f) => f.type + '/' + f.cutoff);
  check('the two cues share no strike transient', accF.every((f) => rejF.indexOf(f) < 0),
    'accept ' + accF.join(' ') + '   reject ' + rejF.join(' '));
  check('the strikes are spectral opposites (one lowpass, one highpass)',
    acc.strikes.every((f) => f.type === 'highpass') && rej.strikes.every((f) => f.type === 'lowpass'),
    accF.join(' ') + ' / ' + rejF.join(' '));

  // 4. Register, on the fundamentals. Quiet upper modes are not held to this: the ka-ching carried
  //    a partial 0.5% from the woodblock's 2874Hz mode for its entire life and taught fine.
  let closest = 1, pair = '';
  for (const a of acc.pitches)
    for (const r of rej.pitches) {
      const d = Math.abs(a - r) / Math.min(a, r);
      if (d < closest) { closest = d; pair = Math.round(a) + ' vs ' + Math.round(r); }
    }
  check('the cue fundamentals stay 15% apart', closest > 0.15,
    pair + ' are only ' + Math.round(closest * 100) + '% apart');

  // A dominant partial arriving late is the one property the working cue has never had; the
  // ka-ching's arrived at t+115ms and it was misread half the time.
  for (const nm of ['accept', 'reject']) {
    const m = nm === 'accept' ? acc : rej;
    check(nm + ' peaks on its first strike',
      m.partials.filter((v) => v.lvl === m.loudest)[0].at <= m.groups[0][0].at + 0.001);
  }

  check('both returned durations cover the actual sound',
    acc.held >= acc.acoustic && rej.held >= rej.acoustic,
    acc.held + 's/' + Math.round(acc.acoustic * 1000) + 'ms, '
    + rej.held + 's/' + Math.round(rej.acoustic * 1000) + 'ms');

  // ToneEmitter waits max(toneSettleMs, returned + 150ms), so a long cue lengthens every card.
  const settleMs = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'config', 'settings.json'), 'utf8')).toneSettleMs;
  check('neither cue lengthens the run loop',
    acc.held * 1000 + 150 <= settleMs && rej.held * 1000 + 150 <= settleMs);

  // Peak amplitude. At soundVolume 1 nothing downstream limits, so a cue summing over unity clips
  // before it reaches the speaker — and a clipped cue is a different sound from the one taught.
  for (const nm of ['accept', 'reject']) {
    const m = nm === 'accept' ? acc : rej;
    const peak = Math.max.apply(null, m.groups.map((g) => g.reduce((s, v) => s + v.lvl, 0)));
    check(nm + ' stays under unity at soundVolume 1', peak < 0.95,
      'peaks at ' + Math.round(peak * 1000) / 1000);
  }
}
console.log('\nconfig/settings.json ships the configuration that actually routes cards');
{
  // A 240-card run (39 keepers) sorted with zero misroutes on soundPack "synth", soundVolume 1.
  // A saved app_settings row shadows this file, so production does not depend on it — but if that
  // row is ever lost, or a fresh environment is set up, the app must come up on the configuration
  // that works rather than a different one. The `tones` and `machine` packs both have documented
  // Sound Learn failures on this rig, so neither is a safe default any more.
  const shipped = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'config', 'settings.json'), 'utf8'));
  check('soundPack ships as the validated "synth"', shipped.soundPack === 'synth',
    'got ' + shipped.soundPack);
  check('soundVolume ships at full', shipped.soundVolume === 1, 'got ' + shipped.soundVolume);

  // The settle must outlast the longer cue, or the next capture starts while the machine is still
  // hearing this one. The reject bell returns 620ms.
  const A = load();
  A.configure({ soundEnabled: true, soundVolume: 1, soundPack: 'synth' });
  const longest = Math.max(A.play('accept'), A.play('reject')) * 1000 + 150;
  check('toneSettleMs covers the longer cue', shipped.toneSettleMs >= longest,
    'settle ' + shipped.toneSettleMs + 'ms vs cue ' + Math.round(longest) + 'ms');
}
console.log('\nthe synth cue tuner — settings reach the cues, and the guards catch a bad drag');
{
  // The sliders exist so the cues can be retuned by ear. That makes it possible to walk a
  // configuration that took ten experiments to find straight back into a broken one, so what is
  // asserted here is that the settings actually reach the oscillators and that each rule is
  // reported before it is saved.
  const A = load();
  const validated = A.SYNTH_VALIDATED;

  check('the shipped defaults ARE the validated four',
    validated.synthAcceptHz === 659.25 && validated.synthAcceptGain === 0.42
    && validated.synthRejectHz === 392.00 && validated.synthRejectGain === 0.50,
    JSON.stringify(validated));

  const shipped = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'config', 'settings.json'), 'utf8'));
  for (const k of Object.keys(validated)) {
    check('config/settings.json ships the validated ' + k, shipped[k] === validated[k],
      'file ' + shipped[k] + ' vs validated ' + validated[k]);
  }

  // The derived second strike must reproduce the run's measured numbers exactly, or the defaults
  // are no longer the configuration that sorted 240 cards.
  const d = A.synthConfig();
  check('the derived second strikes match the validated run',
    Math.abs(d.acceptTailHz - 554.37) < 0.02 && Math.abs(d.rejectTailHz - 329.63) < 0.02
    && Math.abs(d.acceptTailGain - 0.38) < 0.01 && Math.abs(d.rejectTailGain - 0.44) < 0.01,
    d.acceptTailHz + 'Hz/' + d.acceptTailGain + ', ' + d.rejectTailHz + 'Hz/' + d.rejectTailGain);
  check('the validated configuration trips no guard',
    !d.ceiling && !d.spacing && !d.clipping,
    [d.ceiling, d.spacing, d.clipping].filter(Boolean).join(' | '));

  // A slider move must reach the OSCILLATOR, not just the config object. Those are different
  // facts and only the second one changes what the machine hears.
  {
    const log = [];
    const B = load(log);
    B.configure({ soundEnabled: true, soundVolume: 1, soundPack: 'synth',
      synthAcceptHz: 500, synthAcceptGain: 0.30 });
    B.play('accept');
    const freqs = log.filter((e) => e[0] === 'freq').map((e) => e[1]).sort((a, b) => a - b);
    const levels = log.filter((e) => e[0] === 'ramp').map((e) => e[1]);
    check('a pitch change reaches the scheduled oscillators',
      freqs.some((f) => Math.abs(f - 500) < 0.01), freqs.map(Math.round).join(', '));
    check('the second strike follows the first down a minor third',
      freqs.some((f) => Math.abs(f - 500 * Math.pow(2, -3 / 12)) < 0.02),
      freqs.map(Math.round).join(', '));
    check('a level change reaches the scheduled envelope',
      levels.some((v) => Math.abs(v - 0.30) < 0.001), levels.join(', '));
  }

  // ═══ THE GUARDS ═══
  //
  // Rule 2 from the ten-configuration log: every pitch at or below 659Hz has worked and every one
  // at or above 784Hz has been misread about half the time. A slider crosses that in one drag.
  check('a pitch above 660Hz is flagged', !!A.synthCeilingRisk(800, 392));
  check('the reject cue is checked too, not just accept', !!A.synthCeilingRisk(659.25, 780));
  check('660Hz exactly is still clear', !A.synthCeilingRisk(660, 392));
  check('the validated pitches are clear', !A.synthCeilingRisk(659.25, 392));
  check('the message names the offending cue',
    /accept at 800Hz/.test(A.synthCeilingRisk(800, 392)));

  check('two cues converging in pitch are flagged', !!A.synthSpacingRisk(500, 480));
  check('the validated pair is well apart', !A.synthSpacingRisk(659.25, 392));

  // Clipping is silent: nothing downstream limits at soundVolume 1, and an over-unity cue simply
  // becomes a different sound from the one Sound Learn was taught.
  check('a gain that sums over unity is flagged', !!A.synthClipRisk(0.55, 0.55));
  check('the validated gains are clear', !A.synthClipRisk(0.42, 0.50));

  // Clamps stop nonsense; the guards report danger. A slider that refuses to reach 700Hz would
  // make the band unexplorable, which is why the clamp is 900 and the warning is at 660.
  const C = load();
  C.configure({ synthAcceptHz: 5000, synthRejectHz: 10, synthAcceptGain: 9, synthRejectGain: 0 });
  const c = C.synthConfig();
  check('pitch clamps to the range this speaker can produce',
    c.acceptHz === 900 && c.rejectHz === 300, c.acceptHz + ', ' + c.rejectHz);
  check('gain clamps below the clipping point',
    c.acceptGain === 0.55 && c.rejectGain === 0.05, c.acceptGain + ', ' + c.rejectGain);
  check('a clamped-but-dangerous pitch still raises the ceiling flag', !!c.ceiling);
}







console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
