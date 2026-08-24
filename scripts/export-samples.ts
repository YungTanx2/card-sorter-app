/**
 * Exports stored calibration samples to disk for the offline recognition A/B (recognition-ab.ts).
 *
 * Two sources, because the run and the analysis happen in different places:
 *
 *   --url <base>   Pull over HTTP from a deployed instance. This is the normal path: dry runs
 *                  happen on a phone against Railway (getUserMedia needs HTTPS), so the samples
 *                  live on the volume there, not in any local file.
 *   (default)      Open the local SQLite database directly.
 *
 * Ground truth, in priority order:
 *
 *   1. An EXPLICIT label from public/labels.html (capture_labels table). Preferred whenever
 *      present — it's the only source that covers 'low-confidence' extras at all, and the only
 *      one that can express a NEGATIVE ("this frame is not a card" / "not one of this set's
 *      candidates"), which the review strip has no way to record.
 *   2. Falls back to the review strip's verdict: an accepted, non-voided 'needed' row means the
 *      operator confirmed the match, so its productId is a real label. A voided row is
 *      known-wrong but its TRUE identity is unknown — flagged, unlabelled, exported anyway so an
 *      A/B can count how many a geometry rescues into a confident match without being able to
 *      score them for correctness.
 *
 * `trueProductId` is the field a scoring harness should actually compare against: the labelled
 * product id for a 'card' verdict, or null for a 'not-a-card'/'not-in-set' verdict — meaning "no
 * correct match exists in this pool", which is a different (and previously unmeasurable) question
 * from "which card is this".
 *
 * Run: npx ts-node scripts/export-samples.ts <goalSessionId> [outDir] [--url https://host]
 */
import fs from 'fs';
import path from 'path';

type LabelVerdict = 'card' | 'not-a-card' | 'not-in-set';

interface SampleMeta {
  id: number; goalCardId: number; frameW: number; frameH: number; cropJson: string;
  productId: number | null; name: string | null; number: string | null;
  outcome: string; reason: string; score: number | null; voided: boolean;
  labelVerdict: LabelVerdict | null; labelProductId: number | null;
}

const args = process.argv.slice(2);
const urlIdx = args.indexOf('--url');
const baseUrl = urlIdx >= 0 ? args[urlIdx + 1]?.replace(/\/$/, '') : null;
const positional = args.filter((a, i) => a !== '--url' && i !== urlIdx + 1);
const sessionId = positional[0];
const outDir = positional[1] || path.join('samples', 'captures', sessionId ?? 'unknown');

async function fromHttp(base: string, id: string) {
  const get = async (p: string) => {
    const r = await fetch(base + p);
    if (!r.ok) throw new Error(`${p} -> ${r.status} ${r.statusText}`);
    return r;
  };
  const meta = await (await get(`/api/goal-session/${id}/samples`)).json() as SampleMeta[];
  // Carry the set ids through so the A/B knows which candidates to score against without being
  // told twice. session -> goal -> setIds.
  let setIds: number[] = [];
  try {
    // This endpoint returns { session, goal } together, so the goal's setIds come back in one hop.
    const body = await (await get(`/api/goal-session/${id}`)).json() as { goal?: { setIds?: number[] } };
    setIds = body.goal?.setIds ?? [];
    if (!setIds.length) throw new Error('no setIds on the goal in that response');
  } catch (err) {
    console.warn('Could not resolve setIds — pass --sets to recognition-ab.ts:',
      err instanceof Error ? err.message : err);
  }
  const frames = new Map<number, Buffer>();
  for (const m of meta) {
    const r = await get(`/api/capture-sample/${m.id}/frame`);
    frames.set(m.id, Buffer.from(await r.arrayBuffer()));
  }
  return { meta, frames, setIds };
}

function fromLocalDb(id: string) {
  // Required lazily: HTTP mode must not need a local database to exist at all.
  const { db } = require('../src/db') as typeof import('../src/db');
  const rows = db.prepare(`
    SELECT s.id, s.goal_card_id, s.frame_jpeg, s.frame_w, s.frame_h, s.crop_json,
           c.seq, c.product_id, c.name, c.number, c.outcome, c.reason, c.score, c.voided,
           l.verdict as label_verdict, l.product_id as label_product_id
      FROM capture_samples s
      JOIN goal_cards c ON c.id = s.goal_card_id
      LEFT JOIN capture_labels l ON l.capture_sample_id = s.id
     WHERE c.goal_session_id = ? ORDER BY c.seq
  `).all(id) as any[];
  const meta: SampleMeta[] = rows.map((r) => ({
    id: r.id, goalCardId: r.goal_card_id, frameW: r.frame_w, frameH: r.frame_h,
    cropJson: r.crop_json, productId: r.product_id, name: r.name, number: r.number,
    outcome: r.outcome, reason: r.reason, score: r.score, voided: r.voided === 1,
    labelVerdict: r.label_verdict ?? null, labelProductId: r.label_product_id ?? null,
  }));
  const frames = new Map<number, Buffer>(rows.map((r) => [r.id, r.frame_jpeg]));
  const goal = db.prepare(`
    SELECT g.set_ids_json FROM goals g
      JOIN goal_sessions gs ON gs.goal_id = g.id WHERE gs.id = ?
  `).get(id) as { set_ids_json: string } | undefined;
  return { meta, frames, setIds: goal ? JSON.parse(goal.set_ids_json) as number[] : [] };
}

