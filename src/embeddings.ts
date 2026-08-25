import sharp from 'sharp';
import { db } from './db';
import { CandidateCard, EmbeddingMatch } from './types';

// Self-hosted recognition layer — CLIP embeddings + cosine similarity, replacing TCGTracking's
// /scan. See the plan: validated in scripts/embedding-harness.ts (Phase A, 2026-08-05) at 5/6
// correct on real photos that broke TCGTracking's /scan entirely. @huggingface/transformers is
// ESM-only; this project is CommonJS, hence the dynamic import cached below.
const MODEL_ID = 'Xenova/clip-vit-base-patch32';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TransformersModule = any;
let modulePromise: Promise<TransformersModule> | null = null;
function getModule(): Promise<TransformersModule> {
  if (!modulePromise) modulePromise = import('@huggingface/transformers');
  return modulePromise;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let extractorPromise: Promise<any> | null = null;
async function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = getModule().then(({ pipeline }) => pipeline('image-feature-extraction', MODEL_ID));
  }
  return extractorPromise;
}

/**
 * Embeds one image (a card photo, or a TCGCSV reference image) into a CLIP feature vector.
 *
 * Decodes with this project's OWN `sharp` rather than the pipeline's default fromBlob() path
 * — @huggingface/transformers bundles its own (older) sharp copy that crashed on Windows with
 * a real libvips colourspace bug on a completely normal sRGB JPEG straight from TCGCSV (see
 * scripts/embedding-harness.ts and package.json's "overrides", which forces one shared sharp
 * version tree-wide as the permanent fix). Constructing RawImage from already-decoded raw
 * pixels sidesteps the library's internal decode path entirely, not just the version conflict.
 */
export async function embedImage(input: Buffer): Promise<number[]> {
  const { RawImage } = await getModule();
  const { data, info } = await sharp(input).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  const image = new RawImage(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), info.width, info.height, info.channels as 1 | 2 | 3 | 4);
  const extractor = await getExtractor();
  // CLIP's image-feature-extraction pipeline returns an already-pooled [1, 512] tensor for
  // this model (confirmed via the library's own docstring + Phase A) — no pooling options needed.
  const output = await extractor(image);
  return Array.from(output.data as Float32Array);
}

/** Hand-rolled rather than the library's cos_sim() to avoid a dynamic-import round trip inside
 *  a loop scored against every candidate in a set (~150-250 comparisons per capture) — same
 *  math, validated equivalent output in scripts/embedding-harness.ts. */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

const selectVariants = db.prepare(
  'SELECT variant, embedding FROM embedding_cache WHERE product_id = ? AND model_id = ?');
const selectOneVariant = db.prepare(
  'SELECT 1 FROM embedding_cache WHERE product_id = ? AND model_id = ? AND variant = ?');
const upsertEmbedding = db.prepare(`
  INSERT INTO embedding_cache (product_id, model_id, variant, embedding, fetched_at)
  VALUES (@productId, @modelId, @variant, @embedding, @fetchedAt)
  ON CONFLICT(product_id, model_id, variant)
  DO UPDATE SET embedding = excluded.embedding, fetched_at = excluded.fetched_at
`);

/**
 * Extra orientations to embed for a reference image, on top of 'base'.
 *
 * Lorcana Location cards are printed with LANDSCAPE artwork on a normal portrait card, so TCGCSV
 * serves their reference image rotated 90 degrees relative to how the machine sees them — the card
 * goes through the feeder in the same physical orientation as everything else. Measured on the
 * 2026-08-24 corpus, all 3 Location frames ranked 207th / 159th / 34th out of 217, and produced
 * the only silent misroute among 57 labelled cards.
 *
 * BOTH rotations are stored, not just one: the card can be fed either way up, and picking a single
 * direction would fix half the cases and leave the other half exactly as broken. Detection is on
 * the image's own aspect ratio rather than a name or card-type lookup, because the thing that
 * actually breaks matching is the reference art being landscape — whatever the game calls it.
 */
