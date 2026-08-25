/**
 * OCR peer signal — reads the printed card TITLE and resolves it against the candidate pool.
 *
 * WHY THIS EXISTS, and why it reads the title rather than the collector number:
 *
 * Measured on the 57 labelled frames of the 2026-08-17 dry run, at the resolution production
 * already captures:
 *
 *     TITLE  (fuzzy sim >= 0.80)   fired on 32/57   100% precision
 *     NUMBER                       fired on  4/57    50% precision
 *
 * The collector line is ~11px tall against the title's ~33px, which puts it under Tesseract's
 * usable floor. Reading the number was the original plan and it does not work at 1080p — revisit
 * only if capture.js's VIDEO_CONSTRAINTS is raised to 4K, at which point it becomes viable again.
 *
 * The title is a PRIMARY KEY in every variant-scoped runtime pool, which is what makes a read
 * sufficient on its own rather than merely a hint:
 *
 *     variant "Normal"      217 products -> 208 distinct titles, 1 collision (the 10 unnumbered
 *                           puzzle inserts, already excluded by isSetSlotCandidate)
 *     variant "Cold Foil"   207 products -> 207 distinct titles, 0 collisions
 *
 * Enchanted/Epic/Iconic reprints DO share a printed title with their base card, but they never
 * co-occur in one pool — they exist only as Cold Foil, and the base cards only as Normal. That
 * collision is visible ONLY in the unscoped catalog, which is exactly the trap that produced the
 * original variant-twins bug. Always resolve against the scoped candidate list passed in here,
 * never against the whole tcgcsv_cache.
 *
 * This signal is a PEER of the embedding matcher, not a fallback: on the labelled corpus CLIP
 * alone routed 14 cards OCR missed, OCR alone routed 13 cards CLIP missed, 18 were carried by
 * both, and there were ZERO disagreements. fuseSignals() below is how they combine.
 */
import sharp from 'sharp';
import type { CandidateCard, EmbeddingMatch, MatchSource } from './types';

const CARD_ASPECT = 0.716; // 63mm x 88mm

const OCR_CHAR_WHITELIST =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'&.- ";

/** Tesseract is lazily created and reused — worker startup dominates a single recognize() call. */
let workerPromise: Promise<any> | null = null;
async function getWorker(): Promise<any> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker, PSM } = await import('tesseract.js');
      const w = await createWorker('eng');
      await w.setParameters({
        tessedit_pageseg_mode: PSM.SINGLE_LINE,
        // Digits are deliberately excluded: the name bar sits beside the cost/strength/willpower
        // numerals, and letting Tesseract emit them only adds junk for the matcher to chew on.
        tessedit_char_whitelist: OCR_CHAR_WHITELIST,
      });
      return w;
    })().catch((err) => {
      workerPromise = null; // let a later scan retry rather than poisoning the process
      throw err;
    });
  }
  return workerPromise;
}

/** Frees the Tesseract worker. Called from the server's SIGTERM handler. */
export async function shutdownOcr(): Promise<void> {
  if (!workerPromise) return;
  const p = workerPromise;
  workerPromise = null;
  try { await (await p).terminate(); } catch { /* already gone */ }
}

export const normalizeTitle = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** The catalog name carries parentheticals — "(Enchanted)", "(Foil)" — that are NOT printed on
 *  the card. Strip them so we compare against what the camera can actually see. */
export const printedTitle = (name: string): string => name.replace(/\s*\([^)]*\)\s*$/g, '').trim();

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur: number[] = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/**
 * Approximate-SUBSTRING similarity: the best alignment of `pat` anywhere inside `text`.
 *
 * Whole-string Levenshtein was tried first and badly under-scored good reads — a clean
 * "OMNIDROID SCANNING FOR THREATS" still picks up leading and trailing junk from the art and the
 * classification bar, and every junk character counted as an edit. Sliding the pattern instead
 * makes the score depend on the part of the read that actually matters.
 */
export function substringSimilarity(text: string, pat: string): number {
  if (pat.length === 0) return 0;
  if (text.length < pat.length) return 1 - levenshtein(text, pat) / pat.length;
  let best = Infinity;
  const lengths = new Set([pat.length, Math.round(pat.length * 1.15), Math.round(pat.length * 0.85)]);
  for (const L of lengths) {
    if (L <= 0 || L > text.length) continue;
    for (let i = 0; i + L <= text.length; i++) {
      const d = levenshtein(text.slice(i, i + L), pat);
      if (d < best) best = d;
      if (best === 0) return 1;
    }
  }
  return 1 - best / pat.length;
}

interface Box { left: number; top: number; width: number; height: number }

