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

const selectEmbedding = db.prepare('SELECT embedding FROM embedding_cache WHERE product_id = ?');
const upsertEmbedding = db.prepare(`
  INSERT INTO embedding_cache (product_id, embedding, fetched_at) VALUES (@productId, @embedding, @fetchedAt)
  ON CONFLICT(product_id) DO UPDATE SET embedding = excluded.embedding, fetched_at = excluded.fetched_at
`);

/**
 * Cache-aside: embeds a candidate's TCGCSV reference photo once, reused by every future
 * session that scopes the same card (embedding is the compute-expensive step, not something
 * to redo per run — same reasoning as the old product_cache, just for vectors instead of SKUs).
 * Errors on one candidate (a dead imageUrl, a fetch failure) are swallowed with a warning —
 * one missing reference photo shouldn't fail pre-warming the other ~150-250 candidates in a set.
 */
async function getCandidateEmbedding(candidate: CandidateCard): Promise<number[] | null> {
  const cached = selectEmbedding.get(candidate.productId) as { embedding: string } | undefined;
  if (cached) return JSON.parse(cached.embedding) as number[];
  if (!candidate.imageUrl) return null;

  try {
    const res = await fetch(candidate.imageUrl, { headers: { 'User-Agent': 'card-sorter-app/1.0' } });
    if (!res.ok) throw new Error(`image fetch failed: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const embedding = await embedImage(buf);
    upsertEmbedding.run({ productId: candidate.productId, embedding: JSON.stringify(embedding), fetchedAt: Date.now() });
    return embedding;
  } catch (err) {
    console.warn(`[embeddings] skipping candidate ${candidate.productId} (${candidate.name}):`, err instanceof Error ? err.message : err);
    return null;
  }
}

/** Pre-warms embeddings for every candidate in a session's scope. Called once at session
 *  creation (session.ts) — the reason scanCard() needs no network calls during an actual run. */
export async function prewarmEmbeddings(candidates: CandidateCard[]): Promise<void> {
  for (const c of candidates) {
    await getCandidateEmbedding(c);
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
    const cached = selectEmbedding.get(c.productId) as { embedding: string } | undefined;
    if (!cached) continue; // candidate whose reference image never embedded successfully — skip, don't guess
    const score = cosineSimilarity(queryEmbedding, JSON.parse(cached.embedding) as number[]);
    scored.push({ productId: c.productId, score });
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