const ROTATIONS: Record<string, number> = { rot90: 90, rot270: 270 };

const selectRefMeta = db.prepare('SELECT is_landscape FROM reference_meta WHERE product_id = ?');
const upsertRefMeta = db.prepare(`
  INSERT INTO reference_meta (product_id, is_landscape, checked_at)
  VALUES (@productId, @isLandscape, @checkedAt)
  ON CONFLICT(product_id) DO UPDATE SET is_landscape = excluded.is_landscape, checked_at = excluded.checked_at
`);

async function variantsFor(productId: number, image: Buffer): Promise<Array<{ variant: string; buf: Buffer }>> {
  const out = [{ variant: 'base', buf: image }];
  const meta = await sharp(image).metadata();
  const isLandscape = (meta.width ?? 0) > (meta.height ?? 0);
  upsertRefMeta.run({ productId, isLandscape: isLandscape ? 1 : 0, checkedAt: Date.now() });
  if (isLandscape) {
    for (const [variant, angle] of Object.entries(ROTATIONS)) {
      out.push({ variant, buf: await sharp(image).rotate(angle).toBuffer() });
    }
  }
  return out;
}

/**
 * Cache-aside: embeds a candidate's TCGCSV reference photo once, reused by every future
 * session that scopes the same card (embedding is the compute-expensive step, not something
 * to redo per run — same reasoning as the old product_cache, just for vectors instead of SKUs).
 * Errors on one candidate (a dead imageUrl, a fetch failure) are swallowed with a warning —
 * one missing reference photo shouldn't fail pre-warming the other ~150-250 candidates in a set.
 *
 * Returns EVERY stored orientation for the candidate — see variantsFor().
 */
