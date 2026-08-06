/**
 * Phase A go/no-go test for the self-hosted embedding matcher — see plan at
 * ~/.claude/plans/familiarize-yourself-with-the-abstract-patterson.md.
 *
 * Standalone, read-only: fetches the real "Attack of the Vine!" (set 24666, Lorcana
 * categoryId 71) candidate list + reference images from TCGCSV, embeds every candidate
 * once with a pretrained CLIP model, then scores the 6 real photos already on disk
 * (3 original calibration photos + 3 diagnostic captures from the failed 10-card run)
 * against the full candidate set by cosine similarity.
 *
 * No session/server/db wiring, no API key. This does not import src/tcgcsv.ts (doesn't
 * exist yet — that's a Phase B file) — it has its own minimal TCGCSV client, matching
 * the pattern of the other standalone scripts (calibrate.ts, diagnose-scoping.js) in
 * this project's history.
 *
 * Run: npx ts-node scripts/embedding-harness.ts
 */
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

const CATEGORY_ID = 71; // Disney Lorcana
const GROUP_ID = 24666; // Attack of the Vine! (13)
const HEADERS = { 'User-Agent': 'card-sorter-app-embedding-harness/1.0' };
const CACHE_PATH = path.join(
  'C:\\Users\\salmo\\AppData\\Local\\Temp\\claude\\C--Users-salmo-OneDrive-Documents-ClaudeProjects\\930cc013-9d1f-4dae-a31c-faa3cceaa628\\scratchpad',
  'embedding-cache.json',
);
const MODEL_ID = 'Xenova/clip-vit-base-patch32';

interface ExtendedDataEntry { name: string; displayName: string; value: string }
interface TCGProduct {
  productId: number;
  name: string;
  imageUrl?: string;
  extendedData?: ExtendedDataEntry[];
}

function extractField(extendedData: ExtendedDataEntry[] | undefined, field: string): string | null {
  return extendedData?.find((e) => e.name === field)?.value ?? null;
}

async function fetchCandidates(): Promise<TCGProduct[]> {
  const res = await fetch(`https://tcgcsv.com/tcgplayer/${CATEGORY_ID}/${GROUP_ID}/products`, { headers: HEADERS });
  if (!res.ok) throw new Error(`TCGCSV products fetch failed: ${res.status}`);
  const data = (await res.json()) as { results: TCGProduct[] };
  // Real singles only — same "has a Rarity" filter used elsewhere in this codebase
  // (lorcana-seller-csv/onepiece-ev) to exclude sealed product / promos.
  return (data.results ?? []).filter((p) => extractField(p.extendedData, 'Rarity') !== null && p.imageUrl);
}

const queries = [
  {
    label: 'Meilin Lee',
    truthName: 'Meilin Lee',
    truthNumber: '125/207',
    rawFile: 'C:\\Users\\salmo\\OneDrive\\Documents\\ClaudeProjects\\ToShare\\Sample Card Images\\PXL_20260804_163104951.MP.jpg',
    crop: { left: 318, top: 1089, width: 1315, height: 1895 }, // from samples/truth.json
  },
  {
    label: 'Pocahontas',
    truthName: 'Pocahontas',
    truthNumber: '12/207',
    rawFile: 'C:\\Users\\salmo\\OneDrive\\Documents\\ClaudeProjects\\ToShare\\Sample Card Images\\PXL_20260804_163107358.MP.jpg',
    crop: { left: 318, top: 1089, width: 1315, height: 1895 },
  },
  {
    label: 'With a Few Good Friends',
    truthName: 'With a Few Good Friends',
    truthNumber: '65/207',
    rawFile: 'C:\\Users\\salmo\\OneDrive\\Documents\\ClaudeProjects\\ToShare\\Sample Card Images\\PXL_20260804_163109511.MP.jpg',
    crop: { left: 318, top: 1089, width: 1315, height: 1895 },
  },
  {
    label: 'Sprout',
    truthName: 'Sprout',
    truthNumber: null as string | null, // resolved by name match against fetched candidates
    rawFile: 'C:\\Users\\salmo\\.claude\\uploads\\930cc013-9d1f-4dae-a31c-faa3cceaa628\\73ffcf07-capture1785945187636.jpg',
    crop: null, // already the app's own cropped capture
  },
  {
    label: 'Kronk',
    truthName: 'Kronk',
    truthNumber: null as string | null,
    rawFile: 'C:\\Users\\salmo\\.claude\\uploads\\930cc013-9d1f-4dae-a31c-faa3cceaa628\\0db978bb-capture1785945178632.jpg',
    crop: null,
  },
  {
    label: 'Scar',
    truthName: 'Scar',
    truthNumber: '194/207', // confirmed live earlier this session via /scan
    rawFile: 'C:\\Users\\salmo\\.claude\\uploads\\930cc013-9d1f-4dae-a31c-faa3cceaa628\\64416fc8-capture1785945173036.jpg',
    crop: null,
  },
];

