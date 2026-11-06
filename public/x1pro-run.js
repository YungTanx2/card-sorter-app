/**
 * Host-driven X1PRO run loop over Bluetooth — the run-page half of x1pro-ble.js.
 *
 * x1pro-ble.js knows how to talk to the machine; this file knows what a sorting run IS:
 * lease → batch.start → (feed → card held → ask the page for a route → route) repeated until the
 * hopper runs dry. Every step here was first walked by hand on the real unit through /ble.html
 * (fw 0.3.25-pilot.81), and the predicates are the ones that held there.
 *
 * Shared by every run page for the same reason capture.js is: the page decides WHICH bin a card
 * goes to, nothing else. The page supplies onCardHeld(), which must photograph + identify the
 * card and resolve to a route id — or throw, which pauses the run with the card still held.
 *
 * Deliberately NOT set: the firmware's host result policy (host_no_result_action:"route_other").
 * It would auto-route a card the phone hasn't answered for within N seconds — which turns a slow
 * scan into a keeper silently dropped in the bulk pile. This app's rule is pause, never guess
 * (plan Decision #12). The lease is the dead-man switch instead: if the page dies, renewals stop,
 * the lease lapses, and the machine stops with the card still held.
 */
window.X1ProRun = (function () {
  'use strict';

  const { X1ProConnection, LEASED_COMMANDS, cycleRef } = window.X1ProBle;

  const LEASE_TTL_MS = 15000;
  const LEASE_RENEW_MS = 5000;
  // Verified on the rig: route 10 → routed_pass → the ACCEPT bin, 20 → the REJECT bin.
  const ROUTE = Object.freeze({ ACCEPT: 10, REJECT: 20 });
  // The card is held still at WAIT_RESULT, but the camera's preview lags the world by a frame or
  // two — wait this long after the machine says "held" before taking the photo.
  const CAPTURE_DELAY_MS = 250;

  const faulted = (st) => !!st.fault_code && st.fault_code !== 'NONE';
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  class X1ProRunDriver {
    /**
     * @param {object} opts
     * @param {X1ProConnection} opts.conn       authenticated connection (conn.connected === true)
     * @param {function} opts.onCardHeld        async () => routeId | { routeId, last }. Called
     *                                          with the card held under the camera. Throwing
     *                                          pauses the run. last:true routes this card and
     *                                          then ends the run instead of feeding another.
     * @param {function} [opts.onHopperEmpty]   () => void — feed found no card
     * @param {function} [opts.onLastRouted]    () => void — a card returned with last:true has
     *                                          been routed; no further card was fed
     * @param {function} [opts.onPause]         (err) => void — run paused; card may be held
     * @param {function} [opts.onState]         (label) => void — short human-readable progress
     * @param {function} [opts.onLog]           (msg) => void
     */
    constructor(opts) {
      this.conn = opts.conn;
      this.onCardHeld = opts.onCardHeld;
      this.onHopperEmpty = opts.onHopperEmpty || (() => {});
      this.onLastRouted = opts.onLastRouted || (() => {});
      this.onPause = opts.onPause || (() => {});
      this.onState = opts.onState || (() => {});
      this.log = opts.onLog || (() => {});
      this.leaseTimer = null;
      this.running = false;
      this.stopping = false;
      this.held = null;   // { ref, routedBefore } for the card under the camera, if any
    }

    async _cmd(name, args) {
      const r = await this.conn.command(name, args, LEASED_COMMANDS.includes(name) ? this.conn.lease : null);
      if (r.accepted === false) throw new Error(name + ' rejected: ' + r.result);
      return r;
    }

    async _acquireLease() {
      await this._cmd('device.acquire_lease', { lease_ttl_ms: LEASE_TTL_MS });
      if (!this.conn.lease) throw new Error('acquire_lease accepted but granted no lease id');
      this._stopLeaseTimer();
      this.leaseTimer = setInterval(() => {
        if (!this.conn.connected || !this.conn.lease) return;
        this.conn.command('device.renew_lease', { lease_ttl_ms: LEASE_TTL_MS }, this.conn.lease)
          .then((r) => { if (r.accepted === false) this.log('renew_lease rejected: ' + r.result); })
          .catch((e) => this.log('renew_lease failed: ' + e.message));
      }, LEASE_RENEW_MS);
    }

    _stopLeaseTimer() {
      if (this.leaseTimer) { clearInterval(this.leaseTimer); this.leaseTimer = null; }
    }

    /** Lease + batch.start, mirroring the sequence verified in /ble.html. */
    async start() {
      if (!this.conn || !this.conn.connected) throw new Error('X1PRO is not connected');
      if (!this.conn.capabilities.cycleControl) throw new Error('This firmware does not support host cycle control');
      this.onState('TAKING CONTROL…');
      await this._acquireLease();

      // A fresh connection sits in IDLE_UNSYNCED for a few seconds after the lease. A batch left
      // running by an earlier tab must be stopped first, or batch.start has nothing to start.
      let s = (await this._cmd('device.get_status')).status;
      if (s.batch_active) {
        this.log('stopping a batch left running by an earlier session');
        try { await this._cmd('batch.stop', {}); } catch (e) { this.log('batch.stop: ' + e.message); }
      }
      try {
        s = await this.conn.waitFor((st) => st.machine_state === 'READY' && st.run_request === 'STOPPED', 8000, 'READY');
      } catch (e) {
        this.log(e.message + ' — trying batch.start anyway');
      }

      // Firmware rejects a bare batch.start as NONCANONICAL_REQUEST: it must echo the device's own
      // sound_enabled and motion profile (dock_ms forced to 0), exactly as the vendor app does.
      const settings = await this._cmd('settings.get');
      if (settings.kind !== 'machine_settings' || !settings.settings) throw new Error('settings.get: unexpected reply ' + settings.kind);
      const args = { mode: 'continuous', target_count: 0, sound_enabled: settings.settings.sound_enabled === true };
      if (this.conn.capabilities.extensibilityVersion === 1) {
        const motion = await this._cmd('motion.get');
        if (motion.kind !== 'motion_settings' || !motion.profile) throw new Error('motion.get: unexpected reply ' + motion.kind);
        args.motion_profile = { ...motion.profile, dock_ms: 0 };
      }
      await this._cmd('batch.start', args);
      this.status = await this.conn.waitFor(
        (st) => st.machine_state === 'PREPARE_WINDOW' && st.run_request === 'RUNNING' && st.batch_active === true,
        4500, 'BATCH_START');
      this.log('batch running');
      this._loop();
    }

    /** The cycle. Any throw lands in onPause with the machine left exactly where it stopped —
     *  the lease keeps renewing, so a held card stays held until resume() or stop(). */
    async _loop() {
      if (this.running) return;
      this.running = true;
      try {
        while (!this.stopping) {
          if (!this.held) {
            const fed = await this._feed();
            if (!fed) { this.running = false; this.onHopperEmpty(); return; }
          }
          await wait(CAPTURE_DELAY_MS);
          const answer = await this.onCardHeld();
          if (this.stopping) break;
          const last = typeof answer === 'object' && answer !== null && answer.last === true;
          await this._route(typeof answer === 'object' && answer !== null ? answer.routeId : answer);
          // Route BEFORE ending: stopping first would leave the machine holding a card it was
          // never told where to put.
          if (last) { this.running = false; this.onLastRouted(); return; }
        }
      } catch (err) {
        this.running = false;
        if (!this.stopping) { this.log('paused: ' + err.message); this.onPause(err); }
        return;
      }
      this.running = false;
    }

    async _feed() {
      this.onState('FEEDING');
      // The previous route's confirmation (or batch.start) already left a fresh status; only ask
      // the machine again if that status isn't the PREPARE_WINDOW we need to build the cycle ref.
      let s = this.status;
      if (!s || s.machine_state !== 'PREPARE_WINDOW') s = (await this._cmd('device.get_status')).status;
      if (s.machine_state !== 'PREPARE_WINDOW') throw new Error('machine not ready to feed (' + s.machine_state + ', ' + s.pause_reason + ')');
      const ref = cycleRef(s);
      const fedBefore = s.counters.fed;
      const args = { ...ref };
      // Prefeed stages the next card at the hopper, out of the camera's view (verified on the rig).
      if (this.conn.capabilities.prefeed) args.prefeed_after = true;
      await this._cmd('cycle.feed', args);
      const after = await this.conn.waitFor((st) =>
        (st.machine_state === 'WAIT_RESULT' && st.counters.fed === fedBefore + 1) ||
        (st.machine_state === 'PAUSED_RECOVERABLE' && st.pause_reason === 'WAIT_NEXT_CARD') ||
        faulted(st),
        15000, 'FEED');
      this.status = after;
      if (faulted(after)) throw new Error('machine fault ' + after.fault_code);
      if (after.machine_state === 'PAUSED_RECOVERABLE') return false;
      this.held = { ref: cycleRef(after), routedBefore: after.counters.routed };
      return true;
    }

    async _route(routeId) {
      if (!this.conn.capabilities.routeIds.includes(routeId)) throw new Error('route id ' + routeId + ' not offered by this machine');
      this.onState('ROUTING');
      const h = this.held;
      await this._cmd('cycle.route', { ...h.ref, route_id: routeId });
      const after = await this.conn.waitFor((st) =>
        (st.counters.routed === h.routedBefore + 1 && st.servo_action !== 'ROUTE' &&
          ['PREPARE_WINDOW', 'PAUSED_RECOVERABLE', 'READY'].includes(st.machine_state)) ||
        faulted(st),
        8000, 'ROUTE');
      this.status = after;
      if (faulted(after)) throw new Error('machine fault ' + after.fault_code);
      // Counted as routed by the machine itself — the card is physically in a bin.
      this.held = null;
    }

    /**
     * After a pause: look at where the machine actually is, then carry on from there. A card
     * still at WAIT_RESULT for the cycle we fed is re-photographed (onCardHeld again) — a fresh
     * photo of a held card is never worse than re-sending the old one.
     */
    async resume() {
      if (this.running) return;
      if (!this.conn.connected) throw new Error('X1PRO disconnected — reconnect it on the Setup tab, then come back and Resume');
      // A reconnect is a new session with no lease; the old one lapsed with the link.
      if (!this.conn.lease) await this._acquireLease();
      const s = (await this._cmd('device.get_status')).status;
      this.status = s;
      if (this.held) {
        const sameCycle = s.machine_state === 'WAIT_RESULT' && s.cycle_seq === this.held.ref.cycle_seq &&
          s.batch_seq === this.held.ref.batch_seq;
        if (!sameCycle && s.counters.routed > this.held.routedBefore) this.held = null;  // it did route
        else if (!sameCycle) throw new Error('machine is in ' + s.machine_state + ' — the held card was lost track of. Clear the card path, then finish this run and start another.');
      }
      if (!s.batch_active || s.run_request !== 'RUNNING') throw new Error('the batch is no longer running (' + s.machine_state + ') — finish this run and start another.');
      this._loop();
    }

    /** Stop the batch and hand control back. Best effort — the lease lapses on its own anyway. */
    async stop() {
      this.stopping = true;
      this._stopLeaseTimer();
      if (!this.conn || !this.conn.connected) return;
      try { await this._cmd('batch.stop', {}); } catch (e) { this.log('batch.stop: ' + e.message); }
      if (this.conn.lease) {
        try { await this._cmd('device.release_lease', {}); } catch (e) { this.log('release_lease: ' + e.message); }
        this.conn.lease = null;
      }
    }
  }

  /**
   * The Connect/Disconnect button both run pages share. It lives outside Start Run because
   * requestDevice() needs a fresh tap, and starting a run spends that tap on server work before
   * the camera even opens. A connection belongs to one page load: navigating between the price
   * sorter and Set Builder drops it, so each page connects for itself.
   *
   * @returns {{ conn: X1ProConnection|null }} live getter — null whenever not connected
   */
  function connectControl(button, stateEl, opts) {
    opts = opts || {};
    const idle = opts.idleText || 'not connected — runs use audio cues';
    let machine = null;
    function render(text, ok) {
      stateEl.textContent = text;
      stateEl.className = 'machine-state' + (ok ? ' ok' : '');
      button.textContent = ok ? 'Disconnect X1PRO' : 'Connect X1PRO (Bluetooth)';
    }
    button.addEventListener('click', async () => {
      if (machine && machine.connected) { machine.disconnect(); return; }
      const conn = new X1ProConnection({
        onLog: (m) => console.log('[x1pro]', m),
        onDisconnect: () => {
          if (machine === conn) machine = null;
          render('disconnected — runs use audio cues', false);
        },
      });
      button.disabled = true;
      render('connecting… confirm the Android pairing prompt if it appears', false);
      try {
        await conn.connect();
        if (!conn.capabilities.cycleControl) throw new Error('this firmware has no host cycle control');
        machine = conn;
        render('connected · ' + conn.info.device_id + ' · fw ' + conn.capabilities.firmware, true);
      } catch (err) {
        conn.disconnect();
        render('not connected — ' + err.message, false);
      } finally {
        button.disabled = false;
      }
    });
    render(idle, false);
    if (!X1ProConnection.supported()) {
      button.disabled = true;
      render('Bluetooth unavailable in this browser — runs use audio cues', false);
    }
    return { get conn() { return machine && machine.connected ? machine : null; } };
  }

  return { X1ProRunDriver, ROUTE, connectControl };
})();
