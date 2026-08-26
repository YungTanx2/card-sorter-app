/**
 * Regression tests for run deletion (src/session.ts, src/goals.ts).
 *
 * These exist because deletion here is IRREVERSIBLE and the database does not enable
 * PRAGMA foreign_keys — every REFERENCES clause in db.ts is documentation, not enforcement, so a
 * cascade only happens if someone wrote the DELETE by hand. A missed child table does not error;
 * it silently orphans rows that no screen can surface again, and the only symptom is a database
 * that grows and never shrinks. Nothing but a test like this would catch that.
 *
 * Runs against a throwaway database via DATABASE_PATH, so it never touches real run history.
 *
 * Run: node scripts/delete-cascade-test.js   (requires `npm run build` first)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sorter-cascade-'));
process.env.DATABASE_PATH = path.join(TMP, 'test.db');

const { db } = require('../dist/db');
const { deleteSession, getSessionDeletionImpact } = require('../dist/session');
const { deleteGoalSession, getGoalSessionDeletionImpact } = require('../dist/goals');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ok    ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`); failed++; }
}
const count = (sql, ...p) => db.prepare(sql).get(...p).n;

// ── fixtures ────────────────────────────────────────────────────────────────
const now = Date.now();

// A price-sorter run with cards and a bulk box.
db.prepare(`INSERT INTO sessions (id, game_id, game_name, set_ids_json, variant, condition,
  threshold_cents, min_score, min_gap, location, status, created_at, updated_at)
  VALUES ('S1', 71, 'Lorcana', '[1]', 'Normal', 'NM', 50, 0, 0, 'L', 'active', ?, ?)`).run(now, now);
db.prepare(`INSERT INTO bulk_boxes (id, session_id, label, opened_at, card_count)
  VALUES (10, 'S1', 'BOX-1', ?, 2)`).run(now);
for (const seq of [1, 2]) {
  db.prepare(`INSERT INTO cards (session_id, seq, name, decision, reason, bulk_box_id, scanned_at)
    VALUES ('S1', ?, 'X', 'bulk', 'below-threshold', 10, ?)`).run(seq, now);
}

// A second price run that must survive — deletion has to be scoped, not global.
db.prepare(`INSERT INTO sessions (id, game_id, game_name, set_ids_json, variant, condition,
  threshold_cents, min_score, min_gap, location, status, created_at, updated_at)
  VALUES ('S2', 71, 'Lorcana', '[1]', 'Normal', 'NM', 50, 0, 0, 'L', 'active', ?, ?)`).run(now, now);
db.prepare(`INSERT INTO cards (session_id, seq, name, decision, reason, scanned_at)
  VALUES ('S2', 1, 'KEEP ME', 'keeper', 'above-threshold', ?)`).run(now);

// A goal with TWO runs, each with cards, samples and labels.
db.prepare(`INSERT INTO goals (id, name, game_id, game_name, set_ids_json, variant, target_copies,
  excluded_rarities_json, binder_rows, binder_cols, status, created_at, updated_at)
  VALUES ('G1', 'Goal', 71, 'Lorcana', '[1]', 'Normal', 4, '[]', 3, 3, 'active', ?, ?)`).run(now, now);
for (const gs of ['GS1', 'GS2']) {
  db.prepare(`INSERT INTO goal_sessions (id, goal_id, dry_run, status, created_at, updated_at)
    VALUES (?, 'G1', 0, 'complete', ?, ?)`).run(gs, now, now);
  for (const seq of [1, 2]) {
    const info = db.prepare(`INSERT INTO goal_cards (goal_session_id, goal_id, seq, product_id, name,
      score, runner_up_score, outcome, reason, voided, counts_toward_goal, scanned_at)
      VALUES (?, 'G1', ?, 99, 'C', 0.9, 0.5, 'needed', 'fills-slot', 0, 1, ?)`).run(gs, seq, now);
    const cardId = info.lastInsertRowid;
    const si = db.prepare(`INSERT INTO capture_samples (goal_card_id, frame_jpeg, frame_w, frame_h,
      crop_json, created_at) VALUES (?, ?, 1, 1, '{}', ?)`).run(cardId, Buffer.from([1]), now);
    db.prepare(`INSERT INTO capture_labels (capture_sample_id, verdict, product_id, labelled_at)
      VALUES (?, 'card', 99, ?)`).run(si.lastInsertRowid, now);
  }
}
// A hand-entered correction, which must SURVIVE a run delete — it never came from a scan.
db.prepare(`INSERT INTO goal_adjustments (goal_id, product_id, delta, note, created_at)
  VALUES ('G1', 99, 1, 'bought a copy', ?)`).run(now);

console.log('\nimpact reporting happens BEFORE the rows disappear');
{
  const i = getGoalSessionDeletionImpact('GS1');
  check('reports the card count', i.totalCards === 2, JSON.stringify(i));
  check('reports slots that will un-fill', i.committedSlots === 2, JSON.stringify(i));
  check('reports stored frames', i.samples === 2, JSON.stringify(i));
  const p = getSessionDeletionImpact('S1');
  check('price run reports cards and boxes', p.totalCards === 2 && p.bulkBoxes === 1, JSON.stringify(p));
}

console.log('\ndeleteGoalSession leaves no orphan in ANY child table');
{
  deleteGoalSession('GS1');
  check('goal_sessions row gone', count("SELECT COUNT(*) n FROM goal_sessions WHERE id='GS1'") === 0);
  check('goal_cards gone', count("SELECT COUNT(*) n FROM goal_cards WHERE goal_session_id='GS1'") === 0);
  check('capture_samples gone (orphans here leak the most space)',
    count('SELECT COUNT(*) n FROM capture_samples') === 2, 'expected only GS2 samples to remain');
  check('capture_labels gone', count('SELECT COUNT(*) n FROM capture_labels') === 2,
    'expected only GS2 labels to remain');
}

console.log('\n...while leaving everything it should not touch');
{
  check('the OTHER run of the same goal is untouched',
    count("SELECT COUNT(*) n FROM goal_cards WHERE goal_session_id='GS2'") === 2);
  check('the goal itself survives', count("SELECT COUNT(*) n FROM goals WHERE id='G1'") === 1);
  check('hand-entered adjustments survive (they never came from a scan)',
    count("SELECT COUNT(*) n FROM goal_adjustments WHERE goal_id='G1'") === 1);
  check('price runs are unaffected', count('SELECT COUNT(*) n FROM sessions') === 2);
}

console.log('\ndeleteSession leaves no orphan, and is scoped to one run');
{
  deleteSession('S1');
  check('sessions row gone', count("SELECT COUNT(*) n FROM sessions WHERE id='S1'") === 0);
  check('cards gone', count("SELECT COUNT(*) n FROM cards WHERE session_id='S1'") === 0);
  check('bulk_boxes gone', count("SELECT COUNT(*) n FROM bulk_boxes WHERE session_id='S1'") === 0);
  check('the other run survives', count("SELECT COUNT(*) n FROM sessions WHERE id='S2'") === 1);
  check('its cards survive', count("SELECT COUNT(*) n FROM cards WHERE session_id='S2'") === 1);
}

console.log('\ndeleting an already-deleted or unknown run is a no-op, not a crash');
{
  let threw = false;
  try { deleteSession('S1'); deleteGoalSession('GS1'); deleteSession('nope'); deleteGoalSession('nope'); }
  catch (e) { threw = true; }
  check('repeat and unknown deletes do not throw', !threw);
  check('nothing else was collaterally removed',
    count('SELECT COUNT(*) n FROM sessions') === 1 && count("SELECT COUNT(*) n FROM goals WHERE id='G1'") === 1);
}

db.close();
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