async function getCandidateEmbeddings(candidate: CandidateCard): Promise<number[][]> {
  const cached = selectVariants.all(candidate.productId, MODEL_ID) as { variant: string; embedding: string }[];
  if (cached.length) return cached.map((r) => JSON.parse(r.embedding) as number[]);
  if (!candidate.imageUrl) return [];

  try {
    const res = await fetch(candidate.imageUrl, { headers: { 'User-Agent': 'card-sorter-app/1.0' } });
    if (!res.ok) throw new Error(`image fetch failed: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const out: number[][] = [];
    for (const { variant, buf: img } of await variantsFor(candidate.productId, buf)) {
      const embedding = await embedImage(img);
      upsertEmbedding.run({
        productId: candidate.productId, modelId: MODEL_ID, variant,
        embedding: JSON.stringify(embedding), fetchedAt: Date.now(),
      });
      out.push(embedding);
    }
    return out;
  } catch (err) {
    console.warn(`[embeddings] skipping candidate ${candidate.productId} (${candidate.name}):`, err instanceof Error ? err.message : err);
    return [];
  }
}

/** Pre-warms embeddings for every candidate in a session's scope. Called once at session
 *  creation (session.ts) — the reason scanCard() needs no network calls during an actual run. */
export async function prewarmEmbeddings(candidates: CandidateCard[]): Promise<void> {
  let backfilled = 0;
  for (const c of candidates) {
    if (await backfillRotations(c)) backfilled++;
    await getCandidateEmbeddings(c);
  }
  if (backfilled) console.log(`[embeddings] added rotated variants for ${backfilled} landscape reference(s)`);
}

/**
 * Adds rotated variants to an already-cached reference. Returns true if it embedded anything.
 *
 * Only needed for caches written before rotations existed: a landscape card cached back then has
 * just its 'base' row, and that alone makes getCandidateEmbeddings() consider it fully warmed, so
 * without this an existing deployment would keep the broken single-orientation match forever.
 *
 * The reference_meta lookup is what keeps this cheap. Deciding "is this landscape?" needs the
 * image, so checking it live would re-download every reference in the set on every single prewarm
 * — ~261 images per run, forever, to answer a question whose answer never changes. Recording the
 * answer once turns all subsequent runs into a single indexed read per candidate.
 */
async function backfillRotations(candidate: CandidateCard): Promise<boolean> {
  if (!candidate.imageUrl) return false;
  // Nothing cached yet: the normal embed path handles every variant, so there is nothing to fix up.
  if (!selectOneVariant.get(candidate.productId, MODEL_ID, 'base')) return false;

  const known = selectRefMeta.get(candidate.productId) as { is_landscape: number } | undefined;
  if (known && known.is_landscape === 0) return false;                                  // portrait: base is the only orientation
  if (known && selectOneVariant.get(candidate.productId, MODEL_ID, 'rot90')) return false; // landscape, already done

  try {
    const res = await fetch(candidate.imageUrl, { headers: { 'User-Agent': 'card-sorter-app/1.0' } });
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    const meta = await sharp(buf).metadata();
    const isLandscape = (meta.width ?? 0) > (meta.height ?? 0);
    upsertRefMeta.run({ productId: candidate.productId, isLandscape: isLandscape ? 1 : 0, checkedAt: Date.now() });
    if (!isLandscape) return false;

    let wrote = false;
    for (const [variant, angle] of Object.entries(ROTATIONS)) {
      if (selectOneVariant.get(candidate.productId, MODEL_ID, variant)) continue;
      const embedding = await embedImage(await sharp(buf).rotate(angle).toBuffer());
      upsertEmbedding.run({
        productId: candidate.productId, modelId: MODEL_ID, variant,
        embedding: JSON.stringify(embedding), fetchedAt: Date.now(),
      });
      console.log(`[embeddings] backfilled ${variant} for landscape reference ${candidate.productId} (${candidate.name})`);
      wrote = true;
    }
    return wrote;
  } catch (err) {
    console.warn(`[embeddings] rotation backfill failed for ${candidate.productId}:`, err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * Scores an image against every candidate's cached embedding by cosine similarity, sorted
 * descending. Factored out of matchCard so there is exactly one cosine-scoring loop — the
 * labelling view (server.ts's /api/capture-sample/:id/candidates) needs the full ranked list,
 * not just top-2, and a second copy of this loop could silently drift from the one that actually
 * decides routing.
 */
export async function scoreCandidates(imageBuffer: Buffer, candidates: CandidateCard[]): Promise<EmbeddingMatch[]> {
  const queryEmbedding = await embedImage(imageBuffer);

  const scored: EmbeddingMatch[] = [];
  for (const c of candidates) {
    const rows = selectVariants.all(c.productId, MODEL_ID) as { variant: string; embedding: string }[];
    if (rows.length === 0) continue; // reference image never embedded successfully — skip, don't guess
    // MAX across orientations, not mean: the variants are the same card photographed different
    // ways up, so exactly one of them should match a given capture well and the others should
    // match it poorly. Averaging would drag a correct match down by the cost of its own wrong
    // rotations, which is the opposite of what storing them is for.
    let best = -Infinity;
    for (const row of rows) {
      const s = cosineSimilarity(queryEmbedding, JSON.parse(row.embedding) as number[]);
      if (s > best) best = s;
    }
    scored.push({ productId: c.productId, score: best });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * The core recognition call: scores the capture against every candidate, returns the top-2
 * (mirrors TCGTracking's top/runnerUp shape session.ts already consumes — this is a closer
 * drop-in than a candidate-list-prompt approach would have been, since there's no serialization
 * step and a real runner-up falls out of the ranking for free, preserving the minGap
 * confidence-gate concept unchanged).
 */
export async function matchCard(imageBuffer: Buffer, candidates: CandidateCard[]): Promise<{ top: EmbeddingMatch | null; runnerUp: EmbeddingMatch | null }> {
  const scored = await scoreCandidates(imageBuffer, candidates);
  return { top: scored[0] ?? null, runnerUp: scored[1] ?? null };
}
