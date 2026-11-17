/**
 * Offline recognition check for Magic's "Secret Lair x MSCHF: The Zeta Set" (TCGCSV group 24836).
 *
 * There are no real Zeta captures yet, so this SIMULATES them: each card's TCGCSV reference image
 * is pasted, slightly tilted and softened, where a card lands in a real rig frame, then cut with
 * the production capture window (zoom 89 / vpos 60) and downscaled to the 640px upload. That makes
 * it OPTIMISTIC — the query is derived from the very image it is matched against — so read the
 * results as "can the pipeline separate these cards at all", not as a predicted accuracy.
 *
 * What it answers:
 *   - Can CLIP tell the three treatments (white 0001-0121, black 0122-0242, misprint 0243+) apart?
 *   - How close are same-treatment siblings (121 cream cards with black ink art)?
 *   - Does straightening help or hurt a cream card on the light-grey platform?
 *   - Does the Magic title band read the right name (via the production readCardTitle)?
 *
 * Run (against a scratch DB copy, never the real one):
 *   DATABASE_PATH=<copy.db> npx ts-node scripts/zeta-check.ts <rig-frame.jpg> <outDir> [--ocr]
 */
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { prewarmSet, getCandidatesForSets } from '../src/tcgcsv';
import { prewarmEmbeddings, scoreCandidates } from '../src/embeddings';
import { straightenCard } from '../src/straighten';
import { readCardTitle, titleBandsFor } from '../src/ocr';
import type { CandidateCard } from '../src/types';

const GAME_ID = 1;
const GROUP_ID = 24836;
// Production capture window: captureCropZoomPct 89, captureCropVPosPct 60 (see capture.js getCrop).
const CROP = (() => {
  const s = 0.89, w = 0.58 * s, h = 0.47 * s;
  return { left: (1 - w) / 2, top: 0.6 * (1 - h), width: w, height: h };
})();
// The card is centred in that window, as a calibrated rig places it, at the size a real card
// measures in the 1080x1920 sample frame (the Horned King in frame 60: ~505x690px). Frame 60 is
// from August and its card sits 84px right of centre — the rig has been recalibrated since, and
// the window is always horizontally centred, so its position is not reused, only its size.
const CARD = { cx: 1080 * 0.5, cy: 1920 * (CROP.top + CROP.height / 2), w: 505, h: 690 };

const treatment = (n: number) => (n <= 121 ? 'white' : n <= 242 ? 'black' : n <= 363 ? 'misprint' : 'extra');
const baseName = (s: string) => s.replace(/\s*\([^)]*\)\s*$/, '').trim();

/** Deterministic tilt per card, -6..+6 degrees, so reruns compare like with like. */
const tiltFor = (id: number) => ((id * 2654435761) % 1300) / 100 - 6.5;

