/**
 * Vision calibration harness — see plan at ~/.claude/plans/familiarize-yourself-with-the-abstract-patterson.md.
 *
 * Standalone script, NOT wired into the server or session path. Run with:
 *   npx ts-node scripts/calibrate.ts --list-sets     (discovery: resolve gameId/setId for truth.json)
 *   npx ts-node scripts/calibrate.ts                 (main run: score samples/truth.json's photos)
 *
 * Deliberately does not import session.ts/scanCard or getProductCached — this measures raw
 * recognition (score/gap/cropped_image) against the real /scan endpoint, not the app's
 * bulk/keeper decision, and must never touch product_cache/sessions/cards in SQLite.
 *
 * Does not reuse tcgtracking.ts's scanImage()/scanImageWithRetry() because those discard the
 * ScanResponse's `cropped_image` field on the way to a sorted ScanMatch[] — and cropped_image
 * (whether TCGTracking's own detector found the card in frame) is one of the two things this
 * run exists to measure. BASE URL is mirrored from src/tcgtracking.ts, not imported, to avoid
 * touching that file for a one-off script.
 */
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { fetchCategories, fetchSets } from '../src/tcgtracking';
import { ScanMatch, ScanResponse } from '../src/types';

const BASE = 'https://tcgtracking.com/tcgapi/v1';

// Mirrors public/index.html:496-503 exactly (captureCanvas: width = min(videoWidth, 640),
// height keeps aspect, JPEG q0.8) — scoring anything else proves nothing about what the app
// will actually upload. See plan "Replicating the client transform".
async function toClientUpload(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer).resize({ width: 640 }).jpeg({ quality: 80 }).toBuffer();
}

// The crop variant is NOT what index.html ships today (it sends the full frame) — it's a
// hypothetical "what if the mount framed tighter" test. Discovered live: a tight crop of just
// the card is smaller in pixel count than the full frame but LARGER in JPEG bytes at the same
// quality (114KB vs 69KB here), because removing the plain white/orange background removes the
// low-entropy content JPEG compresses best, leaving dense card art+text. A real tighter-crop
// implementation would need this same adaptive step, so it's honest to apply it here too —
// logs the quality actually needed to fit the cap, which is itself a data point.
async function toClientUploadUnderCap(buffer: Buffer, maxBytes = 100 * 1024): Promise<{ buffer: Buffer; quality: number }> {
  for (let quality = 80; quality >= 30; quality -= 10) {
    const out = await sharp(buffer).resize({ width: 640 }).jpeg({ quality }).toBuffer();
    if (out.length <= maxBytes) return { buffer: out, quality };
  }
  const fallback = await sharp(buffer).resize({ width: 640 }).jpeg({ quality: 30 }).toBuffer();
  return { buffer: fallback, quality: 30 };
}