function listLocalSessions() {
  try {
    const { db } = require('../src/db') as typeof import('../src/db');
    console.error('\nLocal sessions with samples:');
    for (const r of db.prepare(`
      SELECT c.goal_session_id AS id, COUNT(*) AS n, MAX(s.created_at) AS last
        FROM capture_samples s JOIN goal_cards c ON c.id = s.goal_card_id
       GROUP BY c.goal_session_id ORDER BY last DESC
    `).all() as any[]) {
      console.error(`  ${r.id}  ${r.n} samples  ${new Date(r.last).toLocaleString()}`);
    }
  } catch { /* no local db — fine, HTTP mode doesn't need one */ }
}

(async () => {
  if (!sessionId) {
    console.error('Usage: npx ts-node scripts/export-samples.ts <goalSessionId> [outDir] [--url https://host]');
    console.error('\nThe session id is in the Set Builder URL / past-runs list.');
    listLocalSessions();
    process.exit(1);
  }

  const { meta, frames, setIds } = baseUrl
    ? await fromHttp(baseUrl, sessionId)
    : fromLocalDb(sessionId);

  if (meta.length === 0) {
    console.error(`No samples for session ${sessionId}. Was "Collect calibration samples" ticked?`);
    process.exit(2);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const samples = meta.map((m, i) => {
    const file = `${String(i + 1).padStart(3, '0')}-sample${m.id}.jpg`;
    fs.writeFileSync(path.join(outDir, file), frames.get(m.id)!);

    const hasExplicitLabel = m.labelVerdict != null;
    const fallbackLabelled = !m.voided && m.outcome === 'needed' && m.productId != null;
    const labelSource: 'explicit-card' | 'explicit-negative' | 'review-strip' | 'none' =
      m.labelVerdict === 'card' ? 'explicit-card'
      : hasExplicitLabel ? 'explicit-negative'
      : fallbackLabelled ? 'review-strip'
      : 'none';
    // null trueProductId on an 'explicit-negative' is not "unknown" — it is the label: no correct
    // match exists in this pool for this frame. That is a real, previously unrepresentable
    // ground-truth state, and a harness that treats null as "skip this row" will silently throw
    // away every negative the labelling view exists to provide.
    const trueProductId =
      labelSource === 'explicit-card' ? m.labelProductId
      : labelSource === 'review-strip' ? m.productId
      : null;

    return {
      file, frameW: m.frameW, frameH: m.frameH,
      /** The crop in force when this was captured — the A/B's baseline arm. */
      productionCrop: JSON.parse(m.cropJson),
      productId: m.productId, name: m.name, number: m.number,
      outcome: m.outcome, reason: m.reason, score: m.score, voided: m.voided,
      labelVerdict: m.labelVerdict, labelProductId: m.labelProductId,
      labelSource,
      /** True if labelSource !== 'none' — kept as a plain boolean for backward-compat with
       *  scripts/recognition-ab.ts's `s.labelled` filter, which predates explicit labels. */
      labelled: labelSource !== 'none',
      trueProductId,
    };
  });

  fs.writeFileSync(path.join(outDir, 'labels.json'), JSON.stringify(
    { goalSessionId: sessionId, setIds, exportedAt: Date.now(), samples }, null, 2));

  const bySource = { 'explicit-card': 0, 'explicit-negative': 0, 'review-strip': 0, none: 0 };
  samples.forEach((s) => { bySource[s.labelSource]++; });
  const labelled = samples.length - bySource.none;
  console.log(`Exported ${samples.length} frames to ${outDir}` + (baseUrl ? ` (from ${baseUrl})` : ''));
  console.log(`  setIds: ${setIds.length ? setIds.join(', ') : 'UNKNOWN — pass --sets to recognition-ab.ts'}`);
  console.log(`  ${labelled} with ground truth:`);
  console.log(`    ${bySource['explicit-card']} explicit — labelled as a specific card`);
  console.log(`    ${bySource['explicit-negative']} explicit — labelled not-a-card / not-in-set`);
  console.log(`    ${bySource['review-strip']} from the review strip (unlabelled fallback)`);
  console.log(`  ${samples.filter((s) => s.voided).length} voided — known-wrong, true identity unknown`);
  console.log(`  ${samples.filter((s) => !s.labelled && s.reason === 'low-confidence').length} low-confidence — still unlabelled; the most informative frames to label next`);
  if (labelled < 20) {
    console.log(`\nNote: ${labelled} labelled samples is thin. A recognition A/B should rest on`);
    console.log('more than this — label more in /labels.html before trusting the result.');
  }
})().catch((err) => { console.error(err); process.exit(1); });
