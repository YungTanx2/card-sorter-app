/**
 * Offline recognition A/B against real captures, scored with ground truth from
 * scripts/export-samples.ts's labels.json.
 *
 * Started as a crop-geometry-only A/B (see git history) for the 2026-08-19 dry run, where a
 * 1080x1920 portrait stream cropped to 702x1011 lost 31% of the card's height to CLIP's
 * centre-crop before the model ever saw it. Generalized here because the underlying problem
 * changed shape: CFSortingRun2 (178 cards, post variant-fix) showed the remaining low-confidence
 * failures split almost entirely on GAP, not score (106 of 108 gap-only) — meaning the fix is not
 * always "feed the model a better crop", and a harness that can only test crop geometry can't
 * measure the others.
 *
 * What actually generalized, and what didn't:
 *
 *   - The SCORING here is what Phase 3's other ideas (multi-frame pooling, CSLS hubness
 *     re-ranking, OCR tie-breaking, a stronger embedding model) all need: accuracy AND rescue
 *     precision against labelled ground truth, not just "does the gap improve". Each of those
 *     ideas gets its own scoring path built directly against src/embeddings.ts when it's built —
 *     this file is not a plugin system for hypothetical future variants, it's the crop-and-gate
 *     harness plus the label contract every future harness should reuse.
 *   - The CROP SWEEP itself stayed, because it's still a real, cheap question ("--zooms",
 *     "--vpos") and the label contract upgrade below makes its answer trustworthy for the first
 *     time — see rescue precision.
 *
 * THE LABEL CONTRACT (see export-samples.ts's doc for the full reasoning): every sample carries
 * `trueProductId` — the correct answer, or null meaning "no correct answer exists in this pool"
 * (an explicit not-a-card/not-in-set label). Before public/labels.html existed, the ONLY ground
 * truth came from the review strip, which has an opinion on roughly half the samples and NONE on
 * low-confidence extras — so a "rescue" (a failure the geometry newly makes confident) could only
 * ever be listed for manual spot-checking, never actually scored. That is the gap this generalization
 * closes: rescue precision below is now a real, verified number wherever a labelled rescue exists.
 *
 * Scores through the SAME matchCard() the app uses, so a geometry that wins here wins in
 * production.
 *
 * Run: npx ts-node scripts/recognition-ab.ts <exportDir> [--sets 24666] [--game 71] [--zooms 85,95,104] [--vpos 44]
 */
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { getCandidatesForSets, prewarmSet, fetchSets } from '../src/tcgcsv';
import { matchCard, prewarmEmbeddings } from '../src/embeddings';
import { getSettings } from '../src/settings';
import { CandidateCard } from '../src/types';

type LabelSource = 'explicit-card' | 'explicit-negative' | 'review-strip' | 'none';

interface Sample {
  file: string; frameW: number; frameH: number;
  productionCrop: { left: number; top: number; width: number; height: number } | null;
  productId: number | null; name: string | null; number: string | null;
  outcome: string; reason: string; score: number | null; voided: boolean;
  labelled: boolean; labelSource: LabelSource; trueProductId: number | null;
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
  console.error('Usage: npx ts-node scripts/recognition-ab.ts <exportDir> [--sets 24666] [--game 71] [--zooms 85,95,104] [--vpos 44]');
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(path.join(exportDir, 'labels.json'), 'utf8')) as
  { setIds: number[]; samples: Sample[] };
const setIds = setsArg ? setsArg.split(',').map(Number) : manifest.setIds;
if (!setIds?.length) { console.error('No setIds in labels.json — pass --sets.'); process.exit(1); }

// export-samples.ts predates trueProductId/labelSource on some exports — degrade to the old
// review-strip-only rule rather than silently scoring zero samples against a stale export.
function normalize(s: Sample): Sample {
  if (s.labelSource) return s;
  const fallback = !s.voided && s.outcome === 'needed' && s.productId != null;
  return { ...s, labelled: fallback, labelSource: fallback ? 'review-strip' : 'none', trueProductId: fallback ? s.productId : null };
}

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

