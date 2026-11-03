/**
 * Run-loop tests for public/x1pro-run.js against a simulated X1PRO.
 *
 * The fake machine models only what the driver relies on, using the state names and counters
 * observed on the real unit (fw 0.3.25-pilot.81): PREPARE_WINDOW → feed → WAIT_RESULT →
 * route → PREPARE_WINDOW, and PAUSED_RECOVERABLE/WAIT_NEXT_CARD when the hopper is empty.
 *
 *   node scripts/x1pro-run-test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

global.window = {
  X1ProBle: {
    LEASED_COMMANDS: ['device.renew_lease', 'device.release_lease', 'batch.start', 'cycle.feed', 'cycle.route'],
    cycleRef: (s) => ({ boot_id: s.boot_id, batch_seq: s.batch_seq, cycle_seq: s.cycle_seq }),
  },
};
eval(fs.readFileSync(path.join(__dirname, '..', 'public', 'x1pro-run.js'), 'utf8'));
const { X1ProRunDriver, ROUTE } = window.X1ProRun;

class FakeMachine {
  constructor(cards) {
    this.cards = cards;
    this.connected = true;
    this.lease = null;
    this.capabilities = { cycleControl: true, routeIds: [10, 20], prefeed: true, extensibilityVersion: 1 };
    this.s = {
      boot_id: '1', batch_seq: '1', cycle_seq: '1', machine_state: 'IDLE_UNSYNCED', run_request: 'STOPPED',
      batch_active: false, fault_code: 'NONE', pause_reason: 'NONE', servo_action: 'DISABLED',
      counters: { fed: 0, routed: 0, routed_pass: 0, routed_fail: 0 },
    };
    this.sent = [];
  }
  snap() { return JSON.parse(JSON.stringify(this.s)); }
  async command(name, args, leaseId) {
    this.sent.push({ name, args, leaseId });
    const s = this.s;
    switch (name) {
      case 'device.acquire_lease':
        this.lease = 'L1';
        setTimeout(() => { if (!s.batch_active) s.machine_state = 'READY'; }, 5);
        return { kind: 'ack', accepted: true, granted_lease_id: 'L1', status: this.snap() };
      case 'device.get_status': return { kind: 'ack', accepted: true, status: this.snap() };
      case 'settings.get': return { kind: 'machine_settings', settings: { sound_enabled: true } };
      case 'motion.get': return { kind: 'motion_settings', profile: { hold_ms: 300, dock_ms: 50 } };
      case 'batch.start':
        assert.strictEqual(leaseId, 'L1');
        assert.strictEqual(args.motion_profile.dock_ms, 0, 'dock_ms forced to 0');
        Object.assign(s, { machine_state: 'PREPARE_WINDOW', run_request: 'RUNNING', batch_active: true, batch_seq: '2' });
        return { kind: 'ack', accepted: true };
      case 'cycle.feed':
        assert.strictEqual(args.cycle_seq, s.cycle_seq, 'feed echoes current cycle_seq');
        assert.strictEqual(args.prefeed_after, true);
        if (s.machine_state !== 'PREPARE_WINDOW') return { kind: 'ack', accepted: false, result: 'BAD_STATE' };
        setTimeout(() => {
          if (this.cards.length) { s.counters.fed++; s.machine_state = 'WAIT_RESULT'; }
          else { s.machine_state = 'PAUSED_RECOVERABLE'; s.pause_reason = 'WAIT_NEXT_CARD'; }
        }, 10);
        return { kind: 'ack', accepted: true };
      case 'cycle.route': {
        assert.strictEqual(args.cycle_seq, s.cycle_seq, 'route echoes held cycle_seq');
        if (s.machine_state !== 'WAIT_RESULT') return { kind: 'ack', accepted: false, result: 'BAD_STATE' };
        s.servo_action = 'ROUTE';
        setTimeout(() => {
          this.cards.shift();
          s.counters.routed++;
          s.counters[args.route_id === 10 ? 'routed_pass' : 'routed_fail']++;
          s.cycle_seq = String(Number(s.cycle_seq) + 1);
          s.servo_action = 'DISABLED';
          s.machine_state = 'PREPARE_WINDOW';
        }, 10);
        return { kind: 'ack', accepted: true };
      }
      case 'batch.stop':
        Object.assign(s, { machine_state: 'READY', run_request: 'STOPPED', batch_active: false });
        return { kind: 'ack', accepted: true };
      case 'device.release_lease': this.lease = null; return { kind: 'ack', accepted: true };
      case 'device.renew_lease': return { kind: 'ack', accepted: true };
      default: throw new Error('unexpected command ' + name);
    }
  }
  async waitFor(pred, timeoutMs, label) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const st = this.snap();
      if (pred(st)) return st;
      if (Date.now() > end) throw new Error(label + '_TIMEOUT');
      await new Promise((r) => setTimeout(r, 2));
    }
  }
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log('ok  ' + name);
}

function runUntil(driver, event) {
  return new Promise((resolve, reject) => {
    driver.onHopperEmpty = () => resolve('empty');
    driver.onPause = (err) => (event === 'pause' ? resolve(err) : reject(err));
  });
}

(async () => {
  await test('sorts a pile: keepers to 10, bulk to 20, stops on empty hopper', async () => {
    const m = new FakeMachine(['keeper', 'bulk', 'keeper']);
    const seen = [];
    const d = new X1ProRunDriver({
      conn: m,
      onCardHeld: async () => { const c = m.cards[0]; seen.push(c); return c === 'keeper' ? ROUTE.ACCEPT : ROUTE.REJECT; },
    });
    const done = runUntil(d, 'empty');
    await d.start();
    assert.strictEqual(await done, 'empty');
    assert.deepStrictEqual(seen, ['keeper', 'bulk', 'keeper']);
    assert.strictEqual(m.s.counters.routed_pass, 2);
    assert.strictEqual(m.s.counters.routed_fail, 1);
    // Routes carry the lease; status polls never do (fw answers INVALID_COMMAND to that).
    assert(m.sent.filter((c) => c.name === 'cycle.route').every((c) => c.leaseId === 'L1'));
    assert(m.sent.filter((c) => c.name === 'device.get_status').every((c) => c.leaseId === null));
    await d.stop();
    assert.strictEqual(m.lease, null);
    assert.strictEqual(m.s.batch_active, false);
  });

  await test('a failed scan pauses with the card held; resume re-photographs and routes it', async () => {
    const m = new FakeMachine(['keeper', 'bulk']);
    let calls = 0;
    const d = new X1ProRunDriver({
      conn: m,
      onCardHeld: async () => { calls++; if (calls === 1) throw new Error('503 recognition busy'); return ROUTE.ACCEPT; },
    });
    let paused = runUntil(d, 'pause');
    await d.start();
    const err = await paused;
    assert.match(err.message, /503/);
    assert.strictEqual(m.s.machine_state, 'WAIT_RESULT', 'card still held');
    assert.strictEqual(m.s.counters.routed, 0, 'nothing routed on a failed scan');
    const done = runUntil(d, 'empty');
    await d.resume();
    assert.strictEqual(await done, 'empty');
    assert.strictEqual(calls, 3, 'held card photographed again, then the second card');
    assert.strictEqual(m.s.counters.routed, 2);
    await d.stop();
  });

  await test('a route whose ack was lost but which landed is not routed twice', async () => {
    const m = new FakeMachine(['bulk', 'bulk']);
    const d = new X1ProRunDriver({ conn: m, onCardHeld: async () => ROUTE.REJECT });
    // Route the first card, but make the driver believe the link dropped before the ack.
    const orig = m.command.bind(m);
    let dropped = false;
    m.command = async (name, args, lease) => {
      const r = await orig(name, args, lease);
      if (name === 'cycle.route' && !dropped) { dropped = true; throw new Error('GATT_DISCONNECTED'); }
      return r;
    };
    const paused = runUntil(d, 'pause');
    await d.start();
    await paused;
    await new Promise((r) => setTimeout(r, 30));   // the route completes on the machine anyway
    const done = runUntil(d, 'empty');
    await d.resume();
    assert.strictEqual(await done, 'empty');
    assert.strictEqual(m.s.counters.routed, 2, 'exactly two routes for two cards');
    assert.strictEqual(m.sent.filter((c) => c.name === 'cycle.route').length, 2);
    await d.stop();
  });

  await test('an empty hopper on the first feed ends the run without routing anything', async () => {
    const m = new FakeMachine([]);
    let held = 0;
    const d = new X1ProRunDriver({ conn: m, onCardHeld: async () => { held++; return ROUTE.REJECT; } });
    const done = runUntil(d, 'empty');
    await d.start();
    assert.strictEqual(await done, 'empty');
    assert.strictEqual(held, 0);
    await d.stop();
  });

  await test('a batch left running by an earlier tab is stopped before starting', async () => {
    const m = new FakeMachine(['bulk']);
    Object.assign(m.s, { machine_state: 'PREPARE_WINDOW', run_request: 'RUNNING', batch_active: true });
    const d = new X1ProRunDriver({ conn: m, onCardHeld: async () => ROUTE.REJECT });
    const done = runUntil(d, 'empty');
    await d.start();
    await done;
    const names = m.sent.map((c) => c.name);
    assert(names.indexOf('batch.stop') < names.indexOf('batch.start'));
    await d.stop();
  });

  await test('a route id the machine does not offer pauses instead of being sent', async () => {
    const m = new FakeMachine(['bulk']);
    const d = new X1ProRunDriver({ conn: m, onCardHeld: async () => 99 });
    const paused = runUntil(d, 'pause');
    await d.start();
    assert.match((await paused).message, /route id 99/);
    assert.strictEqual(m.sent.filter((c) => c.name === 'cycle.route').length, 0);
    await d.stop();
  });

  console.log('all ' + passed + ' passed');
  process.exit(0);
})().catch((err) => { console.error('FAIL', err); process.exit(1); });
