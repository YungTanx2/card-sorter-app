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

console.log('\nresonanceRisk — a cue must not sit in the speaker resonance band');
{
  const A = load();
  // The regression this whole guard exists for: 941Hz shipped and was misdetected.
  check('941Hz (the tone that failed on the rig) is FLAGGED', !!A.resonanceRisk(941));
  check('852Hz is flagged', !!A.resonanceRisk(852));
  check('999Hz is flagged (just inside)', !!A.resonanceRisk(999));
  check('1000Hz is clear (boundary is inclusive-above)', !A.resonanceRisk(1000));
  check('1175Hz reject default is clear', !A.resonanceRisk(1175));
  check('2175Hz accept default is clear', !A.resonanceRisk(2175));
}

console.log('\nharmonicRisk — the two cues must not be a simple integer ratio of each other');
{
  const A = load();
  check('1175/2175 defaults are harmonically clear', !A.harmonicRisk(1175, 2175));
  check('1000/2000 (the vendor pair) is caught as an octave', !!A.harmonicRisk(1000, 2000));
  check('1200/1800 is caught as 3:2', !!A.harmonicRisk(1200, 1800));
  // The point of having BOTH checks: the old pair passes this one and fails the other.
  check('941/1477 passes harmonics — which is why the resonance fault hid', !A.harmonicRisk(941, 1477));
  check('...but 941/1477 fails resonance', !!A.resonanceRisk(941));
}

console.log('\ntoneRampMs actually reaches the scheduled envelope');
{
  for (const ramp of [25, 60, 120]) {
    const log = [];
    const A = load(log);
    A.configure({ soundEnabled: true, soundVolume: 1, soundPack: 'tones',
      toneAcceptHz: 2175, toneRejectHz: 1175, toneDurationMs: 600, toneRampMs: ramp });
    A.play('accept');
    const freq = log.find(e => e[0] === 'freq');
    const up = log.find(e => e[0] === 'ramp');
    const start = log.find(e => e[0] === 'start');
    check(`ramp ${ramp}ms schedules a ${ramp}ms fade-in`,
      !!(freq && up && start) && Math.abs((up[2] - start[1]) * 1000 - ramp) < 1,
      up && start ? 'measured ' + ((up[2] - start[1]) * 1000).toFixed(1) + 'ms' : 'nothing scheduled');
  }
}

console.log('\nplayed frequency follows configuration');
{
  const log = [];
  const A = load(log);
  A.configure({ soundEnabled: true, soundVolume: 1, soundPack: 'tones',
    toneAcceptHz: 2175, toneRejectHz: 1175, toneDurationMs: 600, toneRampMs: 60 });
  A.play('accept');
  check('accept plays toneAcceptHz', log.some(e => e[0] === 'freq' && e[1] === 2175));
  const log2 = [];
  const B = load(log2);
  B.configure({ soundEnabled: true, soundVolume: 1, soundPack: 'tones',
    toneAcceptHz: 2175, toneRejectHz: 1175, toneDurationMs: 600, toneRampMs: 60 });
  B.play('reject');
  check('reject plays toneRejectHz', log2.some(e => e[0] === 'freq' && e[1] === 1175));
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

console.log('\ntoneConfig reports both risks separately');
{
  const A = load();
  A.configure({ soundPack: 'tones', toneAcceptHz: 1477, toneRejectHz: 941 });
  const t = A.toneConfig();
  check('old pair reports NO harmonic risk', !t.risk);
  check('old pair DOES report a resonance risk', !!t.resonance);
  const B = load();
  B.configure({ soundPack: 'tones', toneAcceptHz: 2175, toneRejectHz: 1175 });
  const u = B.toneConfig();
  check('new defaults report neither risk', !u.risk && !u.resonance);
  check('rampMs is surfaced for the Sound check panel', typeof u.rampMs === 'number');
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
