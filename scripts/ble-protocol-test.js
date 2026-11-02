/**
 * Protocol tests for public/x1pro-ble.js — no Bluetooth, no browser, plain Node 22.
 *
 * The device side is written out here independently from the notes in research_tcgverifier-mtg-app
 * (header layouts, IV/AAD construction, HKDF info string) rather than by calling the module's own
 * helpers, so a mistake in the module can't be mirrored by the test and cancel out.
 *
 * Run: node scripts/ble-protocol-test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

global.window = {};
eval(fs.readFileSync(path.join(__dirname, '..', 'public', 'x1pro-ble.js'), 'utf8'));
const M = window.X1ProBle._internal;

let failed = 0, passed = 0;
function ok(cond, msg) {
  if (cond) { passed++; } else { failed++; console.log('FAIL ' + msg); }
}
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const te = new TextEncoder();

// ─── device-side reference implementation, from the spec ───

async function deviceKey(key32, nonce16) {
  const ikm = await crypto.subtle.importKey('raw', key32, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: nonce16, info: te.encode('X1PRO-BLE-CONTROL-v1') },
    ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

function deviceHeader(dir, seq) {
  const h = new Uint8Array(16);
  h.set([0x58, 0x31, 0x41, 0x31]);           // "X1A1"
  h[4] = dir;
  for (let i = 0; i < 8; i++) h[15 - i] = Number((seq >> BigInt(8 * i)) & 0xFFn);   // BE uint64
  return h;
}

function deviceGcm(h, nonce) {
  const iv = new Uint8Array(12);
  iv.set(h[4] === 1 ? [0x52, 0x45, 0x51, 0x31] : [0x52, 0x53, 0x50, 0x31]);   // "REQ1" / "RSP1"
  iv.set(h.subarray(8, 16), 4);
  const aad = new Uint8Array(32);
  aad.set(h); aad.set(nonce, 16);
  return { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 };
}

async function deviceSealResponse(key, nonce, seq, plain) {
  const h = deviceHeader(2, seq);
  const ct = new Uint8Array(await crypto.subtle.encrypt(deviceGcm(h, nonce), key, plain));
  const out = new Uint8Array(16 + ct.length); out.set(h); out.set(ct, 16);
  return out;
}

async function deviceOpenRequest(key, nonce, frame) {
  const h = frame.subarray(0, 16);
  return new Uint8Array(await crypto.subtle.decrypt(deviceGcm(h, nonce), key, frame.subarray(16)));
}

(async () => {
  // CRC-32 standard check value.
  ok(M.crc32(te.encode('123456789')) === 0xCBF43926, 'crc32("123456789") === 0xCBF43926');

  // Frame layout.
  const payload = new Uint8Array(30).map((_, i) => i);
  const frames = M.encodeFrames(payload, 0x0102, 20, 1);
  ok(frames.length === 4, '30 bytes at 20-byte packets = 4 chunks of 8');
  const f1 = frames[1], dv = new DataView(f1.buffer);
  ok(f1[0] === 0x58 && f1[1] === 1, 'magic X + version');
  ok(dv.getUint16(2, true) === 0x0102, 'id little-endian');
  ok(dv.getUint16(4, true) === 30, 'totalLength = whole payload');
  ok(dv.getUint16(6, true) === 8, 'second chunk offset 8');
  ok(dv.getUint32(8, true) === M.crc32(payload), 'every chunk carries whole-payload crc');
  ok(eq(f1.subarray(12), payload.subarray(8, 16)), 'chunk body');
  ok(frames[3].length === 12 + 6, 'last chunk is short');
  ok(M.encodeFrames(new Uint8Array(500), 1, 244, 2).every((p) => p.length <= 244), 'large packets respect size');

  // Reassembly.
  const r = new M.Reassembler();
  let res;
  for (const p of frames) res = r.accept(p);
  ok(res.status === 'COMPLETE' && eq(res.bytes, payload), 'reassembles in-order chunks');
  const r2 = new M.Reassembler();
  r2.accept(frames[0]);
  ok(r2.accept(frames[2]).status === 'INVALID', 'a skipped chunk is INVALID, not silently glued');
  const bad = frames.map((p) => p.slice()); bad[3][13] ^= 0xFF;
  const r3 = new M.Reassembler(); for (const p of bad) res = r3.accept(p);
  ok(res.status === 'INVALID', 'corrupted body fails crc');
  ok(new M.Reassembler().accept(frames[1]).status === 'INVALID', 'mid-message start is INVALID');

  // Secure channel, both directions, against the independent device implementation.
  const key32 = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(16));
  const appKey = await M.deriveSessionKey(key32, nonce);
  const devKey = await deviceKey(key32, nonce);

  const cmd = te.encode(JSON.stringify({ v: 1, kind: 'command', name: 'device.get_status' }));
  const seq = 0x0102030405n;
  const sealed = await M.seal(appKey, nonce, seq, cmd);
  ok(eq(sealed.subarray(0, 16), deviceHeader(1, seq)), 'request header: X1A1, dir 1, BE seq');
  ok(eq(await deviceOpenRequest(devKey, nonce, sealed), cmd), 'device decrypts app request');

  const reply = te.encode('{"kind":"ack","status":{"boot_id":18446744073709551615,"cycle_seq":9007199254740993}}');
  const fromDevice = await deviceSealResponse(devKey, nonce, seq, reply);
  const opened = await M.open(appKey, nonce, seq, fromDevice);
  ok(eq(opened, reply), 'app decrypts device response');

  let msg = '';
  try { await M.open(appKey, nonce, seq + 1n, fromDevice); } catch (e) { msg = e.message; }
  ok(msg === 'SECURE_SEQUENCE_MISMATCH', 'response to a different seq is rejected before decrypt');

  const otherNonce = crypto.getRandomValues(new Uint8Array(16));
  const wrongKey = await M.deriveSessionKey(key32, otherNonce);
  let threw = false;
  try { await M.open(wrongKey, otherNonce, seq, fromDevice); } catch (e) { threw = true; }
  ok(threw, 'a frame from another connection (different nonce) fails authentication');

  const tampered = fromDevice.slice(); tampered[20] ^= 1;
  threw = false;
  try { await M.open(appKey, nonce, seq, tampered); } catch (e) { threw = true; }
  ok(threw, 'tampered ciphertext fails authentication');

  // uint64 fields survive parsing exactly.
  const parsed = M.parseReply(new TextDecoder().decode(opened));
  ok(parsed.status.boot_id === '18446744073709551615', 'boot_id kept exact as string');
  ok(parsed.status.cycle_seq === '9007199254740993', 'cycle_seq above 2^53 kept exact');

  // Full stack: seal -> frame -> reassemble -> open.
  const r4 = new M.Reassembler();
  for (const p of M.encodeFrames(fromDevice, 9, 20, 2)) res = r4.accept(p);
  ok(res.status === 'COMPLETE' && eq(await M.open(appKey, nonce, seq, res.bytes), reply), 'framed secure response round-trips');

  console.log(failed ? failed + ' failed, ' + passed + ' passed' : 'all ' + passed + ' passed');
  process.exit(failed ? 1 : 0);
})();