async function scanRaw(gameId: number, imageBuffer: Buffer, setIds: number[]): Promise<{ res: ScanResponse; latencyMs: number }> {
  const form = new FormData();
  form.set('game_id', String(gameId));
  if (setIds.length > 0) form.set('set_ids', JSON.stringify(setIds));
  form.set('image', new Blob([imageBuffer], { type: 'image/jpeg' }), 'capture.jpg');

  const start = Date.now();
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${BASE}/scan`, { method: 'POST', body: form });
      if (!res.ok) throw new Error(`/scan failed: ${res.status}`);
      const data = (await res.json()) as ScanResponse;
      if (!data.success) throw new Error('/scan returned success:false');
      return { res: data, latencyMs: Date.now() - start };
    } catch (err) {
      lastErr = err;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('/scan failed after retries');
}

function sortedMatches(res: ScanResponse): ScanMatch[] {
  // Same trap documented in tcgtracking.ts:57 — results are NOT score-sorted by the API.
  return [...(res.results ?? [])].sort((a, b) => b.score - a.score);
}

interface Truth {
  gameId: number | null;
  gameName: string;
  setId: number | null;
  setName: string;
  cropBox: { left: number; top: number; width: number; height: number };
  photos: { file: string; name: string; subtitle: string | null; number: string; foil: boolean; note?: string }[];
}

const TRUTH_PATH = path.join(__dirname, '..', 'samples', 'truth.json');

async function listSets() {
  console.log('Fetching /categories ...');
  const categories = await fetchCategories();
  const lorcana = categories.find((c) => /lorcana/i.test(c.name) || /lorcana/i.test(c.display_name));
  console.log(
    categories
      .map((c) => `  id=${c.id.toString().padEnd(4)} sets=${String(c.set_count).padEnd(4)} products=${String(c.product_count).padEnd(6)} ${c.display_name}`)
      .join('\n'),
  );
  if (!lorcana) {
    console.log('\nNo category matched /lorcana/i by name — inspect the list above and pick manually.');
    return;
  }
  console.log(`\nMatched Lorcana: game_id=${lorcana.id} ("${lorcana.display_name}"). Fetching its sets ...`);
  const sets = await fetchSets(lorcana.id);
  console.log(sets.map((s) => `  id=${s.id.toString().padEnd(6)} ${s.name}${s.abbreviation ? ' (' + s.abbreviation + ')' : ''}`).join('\n'));
  console.log(
    '\nLook for the 207-card set (collector numbers on the sample photos all read "N/207") and copy its id/name into samples/truth.json\'s gameId/setId/setName fields.',
  );
}

interface Row {
  file: string;
  variant: string;
  truthName: string;
  truthNumber: string;
  topName: string | null;
  topNumber: string | null;
  topScore: number | null;
  topSetId: number | null;
  correct: boolean;
  runnerUpName: string | null;
  runnerUpScore: number | null;
  gap: number | null;
  nResults: number;
  croppedImagePresent: boolean;
  uploadBytes: number;
  jpegQuality: number;
  latencyMs: number;
}

function csvField(v: string | number | boolean | null): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function run() {
  const truth: Truth = JSON.parse(fs.readFileSync(TRUTH_PATH, 'utf-8'));
  if (truth.gameId === null || truth.setId === null) {
    console.error('samples/truth.json has gameId/setId still null. Run `--list-sets` first and fill them in.');
    process.exit(1);
  }

  const rows: Row[] = [];

  for (const photo of truth.photos) {
    console.log(`\n=== ${path.basename(photo.file)} (truth: ${photo.name} ${photo.number}) ===`);
    const original = fs.readFileSync(photo.file);
    const cropped = await sharp(original).extract(truth.cropBox).toBuffer();
    const fullBuf = await toClientUpload(original);
    const cropCapped = await toClientUploadUnderCap(cropped);

    const variants: { key: string; buffer: Buffer; setIds: number[]; quality: number }[] = [
      { key: 'full-unscoped', buffer: fullBuf, setIds: [], quality: 80 },
      { key: 'full-scoped', buffer: fullBuf, setIds: [truth.setId], quality: 80 },
      { key: 'crop-unscoped', buffer: cropCapped.buffer, setIds: [], quality: cropCapped.quality },
      { key: 'crop-scoped', buffer: cropCapped.buffer, setIds: [truth.setId], quality: cropCapped.quality },
    ];

    for (const v of variants) {
      const { res, latencyMs } = await scanRaw(truth.gameId, v.buffer, v.setIds);
      const matches = sortedMatches(res);
      const top = matches[0] ?? null;
      const runnerUp = matches[1] ?? null;
      // Match on collector number alone: the API returns the full display name ("Name - Subtitle",
      // e.g. "Meilin Lee - Popular Red Panda") while truth.json stores name/subtitle separately for
      // readability, so a strict name-equality check false-negatived every correct match in initial
      // testing. Number is authoritative within a set; a real multi-set dry run should additionally
      // check set_id, since collector numbers repeat across sets (see plan's near-miss finding).
      const correct = !!top && top.number.trim() === photo.number.trim();

      const row: Row = {
        file: path.basename(photo.file),
        variant: v.key,
        truthName: photo.name,
        truthNumber: photo.number,
        topName: top?.name ?? null,
        topNumber: top?.number ?? null,
        topScore: top?.score ?? null,
        topSetId: top?.set_id ?? null,
        correct,
        runnerUpName: runnerUp?.name ?? null,
        runnerUpScore: runnerUp?.score ?? null,
        gap: top && runnerUp ? top.score - runnerUp.score : null,
        nResults: matches.length,
        croppedImagePresent: !!res.cropped_image,
        uploadBytes: v.buffer.length,
        jpegQuality: v.quality,
        latencyMs,
      };
      rows.push(row);
      console.log(
        `  ${v.key.padEnd(14)} top=${(row.topName ?? '(none)').padEnd(24)} #${(row.topNumber ?? '-').padEnd(8)} ` +
          `score=${String(row.topScore ?? '-').padEnd(4)} gap=${String(row.gap ?? '-').padEnd(4)} ` +
          `${row.correct ? 'CORRECT' : 'WRONG  '} bytes=${row.uploadBytes} q${row.jpegQuality} ${row.latencyMs}ms cropped_image=${row.croppedImagePresent}`,
      );
    }
  }

  // ---- CSV ----
  const scratchpad = 'C:\\Users\\salmo\\AppData\\Local\\Temp\\claude\\C--Users-salmo-OneDrive-Documents-ClaudeProjects\\930cc013-9d1f-4dae-a31c-faa3cceaa628\\scratchpad';
  fs.mkdirSync(scratchpad, { recursive: true });
  const csvPath = path.join(scratchpad, `calibration-${Date.now()}.csv`);
  const header = ['file', 'variant', 'truth_name', 'truth_number', 'top_name', 'top_number', 'top_score', 'top_set_id', 'correct', 'runner_up_name', 'runner_up_score', 'gap', 'n_results', 'cropped_image_present', 'upload_bytes', 'jpeg_quality', 'latency_ms'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(
      [r.file, r.variant, r.truthName, r.truthNumber, r.topName, r.topNumber, r.topScore, r.topSetId, r.correct, r.runnerUpName, r.runnerUpScore, r.gap, r.nResults, r.croppedImagePresent, r.uploadBytes, r.jpegQuality, r.latencyMs]
        .map(csvField)
        .join(','),
    );
  }
  fs.writeFileSync(csvPath, lines.join('\r\n') + '\r\n');
  console.log(`\nCSV written to ${csvPath}`);

  // ---- Summary ----
  console.log('\n=== SUMMARY ===');
  for (const variant of ['full-unscoped', 'full-scoped', 'crop-unscoped', 'crop-scoped']) {
    const subset = rows.filter((r) => r.variant === variant);
    const correctCount = subset.filter((r) => r.correct).length;
    const withCropped = subset.filter((r) => r.croppedImagePresent).length;
    const meanLatency = subset.reduce((s, r) => s + r.latencyMs, 0) / (subset.length || 1);
    console.log(`${variant.padEnd(14)} recognized ${correctCount}/${subset.length}   cropped_image ${withCropped}/${subset.length}   mean latency ${meanLatency.toFixed(0)}ms`);
  }

  const correctScores = rows.filter((r) => r.correct && r.topScore !== null).map((r) => r.topScore as number);
  const correctGaps = rows.filter((r) => r.correct && r.gap !== null).map((r) => r.gap as number);
  const incorrectScores = rows.filter((r) => !r.correct && r.topScore !== null).map((r) => r.topScore as number);

  if (correctScores.length > 0) {
    console.log(`\nCorrect-match score range: ${Math.min(...correctScores)}-${Math.max(...correctScores)}`);
    console.log(`Correct-match gap range:   ${Math.min(...correctGaps)}-${Math.max(...correctGaps)}`);
  }
  if (incorrectScores.length > 0) {
    console.log(`Incorrect-match scores seen: ${incorrectScores.join(', ')}  <- first real upper-bound data for minScore`);
  } else {
    console.log('No incorrect matches observed in this run — expected with n=3 from one set; this run cannot bound minScore/minGap from above.');
  }

  const fullBytes = rows.filter((r) => r.variant.startsWith('full')).map((r) => r.uploadBytes);
  const overCap = rows.filter((r) => r.uploadBytes > 100 * 1024);
  console.log(`\nUpload sizes (full-frame variant): ${Math.min(...fullBytes)}-${Math.max(...fullBytes)} bytes`);
  if (overCap.length > 0) {
    console.log(`WARNING: ${overCap.length} row(s) exceeded the ~100KB decoded cap noted in the plan.`);
  }

  const cropDelta = ['unscoped', 'scoped'].map((suffix) => {
    const full = rows.filter((r) => r.variant === `full-${suffix}`);
    const crop = rows.filter((r) => r.variant === `crop-${suffix}`);
    return `  ${suffix}: full ${full.filter((r) => r.correct).length}/${full.length} -> crop ${crop.filter((r) => r.correct).length}/${crop.length}`;
  });
  console.log('\nFull-frame vs. cropped delta (the phone-mount question):');
  console.log(cropDelta.join('\n'));

  console.log(
    '\nReminder: n=3 photos from a single 207-card set. This does not set minScore/minGap — it only ' +
      'shows whether physical-card recognition works at all and how much framing/scoping matter. ' +
      'The plan\'s ~50-card, multi-set dry run (including near-miss reprints and foils) is still required ' +
      'before touching config/settings.json.',
  );
}

if (process.argv.includes('--list-sets')) {
  listSets().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