async function main() {
  console.log(`Loading CLIP model (${MODEL_ID}) — first run downloads weights, subsequent runs use the local cache...`);
  // Dynamic import: @huggingface/transformers is ESM-only, this project is CommonJS.
  const { pipeline, cos_sim, RawImage } = await import('@huggingface/transformers');
  const extractor = await pipeline('image-feature-extraction', MODEL_ID);

  async function embed(input: Buffer): Promise<number[]> {
    // RawImage.fromBlob() decodes via @huggingface/transformers' OWN bundled sharp
    // (node_modules/@huggingface/transformers/node_modules/sharp) — an outdated version
    // with real libvips colourspace bugs (matches the "sharp <0.35.0" advisory `npm audit`
    // flagged on install) that threw "colourspace: parameter space not set" on a perfectly
    // normal sRGB JPEG straight from TCGCSV. Bypass it entirely: decode with this project's
    // own (current, working) `sharp`, and hand RawImage raw decoded pixels directly via its
    // (data, width, height, channels) constructor instead of going through fromBlob's decode path.
    const { data, info } = await sharp(input).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
    const image = new RawImage(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), info.width, info.height, info.channels as 1 | 2 | 3 | 4);
    // CLIP's image-feature-extraction pipeline returns an already-pooled [1, 512] tensor
    // by default (see @huggingface/transformers' own docstring example for this exact
    // model) — no pooling/normalize options needed; cos_sim() below handles normalization.
    const output = await extractor(image);
    return Array.from(output.data as Float32Array);
  }

  console.log('Fetching candidate list from TCGCSV (Attack of the Vine!, set 24666)...');
  const candidates = await fetchCandidates();
  console.log(`  ${candidates.length} real cards found.`);

  // ---- candidate embedding cache (avoid re-downloading/re-embedding ~200 images every run) ----
  let cache: Record<string, number[]> = {};
  if (fs.existsSync(CACHE_PATH)) {
    try { cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8')); } catch { /* corrupt cache, rebuild */ }
  }

  const candidateEmbeddings: { productId: number; name: string; number: string | null; embedding: number[] }[] = [];
  let fetched = 0;
  for (const c of candidates) {
    const key = `${MODEL_ID}::${c.productId}`;
    let emb = cache[key];
    if (!emb) {
      const imgRes = await fetch(c.imageUrl!, { headers: HEADERS });
      if (!imgRes.ok) {
        console.warn(`  WARN: image fetch failed for ${c.name} (${c.productId}): ${imgRes.status}`);
        continue;
      }
      const buf = Buffer.from(await imgRes.arrayBuffer());
      emb = await embed(buf);
      cache[key] = emb;
      fetched++;
      if (fetched % 20 === 0) {
        console.log(`  embedded ${fetched} new candidates so far...`);
        fs.writeFileSync(CACHE_PATH, JSON.stringify(cache)); // checkpoint periodically
      }
    }
    candidateEmbeddings.push({
      productId: c.productId,
      name: c.name,
      number: extractField(c.extendedData, 'Number'),
      embedding: emb,
    });
  }
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache));
  console.log(`Candidate embeddings ready: ${candidateEmbeddings.length} total (${fetched} newly computed, ${candidateEmbeddings.length - fetched} from cache).`);

  // ---- resolve ground truth productIds by name match, now that we have the real list ----
  for (const q of queries) {
    if (q.truthNumber) continue; // already known
    const match = candidateEmbeddings.find((c) => c.name.toLowerCase().includes(q.truthName.toLowerCase()));
    if (match) {
      q.truthNumber = match.number;
      console.log(`Resolved ground truth for "${q.label}": ${match.name} #${match.number} (productId ${match.productId})`);
    } else {
      console.warn(`WARN: could not resolve ground truth for "${q.label}" by name match — will report but can't score correctness.`);
    }
  }

  // ---- score each query photo ----
  console.log('\n=== RESULTS ===');
  const rows: { label: string; correct: boolean; topScore: number; gap: number; topName: string; topNumber: string | null }[] = [];

  for (const q of queries) {
    const raw = fs.readFileSync(q.rawFile);
    const queryBuf = q.crop ? await sharp(raw).extract(q.crop).toBuffer() : raw;
    const queryEmb = await embed(queryBuf);

    const scored = candidateEmbeddings
      .map((c) => ({ ...c, score: cos_sim(queryEmb, c.embedding) }))
      .sort((a, b) => b.score - a.score);

    const top = scored[0];
    const runnerUp = scored[1];
    const correct = top.number === q.truthNumber;
    const gap = top.score - runnerUp.score;

    rows.push({ label: q.label, correct, topScore: top.score, gap, topName: top.name, topNumber: top.number });

    console.log(
      `${q.label.padEnd(26)} truth=${(q.truthNumber ?? '?').padEnd(8)} -> top="${top.name}" #${top.number} score=${top.score.toFixed(4)} ` +
        `gap=${gap.toFixed(4)} ${correct ? 'CORRECT' : 'WRONG  '} (runner-up: "${runnerUp.name}" #${runnerUp.number} score=${runnerUp.score.toFixed(4)})`,
    );
  }

  // ---- summary ----
  const correctCount = rows.filter((r) => r.correct).length;
  console.log(`\nRecognized ${correctCount}/${rows.length}`);

  const correctScores = rows.filter((r) => r.correct).map((r) => r.topScore);
  const incorrectScores = rows.filter((r) => !r.correct).map((r) => r.topScore);
  const correctGaps = rows.filter((r) => r.correct).map((r) => r.gap);
  const incorrectGaps = rows.filter((r) => !r.correct).map((r) => r.gap);

  if (correctScores.length > 0) console.log(`Correct-match score range: ${Math.min(...correctScores).toFixed(4)}-${Math.max(...correctScores).toFixed(4)}`);
  if (incorrectScores.length > 0) console.log(`Incorrect-match score range: ${Math.min(...incorrectScores).toFixed(4)}-${Math.max(...incorrectScores).toFixed(4)}`);
  if (correctGaps.length > 0) console.log(`Correct-match gap range: ${Math.min(...correctGaps).toFixed(4)}-${Math.max(...correctGaps).toFixed(4)}`);
  if (incorrectGaps.length > 0) console.log(`Incorrect-match gap range: ${Math.min(...incorrectGaps).toFixed(4)}-${Math.max(...incorrectGaps).toFixed(4)}`);

  console.log(
    '\nReminder: n=6 across one set. This is a go/no-go signal (does embedding matching clear TCGTracking\'s ' +
      '1/3 bar at all, and is there any score separation), not a calibrated threshold — that still needs the ' +
      'full dry run once an approach is chosen.',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
