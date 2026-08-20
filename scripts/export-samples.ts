/**
 * Exports stored calibration samples to disk for the offline crop-geometry A/B (crop-ab.ts).
 *
 * Two sources, because the run and the analysis happen in different places:
 *
 *   --url <base>   Pull over HTTP from a deployed instance. This is the normal path: dry runs
 *                  happen on a phone against Railway (getUserMedia needs HTTPS), so the samples
 *                  live on the volume there, not in any local file.
 *   (default)      Open the local SQLite database directly.
 *
 * Ground truth comes from the review strip. An accepted, non-voided row means the operator
 * confirmed the match, so its productId is a real label. A voided row is known-wrong but its TRUE
 * identity is unknown — the strip records that a match was bad, not what the card actually was.
 * Those export flagged and unlabelled: the A/B can count how many a geometry rescues into a
 * confident match, but cannot score them for correctness.
 *
 * Run: npx ts-node scripts/export-samples.ts <goalSessionId> [outDir] [--url https://host]
 */
import fs from 'fs';
import path from 'path';

interface SampleMeta {
  id: number; goalCardId: number; frameW: number; frameH: number; cropJson: string;
  productId: number | null; name: string | null; number: string | null;
  outcome: string; reason: string; score: number | null; voided: boolean;
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
    console.warn('Could not resolve setIds — pass --sets to crop-ab.ts:',
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
           c.seq, c.product_id, c.name, c.number, c.outcome, c.reason, c.score, c.voided
      FROM capture_samples s JOIN goal_cards c ON c.id = s.goal_card_id
     WHERE c.goal_session_id = ? ORDER BY c.seq
  `).all(id) as any[];
  const meta: SampleMeta[] = rows.map((r) => ({
    id: r.id, goalCardId: r.goal_card_id, frameW: r.frame_w, frameH: r.frame_h,
    cropJson: r.crop_json, productId: r.product_id, name: r.name, number: r.number,
    outcome: r.outcome, reason: r.reason, score: r.score, voided: r.voided === 1,
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
    return {
      file, frameW: m.frameW, frameH: m.frameH,
      /** The crop in force when this was captured — the A/B's baseline arm. */
      productionCrop: JSON.parse(m.cropJson),
      productId: m.productId, name: m.name, number: m.number,
      outcome: m.outcome, reason: m.reason, score: m.score, voided: m.voided,
      /** Only trustworthy when true: operator-confirmed in the review strip. */
      labelled: !m.voided && m.outcome === 'needed' && m.productId != null,
    };
  });

  fs.writeFileSync(path.join(outDir, 'labels.json'), JSON.stringify(
    { goalSessionId: sessionId, setIds, exportedAt: Date.now(), samples }, null, 2));

  const labelled = samples.filter((s) => s.labelled).length;
  console.log(`Exported ${samples.length} frames to ${outDir}` + (baseUrl ? ` (from ${baseUrl})` : ''));
  console.log(`  setIds: ${setIds.length ? setIds.join(', ') : 'UNKNOWN — pass --sets to crop-ab.ts'}`);
  console.log(`  ${labelled} with ground truth (confirmed in the review strip)`);
  console.log(`  ${samples.filter((s) => s.voided).length} voided — known-wrong, true identity unknown`);
  console.log(`  ${samples.filter((s) => s.reason === 'low-confidence').length} low-confidence — unlabelled, but the most informative failures`);
  if (labelled < 20) {
    console.log(`\nNote: ${labelled} labelled samples is thin. The crop decision should rest on`);
    console.log('more than this before BASE_CROP_W/H is changed.');
  }
})().catch((err) => { console.error(err); process.exit(1); });
