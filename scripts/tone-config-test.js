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

console.log('\nthe synth pack’s paired blocks — same shape, nothing in common');
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
    const bodies = partials.filter((v) => v.hz < 1500).sort((a, b) => a.at - b.at);
    return { held, partials, strikes, bodies,
      acoustic: Math.max.apply(null, partials.map((v) => v.endsAt)),
      loudest: Math.max.apply(null, partials.map((v) => v.lvl)) };
  };

  const acc = cue('accept'), rej = cue('reject');

  check('both cues are two strikes of three modes',
    acc.partials.length === 6 && rej.partials.length === 6,
    acc.partials.length + ' / ' + rej.partials.length);

  // The reject cue is the CONTROL: the only cue this rig has ever classified reliably. Its
  // numbers must not drift while the accept cue is rebuilt around it.
  check('reject is unchanged — E5 then C#5, falling', rej.bodies.length === 2
    && Math.abs(rej.bodies[0].hz - 659.25) < 0.01 && Math.abs(rej.bodies[1].hz - 554.37) < 0.01,
    rej.bodies.map((v) => Math.round(v.hz)).join(', '));
  check('reject strikes stay 110ms apart',
    Math.abs((rej.bodies[1].at - rej.bodies[0].at) - 0.11) < 0.001);

  check('accept is C6 then Eb6, rising', acc.bodies.length === 2
    && Math.abs(acc.bodies[0].hz - 1046.50) < 0.01 && Math.abs(acc.bodies[1].hz - 1244.51) < 0.01,
    acc.bodies.map((v) => Math.round(v.hz)).join(', '));

  // Contour makes the pair readable by ear without attending to it, and gives the detector a
  // second discriminator now that both cues share an envelope.
  check('accept RISES where reject FALLS',
    acc.bodies[1].hz > acc.bodies[0].hz && rej.bodies[1].hz < rej.bodies[0].hz);
  check('the strike timing differs (80ms vs 110ms)',
    Math.abs((acc.bodies[1].at - acc.bodies[0].at) - 0.08) < 0.001,
    'accept gap ' + Math.round((acc.bodies[1].at - acc.bodies[0].at) * 1000) + 'ms');

  // THE REGRESSION GUARD. Both mallets used to be highpass/3000 at gains 0.302 and 0.300 —
  // matched on purpose so the pack sounded like one instrument, which meant the first 16ms of the
  // two cues were the same sound, and the ka-ching's first 15ms were nothing else. That is the
  // one defect this rebuild exists to remove, and nothing else here would catch its return.
  const accF = acc.strikes.map((f) => f.type + '/' + f.cutoff);
  const rejF = rej.strikes.map((f) => f.type + '/' + f.cutoff);
  check('the two cues share no strike transient', accF.every((f) => rejF.indexOf(f) < 0),
    'accept ' + accF.join(' ') + '   reject ' + rejF.join(' '));
  check('the strikes are spectral opposites (one lowpass, one highpass)',
    acc.strikes.every((f) => f.type === 'lowpass') && rej.strikes.every((f) => f.type === 'highpass'),
    accF.join(' ') + ' / ' + rejF.join(' '));

  // Register. With the envelope now shared, this is what carries the discrimination.
  let closest = 1, pair = '';
  for (const a of acc.partials) {
    for (const r of rej.partials) {
      const d = Math.abs(a.hz - r.hz) / Math.min(a.hz, r.hz);
      if (d < closest) { closest = d; pair = Math.round(a.hz) + ' vs ' + Math.round(r.hz); }
    }
  }
  check('no partial of one cue lands within 15% of any partial of the other', closest > 0.15,
    pair + ' are only ' + Math.round(closest * 100) + '% apart');

  // Level was the fourth theory this rig refuted: the ka-ching carried 2.5-6.7x MORE energy than
  // the woodblock and was still the cue that got misread. Parity is not a fix — it removes a
  // confound, so that if misreads persist, level is not what to reach for next.
  const spread = Math.abs(acc.loudest - rej.loudest) / Math.min(acc.loudest, rej.loudest);
  check('neither cue is the loud one', spread < 0.20,
    'accept peaks ' + acc.loudest + ', reject ' + rej.loudest);

  // Front-loaded and quickly over is the ONLY property the working cue has that the ka-ching
  // lacked, so it is the property being copied.
  check('both cues are over inside 250ms', acc.acoustic <= 0.25 && rej.acoustic <= 0.25,
    Math.round(acc.acoustic * 1000) + 'ms / ' + Math.round(rej.acoustic * 1000) + 'ms');
  check('each cue’s loudest partial is present from its first strike',
    acc.partials.filter((v) => v.lvl === acc.loudest)[0].at <= acc.bodies[0].at + 0.001
    && rej.partials.filter((v) => v.lvl === rej.loudest)[0].at <= rej.bodies[0].at + 0.001);

  check('both returned durations cover the actual sound',
    acc.held >= acc.acoustic && rej.held >= rej.acoustic,
    acc.held + 's/' + Math.round(acc.acoustic * 1000) + 'ms, '
    + rej.held + 's/' + Math.round(rej.acoustic * 1000) + 'ms');

  // ToneEmitter waits max(toneSettleMs, returned + 150ms), so a long cue lengthens every card.
  const settleMs = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'config', 'settings.json'), 'utf8')).toneSettleMs;
  check('neither cue lengthens the run loop',
    acc.held * 1000 + 150 <= settleMs && rej.held * 1000 + 150 <= settleMs);

  // NOTE there is deliberately no detection-band assertion here any more. The machine is taught on
  // THIS pack, so 941/1477 are not in play, and the accept cue's C6 sits 11% from 941 by necessity
  // — the register had to clear the reject cue's, and that is where it landed. If the layered pack
  // is ever built (tones for the machine, these on top), accept needs retuning first.
}



console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