async function simulate(frame: Buffer, fw: number, fh: number, ref: Buffer, tilt: number): Promise<Buffer> {
  // CARD is in 1080x1920 frame pixels; scale it if the sample frame is another size.
  const k = fw / 1080;
  const card = await sharp(ref).resize(Math.round(CARD.w * k), Math.round(CARD.h * k), { fit: 'fill' })
    .ensureAlpha().rotate(tilt, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  const m = await sharp(card).metadata();
  const placed = await sharp(frame)
    .composite([{ input: card, left: Math.round(CARD.cx * k - m.width! / 2), top: Math.round(CARD.cy * k - m.height! / 2) }])
    .modulate({ brightness: 0.93, saturation: 0.92 }).blur(0.9).jpeg({ quality: 85 }).toBuffer();
  const crop = {
    left: Math.round(CROP.left * fw), top: Math.round(CROP.top * fh),
    width: Math.round(CROP.width * fw), height: Math.round(CROP.height * fh),
  };
  return sharp(placed).extract(crop).resize({ width: 640, height: 640, fit: 'inside' })
    .jpeg({ quality: 75 }).toBuffer();
}

async function main() {
  const [framePath, outDir] = process.argv.slice(2);
  const withOcr = process.argv.includes('--ocr');
  if (!framePath || !outDir) throw new Error('usage: zeta-check.ts <rig-frame.jpg> <outDir> [--ocr]');
  fs.mkdirSync(outDir, { recursive: true });

  console.log('prewarming Zeta (first time downloads ~380 images and embeds them)...');
  const t0 = Date.now();
  await prewarmEmbeddings(await prewarmSet(GAME_ID, GROUP_ID, 'Secret Lair x MSCHF: The Zeta Set'));
  console.log(`prewarmed in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  const pool: CandidateCard[] = getCandidatesForSets([GROUP_ID], 'Normal');
  const byId = new Map(pool.map((c) => [c.productId, c]));
  console.log(`pool: ${pool.length} candidates`);

  const frame = fs.readFileSync(framePath);
  const fm = await sharp(frame).metadata();
  const rows: string[] = ['productId,number,treatment,name,tilt,mode,top1,correct,sameNameWrongTreatment,score,gap,runnerUp,ocrRead,ocrIds,ocrSim'];
  const tally: Record<string, { n: number; ok: number; treatWrong: number; gaps: number[] }> = {};

  for (const c of pool) {
    const num = Number(c.number);
    if (!c.imageUrl || !Number.isFinite(num)) continue;
    const ref = Buffer.from(await (await fetch(c.imageUrl.replace('_200w', '_400w'))).arrayBuffer());
    const tilt = tiltFor(c.productId);
    const capture = await simulate(frame, fm.width!, fm.height!, ref, tilt);
    if (num % 40 === 1) fs.writeFileSync(path.join(outDir, `cap-${String(num).padStart(4, '0')}.jpg`), capture);

    let ocrCell = ',,';
    if (withOcr) {
      const ocr = await readCardTitle(capture, pool, { minTitleChars: 6, bands: titleBandsFor(GAME_ID) });
      ocrCell = ocr ? `"${ocr.raw.replace(/"/g, "'")}",${ocr.productIds.length},${ocr.sim.toFixed(3)}` : ',,';
      const key = 'ocr';
      tally[key] ??= { n: 0, ok: 0, treatWrong: 0, gaps: [] };
      tally[key].n++;
      if (ocr && ocr.sim >= 0.8 && ocr.productIds.includes(c.productId)) tally[key].ok++;
    }

    for (const mode of ['plain', 'straight'] as const) {
      const img = mode === 'straight' ? (await straightenCard(capture)).image : capture;
      const scored = await scoreCandidates(img, pool);
      const top = scored[0], second = scored[1];
      const topCard = byId.get(top.productId)!;
      const correct = top.productId === c.productId;
      const treatWrong = !correct && baseName(topCard.name) === baseName(c.name);
      const key = `${mode}/${treatment(num)}`;
      tally[key] ??= { n: 0, ok: 0, treatWrong: 0, gaps: [] };
      tally[key].n++;
      if (correct) { tally[key].ok++; tally[key].gaps.push(top.score - second.score); }
      if (treatWrong) tally[key].treatWrong++;
      rows.push([c.productId, num, treatment(num), `"${c.name}"`, tilt.toFixed(1), mode, top.productId, correct,
        treatWrong, top.score.toFixed(4), (top.score - second.score).toFixed(4), `"${byId.get(second.productId)?.name}"`, ocrCell].join(','));
    }
  }

  fs.writeFileSync(path.join(outDir, 'zeta-check.csv'), rows.join('\n'));
  console.log('\nmode/treatment     top1-correct   wrong-treatment-same-name   median gap (correct)');
  for (const [k, t] of Object.entries(tally).sort()) {
    const g = t.gaps.sort((a, b) => a - b);
    const med = g.length ? g[Math.floor(g.length / 2)].toFixed(4) : '-';
    console.log(`${k.padEnd(18)} ${String(t.ok).padStart(4)}/${String(t.n).padEnd(4)} ${((100 * t.ok) / t.n).toFixed(0).padStart(4)}%   ${String(t.treatWrong).padStart(6)}                     ${med}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
