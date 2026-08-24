/**
 * Synthetic-frame test for the capture state machine in public/capture.js.
 *
 * Drives _tick() directly with scripted grayscale frames, so the gate's decisions can be asserted
 * without a camera, a machine, or a browser. That matters more here than for most code: every bug
 * this gate has had (WAIT_CLEAR being a no-op, slow-drift capture, and now capturing bare
 * platform) was invisible on screen and only showed up as strange rows in a manifest hours later.
 *
 * Run: node scripts/capture-gate-test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DIFF_W = 64;
const DIFF_H = 48;
const PIXELS = DIFF_W * DIFF_H;

// ── minimal DOM shim ────────────────────────────────────────────────────────
// capture.js only needs canvases to exist; every frame the tests care about is injected by
// overriding _sampleGray, so getImageData never has to produce anything meaningful.
function makeCanvas() {
  return {
    width: 0,
    height: 0,
    getContext: () => ({
      drawImage() {},
      getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    }),
    toBlob(cb) { cb({ size: 1000 }); },
  };
}

const sandbox = {
  window: {},
  document: { createElement: (tag) => (tag === 'canvas' ? makeCanvas() : { style: {} }) },
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Uint8ClampedArray,
  Math,
  Date,
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  atob: (b) => Buffer.from(b, 'base64').toString('binary'),
  navigator: { mediaDevices: {} },
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
  fetch: () => Promise.reject(new Error('no network in this test')),
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'capture.js'), 'utf8'), sandbox);

const Lib = sandbox.window.CardSorterCapture;
const S = Lib.STATE;

// ── frame fixtures ──────────────────────────────────────────────────────────
const flat = (v) => { const g = new Uint8ClampedArray(PIXELS); g.fill(v); return g; };
/** Bare platform: uniform bright, plus a little sensor noise so it is never bit-identical. */
const platform = (seed) => {
  const g = new Uint8ClampedArray(PIXELS);
  for (let i = 0; i < PIXELS; i++) g[i] = 210 + ((i * 7 + seed) % 3);
  return g;
};
/** A card: dark border and busy interior — far from platform in mean-abs terms. */
const card = (seed) => {
  const g = new Uint8ClampedArray(PIXELS);
  for (let i = 0; i < PIXELS; i++) {
    const x = i % DIFF_W, y = (i / DIFF_W) | 0;
    const border = x < 6 || x > DIFF_W - 7 || y < 4 || y > DIFF_H - 5;
    g[i] = border ? 20 : 60 + ((x * 13 + y * 29 + seed) % 120);
  }
  return g;
};

const SETTINGS = {
  captureCropZoomPct: 100, captureCropVPosPct: 50,
  frameDiffThreshold: 12, stableFrames: 3,
  confirmMinSpanMs: 500, confirmMaxDrift: 6, confirmMaxAttempts: 5,
  hopperEmptyTimeoutMs: 8000,
  cardPresenceMinDiff: 10,
  emptyPlatformBaseline: null, emptyPlatformCrop: null,
};

function makeRig(overrides) {
  const events = { captures: 0, noCard: [], stalls: [], hopperEmpty: 0 };
  const rig = new Lib.CaptureRig({
    video: { videoWidth: 1080, videoHeight: 1920 },
    settings: { ...SETTINGS, ...overrides },
    onCapture: () => { events.captures++; },
    onNoCard: (d) => events.noCard.push(d),
    onStall: (r) => events.stalls.push(r),
    onHopperEmpty: () => { events.hopperEmpty++; },
  });
  // _triggerCapture is async and touches canvases/blobs; the gate's DECISION is what is under
  // test, so stub the encode step and count the intent instead. It must still move to SCANNING
  // like the real one does — _tick() returns early in that state, and without it a single settled
  // frame would be re-captured on every subsequent tick.
  rig._triggerCapture = (meta) => { events.captures++; events.lastMeta = meta; rig._setState(S.SCANNING); };
  rig.feed = (frame) => { rig._sampleGray = () => frame; rig._tick(); };
  return { rig, events };
}

/** Holds one frame steady for long enough to clear stableFrames AND confirmMinSpanMs. */
function settle(rig, frame, ticks = 8) {
  const realNow = Date.now;
  let t = realNow.call(Date);
  Date.now = () => t;
  try {
    for (let i = 0; i < ticks; i++) { t += 200; rig.feed(frame); }
  } finally {
    Date.now = realNow;
  }
}

// ── assertions ──────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}

console.log('\nbaseline encode/decode');
{
  const g = platform(0);
  const b64 = Lib.encodeGray(g);
  const crop = Lib.getCrop(SETTINGS);
  const back = Lib.decodeBaseline(b64, crop, crop);
  check('round-trips exactly', back && Lib.meanAbsDiff(g, back) === 0);
  check('rejects a baseline from a different crop',
    Lib.decodeBaseline(b64, crop, { ...crop, width: crop.width + 0.2 }) === null);
  check('accepts a crop within float tolerance',
    Lib.decodeBaseline(b64, crop, { ...crop, width: crop.width + 0.001 }) !== null);
  check('null baseline decodes to null', Lib.decodeBaseline(null, crop, crop) === null);
  check('garbage baseline decodes to null rather than throwing',
    Lib.decodeBaseline('!!!not base64!!!', crop, crop) === null);
}

