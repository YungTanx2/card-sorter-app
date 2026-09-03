import crypto from 'crypto';
import sharp from 'sharp';
import { db } from './db';
import { StallError } from './errors';
import { matchCard, prewarmEmbeddings } from './embeddings';
import { readCardTitle, fuseSignals, OcrTitleMatch } from './ocr';
import { getSettings } from './settings';
import { fetchSets, getCandidatesForSets, prewarmSet, fetchSetCandidates } from './tcgcsv';
import { assignSlots, parseCardNumber, compareCardNumbers } from './ordering';
import {
  CandidateCard, Goal, GoalCard, GoalConfig, GoalOutcome, GoalReason, GoalSession, GoalSlot,
  MatchSource, SessionStatus,
} from './types';

/**
 * Set Builder mode — routes a pile against a long-lived set-building goal instead of a price
 * threshold. See PRDs/card-sorter-set-builder.md.
 *
 * Deliberately parallel to session.ts rather than sharing it: same recognition layer
 * (embeddings.ts, tcgcsv.ts), completely different question and completely different tables.
 * Nothing in here touches pricing, SKUs, or TCGTracking, which is why a run makes zero network
 * calls once the goal's sets are pre-warmed.
 */

// ---- goals ----

const insertGoal = db.prepare(`
  INSERT INTO goals (id, name, game_id, game_name, set_ids_json, variant, target_copies,
    excluded_rarities_json, binder_rows, binder_cols, status, created_at, updated_at)
  VALUES (@id, @name, @gameId, @gameName, @setIdsJson, @variant, @targetCopies,
    @excludedRaritiesJson, @binderRows, @binderCols, @status, @createdAt, @updatedAt)
`);
const selectGoal = db.prepare('SELECT * FROM goals WHERE id = ?');
const selectAllGoals = db.prepare('SELECT * FROM goals ORDER BY created_at DESC');
const updateGoalStatus = db.prepare('UPDATE goals SET status = ?, updated_at = ? WHERE id = ?');

interface GoalRow {
  id: string; name: string; game_id: number; game_name: string; set_ids_json: string;
  variant: string; target_copies: number; excluded_rarities_json: string;
  binder_rows: number; binder_cols: number; status: 'active' | 'complete';
  created_at: number; updated_at: number;
}

