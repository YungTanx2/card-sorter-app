/**
 * X1PRO wireless control over Web Bluetooth — the digital replacement for Sound Learn audio cues.
 *
 * Nothing here is documented by the vendor. It is reconstructed from their own scanner app
 * (mtg.tcgverifier.com, bundle index-BUUcPCVL.js, 2026-11-01); the byte-level notes live in the
 * research_tcgverifier-mtg-app memory. Treat every constant as "what their app sends", not as a
 * spec, and expect firmware to disagree in places — that is what ble.html exists to find out.
 *
 * Three layers, bottom up:
 *   1. Transport frames — 'X' header + CRC-32, chunked to the BLE packet size, over rx/tx.
 *   2. Secure channel — AES-256-GCM, key = HKDF(pairing key, per-connection session_nonce).
 *   3. Commands — JSON {v, kind:"command", name, args, lease_id, ...} -> JSON ack/error.
 *
 * Plain script (not an ESM module) exposing one global, same as capture.js and audio.js.
 * Web Bluetooth needs Chrome on Android or desktop over HTTPS/localhost — there is none on iOS.
 */
window.X1ProBle = (function () {
  'use strict';

  const UUID = Object.freeze({
    service:    '46e70001-5c91-4d60-9c3b-72a611407b80',
    rx:         '46e70002-5c91-4d60-9c3b-72a611407b80',   // app -> device, write with response
    tx:         '46e70003-5c91-4d60-9c3b-72a611407b80',   // device -> app, notifications
    info:       '46e70004-5c91-4d60-9c3b-72a611407b80',   // JSON profile + session_nonce
    pairingKey: '46e70005-5c91-4d60-9c3b-72a611407b80',   // 32-byte long-term key, OS-bond protected
  });

  const PROFILE = 'x1pro-ble-wireless-control-v1';
  const HKDF_INFO = 'X1PRO-BLE-CONTROL-v1';
  const FRAME_HEADER = 12;
  const MAX_PAYLOAD = 2048;
  const MAX_PACKET = 512;
  // Web Bluetooth exposes no MTU, so start at the BLE minimum. The vendor only promotes past 20
  // after observing larger response packets; 20 is slow but can't be wrong.
  const DEFAULT_PACKET = 20;
  const REPLY_TIMEOUT_MS = 30000;
  const STORE_KEY = 'x1pro-ble-pairing-v1';

  const enc = new TextEncoder();
  const dec = new TextDecoder('utf-8', { fatal: true });
  const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
  const unhex = (s) => Uint8Array.from(s.match(/../g), (h) => parseInt(h, 16));

  // ═══════════════════════ 1. TRANSPORT FRAMES ═══════════════════════════

  /** CRC-32, reflected, poly 0xEDB88320 — over the WHOLE payload, repeated in every chunk. */
  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (const b of bytes) {
      c ^= b;
      for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xEDB88320 : 0);
    }
    return ~c >>> 0;
  }

  /**
   * Header (little-endian): [0]'X' [1]version [2-3]id [4-5]totalLength [6-7]offset [8-11]crc32.
   * Every chunk carries the full-payload length and CRC, so the receiver can validate on the last.
   */
  function encodeFrames(payload, id, packetSize, version) {
    const crc = crc32(payload);
    const step = packetSize - FRAME_HEADER;
    const out = [];
    for (let off = 0; off < payload.length; off += step) {
      const chunk = payload.subarray(off, off + step);
      const pkt = new Uint8Array(FRAME_HEADER + chunk.length);
      const dv = new DataView(pkt.buffer);
      pkt[0] = 0x58;
      pkt[1] = version;
      dv.setUint16(2, id, true);
      dv.setUint16(4, payload.length, true);
      dv.setUint16(6, off, true);
      dv.setUint32(8, crc, true);
      pkt.set(chunk, FRAME_HEADER);
      out.push(pkt);
    }
    return out;
  }

  /** Reassembles notification packets into one payload. Strictly in-order — the device sends
   *  chunks sequentially, and anything else means a dropped packet, which should fail loudly. */
  class Reassembler {
    constructor() { this.reset(); }
    reset() { this.active = false; this.buf = null; this.received = 0; }
    accept(pkt) {
      if (pkt.length <= FRAME_HEADER || pkt.length > MAX_PACKET || pkt[0] !== 0x58) return { status: 'INVALID' };
      const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
      const id = dv.getUint16(2, true), total = dv.getUint16(4, true);
      const off = dv.getUint16(6, true), crc = dv.getUint32(8, true);
      const body = pkt.subarray(FRAME_HEADER);
      if (!total || total > MAX_PAYLOAD || off >= total || body.length > total - off) return { status: 'INVALID' };
      if (!this.active) {
        if (off !== 0) return { status: 'INVALID' };
        Object.assign(this, { active: true, id, total, crc, buf: new Uint8Array(total), received: 0 });
      }
      if (id !== this.id || total !== this.total || crc !== this.crc || off !== this.received) {
        this.reset();
        return { status: 'INVALID' };
      }
      this.buf.set(body, off);
      this.received += body.length;
      if (this.received < total) return { status: 'MORE' };
      const bytes = this.buf;
      this.reset();
      return crc32(bytes) === crc ? { status: 'COMPLETE', bytes } : { status: 'INVALID' };
    }
  }

  // ═══════════════════════ 2. SECURE CHANNEL ═══════════════════════════

  async function deriveSessionKey(key32, nonce16) {
    const ikm = await crypto.subtle.importKey('raw', key32, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: nonce16, info: enc.encode(HKDF_INFO) },
      ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  /** 16 bytes: "X1A1", [4] 1=request 2=response, [8-15] uint64 sequence BIG-endian. */
  function secureHeader(direction, seq) {
    const h = new Uint8Array(16);
    h.set(enc.encode('X1A1'));
    h[4] = direction;
    new DataView(h.buffer).setBigUint64(8, seq, false);
    return h;
  }

  /** IV = "REQ1"|"RSP1" + the header's 8 sequence bytes; AAD = header + session nonce, so a
   *  frame replayed into a different connection fails authentication. */
  function gcmParams(header, nonce) {
    const iv = new Uint8Array(12);
    iv.set(enc.encode(header[4] === 1 ? 'REQ1' : 'RSP1'));
    iv.set(header.subarray(8), 4);
    const aad = new Uint8Array(32);
    aad.set(header);
    aad.set(nonce, 16);
    return { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 };
  }

  async function seal(key, nonce, seq, plaintext) {
    const h = secureHeader(1, seq);
    const ct = new Uint8Array(await crypto.subtle.encrypt(gcmParams(h, nonce), key, plaintext));
    const out = new Uint8Array(16 + ct.length);
    out.set(h);
    out.set(ct, 16);
    return out;
  }

  async function open(key, nonce, seq, frame) {
    if (frame.length < 33) throw new Error('INVALID_SECURE_FRAME');
    const h = secureHeader(2, seq);
    // The response must echo OUR sequence — a reply to some other request is not this reply.
    if (!h.every((b, i) => b === frame[i])) throw new Error('SECURE_SEQUENCE_MISMATCH');
    return new Uint8Array(await crypto.subtle.decrypt(gcmParams(h, nonce), key, frame.subarray(16)));
  }

  /** boot_id / batch_seq / cycle_seq are uint64 and can exceed 2^53, so JSON.parse would round
   *  them silently. Quote them first; they are only ever echoed back, never computed on. */
  function parseReply(text) {
    return JSON.parse(text.replace(/("(?:boot_id|batch_seq|cycle_seq)"\s*:\s*)([0-9]+)(?=\s*[,}])/g, '$1"$2"'));
  }

  // ═══════════════════════ PAIRING STORE ═══════════════════════════

  function loadPairing(deviceId) {
    try {
      const all = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      return all[deviceId] || null;
    } catch (e) { return null; }
  }

  function savePairing(deviceId, keyHex) {
    try {
      const all = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      all[deviceId] = { key_hex: keyHex, saved_at: new Date().toISOString() };
      localStorage.setItem(STORE_KEY, JSON.stringify(all));
      return true;
    } catch (e) { return false; }
  }

  function forgetPairings() {
    try { localStorage.removeItem(STORE_KEY); } catch (e) { /* nothing to forget */ }
  }

  // ═══════════════════════ 3. CONNECTION + COMMANDS ═══════════════════════════

  class X1ProConnection {
    /** @param {object} [opts] { onLog(msg), onDisconnect() } */
    constructor(opts) {
      opts = opts || {};
      this.onLog = opts.onLog || (() => {});
      this.onDisconnect = opts.onDisconnect || (() => {});
      this.device = null;
      this.rxChar = null;
      this.info = null;
      this.key = null;
      this.nonce = null;
      this.seq = 0n;
      this.frameId = 0;
      this.frameVersion = 1;
      this.packetSize = DEFAULT_PACKET;
      this.lease = null;
      this.pending = null;
      this.queue = Promise.resolve();
      this.reasm = new Reassembler();
    }

    static supported() { return !!(navigator.bluetooth && window.isSecureContext && crypto.subtle); }

    get connected() { return !!(this.device && this.device.gatt.connected && this.key); }

    /** Must be called from a user gesture — requestDevice() refuses otherwise. */
    async connect() {
      if (!X1ProConnection.supported()) {
        throw new Error('Web Bluetooth unavailable — use Chrome on Android or desktop, over HTTPS or localhost.');
      }
      // Service filter first (what the vendor uses); name prefixes in case firmware doesn't
      // advertise the service UUID in its advertisement packet.
      this.device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [UUID.service] }, { namePrefix: 'X1PRO' }, { namePrefix: 'x1pro' }],
        optionalServices: [UUID.service],
      });
      this.device.addEventListener('gattserverdisconnected', () => {
        this.key = null;
        this.lease = null;
        if (this.pending) { this.pending.reject(new Error('GATT_DISCONNECTED')); this.pending = null; }
        this.onLog('disconnected');
        this.onDisconnect();
      });
      this.onLog('selected ' + (this.device.name || this.device.id));

      const gatt = await this.device.gatt.connect();
      const svc = await gatt.getPrimaryService(UUID.service);
      const [rx, tx, infoChar, keyChar] = await Promise.all(
        [UUID.rx, UUID.tx, UUID.info, UUID.pairingKey].map((u) => svc.getCharacteristic(u)));
      this.rxChar = rx;

      const infoView = await infoChar.readValue();
      this.info = JSON.parse(dec.decode(infoView));
      this.onLog('info ' + JSON.stringify(this.info));
      if (this.info.profile !== PROFILE) throw new Error('WRONG_DEVICE_PROFILE: ' + this.info.profile);
      if (this.info.pairing !== 2) throw new Error('PAIRING_NOT_SUPPORTED: pairing=' + this.info.pairing);
      if (!/^x1pro-[A-Za-z0-9_-]{1,58}$/.test(this.info.device_id || '')) throw new Error('INVALID_DEVICE_ID');
      if (!/^[0-9a-f]{32}$/.test(this.info.session_nonce || '')) throw new Error('INVALID_SESSION_NONCE');
      this.nonce = unhex(this.info.session_nonce);

      // Reading the key characteristic is what makes Android raise its pairing prompt (it is
      // encryption-protected). The vendor reads it on EVERY connect to restore link encryption,
      // but only trusts the stored copy after the first pairing — so do the same, and log if the
      // two ever disagree, since that would mean the key rotates.
      this.onLog('reading pairing key — confirm the Android pairing prompt if it appears (up to ~45s)');
      const keyView = await keyChar.readValue();
      if (keyView.byteLength !== 32) throw new Error('PAIRING_KEY_UNAVAILABLE: ' + keyView.byteLength + ' bytes');
      const readHex = hex(new Uint8Array(keyView.buffer, keyView.byteOffset, 32));
      const stored = loadPairing(this.info.device_id);
      let keyHex = readHex;
      if (stored) {
        if (stored.key_hex !== readHex) this.onLog('NOTE: key read differs from stored pairing — using stored (vendor behaviour)');
        keyHex = stored.key_hex;
      } else {
        this.onLog(savePairing(this.info.device_id, readHex) ? 'pairing saved' : 'WARNING: could not persist pairing');
      }

      tx.addEventListener('characteristicvaluechanged', (ev) => this._onPacket(ev.target.value));
      await tx.startNotifications();

      this.key = await deriveSessionKey(unhex(keyHex), this.nonce);
      this.seq = 0n;
      this.frameId = 0;
      this.frameVersion = 1;

      const status = await this.command('device.get_status');
      // Firmware states which frame version it speaks only once authenticated.
      const fv = status.ble_frame_version ?? 1;
      if (fv === 1 || fv === 2) this.frameVersion = fv;
      this.capabilities = {
        cycleControl: status.cycle_control_supported === true,
        routeIds: Array.isArray(status.cycle_route_ids) ? status.cycle_route_ids.slice() : [],
        prefeed: status.prefeed_supported === true,
        hostResultPolicy: status.host_result_policy_supported === true,
        extensibilityVersion: status.extensibility_version === 1 ? 1 : 0,
        firmware: status.firmware_version || null,
      };
      this.onLog('authenticated — ' + JSON.stringify(this.capabilities));
      return status;
    }

    disconnect() {
      if (this.device && this.device.gatt.connected) this.device.gatt.disconnect();
    }

    _onPacket(view) {
      const pkt = new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
      const r = this.reasm.accept(pkt);
      if (r.status === 'INVALID') {
        this.onLog('dropped invalid packet ' + hex(pkt.subarray(0, 12)));
        if (this.pending) { this.pending.reject(new Error('BLE_RESPONSE_INVALID')); this.pending = null; }
      } else if (r.status === 'COMPLETE' && this.pending) {
        this.pending.resolve(r.bytes);
        this.pending = null;
      }
    }

    async _transfer(payload) {
      this.frameId = this.frameId >= 65535 ? 1 : this.frameId + 1;
      const packets = encodeFrames(payload, this.frameId, this.packetSize, this.frameVersion);
      this.reasm.reset();
      const reply = new Promise((resolve, reject) => {
        const t = setTimeout(() => { this.pending = null; reject(new Error('BLE_RESPONSE_TIMEOUT')); }, REPLY_TIMEOUT_MS);
        this.pending = {
          resolve: (b) => { clearTimeout(t); resolve(b); },
          reject: (e) => { clearTimeout(t); reject(e); },
        };
      });
      for (const p of packets) await this.rxChar.writeValueWithResponse(p);
      return reply;
    }

    /**
     * One encrypted request/response. Serialised through a queue: the device answers one
     * request at a time, and a lease renewal racing a route would interleave their packets.
     * Resolves with the parsed reply; throws on kind:"error" or a malformed ack. An ack with
     * accepted:false is RETURNED, not thrown — "the device refused" is information.
     *
     * leaseId is opt-in per call, never defaulted to the held lease: firmware 0.3.25 answers
     * INVALID_COMMAND to a get_status that carries one. The vendor attaches it only to
     * renew_lease, batch.start, cycle.feed and cycle.route — see LEASED_COMMANDS.
     */
    command(name, args, leaseId) {
      const run = async () => {
        if (!this.key) throw new Error('NOT_AUTHENTICATED');
        const seq = this.seq + 1n;
        const id = hex(crypto.getRandomValues(new Uint8Array(16)));
        const msg = {
          v: 1, kind: 'command', id, device_id: this.info.device_id,
          client_id: this.info.session_nonce.slice(0, 16), client_seq: Number(seq),
          name, lease_id: leaseId || null, args: args || {},
        };
        const plain = enc.encode(JSON.stringify(msg));
        if (plain.length > 1024) throw new Error('COMMAND_TOO_LARGE');
        const frame = await seal(this.key, this.nonce, seq, plain);
        this.seq = seq;
        const t0 = performance.now();
        const replyBytes = await this._transfer(frame);
        const reply = parseReply(dec.decode(await open(this.key, this.nonce, seq, replyBytes)));
        reply._ms = Math.round(performance.now() - t0);
        if (reply.kind === 'error') throw new Error(name + ': ' + (reply.error || 'DEVICE_ERROR'));
        if (reply.kind === 'ack' && (reply.ref !== id || reply.client_seq !== Number(seq) || reply.device_id !== this.info.device_id)) {
          throw new Error('INVALID_ACK');
        }
        if (reply.granted_lease_id) this.lease = reply.granted_lease_id;
        return reply;
      };
      const p = this.queue.then(run, run);
      this.queue = p.catch(() => {});
      return p;
    }

    /** Polls get_status until predicate(status) is truthy. 75ms matches the vendor's cadence. */
    async waitFor(predicate, timeoutMs, label) {
      const end = Date.now() + timeoutMs;
      for (;;) {
        const r = await this.command('device.get_status');
        if (predicate(r.status || {})) return r.status;
        if (Date.now() > end) {
          const s = r.status || {};
          throw new Error((label || 'WAIT') + '_TIMEOUT (state ' + s.machine_state + ', run ' + s.run_request + ')');
        }
        await new Promise((res) => setTimeout(res, 75));
      }
    }
  }

  /** Commands that must carry the held lease id. Everything else sends lease_id: null. */
  const LEASED_COMMANDS = Object.freeze(['device.renew_lease', 'device.release_lease',
    'batch.start', 'cycle.feed', 'cycle.route']);

  /** The three uint64 identity fields every cycle command must echo from the latest status. */
  function cycleRef(status) {
    return { boot_id: status.boot_id, batch_seq: status.batch_seq, cycle_seq: status.cycle_seq };
  }

  return { X1ProConnection, UUID, LEASED_COMMANDS, cycleRef, forgetPairings, loadPairing,
    // exported for tests
    _internal: { crc32, encodeFrames, Reassembler, seal, open, deriveSessionKey, parseReply, secureHeader } };
})();