/**
 * Locates the card inside the already-cropped capture.
 *
 * The platform is bright and desaturated; the card is darker, more saturated, or both. Masking on
 * "not platform" and taking the widest occupied run is enough — the rig is fixed, so this only has
 * to absorb a few millimetres of placement drift, not find a card in an arbitrary scene.
 *
 * Returns null when the detected shape is nowhere near a card's aspect ratio, which is the honest
 * outcome for a phantom capture of the bare platform. Callers treat null as "no OCR signal", never
 * as "not a card" — that call belongs to minCardScore.
 */
async function detectCard(buf: Buffer): Promise<Box | null> {
  const W = 220, H = 320;
  const { data, info } = await sharp(buf).removeAlpha().resize(W, H, { fit: 'fill' })
    .raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  const colSum = new Array<number>(W).fill(0);
  const rowSum = new Array<number>(H).fill(0);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * ch;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const sat = mx === 0 ? 0 : (mx - mn) / mx;
      if (mx < 165 || sat > 0.28) { colSum[x]++; rowSum[y]++; }
    }
  }
  const widestRun = (arr: number[], span: number, frac: number): [number, number] => {
    const thr = span * frac;
    let bs = -1, be = -1, s = -1;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] >= thr) { if (s < 0) s = i; }
      else { if (s >= 0 && i - s > be - bs) { bs = s; be = i - 1; } s = -1; }
    }
    if (s >= 0 && arr.length - s > be - bs) { bs = s; be = arr.length - 1; }
    return [bs, be];
  };
  const [x0, x1] = widestRun(colSum, H, 0.35);
  const [y0, y1] = widestRun(rowSum, W, 0.35);
  if (x0 < 0 || y0 < 0) return null;

  const meta = await sharp(buf).metadata();
  const fw = meta.width ?? 0, fh = meta.height ?? 0;
  if (!fw || !fh) return null;
  const box: Box = {
    left: Math.round((x0 / W) * fw),
    top: Math.round((y0 / H) * fh),
    width: Math.round(((x1 - x0 + 1) / W) * fw),
    height: Math.round(((y1 - y0 + 1) / H) * fh),
  };
  if (box.width < 40 || box.height < 60) return null;
  // The mask bleeds sideways on bright cards, so the tolerance here is wide on purpose; it is a
  // sanity check against an empty platform, not a precision measurement.
  const aspect = box.width / box.height;
  if (aspect < CARD_ASPECT * 0.75 || aspect > CARD_ASPECT * 1.35) return null;
  return box;
}

/** Fractional bands within the detected card. Lorcana puts the name on a stable line with the
 *  subtitle directly beneath; both are read and joined, because "MULAN" alone is ambiguous
 *  against every other Mulan printing while "MULAN CREATED BY THE VINE" is not. */
const BANDS = {
  name: { x: 0.05, y: 0.540, w: 0.72, h: 0.055 },
  sub:  { x: 0.05, y: 0.585, w: 0.72, h: 0.042 },
};

function bandBox(card: Box, b: { x: number; y: number; w: number; h: number }, fw: number, fh: number): Box {
  const left = Math.max(0, Math.min(fw - 8, Math.round(card.left + b.x * card.width)));
  const top = Math.max(0, Math.min(fh - 8, Math.round(card.top + b.y * card.height)));
  return {
    left, top,
    width: Math.max(8, Math.min(fw - left, Math.round(b.w * card.width))),
    height: Math.max(8, Math.min(fh - top, Math.round(b.h * card.height))),
  };
}

export interface OcrTitleMatch {
  productId: number;
  /** Approximate-substring similarity in [0, 1] against the resolved title. */
  sim: number;
  /** Gap to the next-best DISTINCT title — near-zero means two catalog titles fit equally well. */
  margin: number;
  /** What Tesseract actually returned, kept for the manifest so a miss is diagnosable. */
  raw: string;
}

/**
 * Reads the title off a capture and resolves it to a candidate.
 *
 * NEVER throws: OCR is a peer signal, and a Tesseract failure must degrade the run to
 * embedding-only rather than stalling it. Returns null when there is no usable read.
 */
