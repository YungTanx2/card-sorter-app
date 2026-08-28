/**
 * Tests for the `tones` pack's detection parameters (public/audio.js).
 *
 * Runs the real audio.js under a fake AudioContext that records the scheduled envelope, so these
 * assert what the machine would actually HEAR rather than what the config object holds. That
 * distinction matters: toneRampMs being stored correctly and toneRampMs reaching the oscillator
 * are different facts, and only the second one affects detection.
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
    createBufferSource() { return { buffer: null, connect() {}, start() {} }; },
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
  A.configure({ soundEnabled: true, soundVolume: 1, soundPack: 'tones',
    toneAcceptHz: 1477, toneRejectHz: 941, toneDurationMs: 600, toneRampMs: 80 });
  A.play('accept');
  const [up, down] = log.filter(e => e[0] === 'curve').map(e => e[1]);
  const rise = riseFraction(up);
  // Raised cosine: 10-90% spans ~59% of the curve. Exponential managed 26%.
  check('10-90% rise covers most of the nominal ramp (exponential scored 0.26)',
    rise > 0.5, 'measured ' + rise.toFixed(3));
  check('the fade starts at true silence', up[0] === 0);
  check('the fade reaches full gain', Math.abs(up[up.length - 1] - 0.5) < 1e-6);
  check('the halfway point is halfway up, not 1.4% up (exponential was 0.0071)',
    Math.abs(up[(up.length - 1) / 2 | 0] - 0.25) < 0.01,
    'measured ' + up[(up.length - 1) / 2 | 0].toFixed(4));
  check('it is monotonic', up.every((v, i) => i === 0 || v >= up[i - 1]));
  // Zero slope at both ends is the property that keeps the cone from being kicked from rest.
  const slope = (c, i) => Math.abs(c[i + 1] - c[i]);
  const mid = (up.length / 2) | 0;
  check('slope at the start is far below the slope at the midpoint',
    slope(up, 0) < slope(up, mid) / 10, slope(up, 0).toFixed(6) + ' vs ' + slope(up, mid).toFixed(6));
  check('slope at the end is far below the slope at the midpoint',
    slope(up, up.length - 2) < slope(up, mid) / 10);
  check('the release is the attack reversed', down[0] === 0.5 && down[down.length - 1] === 0);
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
    toneAcceptHz: 1477, toneRejectHz: 941, toneDurationMs: 600, toneRampMs: 80 });
  A.play('accept');
  check('accept plays toneAcceptHz', log.some(e => e[0] === 'freq' && e[1] === 1477));
  const log2 = [];
  const B = load(log2);
  B.configure({ soundEnabled: true, soundVolume: 1, soundPack: 'tones',
    toneAcceptHz: 1477, toneRejectHz: 941, toneDurationMs: 600, toneRampMs: 80 });
  B.play('reject');
  check('reject plays toneRejectHz', log2.some(e => e[0] === 'freq' && e[1] === 941));
  // Accept must be the HIGHER tone: the transient resembles the LOW cue, so if the detector
  // latches early it errs toward reject — a keeper into bulk, which the manifest still records.
  check('accept is the higher of the two', A.toneConfig().acceptHz > A.toneConfig().rejectHz);
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

console.log('\nthe bundled DEFAULTS are the pair Sound Learn actually accepted');
{
  const A = load();
  const d = A.DEFAULTS;
  check('accept defaults to 1477Hz', d.toneAcceptHz === 1477);
  check('reject defaults to 941Hz', d.toneRejectHz === 941);
  check('ramp defaults at or above the resonance-safe threshold', d.toneRampMs >= 60,
    'got ' + d.toneRampMs);
  // config/settings.json is what production actually loads; DEFAULTS only cover a missing row.
  const shipped = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'settings.json'), 'utf8'));
  check('config/settings.json agrees with DEFAULTS on both tones',
    shipped.toneAcceptHz === d.toneAcceptHz && shipped.toneRejectHz === d.toneRejectHz,
    JSON.stringify({ file: [shipped.toneRejectHz, shipped.toneAcceptHz], defaults: [d.toneRejectHz, d.toneAcceptHz] }));
  check('config/settings.json agrees on the ramp', shipped.toneRampMs === d.toneRampMs,
    'file ' + shipped.toneRampMs + ' vs defaults ' + d.toneRampMs);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
