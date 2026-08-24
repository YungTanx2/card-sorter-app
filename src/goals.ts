import crypto from 'crypto';
import sharp from 'sharp';
import { db } from './db';
import { StallError } from './errors';
import { matchCard, prewarmEmbeddings } from './embeddings';
import { getSettings } from './settings';
import { fetchSets, getCandidatesForSets, prewarmSet, fetchSetCandidates } from './tcgcsv';
import { assignSlots, parseCardNumber, compareCardNumbers } from './ordering';
import {
  CandidateCard, Goal, GoalCard, GoalConfig, GoalOutcome, GoalReason, GoalSession, GoalSlot,
  SessionStatus,
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
 * Hard-deletes a goal and everything derived from it. Needed because a goal's printing and
 * target are fixed at creation — get either wrong and the goal is permanently useless, so
 * without this the only remedy is editing SQLite by hand.
 *
 * Wrapped in a transaction: goal_cards rows ARE the progress (there is no counter to fall back
 * on), so a partial delete would leave orphaned scan rows that no goal can ever surface again.
 * Deliberately does not touch tcgcsv_cache or embedding_cache — those are shared with the
 * price-sorter and expensive to rebuild.
 */
export const deleteGoal = db.transaction((id: string) => {
  // Before goal_cards, since these hang off card ids. Explicit because foreign_keys is off — see
  // the capture_samples comment in db.ts; a REFERENCES clause alone would silently orphan the
  // largest rows in the schema.
  db.prepare(`DELETE FROM capture_samples WHERE goal_card_id IN
    (SELECT id FROM goal_cards WHERE goal_id = ?)`).run(id);
  db.prepare('DELETE FROM goal_cards WHERE goal_id = ?').run(id);
  db.prepare('DELETE FROM goal_adjustments WHERE goal_id = ?').run(id);
  db.prepare('DELETE FROM goal_sessions WHERE goal_id = ?').run(id);
  db.prepare('DELETE FROM goals WHERE id = ?').run(id);
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
    counts_toward_goal, thumb_jpeg, scanned_at)
  VALUES (@goalSessionId, @goalId, @seq, @productId, @name, @number, @score,
    @runnerUpScore, @runnerUpProductId, @runnerUpName, @outcome, @reason, 0,
    @countsTowardGoal, @thumbJpeg, @scannedAt)
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
}

function toGoalCard(row: GoalCardRow): GoalCard {
  return {
    id: row.id, goalSessionId: row.goal_session_id, goalId: row.goal_id, seq: row.seq,
    productId: row.product_id, name: row.name, number: row.number, score: row.score,
    runnerUpScore: row.runner_up_score,
    runnerUpProductId: row.runner_up_product_id, runnerUpName: row.runner_up_name,
    outcome: row.outcome, reason: row.reason,
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

  let top, runnerUp, candidates: CandidateCard[];
  try {
    // Scoped to the goal's printing — a goal is already single-variant by construction, so a
    // product with no price in that printing is not a card this goal can ever want (tcgcsv.ts).
    candidates = getCandidatesForSets(goal.setIds, goal.variant);
    const match = await matchCard(imageBuffer, candidates);
    top = match.top;
    runnerUp = match.runnerUp;
  } catch (err) {
    updateGoalSessionStatus.run('stalled', Date.now(), goalSessionId);
    throw new StallError(err instanceof Error ? err.message : 'recognition failed');
  }
  if (session.status === 'stalled') updateGoalSessionStatus.run('active', Date.now(), goalSessionId);

  const settings = getSettings();
  const seq = (nextGoalSeq.get(goalSessionId) as { n: number }).n;
  const scannedAt = Date.now();
  const countsTowardGoal = session.dryRun ? 0 : 1;

  // See session.ts — the runner-up's identity is what makes a small gap diagnosable, so it is
  // stamped on every row rather than only on the ones that failed the gate.
  const runnerUpProductId = runnerUp?.productId ?? null;
  const runnerUpName = runnerUp ? candidates.find((c) => c.productId === runnerUp!.productId)?.name ?? null : null;

  const record = async (
    outcome: GoalOutcome, reason: GoalReason, candidate: CandidateCard | null,
    score: number | null, withThumb: boolean,
  ): Promise<ScanGoalCardResult> => {
    const info = insertGoalCard.run({
      goalSessionId, goalId: goal.id, seq,
      productId: candidate?.productId ?? null, name: candidate?.name ?? null,
      number: candidate?.number ?? null, score, runnerUpScore: runnerUp?.score ?? null,
      runnerUpProductId, runnerUpName,
      outcome, reason, countsTowardGoal,
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

  // 0. Server-side backstop for phantom captures — see AppSettings.minCardScore's doc and
  //    session.ts's identical check. Ahead of the confidence gate for the same reason: "did
  //    anything here resemble a card" is a different question from "which card, confidently".
  //    Never changes the outcome (still 'extra', count unaffected) — only the reason label.
  if (top && top.score < settings.minCardScore) {
    const guess = candidates.find((c) => c.productId === top!.productId) ?? null;
    return record('extra', 'not-a-card', guess, top.score, false);
  }

  // 1. Unrecognized or ambiguous. Deliberately checked before anything else — we know nothing
  //    about this card, so no rarity or slot reasoning is valid. No count changes, so the goal
  //    still reports the real card missing and a re-run gets another shot at it.
  const confident = !!top
    && top.score >= settings.minScore
    && (!runnerUp || top.score - runnerUp.score >= settings.minGap);
  if (!top || !confident) {
    // Log the best guess anyway so the run's manifest is diagnosable, but never act on it.
    const guess = top ? candidates.find((c) => c.productId === top!.productId) ?? null : null;
    return record('extra', 'low-confidence', guess, top?.score ?? null, false);
  }

  const candidate = candidates.find((c) => c.productId === top!.productId) ?? null;

  // 2. Matched something that isn't a set slot at all — a puzzle insert or similar filler that
  //    TCGPlayer lists alongside the real cards. Its own reason rather than being folded into
  //    'excluded-rarity', so a run's manifest stays honest about why a card was passed over.
  if (!candidate || !isSetSlotCandidate(candidate)) {
    return record('extra', 'not-a-set-slot', candidate, top.score, false);
  }

  // 3. A rarity this goal deliberately doesn't collect (chase cards in a play-set goal).
  if (candidate.rarity && goal.excludedRarities.some((r) => r.trim().toLowerCase() === candidate.rarity!.trim().toLowerCase())) {
    return record('extra', 'excluded-rarity', candidate, top.score, false);
  }

  // 4. Already have enough. In a dry run this still reads the real (committed) counts, so a dry
  //    run against a partially-built goal reports what a live run would actually do.
  const owned = getOwnedCounts(goal.id).get(top.productId) ?? 0;
  if (owned >= goal.targetCopies) {
    return record('extra', 'slot-filled', candidate, top.score, false);
  }

  // 5. Fills a slot. Only this path stores a thumbnail — it's the only one the review strip
  //    covers, since it's the only one that mutates long-lived goal state.
  return record('needed', 'fills-slot', candidate, top.score, true);
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

export interface CaptureSampleRow {
  id: number; goalCardId: number; frameW: number; frameH: number; cropJson: string;
  productId: number | null; name: string | null; number: string | null;
  outcome: GoalOutcome; reason: GoalReason; score: number | null; voided: boolean;
}

/**
 * Stored samples for a run, joined to the card each came from.
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
           c.product_id, c.name, c.number, c.outcome, c.reason, c.score, c.voided
      FROM capture_samples s
      JOIN goal_cards c ON c.id = s.goal_card_id
     WHERE c.goal_session_id = ?
     ORDER BY c.seq
  `).all(goalSessionId).map((r: any) => ({
    id: r.id, goalCardId: r.goal_card_id, frameW: r.frame_w, frameH: r.frame_h,
    cropJson: r.crop_json, productId: r.product_id, name: r.name, number: r.number,
    outcome: r.outcome, reason: r.reason, score: r.score, voided: r.voided === 1,
  }));
}

export function getCaptureSampleFrame(id: number): Buffer | null {
  const row = db.prepare('SELECT frame_jpeg FROM capture_samples WHERE id = ?').get(id) as
    { frame_jpeg: Buffer } | undefined;
  return row?.frame_jpeg ?? null;
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