function toGoal(row: GoalRow): Goal {
  return {
    id: row.id, name: row.name, gameId: row.game_id, gameName: row.game_name,
    setIds: JSON.parse(row.set_ids_json), variant: row.variant, targetCopies: row.target_copies,
    excludedRarities: JSON.parse(row.excluded_rarities_json),
    binderRows: row.binder_rows, binderCols: row.binder_cols, status: row.status,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

/**
 * Creates the goal, then pre-warms catalog + embeddings for every scoped set — identical to
 * session.ts's createSession(), and intentionally so: both modes need the same cached
 * candidates, and tcgcsv_cache/embedding_cache are shared. A goal on a set the price-sorter
 * already ran is therefore near-instant; a brand-new set pays the one-time ~90s embedding cost
 * once, for both modes forever.
 */
export async function createGoal(config: GoalConfig): Promise<Goal> {
  if (config.setIds.length === 0) {
    throw new Error('At least one set must be selected — a goal scopes what the matcher compares against.');
  }
  if (!Number.isInteger(config.targetCopies) || config.targetCopies < 1) {
    throw new Error('targetCopies must be a positive integer (1 = master set, 4 = play set).');
  }
  if (config.binderRows < 1 || config.binderCols < 1) {
    throw new Error('Binder dimensions must be at least 1x1.');
  }

  const now = Date.now();
  const id = crypto.randomUUID();
  insertGoal.run({
    id, name: config.name, gameId: config.gameId, gameName: config.gameName,
    setIdsJson: JSON.stringify(config.setIds), variant: config.variant,
    targetCopies: config.targetCopies,
    excludedRaritiesJson: JSON.stringify(config.excludedRarities ?? []),
    binderRows: config.binderRows, binderCols: config.binderCols,
    status: 'active', createdAt: now, updatedAt: now,
  });

  const sets = await fetchSets(config.gameId);
  const setNameById = new Map(sets.map((s) => [s.id, s.name]));
  for (const groupId of config.setIds) {
    const groupName = setNameById.get(groupId) ?? String(groupId);
    const candidates = await prewarmSet(config.gameId, groupId, groupName);
    await prewarmEmbeddings(candidates);
  }

  return getGoal(id)!;
}

export function getGoal(id: string): Goal | undefined {
  const row = selectGoal.get(id) as GoalRow | undefined;
  return row ? toGoal(row) : undefined;
}

export function listGoals(): Goal[] {
  return (selectAllGoals.all() as GoalRow[]).map(toGoal);
}

export function completeGoal(id: string): Goal {
  updateGoalStatus.run('complete', Date.now(), id);
  const g = getGoal(id);
  if (!g) throw new Error(`Goal ${id} not found`);
  return g;
}

/**
 * Everything derived from a goal — its progress, its runs, and the frames captured during them.
 * Leaves the goals row itself alone, so deleteGoal() and resetGoal() can share it.
 *
 * Shared rather than duplicated specifically BECAUSE the order is load-bearing and invisible:
 * PRAGMA foreign_keys is off (see the capture_samples comment in db.ts), so a REFERENCES clause
 * cascades nothing and each delete has to name its own children. Two hand-maintained copies of
 * that order would drift the first time a table is added, and the failure mode is silent —
 * orphaned rows no screen can surface.
 *
 * Deliberately does not touch tcgcsv_cache or embedding_cache: those are shared with the
 * price-sorter and expensive to rebuild.
 *
 * Callers must be inside a transaction. goal_cards rows ARE the progress — there is no counter
 * to fall back on — so a partial purge leaves a goal reporting a count matching neither the old
 * state nor the new one.
 */
function purgeGoalDerived(id: string): void {
  // Labels before samples (labels hang off sample ids); samples before cards (samples hang off
  // card ids). Adjustments are goal-scoped rather than run-scoped, so they key off goal_id.
  db.prepare(`DELETE FROM capture_labels WHERE capture_sample_id IN
    (SELECT s.id FROM capture_samples s JOIN goal_cards c ON c.id = s.goal_card_id WHERE c.goal_id = ?)`).run(id);
  db.prepare(`DELETE FROM capture_samples WHERE goal_card_id IN
    (SELECT id FROM goal_cards WHERE goal_id = ?)`).run(id);
  db.prepare('DELETE FROM goal_cards WHERE goal_id = ?').run(id);
  db.prepare('DELETE FROM goal_adjustments WHERE goal_id = ?').run(id);
  db.prepare('DELETE FROM goal_sessions WHERE goal_id = ?').run(id);
}

/**
 * Hard-deletes a goal and everything derived from it. Needed because a goal's printing and
 * target are fixed at creation — get either wrong and the goal is permanently useless, so
 * without this the only remedy is editing SQLite by hand.
 */
export const deleteGoal = db.transaction((id: string) => {
  purgeGoalDerived(id);
  db.prepare('DELETE FROM goals WHERE id = ?').run(id);
});

/**
 * Wipes a goal's progress but keeps the goal. The "collect this set again from scratch" action.
 *
 * Exists because delete-and-recreate was the only way to redo a set, and that throws away the
 * configuration — sets, printing, target copies, excluded rarities, binder dimensions — which is
 * the part normally worth keeping. Recreating it by hand also risks entering a DIFFERENT printing
 * or target, which is unrecoverable in the other direction.
 *
 * Clears goal_adjustments, unlike deleteGoalSession(). That function leaves them deliberately:
 * adjustments are manual corrections with no relationship to which run was open. Here the scope
 * is the whole goal, and surviving adjustments would give a freshly-reset set owned counts with
 * no scans behind them — precisely the unexplainable state a reset exists to escape.
 *
 * Reopens a completed goal: zero progress with a 'complete' status is a contradiction, and
 * wanting to collect it again is the only reason to reset a finished one.
 */
export const resetGoal = db.transaction((id: string): Goal => {
  purgeGoalDerived(id);
  updateGoalStatus.run('active', Date.now(), id);
  const goal = getGoal(id);
  if (!goal) throw new Error(`Goal ${id} not found`);
  return goal;
});

// ---- derived progress ----

/**
 * The single source of truth for "how many of this card do I have?". There is deliberately no
 * stored counter anywhere — see db.ts. Two inputs:
 *
 *   1. Accepted, non-voided, goal-counting scan rows. Voiding one in the review strip drops the
 *      count automatically, which is the whole reason the review strip can be a one-flag write.
 *   2. An append-only adjustments log for corrections that never came from a scan.
 *
 * At ~250 candidates and a few thousand scan rows this aggregate is free; correctness matters
 * far more than the microseconds a counter column would save.
 */
export function getOwnedCounts(goalId: string): Map<number, number> {
  const scanned = db.prepare(`
    SELECT product_id, COUNT(*) AS n
      FROM goal_cards
     WHERE goal_id = ? AND outcome = 'needed' AND voided = 0 AND counts_toward_goal = 1
       AND product_id IS NOT NULL
     GROUP BY product_id
  `).all(goalId) as { product_id: number; n: number }[];

  const counts = new Map<number, number>();
  for (const row of scanned) counts.set(row.product_id, row.n);

  const adjusted = db.prepare(`
    SELECT product_id, SUM(delta) AS d FROM goal_adjustments WHERE goal_id = ? GROUP BY product_id
  `).all(goalId) as { product_id: number; d: number }[];

  for (const row of adjusted) {
    // Clamp at zero: an over-subtracting adjustment shouldn't make a slot "negatively owned"
    // and start demanding extra copies.
    counts.set(row.product_id, Math.max(0, (counts.get(row.product_id) ?? 0) + row.d));
  }

  return counts;
}

/**
 * Whether a catalog entry is a real set slot at all.
 *
 * tcgcsv.ts's isSingleCard() already drops most non-cards by requiring a Rarity, but that filter
 * is too weak for set building: TCGPlayer lists puzzle inserts and similar filler WITH a Rarity
 * entry whose value is the literal string "None" and no printed number (confirmed live —
 * "Attack of the Vine!" carries 10 of them). Harmless for the price-sorter, which would just
 * bulk them; fatal here, where they'd occupy binder pockets and hold a master set permanently
 * short of 100%.
 *
 * A printed number is the discriminator the catalog layer already relies on to tell real cards
 * from sealed/code product, so this reuses it rather than inventing a name-matching heuristic.
 */
function isSetSlotCandidate(c: CandidateCard): boolean {
  return !!c.number && c.number.trim() !== '';
}

/** Every in-scope candidate as a binder pocket, with its owned count. Non-cards and excluded
 *  rarities are removed before indexing — they are not holes, they're not part of this goal. */
/** Sentinel for cards with no Rarity value at all. They are never excluded (see isExcluded in
 *  ordering.ts), so they are ALWAYS collected — the preview must say so rather than hide them. */
export const NO_RARITY_KEY = '(no rarity)';

/**
 * How many binder slots each rarity would contribute, for sets that may not be prewarmed yet.
 *
 * Powers the goal-creation preview. Counted through the SAME filter slot assignment uses
 * (isSetSlotCandidate — a printed number), so the preview's total is the goal's real slot count
 * and not an approximation from the raw product list.
 */
export async function fetchRaritySlotCounts(gameId: number, setIds: number[]): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const setId of setIds) {
    for (const c of await fetchSetCandidates(gameId, setId)) {
      if (!isSetSlotCandidate(c)) continue;
      const key = c.rarity && c.rarity.trim() ? c.rarity.trim() : NO_RARITY_KEY;
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  return counts;
}

export function getGoalSlots(goal: Goal): GoalSlot[] {
  // Variant-scoped, and this one is load-bearing for progress rather than just recognition: a
  // slot for a printing the goal doesn't collect can never fill, so leaving it in makes the
  // denominator permanently unreachable and the goal impossible to complete. Note this can
  // SHRINK totalSlots for a goal created before the filter existed — the removed slots are
  // exactly the ones that were never fillable.
  const candidates = getCandidatesForSets(goal.setIds, goal.variant).filter(isSetSlotCandidate);
  const owned = getOwnedCounts(goal.id);
  return assignSlots(candidates, goal.setIds, goal.binderRows, goal.binderCols, goal.excludedRarities)
    .map((slot) => ({
      productId: slot.productId, name: slot.name, number: slot.number, rarity: slot.rarity,
      imageUrl: slot.imageUrl, setId: slot.setId, setName: slot.setName,
      page: slot.page, pocket: slot.pocket,
      owned: owned.get(slot.productId) ?? 0,
      target: goal.targetCopies,
    }));
}

export interface GoalProgress {
  goal: Goal;
  slots: GoalSlot[];
  totalSlots: number;
  filledSlots: number;   // slots at or above target
  totalCopiesNeeded: number;
  totalCopiesOwned: number;
  pages: number;
}

export function getGoalProgress(goalId: string): GoalProgress {
  const goal = getGoal(goalId);
  if (!goal) throw new Error(`Goal ${goalId} not found`);
  const slots = getGoalSlots(goal);
  const perPage = Math.max(1, goal.binderRows * goal.binderCols);

  return {
    goal,
    slots,
    totalSlots: slots.length,
    filledSlots: slots.filter((s) => s.owned >= s.target).length,
    totalCopiesNeeded: slots.length * goal.targetCopies,
    // Cap each slot's contribution at its target so surplus copies of one card can't make a
    // goal look more complete than it is.
    totalCopiesOwned: slots.reduce((sum, s) => sum + Math.min(s.owned, s.target), 0),
    pages: Math.ceil(slots.length / perPage),
  };
}

/** Unfilled pockets, in binder order. No prices — set mode is entirely price-free by design. */
export function getMissingList(goalId: string): GoalSlot[] {
  return getGoalProgress(goalId).slots.filter((s) => s.owned < s.target);
}

// ---- goal sessions ----

const insertGoalSession = db.prepare(`
  INSERT INTO goal_sessions (id, goal_id, dry_run, status, created_at, updated_at)
  VALUES (@id, @goalId, @dryRun, @status, @createdAt, @updatedAt)
`);
const selectGoalSession = db.prepare('SELECT * FROM goal_sessions WHERE id = ?');
const selectGoalSessionsForGoal = db.prepare('SELECT * FROM goal_sessions WHERE goal_id = ? ORDER BY created_at DESC');
const updateGoalSessionStatus = db.prepare('UPDATE goal_sessions SET status = ?, updated_at = ? WHERE id = ?');

interface GoalSessionRow {
  id: string; goal_id: string; dry_run: number; status: SessionStatus;
  created_at: number; updated_at: number;
}

function toGoalSession(row: GoalSessionRow): GoalSession {
  return {
    id: row.id, goalId: row.goal_id, dryRun: row.dry_run === 1, status: row.status,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

/** Defaults to a dry run. Committing to goal state is opt-in, not opt-out — recognition has not
 *  yet been validated on physical cards, and a wrong accept here corrupts weeks of binder work
 *  rather than mispricing one card. */
export function createGoalSession(goalId: string, dryRun = true): GoalSession {
  if (!getGoal(goalId)) throw new Error(`Goal ${goalId} not found`);
  const now = Date.now();
  const id = crypto.randomUUID();
  insertGoalSession.run({
    id, goalId, dryRun: dryRun ? 1 : 0, status: 'active' as SessionStatus,
    createdAt: now, updatedAt: now,
  });
  return getGoalSession(id)!;
}

export function getGoalSession(id: string): GoalSession | undefined {
  const row = selectGoalSession.get(id) as GoalSessionRow | undefined;
  return row ? toGoalSession(row) : undefined;
}

export function listGoalSessions(goalId: string): GoalSession[] {
  return (selectGoalSessionsForGoal.all(goalId) as GoalSessionRow[]).map(toGoalSession);
}

export interface GoalSessionSummary {
  session: GoalSession;
  goalName: string;
  gameName: string;
  /** Scans recorded, split by what the run actually did with them. */
  total: number;
  accepted: number;
  lowConfidence: number;
  /** Of the low-confidence rows, how many the end-of-run review would surface — i.e. how many are
   *  answerable rather than hopeless. Zero here means the pile has nothing worth looking at. */
  reviewable: number;
  samples: number;
}

/**
 * Every Set Builder run across every goal, newest first, with the counts the run list shows.
 *
 * One grouped query per statistic rather than N per run: a history page is the one screen that
 * touches every row in the table, and the per-run aggregates this app uses elsewhere are only
 * cheap because they run against a single session.
 */
export function listAllGoalSessionSummaries(): GoalSessionSummary[] {
  const minScore = getSettings().minScore;
  const rows = db.prepare(`
    SELECT s.*, g.name AS goal_name, g.game_name AS game_name
      FROM goal_sessions s JOIN goals g ON g.id = s.goal_id
     ORDER BY s.created_at DESC
  `).all() as (GoalSessionRow & { goal_name: string; game_name: string })[];

  const tally = (sql: string, params: unknown[] = []) => {
    const m = new Map<string, number>();
    for (const r of db.prepare(sql).all(...params) as { k: string; n: number }[]) m.set(r.k, r.n);
    return m;
  };
  const total = tally('SELECT goal_session_id AS k, COUNT(*) AS n FROM goal_cards GROUP BY k');
  const accepted = tally("SELECT goal_session_id AS k, COUNT(*) AS n FROM goal_cards WHERE outcome = 'needed' AND voided = 0 GROUP BY k");
  const lowConf = tally("SELECT goal_session_id AS k, COUNT(*) AS n FROM goal_cards WHERE reason = 'low-confidence' GROUP BY k");
  // Same OR condition as isReviewableLowConfidence, expressed in SQL so the history page does not
  // have to load every card row just to count them. Kept adjacent to that function on purpose —
  // if one changes the other must too.
  const reviewable = tally(
    `SELECT goal_session_id AS k, COUNT(*) AS n FROM goal_cards
      WHERE reason = 'low-confidence' AND voided = 0 AND (score >= ? OR runner_up_score >= ?)
      GROUP BY k`, [minScore, minScore]);
  const samples = tally(`SELECT c.goal_session_id AS k, COUNT(*) AS n
      FROM capture_samples s JOIN goal_cards c ON c.id = s.goal_card_id GROUP BY k`);

  return rows.map((r) => ({
    session: toGoalSession(r),
    goalName: r.goal_name,
    gameName: r.game_name,
    total: total.get(r.id) ?? 0,
    accepted: accepted.get(r.id) ?? 0,
    lowConfidence: lowConf.get(r.id) ?? 0,
    reviewable: reviewable.get(r.id) ?? 0,
    samples: samples.get(r.id) ?? 0,
  }));
}

/**
 * What deleting a run would cost, so the confirm can state it instead of the user discovering it.
 *
 * Set Builder progress is DERIVED from goal_cards (see getOwnedCounts) — there is no counter. So
 * deleting a committed run does not merely tidy a list, it un-fills every slot that run filled.
 * That is correct behaviour, and it is also exactly the kind of consequence a generic "are you
 * sure?" hides. A dry run reports 0 here, which is what makes it obviously safe to remove.
 */
export function getGoalSessionDeletionImpact(id: string): {
  totalCards: number; committedSlots: number; samples: number;
} {
  const totalCards = (db.prepare('SELECT COUNT(*) AS n FROM goal_cards WHERE goal_session_id = ?')
    .get(id) as { n: number }).n;
  // Mirrors getOwnedCounts's filter exactly — anything it counts is a slot that will un-fill.
  const committedSlots = (db.prepare(`
    SELECT COUNT(*) AS n FROM goal_cards
     WHERE goal_session_id = ? AND outcome = 'needed' AND voided = 0 AND counts_toward_goal = 1
       AND product_id IS NOT NULL`).get(id) as { n: number }).n;
  const samples = (db.prepare(`
    SELECT COUNT(*) AS n FROM capture_samples
     WHERE goal_card_id IN (SELECT id FROM goal_cards WHERE goal_session_id = ?)`)
    .get(id) as { n: number }).n;
  return { totalCards, committedSlots, samples };
}

/**
 * Hard-deletes ONE run and everything recorded during it, leaving the goal itself intact.
 *
 * Same manual-cascade discipline as deleteGoal(), and for the same reason: PRAGMA foreign_keys is
 * off, so a REFERENCES clause cascades nothing and a partial delete silently orphans rows that no
 * screen can ever surface again. Order matters — labels hang off sample ids, samples off card ids.
 *
 * Transactional because goal_cards rows ARE the goal's progress. A half-finished delete would
 * leave the goal reporting a slot count that matches neither the old state nor the new one.
 *
 * Deliberately does NOT touch goal_adjustments: those are manual corrections the operator entered
 * by hand, not scan output, and they have no relationship to which run was open at the time.
 */
export const deleteGoalSession = db.transaction((id: string) => {
  db.prepare(`DELETE FROM capture_labels WHERE capture_sample_id IN
    (SELECT s.id FROM capture_samples s JOIN goal_cards c ON c.id = s.goal_card_id
      WHERE c.goal_session_id = ?)`).run(id);
  db.prepare(`DELETE FROM capture_samples WHERE goal_card_id IN
    (SELECT id FROM goal_cards WHERE goal_session_id = ?)`).run(id);
  db.prepare('DELETE FROM goal_cards WHERE goal_session_id = ?').run(id);
  db.prepare('DELETE FROM goal_sessions WHERE id = ?').run(id);
});

export function resumeGoalSession(id: string): GoalSession {
  updateGoalSessionStatus.run('active', Date.now(), id);
  const s = getGoalSession(id);
  if (!s) throw new Error(`Goal session ${id} not found`);
  return s;
}

export function completeGoalSession(id: string): GoalSession {
  updateGoalSessionStatus.run('complete', Date.now(), id);
  const s = getGoalSession(id);
  if (!s) throw new Error(`Goal session ${id} not found`);
  return s;
}

// ---- scanning ----

const insertGoalCard = db.prepare(`
  INSERT INTO goal_cards (goal_session_id, goal_id, seq, product_id, name, number, score,
    runner_up_score, runner_up_product_id, runner_up_name, outcome, reason, voided,
    counts_toward_goal, thumb_jpeg, scanned_at, match_source, ocr_sim, ocr_raw)
  VALUES (@goalSessionId, @goalId, @seq, @productId, @name, @number, @score,
    @runnerUpScore, @runnerUpProductId, @runnerUpName, @outcome, @reason, 0,
    @countsTowardGoal, @thumbJpeg, @scannedAt, @matchSource, @ocrSim, @ocrRaw)
`);
const nextGoalSeq = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM goal_cards WHERE goal_session_id = ?');
const selectGoalCard = db.prepare('SELECT * FROM goal_cards WHERE id = ?');
const selectGoalCardThumb = db.prepare('SELECT thumb_jpeg FROM goal_cards WHERE id = ?');
const setGoalCardVoided = db.prepare('UPDATE goal_cards SET voided = ? WHERE id = ?');

interface GoalCardRow {
  id: number; goal_session_id: string; goal_id: string; seq: number; product_id: number | null;
  name: string | null; number: string | null; score: number | null; runner_up_score: number | null;
  runner_up_product_id: number | null; runner_up_name: string | null;
  outcome: GoalOutcome; reason: GoalReason; voided: number; counts_toward_goal: number;
  thumb_jpeg: Buffer | null; scanned_at: number;
  match_source: MatchSource | null; ocr_sim: number | null; ocr_raw: string | null;
}

function toGoalCard(row: GoalCardRow): GoalCard {
  return {
    id: row.id, goalSessionId: row.goal_session_id, goalId: row.goal_id, seq: row.seq,
    productId: row.product_id, name: row.name, number: row.number, score: row.score,
    runnerUpScore: row.runner_up_score,
    runnerUpProductId: row.runner_up_product_id, runnerUpName: row.runner_up_name,
    outcome: row.outcome, reason: row.reason,
    matchSource: row.match_source, ocrSim: row.ocr_sim, ocrRaw: row.ocr_raw,
    voided: row.voided === 1, countsTowardGoal: row.counts_toward_goal === 1,
    hasThumb: row.thumb_jpeg != null, scannedAt: row.scanned_at,
  };
}

function getGoalCard(id: number): GoalCard {
  return toGoalCard(selectGoalCard.get(id) as GoalCardRow);
}

/** Small enough to keep hundreds of runs in SQLite, large enough to compare against a 200x280
 *  TCGCSV reference image side by side in the review strip. */
async function makeThumb(imageBuffer: Buffer): Promise<Buffer | null> {
  try {
    return await sharp(imageBuffer).resize({ width: 200, withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer();
  } catch (err) {
    // A thumbnail is a review aid, not part of the routing decision — never fail a scan over it.
    console.warn('[goals] thumbnail generation failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

export interface ScanGoalCardResult {
  outcome: GoalOutcome;
  reason: GoalReason;
  card: GoalCard;
  /** Post-scan owned count for the matched card, so the UI can show "2 of 4" without refetching
   *  the whole progress payload on every capture. */
  owned: number | null;
  target: number;
  /** Set-level progress AFTER this card was recorded. Carried on every scan for two reasons: the
   *  run's Filled counter can move in real time, and the frontend can stop the moment the last
   *  slot fills without a second round trip to find out. */
  filledSlots: number;
  totalSlots: number;
  /** Every slot at or above target. Never true in a dry run — dry scans record
   *  counts_toward_goal = 0, so they cannot move progress and cannot end a run. */
  goalComplete: boolean;
}

/**
 * The core per-card decision. Recognition is local (embeddings.ts) and the catalog is local
 * (tcgcsv_cache), so this makes no network calls at all — set mode has no pricing step and no
 * SKU lookup, which were the price-sorter's only remaining external dependencies.
 *
 * Order of checks matters. Confidence is evaluated FIRST, before rarity or slot state, because
 * an unidentified card must never be reasoned about as though we know what it is. Everything
 * that isn't a confident, wanted, unfilled slot routes to `extra` — the fail-safe direction, and
 * one that's self-healing for low-confidence cards since the slot stays open for a later re-run.
 */
export async function scanGoalCard(goalSessionId: string, imageBuffer: Buffer): Promise<ScanGoalCardResult> {
  const session = getGoalSession(goalSessionId);
  if (!session) throw new Error(`Goal session ${goalSessionId} not found`);
  const goal = getGoal(session.goalId);
  if (!goal) throw new Error(`Goal ${session.goalId} not found`);

  const settings = getSettings();
  let top, runnerUp, candidates: CandidateCard[];
  let ocr: OcrTitleMatch | null = null;
  try {
    // Scoped to the goal's printing — a goal is already single-variant by construction, so a
    // product with no price in that printing is not a card this goal can ever want (tcgcsv.ts).
    // The SAME scoped list feeds OCR, which is what makes a title read sufficient on its own:
    // titles collide only in the unscoped catalog (see ocr.ts).
    candidates = getCandidatesForSets(goal.setIds, goal.variant);
    // Run both signals concurrently. They are independent, and OCR (~250ms) is the slower of the
    // two, so serialising them would add its full cost to every scan for no reason. Recognition
    // still sits far inside the 4.2s machine cycle.
    const [match, ocrResult] = await Promise.all([
      matchCard(imageBuffer, candidates),
      settings.ocrEnabled
        ? readCardTitle(imageBuffer, candidates, { minTitleChars: settings.ocrMinTitleChars })
        : Promise.resolve(null),
    ]);
    top = match.top;
    runnerUp = match.runnerUp;
    ocr = ocrResult;
  } catch (err) {
    updateGoalSessionStatus.run('stalled', Date.now(), goalSessionId);
    throw new StallError(err instanceof Error ? err.message : 'recognition failed');
  }
  if (session.status === 'stalled') updateGoalSessionStatus.run('active', Date.now(), goalSessionId);

  const seq = (nextGoalSeq.get(goalSessionId) as { n: number }).n;
  const scannedAt = Date.now();
  const countsTowardGoal = session.dryRun ? 0 : 1;

  // See session.ts — the runner-up's identity is what makes a small gap diagnosable, so it is
  // stamped on every row rather than only on the ones that failed the gate.
  const runnerUpProductId = runnerUp?.productId ?? null;
  const runnerUpName = runnerUp ? candidates.find((c) => c.productId === runnerUp!.productId)?.name ?? null : null;

  const record = async (
    outcome: GoalOutcome, reason: GoalReason, candidate: CandidateCard | null,
    score: number | null, withThumb: boolean, matchSource: MatchSource | null = null,
  ): Promise<ScanGoalCardResult> => {
    const info = insertGoalCard.run({
      goalSessionId, goalId: goal.id, seq,
      productId: candidate?.productId ?? null, name: candidate?.name ?? null,
      number: candidate?.number ?? null, score, runnerUpScore: runnerUp?.score ?? null,
      runnerUpProductId, runnerUpName,
      outcome, reason, countsTowardGoal,
      matchSource,
      // Stamped on EVERY row, not just OCR-decided ones — the whole value of a peer signal is
      // being able to ask afterwards what the other one saw.
      ocrSim: ocr?.sim ?? null, ocrRaw: ocr?.raw ?? null,
      thumbJpeg: withThumb ? await makeThumb(imageBuffer) : null,
      scannedAt,
    });
    const card = getGoalCard(info.lastInsertRowid as number);
    // Read progress AFTER the insert, so "complete" means including this card. Recomputing the
    // whole thing per scan rather than tracking a counter is the same trade db.ts already makes:
    // it's a couple of aggregates over a few thousand rows, next to nothing beside recognition,
    // and it cannot drift out of sync with the rows that define it.
    const progress = getGoalProgress(goal.id);
    return {
      outcome, reason, card, target: goal.targetCopies,
      owned: candidate ? (getOwnedCounts(goal.id).get(candidate.productId) ?? 0) : null,
      filledSlots: progress.filledSlots,
      totalSlots: progress.totalSlots,
      // A goal with no slots at all (an empty or unsynced set) is NOT complete — otherwise the
      // first scan against a misconfigured goal would instantly end the run.
      goalComplete: progress.totalSlots > 0 && progress.filledSlots >= progress.totalSlots,
    };
  };

  // The peer decision. Both signals are computed above; fuseSignals decides whether either,
  // both, or neither is confident, and flags the case where they disagree. See ocr.ts.
  const fused = fuseSignals({
    top, runnerUp, ocr,
    minScore: settings.minScore, minGap: settings.minGap, ocrMinSim: settings.ocrMinSim,
  });

  // 0. Server-side backstop for phantom captures — see AppSettings.minCardScore's doc and
  //    session.ts's identical check. Ahead of the confidence gate for the same reason: "did
  //    anything here resemble a card" is a different question from "which card, confidently".
  //    Never changes the outcome (still 'extra', count unaffected) — only the reason label.
  //
  //    A confident OCR read vetoes this. ocr.ts only produces a read when it found a card-shaped
  //    region AND matched a real catalog title, which is stronger evidence of "a card is present"
  //    than a low cosine is of its absence. This is what rescues Location cards, whose landscape
  //    reference art scores ~0.57 and was being labelled 'not-a-card' outright.
  if (top && top.score < settings.minCardScore && !fused.ocrConfident) {
    const guess = candidates.find((c) => c.productId === top!.productId) ?? null;
    return record('extra', 'not-a-card', guess, top.score, false);
  }

  // 1a. Both signals confident, different cards. Fails safe rather than picking a winner — see
  //     FusedMatch.conflict for why this is surfaced instead of resolved.
  if (fused.conflict) {
    const clipGuess = candidates.find((c) => c.productId === top!.productId) ?? null;
    console.warn(
      `[goals] signal conflict on seq ${seq}: embedding says ${top!.productId} (${clipGuess?.name ?? '?'}) `
      + `@ ${top!.score.toFixed(4)}, OCR says ${ocr!.productId} @ sim ${ocr!.sim.toFixed(3)} from "${ocr!.raw}"`,
    );
    return record('extra', 'signal-conflict', clipGuess, top!.score, false);
  }

  // 1b. Neither signal was confident. Deliberately checked before anything else — we know nothing
  //     about this card, so no rarity or slot reasoning is valid. No count changes, so the goal
  //     still reports the real card missing and a re-run gets another shot at it.
  if (fused.productId == null) {
    // Log the best guess anyway so the run's manifest is diagnosable, but never act on it.
    const guess = top ? candidates.find((c) => c.productId === top!.productId) ?? null : null;
    // A thumbnail IS stored here, unlike every other 'extra' path. These are the rows the
    // end-of-run review shows, and a review of unidentified cards without a picture of the card
    // is useless — the whole task is "look at it and tell me which of these two it was".
    // Deliberately not extended to the other extras: 'not-a-card' has nothing worth looking at,
    // and 'slot-filled'/'excluded-rarity' were identified confidently, so there is nothing to
    // adjudicate. See isReviewableLowConfidence() for which of these rows actually surface.
    return record('extra', 'low-confidence', guess, top?.score ?? null, true);
  }

  const identifiedId = fused.productId;
  const candidate = candidates.find((c) => c.productId === identifiedId) ?? null;
  // Score reported for the row is still the embedding's, which is null-able now that OCR can
  // carry a card on its own — a row with a match_source of 'ocr' and a low score is not a bug.
  const matchScore = top?.score ?? null;

  // 2. Matched something that isn't a set slot at all — a puzzle insert or similar filler that
  //    TCGPlayer lists alongside the real cards. Its own reason rather than being folded into
  //    'excluded-rarity', so a run's manifest stays honest about why a card was passed over.
  if (!candidate || !isSetSlotCandidate(candidate)) {
    return record('extra', 'not-a-set-slot', candidate, matchScore, false, fused.source);
  }

  // 3. A rarity this goal deliberately doesn't collect (chase cards in a play-set goal).
  if (candidate.rarity && goal.excludedRarities.some((r) => r.trim().toLowerCase() === candidate.rarity!.trim().toLowerCase())) {
    return record('extra', 'excluded-rarity', candidate, matchScore, false, fused.source);
  }

  // 4. Already have enough. In a dry run this still reads the real (committed) counts, so a dry
  //    run against a partially-built goal reports what a live run would actually do.
  const owned = getOwnedCounts(goal.id).get(identifiedId) ?? 0;
  if (owned >= goal.targetCopies) {
    return record('extra', 'slot-filled', candidate, matchScore, false, fused.source);
  }

  // 5. Fills a slot. Only this path stores a thumbnail — it's the only one the review strip
  //    covers, since it's the only one that mutates long-lived goal state.
  return record('needed', 'fills-slot', candidate, matchScore, true, fused.source);
}

// ---- review, filing, corrections ----

export function getGoalCardsForSession(goalSessionId: string): GoalCard[] {
  const rows = db.prepare('SELECT * FROM goal_cards WHERE goal_session_id = ? ORDER BY seq').all(goalSessionId) as GoalCardRow[];
  return rows.map(toGoalCard);
}

/**
 * Stores the full uncropped frame a scan came from, for offline crop-geometry A/B.
 *
 * Best-effort by design: this is calibration data, and failing to keep a sample must never fail
 * the scan that produced it — the card is physically routed either way.
 */
export function saveCaptureSample(
  goalCardId: number, frame: Buffer, width: number, height: number, crop: unknown,
): void {
  try {
    db.prepare(`INSERT INTO capture_samples
      (goal_card_id, frame_jpeg, frame_w, frame_h, crop_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(goalCardId, frame, width, height, JSON.stringify(crop ?? null), Date.now());
  } catch (err) {
    console.warn('[goals] capture sample not stored:', err instanceof Error ? err.message : err);
  }
}

export type CaptureLabelVerdict = 'card' | 'not-a-card' | 'not-in-set';

export interface CaptureSampleRow {
  id: number; goalCardId: number; frameW: number; frameH: number; cropJson: string;
  productId: number | null; name: string | null; number: string | null;
  outcome: GoalOutcome; reason: GoalReason; score: number | null; voided: boolean;
  /** What the peer signals concluded — see MatchSource. Shown in the labelling view so a human
   *  reviewing a frame can see WHICH signal decided it, and what OCR actually read. */
  matchSource: MatchSource | null;
  ocrSim: number | null;
  ocrRaw: string | null;
  /** Explicit ground truth from the labelling view — see capture_labels' doc in db.ts. Distinct
   *  from voided/productId above (the review strip's opinion): this is null until a human has
   *  actually looked at the frame, whereas voided is only ever set on 'needed' outcomes. */
  labelVerdict: CaptureLabelVerdict | null;
  labelProductId: number | null;
}

/**
 * Stored samples for a run, joined to the card each came from and to any explicit label.
 *
 * `voided` carries the review strip's verdict: false on an accepted row means the operator
 * confirmed the match, so productId is ground truth. A voided row is known-wrong but its TRUE
 * identity is unknown — the review strip records that a match was bad, not what the card was.
 * Exported anyway, flagged, so an A/B can count how many a geometry rescues even though it
 * cannot score them.
 */
export function getCaptureSamples(goalSessionId: string): CaptureSampleRow[] {
  return db.prepare(`
    SELECT s.id, s.goal_card_id, s.frame_w, s.frame_h, s.crop_json,
           c.product_id, c.name, c.number, c.outcome, c.reason, c.score, c.voided,
           c.match_source, c.ocr_sim, c.ocr_raw,
           l.verdict as label_verdict, l.product_id as label_product_id
      FROM capture_samples s
      JOIN goal_cards c ON c.id = s.goal_card_id
      LEFT JOIN capture_labels l ON l.capture_sample_id = s.id
     WHERE c.goal_session_id = ?
     ORDER BY c.seq
  `).all(goalSessionId).map((r: any) => ({
    id: r.id, goalCardId: r.goal_card_id, frameW: r.frame_w, frameH: r.frame_h,
    cropJson: r.crop_json, productId: r.product_id, name: r.name, number: r.number,
    outcome: r.outcome, reason: r.reason, score: r.score, voided: r.voided === 1,
    matchSource: r.match_source ?? null, ocrSim: r.ocr_sim ?? null, ocrRaw: r.ocr_raw ?? null,
    labelVerdict: r.label_verdict ?? null, labelProductId: r.label_product_id ?? null,
  }));
}

export function getCaptureSampleFrame(id: number): Buffer | null {
  const row = db.prepare('SELECT frame_jpeg FROM capture_samples WHERE id = ?').get(id) as
    { frame_jpeg: Buffer } | undefined;
  return row?.frame_jpeg ?? null;
}

export interface CaptureSampleContext {
  id: number;
  frame: Buffer;
  frameW: number;
  frameH: number;
  /** Fractions as getCrop() returns them, or null if this sample predates crop tracking. */
  crop: { left: number; top: number; width: number; height: number } | null;
  goal: Goal;
}

/**
 * Resolves everything the labelling view needs to score a stored frame against its own goal's
 * candidate pool: the goal_card -> goal_session -> goal chain, so the top-K shown for labelling
 * uses the SAME variant-scoped pool recognition actually matched against, not the whole game's
 * catalog.
 */
export function getCaptureSampleContext(sampleId: number): CaptureSampleContext | undefined {
  const row = db.prepare(`
    SELECT s.frame_jpeg, s.frame_w, s.frame_h, s.crop_json, g.*
      FROM capture_samples s
      JOIN goal_cards c ON c.id = s.goal_card_id
      JOIN goal_sessions gs ON gs.id = c.goal_session_id
      JOIN goals g ON g.id = gs.goal_id
     WHERE s.id = ?
  `).get(sampleId) as ({ frame_jpeg: Buffer; frame_w: number; frame_h: number; crop_json: string } & GoalRow) | undefined;
  if (!row) return undefined;
  let crop: CaptureSampleContext['crop'] = null;
  try { crop = row.crop_json ? JSON.parse(row.crop_json) : null; } catch { /* keep null */ }
  return { id: sampleId, frame: row.frame_jpeg, frameW: row.frame_w, frameH: row.frame_h, crop, goal: toGoal(row) };
}

const upsertCaptureLabel = db.prepare(`
  INSERT INTO capture_labels (capture_sample_id, verdict, product_id, labelled_at)
  VALUES (@sampleId, @verdict, @productId, @labelledAt)
  ON CONFLICT(capture_sample_id) DO UPDATE SET
    verdict = excluded.verdict, product_id = excluded.product_id, labelled_at = excluded.labelled_at
`);

/** Records (or overwrites) ground truth for one stored frame. `productId` is required for
 *  verdict='card' and ignored otherwise — enforced by the caller (server.ts), not here, since
 *  this is a pure data-layer write. */
export function saveCaptureLabel(sampleId: number, verdict: CaptureLabelVerdict, productId: number | null): void {
  upsertCaptureLabel.run({ sampleId, verdict, productId, labelledAt: Date.now() });
}

export function getGoalCardThumb(id: number): Buffer | null {
  const row = selectGoalCardThumb.get(id) as { thumb_jpeg: Buffer | null } | undefined;
  return row?.thumb_jpeg ?? null;
}

/**
 * The review strip's only write. Voiding un-fills the slot the card filled, because owned counts
 * are derived from exactly these rows — no counter to also remember to decrement, and no way for
 * the two to disagree. Reversible in both directions.
 */
export function setGoalCardVoid(id: number, voided: boolean): GoalCard {
  setGoalCardVoided.run(voided ? 1 : 0, id);
  return getGoalCard(id);
}

export interface ReviewEntry {
  card: GoalCard;
  /** TCGCSV reference photo for the card the capture was matched to — the thing you're actually
   *  comparing against in the review strip. */
  referenceImageUrl: string | null;
}

/** Accepted cards from a run, paired with the reference image of whatever they were matched to.
 *  Includes voided rows so an un-void is possible without hunting for the card again. */
export function getReviewStrip(goalSessionId: string): ReviewEntry[] {
  const session = getGoalSession(goalSessionId);
  if (!session) throw new Error(`Goal session ${goalSessionId} not found`);
  const goal = getGoal(session.goalId)!;
  // Deliberately NOT variant-scoped: this is a lookup for historical rows, and a scan recorded
  // before the filter existed may point at a product the current variant excludes. Narrowing it
  // would blank that row's reference image and make the very rows worth reviewing unreviewable.
  const byId = new Map(getCandidatesForSets(goal.setIds).map((c) => [c.productId, c]));

  return getGoalCardsForSession(goalSessionId)
    .filter((c) => c.outcome === 'needed')
    .map((card) => ({
      card,
      referenceImageUrl: card.productId != null ? byId.get(card.productId)?.imageUrl ?? null : null,
    }));
}

export interface LowConfidenceCandidate {
  productId: number | null;
  name: string | null;
  number: string | null;
  score: number | null;
  imageUrl: string | null;
}

export interface LowConfidenceEntry {
  card: GoalCard;
  /** The two candidates that were too close to separate — the actual subject of the review. */
  top: LowConfidenceCandidate;
  runnerUp: LowConfidenceCandidate;
  /** score - runnerUpScore. Null when either side is missing. The number that failed minGap. */
  gap: number | null;
}

/**
 * Predicate for "worth a human look" among low-confidence rows.
 *
 * A run's low-confidence pile mixes two very different failures, and only one of them is
 * reviewable. If at least one candidate cleared minScore, the model DID find a plausible card and
 * was merely unable to separate it from the next one — a person looking at the photo can usually
 * settle that in a second. If neither cleared it, nothing in the pool resembled the capture, so
 * there is no question to answer; showing those rows would bury the answerable ones.
 *
 * Deliberately OR rather than AND: a top that clears minScore while its runner-up sits below is
 * still a near-miss the gap rejected, and it is the easiest case of all to adjudicate.
 */
function isReviewableLowConfidence(card: GoalCard, minScore: number): boolean {
  if (card.reason !== 'low-confidence' || card.voided) return false;
  return (card.score != null && card.score >= minScore)
    || (card.runnerUpScore != null && card.runnerUpScore >= minScore);
}

/**
 * The end-of-run "which of these two was it" list.
 *
 * Pairs each reviewable low-confidence capture with BOTH candidates and their reference photos,
 * because the decision being asked for is a three-way visual comparison and a name alone does not
 * support it. The capture's own thumbnail comes from goal_cards.thumb_jpeg, which scanGoalCard
 * now stores for this outcome specifically.
 */
export function getLowConfidenceReview(goalSessionId: string): LowConfidenceEntry[] {
  const session = getGoalSession(goalSessionId);
  if (!session) throw new Error(`Goal session ${goalSessionId} not found`);
  const goal = getGoal(session.goalId)!;
  const minScore = getSettings().minScore;
  // Unscoped for the same reason as getReviewStrip: this resolves historical rows, and narrowing
  // by the current variant would blank the image of the very rows worth reviewing.
  const byId = new Map(getCandidatesForSets(goal.setIds).map((c) => [c.productId, c]));

  const look = (productId: number | null, name: string | null, score: number | null): LowConfidenceCandidate => {
    const c = productId != null ? byId.get(productId) : undefined;
    return {
      productId,
      // Prefer the catalog's current name, but fall back to what was stamped on the row so a
      // product that has since left the pool still reads as something.
      name: c?.name ?? name,
      number: c?.number ?? null,
      score,
      imageUrl: c?.imageUrl ?? null,
    };
  };

  return getGoalCardsForSession(goalSessionId)
    .filter((c) => isReviewableLowConfidence(c, minScore))
    .map((card) => ({
      card,
      top: look(card.productId, card.name, card.score),
      runnerUp: look(card.runnerUpProductId, card.runnerUpName, card.runnerUpScore),
      gap: card.score != null && card.runnerUpScore != null ? card.score - card.runnerUpScore : null,
    }));
}

export interface FilingEntry {
  card: GoalCard;
  page: number | null;
  pocket: number | null;
}

/**
 * The accepted pile, ordered so filing it is a mechanical walk rather than a sort.
 *
 * Reverse scan order, because the machine drops each routed card on top of the last — so the
 * physical stack, picked up and turned over, reads newest-first. Every entry carries its target
 * page and pocket, which is the whole point: you never read a card number or consult a checklist.
 *
 * Voided rows are dropped — if the review strip says a card was misidentified, you don't want it
 * in the binder, and its "slot" was wrong anyway.
 */
export function getFilingList(goalSessionId: string): FilingEntry[] {
  const session = getGoalSession(goalSessionId);
  if (!session) throw new Error(`Goal session ${goalSessionId} not found`);
  const goal = getGoal(session.goalId)!;

  const slotByProduct = new Map(getGoalSlots(goal).map((s) => [s.productId, s]));

  return getGoalCardsForSession(goalSessionId)
    .filter((c) => c.outcome === 'needed' && !c.voided)
    .sort((a, b) => b.seq - a.seq)
    .map((card) => {
      const slot = card.productId != null ? slotByProduct.get(card.productId) : undefined;
      return { card, page: slot?.page ?? null, pocket: slot?.pocket ?? null };
    });
}

const insertAdjustment = db.prepare(`
  INSERT INTO goal_adjustments (goal_id, product_id, delta, note, created_at)
  VALUES (?, ?, ?, ?, ?)
`);

/** Append-only correction for copies that never came through the machine — "I already own this",
 *  "I sold that one". Not an editable count, for the same reason there is no counter column. */
export function adjustGoal(goalId: string, productId: number, delta: number, note?: string): number {
  if (!getGoal(goalId)) throw new Error(`Goal ${goalId} not found`);
  if (!Number.isInteger(delta) || delta === 0) throw new Error('delta must be a non-zero integer.');
  insertAdjustment.run(goalId, productId, delta, note ?? null, Date.now());
  return getOwnedCounts(goalId).get(productId) ?? 0;
}

/** Re-exported so server.ts can sort ad-hoc lists the same way the binder does. */
export { parseCardNumber, compareCardNumbers };