/** Would the confidence gate accept this match, using the SAME rule as session.ts/goals.ts. */
function confident(top: { score: number } | null, runnerUp: { score: number } | null, minScore: number, minGap: number): boolean {
  if (!top) return false;
  return top.score >= minScore && (!runnerUp || top.score - runnerUp.score >= minGap);
}

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
  const candidateById = new Map(candidates.map((c) => [c.productId, c]));

  const samples = manifest.samples.map(normalize);
  const labelled = samples.filter((s) => s.labelled);
  const positives = labelled.filter((s) => s.trueProductId != null);
  const negatives = labelled.filter((s) => s.trueProductId == null);
  const failures = samples.filter((s) => s.reason === 'low-confidence');
  const labelledFailures = failures.filter((s) => s.labelled);
  console.log(`${candidates.length} candidates | ${labelled.length} labelled (${positives.length} positive, ${negatives.length} negative) | ` +
    `${failures.length} known failures (${labelledFailures.length} labelled)\n`);
  if (negatives.length === 0) {
    console.log('No negative labels (not-a-card / not-in-set) yet — label some in /labels.html ' +
      'to measure false-confidence rate, not just accuracy.\n');
  }

  const results: {
    g: Geometry;
    posCorrect: number; posTotal: number;
    negFalseConfident: number; negTotal: number;
    medScore: number; medGap: number;
    rescuedTotal: number; rescuedCorrect: number; rescuedWrong: number; rescuedUnverified: string[];
  }[] = [];

  for (const g of GEOMETRIES) {
    const scores: number[] = [];
    const gaps: number[] = [];
    let posCorrect = 0;
    for (const s of positives) {
      const buf = await render(g, path.join(exportDir, s.file), s.frameW, s.frameH);
      const { top, runnerUp } = await matchCard(buf, candidates);
      if (!top) continue;
      scores.push(top.score);
      gaps.push(runnerUp ? top.score - runnerUp.score : top.score);
      if (top.productId === s.trueProductId) posCorrect++;
    }

    // A negative that the gate confidently matches is a false positive — the previously
    // unmeasurable failure mode this label type exists to catch. Not merged into posCorrect: it
    // is scored on a different axis (should the gate fire at all, not which card).
    let negFalseConfident = 0;
    for (const s of negatives) {
      const buf = await render(g, path.join(exportDir, s.file), s.frameW, s.frameH);
      const { top, runnerUp } = await matchCard(buf, candidates);
      if (confident(top, runnerUp, settings.minScore, settings.minGap)) negFalseConfident++;
    }

    // Rescues: a currently-low-confidence frame this geometry makes confident. Verified precision
    // only covers labelled failures; unverified ones are listed for a manual spot-check, same as
    // before, but now clearly separated from the number that's actually trustworthy.
    let rescuedTotal = 0, rescuedCorrect = 0, rescuedWrong = 0;
    const rescuedUnverified: string[] = [];
    for (const s of failures) {
      const buf = await render(g, path.join(exportDir, s.file), s.frameW, s.frameH);
      const { top, runnerUp } = await matchCard(buf, candidates);
      if (!confident(top, runnerUp, settings.minScore, settings.minGap) || !top) continue;
      rescuedTotal++;
      if (!s.labelled) {
        const c = candidateById.get(top.productId);
        rescuedUnverified.push(`${s.file} -> ${c?.name ?? top.productId} (${c?.number ?? '?'}) score ${top.score.toFixed(3)}`);
        continue;
      }
      if (top.productId === s.trueProductId) rescuedCorrect++; else rescuedWrong++;
    }

    const r = {
      g, posCorrect, posTotal: positives.length, negFalseConfident, negTotal: negatives.length,
      medScore: median(scores), medGap: median(gaps),
      rescuedTotal, rescuedCorrect, rescuedWrong, rescuedUnverified,
    };
    results.push(r);
    const acc = r.posTotal ? ((r.posCorrect / r.posTotal) * 100).toFixed(0) : '—';
    const precision = (r.rescuedCorrect + r.rescuedWrong) > 0
      ? ((r.rescuedCorrect / (r.rescuedCorrect + r.rescuedWrong)) * 100).toFixed(0) + '%' : 'n/a';
    console.log(`  ${g.name}: acc ${acc}%  gap ${r.medGap.toFixed(3)}  rescued ${r.rescuedTotal}/${failures.length}  ` +
      `(verified precision ${precision})  falseConfident ${r.negFalseConfident}/${r.negTotal || 0}`);
  }

  console.log('\n' + 'geometry'.padEnd(30) + 'acc'.padEnd(16) + 'med gap'.padEnd(9) +
    'rescued'.padEnd(10) + 'precision'.padEnd(11) + 'falseConf');
  console.log('-'.repeat(90));
  for (const r of results) {
    const acc = r.posTotal ? `${r.posCorrect}/${r.posTotal} (${((r.posCorrect / r.posTotal) * 100).toFixed(0)}%)` : 'n/a';
    const verified = r.rescuedCorrect + r.rescuedWrong;
    const precision = verified > 0 ? `${r.rescuedCorrect}/${verified} (${((r.rescuedCorrect / verified) * 100).toFixed(0)}%)` : 'n/a';
    console.log(
      r.g.name.padEnd(30) + acc.padEnd(16) + r.medGap.toFixed(3).padEnd(9) +
      `${r.rescuedTotal}/${failures.length}`.padEnd(10) + precision.padEnd(11) +
      `${r.negFalseConfident}/${r.negTotal || 0}`);
  }

  // Decision rule: a geometry qualifies only if it does not make anything WORSE that is actually
  // measurable — accuracy, gap, AND (whenever there is a verified rescue to judge) precision.
  // False-confidence on negatives is reported but not gating yet: with negatives still rare
  // (label more to change that), a single false positive would swing the rate too hard to trust
  // as a hard gate.
  const base = results[0];
  const baseVerified = base.rescuedCorrect + base.rescuedWrong;
  const basePrecision = baseVerified > 0 ? base.rescuedCorrect / baseVerified : null;
  const better = results.slice(1).filter((r) => {
    if (r.posTotal && r.posCorrect / r.posTotal < base.posCorrect / (base.posTotal || 1)) return false;
    if (r.medGap <= base.medGap) return false;
    const verified = r.rescuedCorrect + r.rescuedWrong;
    if (basePrecision != null && verified > 0 && r.rescuedCorrect / verified < basePrecision) return false;
    return true;
  });
  console.log('\nDecision rule: beat production on accuracy AND median gap, and never regress verified rescue precision.');
  if (better.length === 0) {
    console.log('No geometry qualifies — leave BASE_CROP_W/H alone.');
  } else {
    const best = better.sort((a, b) => b.medGap - a.medGap)[0];
    console.log(`Best: "${best.g.name}" — median gap ${base.medGap.toFixed(3)} -> ${best.medGap.toFixed(3)}, ` +
      `rescued ${best.rescuedTotal}/${failures.length} known failures (production rescued ${base.rescuedTotal}).`);
    if (best.rescuedUnverified.length) {
      console.log('\nUnverified rescues — no ground truth yet, label these in /labels.html before trusting the count:');
      best.rescuedUnverified.slice(0, 15).forEach((l) => console.log('  ' + l));
    }
  }
})().catch((err) => { console.error(err); process.exit(1); });