console.log('\nno baseline configured — behaviour must be unchanged');
{
  const { rig, events } = makeRig({});
  rig._setState(S.CHANGING);
  settle(rig, platform(0));
  check('captures bare platform when no baseline is set (the old behaviour)', events.captures === 1,
    'captures=' + events.captures);
  check('onNoCard not called', events.noCard.length === 0);
}

const crop = Lib.getCrop(SETTINGS);
const withBaseline = { emptyPlatformBaseline: Lib.encodeGray(platform(0)), emptyPlatformCrop: crop };

console.log('\nbaseline configured');
{
  const { rig, events } = makeRig(withBaseline);
  rig._setState(S.CHANGING);
  settle(rig, platform(1));
  check('does NOT capture bare platform', events.captures === 0, 'captures=' + events.captures);
  check('reports onNoCard', events.noCard.length >= 1);
  check('returns to ARMED so the hopper-empty timer can run', rig.state === S.ARMED, 'state=' + rig.state);
}
{
  const { rig, events } = makeRig(withBaseline);
  rig._setState(S.CHANGING);
  settle(rig, card(3));
  check('DOES capture a real card', events.captures === 1, 'captures=' + events.captures);
  check('onNoCard not called for a card', events.noCard.length === 0);
}

console.log('\nstale baseline (crop moved since it was taken)');
{
  const { rig, events } = makeRig({
    emptyPlatformBaseline: Lib.encodeGray(platform(0)),
    emptyPlatformCrop: { left: crop.left, top: crop.top + 0.3, width: crop.width, height: crop.height },
  });
  rig._setState(S.CHANGING);
  settle(rig, platform(1));
  check('falls back to capturing rather than silently suppressing', events.captures === 1,
    'captures=' + events.captures);
}

console.log('\nthreshold boundary');
{
  const base = platform(0);
  const near = flat(210 + 9);   // ~9 from baseline: below the 10 threshold -> no card
  const far = flat(210 + 40);   // ~40 from baseline: above -> card
  {
    const { rig, events } = makeRig(withBaseline);
    rig._setState(S.CHANGING);
    settle(rig, near);
    check('diff just under threshold is treated as empty', events.captures === 0,
      'diff=' + Lib.meanAbsDiff(near, base).toFixed(2) + ' captures=' + events.captures);
  }
  {
    const { rig, events } = makeRig(withBaseline);
    rig._setState(S.CHANGING);
    settle(rig, far);
    check('diff over threshold captures', events.captures === 1,
      'diff=' + Lib.meanAbsDiff(far, base).toFixed(2) + ' captures=' + events.captures);
  }
}

console.log('\nregression: the gate this sits inside must still work');
{
  // Slow drift must still be refused — the presence check must not accidentally short-circuit
  // the drift confirmation by capturing something that never settled.
  const { rig, events } = makeRig(withBaseline);
  rig._setState(S.CHANGING);
  const realNow = Date.now;
  let t = realNow.call(Date);
  Date.now = () => t;
  try {
    // Creeping card: each tick moves a little (under frameDiffThreshold) but drifts far from anchor.
    for (let i = 0; i < 10; i++) {
      t += 200;
      const g = card(0);
      for (let p = 0; p < PIXELS; p++) g[p] = Math.max(0, Math.min(255, g[p] + i * 9));
      rig.feed(g);
    }
  } finally { Date.now = realNow; }
  check('a creeping card is not captured', events.captures === 0, 'captures=' + events.captures);
}
{
  // With stableFrames=3 and 200ms ticks: the anchor is set on tick 1, stableCount reaches 3 on
  // tick 3 (span=400ms, still under confirmMinSpanMs=500 -> must NOT capture), and by tick 4 the
  // span is 600ms -> must capture. Both sides of that boundary are worth asserting, since an
  // off-by-one here previously produced a false failure in this test, not in the app.
  const { rig, events } = makeRig(withBaseline);
  rig._setState(S.CHANGING);
  const realNow = Date.now;
  let t = realNow.call(Date);
  Date.now = () => t;
  try {
    for (let i = 0; i < 3; i++) { t += 200; rig.feed(card(7)); }
    check('does not capture before confirmMinSpanMs has elapsed (span=400ms)', events.captures === 0,
      'captures=' + events.captures);
    t += 200; rig.feed(card(7));
    check('captures once confirmMinSpanMs has elapsed (span=600ms)', events.captures === 1,
      'captures=' + events.captures);
  } finally { Date.now = realNow; }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail === 0 ? 0 : 1);
