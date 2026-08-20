/**
 * Crop-geometry A/B against real captures — the experiment that decides BASE_CROP_W/H.
 *
 * The problem it exists to answer, from the 2026-08-19 50-card dry run: the phone streams
 * 1080x1920 PORTRAIT, and because the crop is a fixed fraction of the frame it comes out at
 * 702x1011 — portrait in pixels. CLIP resizes the shortest edge to 224 then centre-crops to
 * 224x224 (its own preprocessor_config.json), so a portrait crop loses 31% of the card's HEIGHT
 * — the name bar and the text box — before the model sees anything. That run produced 17
 * low-confidence failures out of 51, and those never reach the review strip, so they are
 * invisible from the UI.
 *
 * The counter-argument this has to test rather than assume: the TCGCSV reference images are
 * portrait card art getting the SAME centre-crop, so they also represent a middle band of the
 * card. Matching that framing might beat preserving the whole card. Genuinely two-sided.
 *
 * Note a hard constraint of a portrait frame: a landscape crop cannot contain the whole card, so
 * "just make it landscape" is not on the menu. The realistic candidates are square-ish crops and
 * letterbox padding, both of which avoid centre-crop truncation entirely.
 *
 * Scores through the SAME matchCard() the app uses, so a geometry that wins here wins in
 * production.
 *
 * Run: npx ts-node scripts/crop-ab.ts <exportDir> [--sets 24666] [--game 71]
 */
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { getCandidatesForSets, prewarmSet, fetchSets } from '../src/tcgcsv';
import { matchCard, prewarmEmbeddings } from '../src/embeddings';
import { getSettings } from '../src/settings';
import { CandidateCard } from '../src/types';

interface Sample {
  file: string; frameW: number; frameH: number;
  productionCrop: { left: number; top: number; width: number; height: number } | null;
  productId: number | null; name: string | null; number: string | null;
  outcome: string; reason: string; score: number | null; voided: boolean; labelled: boolean;
}

type Geometry = {
  name: string;
  /** Fractions of the frame; vpos mirrors captureCropVPosPct. Matches getCrop() in capture.js. */
  width: number; height: number; vpos: number;
  /** Letterbox the crop to a square before handing it over. Preserves the card at full crop
   *  resolution AND avoids centre-crop truncation, at the cost of feeding the model grey bars. */
  padSquare?: boolean;
};

// Baseline is the run's ACTUAL production crop, recovered from labels.json (zoom ~112%, vpos 44),
// so the comparison is against what really shipped rather than the bundled default.
const GEOMETRIES: Geometry[] = [
  { name: 'production (portrait 0.69)', width: 0.6496, height: 0.5264, vpos: 0.44 },
  { name: 'production + pad square', width: 0.6496, height: 0.5264, vpos: 0.44, padSquare: true },
  { name: 'square crop 0.936x0.5264', width: 0.936, height: 0.5264, vpos: 0.44 },
  { name: 'wider portrait 0.80x0.5264', width: 0.80, height: 0.5264, vpos: 0.44 },
  { name: 'taller portrait 0.6496x0.62', width: 0.6496, height: 0.62, vpos: 0.44 },
  { name: 'tight card 0.55x0.47', width: 0.55, height: 0.47, vpos: 0.44 },
  { name: 'tight card + pad square', width: 0.55, height: 0.47, vpos: 0.44, padSquare: true },
  { name: 'full frame (control)', width: 1.0, height: 1.0, vpos: 0.50 },
];

const args = process.argv.slice(2);
const exportDir = args[0];
const setsArg = args.indexOf('--sets') >= 0 ? args[args.indexOf('--sets') + 1] : null;
const gameArg = args.indexOf('--game') >= 0 ? Number(args[args.indexOf('--game') + 1]) : 71;
const zoomsArg = args.indexOf('--zooms') >= 0 ? args[args.indexOf('--zooms') + 1] : null;
const vposArg = args.indexOf('--vpos') >= 0 ? Number(args[args.indexOf('--vpos') + 1]) : 44;

/**
 * Sweep captureCropZoomPct instead of arbitrary shapes, reproducing getCrop()'s exact maths
 * (BASE_CROP 0.58 x 0.47, scaled, clamped). The first sweep showed tighter-is-better, and this is
 * the actionable form of that: the answer is a slider value the operator can set, with no code
 * change and no redeploy.
 */
const BASE_CROP_W = 0.58;
const BASE_CROP_H = 0.47;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
if (zoomsArg) {
  GEOMETRIES.length = 0;
  for (const z of zoomsArg.split(',').map(Number)) {
    const scale = z / 100;
    GEOMETRIES.push({
      name: `zoom ${z}%`,
      width: clamp(BASE_CROP_W * scale, 0.15, 0.95),
      height: clamp(BASE_CROP_H * scale, 0.15, 0.95),
      vpos: vposArg / 100,
    });
  }
}

if (!exportDir) {
  console.error('Usage: npx ts-node scripts/crop-ab.ts <exportDir> [--sets 24666] [--game 71]');
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(path.join(exportDir, 'labels.json'), 'utf8')) as
  { setIds: number[]; samples: Sample[] };
const setIds = setsArg ? setsArg.split(',').map(Number) : manifest.setIds;
if (!setIds?.length) { console.error('No setIds in labels.json — pass --sets.'); process.exit(1); }

