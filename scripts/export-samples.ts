/**
 * Exports stored calibration samples to disk for offline crop-geometry A/B.
 *
 * Standalone and read-only, matching calibrate.ts / embedding-harness.ts: it opens the database
 * directly and writes JPEGs plus a labels file. Nothing here touches run state.
 *
 * Ground truth comes from the review strip. An accepted, non-voided row means the operator
 * confirmed the match, so its productId is a real label. A voided row is known-wrong but its TRUE
 * identity is unknown — the strip records that a match was bad, not what the card actually was.
 * Those export flagged and unlabelled: an A/B can count how many a geometry rescues into a
 * confident match, but cannot score them for correctness.
 *
 * Run: npx ts-node scripts/export-samples.ts <goalSessionId> [outDir]
 */
import fs from 'fs';
import path from 'path';
import { db } from '../src/db';

const sessionId = process.argv[2];
const outDir = process.argv[3] || path.join('samples', 'captures', sessionId ?? 'unknown');

if (!sessionId) {
  console.error('Usage: npx ts-node scripts/export-samples.ts <goalSessionId> [outDir]');
  console.error('\nAvailable sessions with samples:');
  for (const r of db.prepare(`
    SELECT c.goal_session_id AS id, COUNT(*) AS n, MAX(s.created_at) AS last
      FROM capture_samples s JOIN goal_cards c ON c.id = s.goal_card_id
     GROUP BY c.goal_session_id ORDER BY last DESC
  `).all() as any[]) {
    console.error(`  ${r.id}  ${r.n} samples  ${new Date(r.last).toLocaleString()}`);
  }
  process.exit(1);
}

const rows = db.prepare(`
  SELECT s.id, s.frame_jpeg, s.frame_w, s.frame_h, s.crop_json,
         c.seq, c.product_id, c.name, c.number, c.outcome, c.reason, c.score, c.voided
    FROM capture_samples s JOIN goal_cards c ON c.id = s.goal_card_id
   WHERE c.goal_session_id = ? ORDER BY c.seq
`).all(sessionId) as any[];

if (rows.length === 0) {
  console.error(`No samples for session ${sessionId}. Was "Collect calibration samples" on?`);
  process.exit(2);
}

fs.mkdirSync(outDir, { recursive: true });

const labels = rows.map((r) => {
  const file = `${String(r.seq).padStart(3, '0')}-sample${r.id}.jpg`;
  fs.writeFileSync(path.join(outDir, file), r.frame_jpeg);
  return {
    file,
    frameW: r.frame_w,
    frameH: r.frame_h,
    /** The crop in force when this was captured — the A/B's baseline arm. */
    productionCrop: JSON.parse(r.crop_json),
    /** Only trustworthy when labelled is true. */
    productId: r.product_id,
    name: r.name,
    number: r.number,
    outcome: r.outcome,
    reason: r.reason,
    score: r.score,
    voided: r.voided === 1,
    labelled: r.voided !== 1 && r.outcome === 'needed' && r.product_id != null,
  };
});

fs.writeFileSync(path.join(outDir, 'labels.json'),
  JSON.stringify({ goalSessionId: sessionId, exportedAt: Date.now(), samples: labels }, null, 2));

const labelled = labels.filter((l) => l.labelled).length;
const lowConf = labels.filter((l) => l.reason === 'low-confidence').length;
console.log(`Exported ${labels.length} frames to ${outDir}`);
console.log(`  ${labelled} with ground truth (confirmed in the review strip)`);
console.log(`  ${labels.filter((l) => l.voided).length} voided — known-wrong, true identity unknown`);
console.log(`  ${lowConf} low-confidence — the most informative failures, unlabelled`);
if (labelled < 20) {
  console.log(`\nNote: ${labelled} labelled samples is thin for an A/B. The crop decision should`);
  console.log('rest on more than this before BASE_CROP_W/H is changed.');
}