export async function readCardTitle(
  imageBuffer: Buffer,
  candidates: CandidateCard[],
  opts: { minTitleChars: number },
): Promise<OcrTitleMatch | null> {
  if (candidates.length === 0) return null;
  try {
    const meta = await sharp(imageBuffer).metadata();
    const fw = meta.width ?? 0, fh = meta.height ?? 0;
    if (!fw || !fh) return null;
    const card = await detectCard(imageBuffer);
    if (!card) return null;

    // Titles shorter than this match almost any garbage read once fuzzy matching is involved —
    // a 4-character name like "RAHR" found a low-distance window in pure noise during the
    // feasibility run. Excluded from the index (not filtered afterwards) so a short title can
    // never win, and so its absence is reflected in the runner-up margin too.
    const index = new Map<string, number[]>();
    for (const c of candidates) {
      const k = normalizeTitle(printedTitle(c.name));
      if (k.length < opts.minTitleChars) continue;
      const list = index.get(k);
      if (list) list.push(c.productId); else index.set(k, [c.productId]);
    }
    if (index.size === 0) return null;

    const worker = await getWorker();
    const render = async (b: { x: number; y: number; w: number; h: number }, scale: number, invert: boolean): Promise<Buffer> => {
      const box = bandBox(card, b, fw, fh);
      let p = sharp(imageBuffer).extract(box).greyscale()
        .resize({ width: Math.round(box.width * scale), kernel: 'lanczos3' }).normalise();
      if (invert) p = p.negate();
      return p.png().toBuffer();
    };

    let best: OcrTitleMatch | null = null;
    // Lorcana name bars run light-on-dark AND dark-on-light depending on the ink colour, and
    // Tesseract is markedly better on dark-on-light, so both polarities are tried and the better
    // resolution kept. Two extra recognize() calls cost ~120ms against a 4.2s machine cycle.
    for (const invert of [true, false]) {
      const [nameBuf, subBuf] = await Promise.all([
        render(BANDS.name, 4, invert),
        render(BANDS.sub, 5, invert),
      ]);
      const t1 = (await worker.recognize(nameBuf, {}, { text: true })).data.text ?? '';
      const t2 = (await worker.recognize(subBuf, {}, { text: true })).data.text ?? '';
      const raw = `${t1} ${t2}`.replace(/\s+/g, ' ').trim();
      const q = normalizeTitle(raw);
      if (q.length < opts.minTitleChars) continue;

      let topKey = '', topSim = -1, secondSim = -1;
      for (const k of index.keys()) {
        const sim = substringSimilarity(q, k);
        if (sim > topSim) { secondSim = topSim; topSim = sim; topKey = k; }
        else if (sim > secondSim) { secondSim = sim; }
      }
      const ids = index.get(topKey);
      if (!ids || ids.length === 0) continue;
      if (!best || topSim > best.sim) {
        best = { productId: ids[0], sim: topSim, margin: topSim - Math.max(secondSim, 0), raw };
      }
    }
    return best;
  } catch (err) {
    console.warn('[ocr] read failed, degrading to embedding-only:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** The peer decision: what the two signals jointly concluded, and which of them concluded it. */
export interface FusedMatch {
  /** The agreed card, or null when nothing was confident enough — or when they disagreed. */
  productId: number | null;
  source: MatchSource | null;
  /**
   * Both signals were confident and named DIFFERENT cards.
   *
   * This never happened once across the 18 corpus frames where both fired, which is precisely why
   * it is worth surfacing rather than resolving. A disagreement is not a close call to be broken
   * by preferring one signal — it means something upstream has moved: the crop geometry drifted,
   * a threshold is stale, or the candidate pool is wrong for the pile being fed. Routing on
   * either answer would hide the very event that explains the run.
   *
   * So it fails safe to extras/bulk with its own reason code. The card is re-scannable, and the
   * manifest records both answers.
   */
  conflict: boolean;
  clipConfident: boolean;
  ocrConfident: boolean;
}

/**
 * Combines the embedding and OCR signals as PEERS.
 *
 * Neither is primary. Measured on the labelled corpus: 18 frames carried by both, 14 by the
 * embedding alone, 13 by OCR alone, 12 by neither. An architecture that made either one
 * subordinate would give up roughly a quarter of the cards the other rescues — the ordering was
 * tested both ways and produced identical results (79% recall, 98% precision) precisely because
 * the two never contradicted each other.
 */
export function fuseSignals(args: {
  top: EmbeddingMatch | null;
  runnerUp: EmbeddingMatch | null;
  ocr: OcrTitleMatch | null;
  minScore: number;
  minGap: number;
  ocrMinSim: number;
}): FusedMatch {
  const { top, runnerUp, ocr, minScore, minGap, ocrMinSim } = args;
  const clipConfident = !!top
    && top.score >= minScore
    && (!runnerUp || top.score - runnerUp.score >= minGap);
  const ocrConfident = !!ocr && ocr.sim >= ocrMinSim;

  if (clipConfident && ocrConfident) {
    if (top!.productId !== ocr!.productId) {
      return { productId: null, source: null, conflict: true, clipConfident, ocrConfident };
    }
    return { productId: top!.productId, source: 'both', conflict: false, clipConfident, ocrConfident };
  }
  if (clipConfident) return { productId: top!.productId, source: 'clip', conflict: false, clipConfident, ocrConfident };
  if (ocrConfident) return { productId: ocr!.productId, source: 'ocr', conflict: false, clipConfident, ocrConfident };
  return { productId: null, source: null, conflict: false, clipConfident, ocrConfident };
}