/** Same mapping as getCrop() in capture.js, in absolute pixels. */
function cropRect(g: Geometry, w: number, h: number) {
  const cw = Math.min(Math.round(g.width * w), w);
  const ch = Math.min(Math.round(g.height * h), h);
  return {
    left: Math.max(0, Math.round((w - cw) / 2)),
    top: Math.max(0, Math.min(h - ch, Math.round(g.vpos * (h - ch)))),
    width: cw, height: ch,
  };
}

async function render(g: Geometry, file: string, fw: number, fh: number): Promise<Buffer> {
  const r = cropRect(g, fw, fh);
  const cropped = await sharp(fs.readFileSync(file)).extract(r).toBuffer();
  if (!g.padSquare) return sharp(cropped).jpeg({ quality: 90 }).toBuffer();
  const side = Math.max(r.width, r.height);
  return sharp(cropped)
    .resize(side, side, {
      fit: 'contain',
      // Mid-grey rather than black or white: neither a card border nor a dark background, so it is
      // the least likely of the obvious choices to read as card content.
      background: { r: 128, g: 128, b: 128 },
    })
    .jpeg({ quality: 90 })
    .toBuffer();
}

const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

(async () => {
  const settings = getSettings();
  console.log(`Confidence gate: minScore ${settings.minScore}, minGap ${settings.minGap}`);
  console.log(`Sets ${setIds.join(', ')} — warming catalog + embeddings...`);
  const sets = await fetchSets(gameArg);
  const nameById = new Map(sets.map((s) => [s.id, s.name]));
  for (const id of setIds) {
    await prewarmEmbeddings(await prewarmSet(gameArg, id, nameById.get(id) ?? String(id)));
  }
  const candidates: CandidateCard[] = getCandidatesForSets(setIds);

  const labelled = manifest.samples.filter((s) => s.labelled);
  const failures = manifest.samples.filter((s) => s.reason === 'low-confidence');
  console.log(`${candidates.length} candidates | ${labelled.length} labelled | ${failures.length} known failures\n`);

  const results: {
    g: Geometry; acc: number; correct: number; medScore: number; medGap: number;
    rescued: number; rescues: string[];
  }[] = [];

  for (const g of GEOMETRIES) {
    const scores: number[] = [];
    const gaps: number[] = [];
    let correct = 0;
    for (const s of labelled) {
      const buf = await render(g, path.join(exportDir, s.file), s.frameW, s.frameH);
      const { top, runnerUp } = await matchCard(buf, candidates);
      if (!top) continue;
      scores.push(top.score);
      gaps.push(runnerUp ? top.score - runnerUp.score : top.score);
      if (top.productId === s.productId) correct++;
    }
    // A geometry that turns a known failure into a CONFIDENT match is the headline evidence, but
    // the identity is unverified — listed for physical spot-checking, never counted as correct.
    const rescues: string[] = [];
    for (const s of failures) {
      const buf = await render(g, path.join(exportDir, s.file), s.frameW, s.frameH);
      const { top, runnerUp } = await matchCard(buf, candidates);
      if (!top || !runnerUp) continue;
      if (top.score >= settings.minScore && top.score - runnerUp.score >= settings.minGap) {
        const c = candidates.find((x) => x.productId === top.productId);
        rescues.push(`${s.file} -> ${c?.name ?? top.productId} (${c?.number ?? '?'}) ` +
          `score ${top.score.toFixed(3)} gap ${(top.score - runnerUp.score).toFixed(3)}`);
      }
    }
    const r = {
      g, correct, acc: labelled.length ? (correct / labelled.length) * 100 : 0,
      medScore: median(scores), medGap: median(gaps), rescued: rescues.length, rescues,
    };
    results.push(r);
    console.log(`  ${g.name}: acc ${r.acc.toFixed(0)}%  gap ${r.medGap.toFixed(3)}  rescued ${r.rescued}/${failures.length}`);
  }

  console.log('\n' + 'geometry'.padEnd(32) + 'top-1'.padEnd(10) + 'acc'.padEnd(7) +
    'med score'.padEnd(11) + 'med gap'.padEnd(10) + 'rescued');
  console.log('-'.repeat(82));
  for (const r of results) {
    console.log(
      r.g.name.padEnd(32) +
      `${r.correct}/${labelled.length}`.padEnd(10) +
      (r.acc.toFixed(0) + '%').padEnd(7) +
      r.medScore.toFixed(3).padEnd(11) +
      r.medGap.toFixed(3).padEnd(10) +
      `${r.rescued}/${failures.length}`);
  }

  const base = results[0];
  const better = results.slice(1).filter((r) => r.acc >= base.acc && r.medGap > base.medGap);
  console.log('\nDecision rule: beat production on accuracy AND median gap.');
  if (better.length === 0) {
    console.log('No geometry qualifies — leave BASE_CROP_W/H alone.');
  } else {
    const best = better.sort((a, b) => b.medGap - a.medGap)[0];
    console.log(`Best: "${best.g.name}" — median gap ${base.medGap.toFixed(3)} -> ${best.medGap.toFixed(3)}, ` +
      `rescued ${best.rescued}/${failures.length} known failures (production rescued ${base.rescued}).`);
    if (best.rescues.length) {
      console.log('\nRescued failures — identities UNVERIFIED, spot-check against the extras pile:');
      best.rescues.slice(0, 15).forEach((l) => console.log('  ' + l));
    }
  }
})().catch((err) => { console.error(err); process.exit(1); });
