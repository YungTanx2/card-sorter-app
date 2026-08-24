import crypto from 'crypto';
import { db } from './db';
import { StallError } from './errors';
import { getProductCached } from './tcgtracking';
import { matchCard, prewarmEmbeddings } from './embeddings';
import { getSettings } from './settings';
import { fetchSets, getCandidatesForSets, getPricesForProduct, prewarmSet } from './tcgcsv';
import { BulkBox, CardRecord, Decision, DecisionReason, Session, SessionConfig, SessionStatus, TCGCSVPrice } from './types';

/** Re-exported from errors.ts, where it moved so Set Builder's scan pipeline can throw the same
 *  type. In THIS pipeline it covers a narrow surface: matching is local (embeddings.ts, no
 *  network), so it only fires for genuinely unexpected failures upstream of the keeper/bulk
 *  decision (a corrupt cached embedding, the model failing to load, etc.). It deliberately does
 *  NOT cover the post-decision SKU lookup below — see resolveSkuForKeeper. */
export { StallError } from './errors';

// ---- sessions ----

const insertSession = db.prepare(`
  INSERT INTO sessions (id, game_id, game_name, set_ids_json, variant, condition, threshold_cents,
    min_score, min_gap, location, status, current_bulk_box_id, created_at, updated_at)
  VALUES (@id, @gameId, @gameName, @setIdsJson, @variant, @condition, @thresholdCents,
    @minScore, @minGap, @location, @status, NULL, @createdAt, @updatedAt)
`);
const selectSession = db.prepare('SELECT * FROM sessions WHERE id = ?');
const updateSessionStatus = db.prepare('UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?');
const updateSessionBulkBox = db.prepare('UPDATE sessions SET current_bulk_box_id = ?, updated_at = ? WHERE id = ?');

interface SessionRow {
  id: string; game_id: number; game_name: string; set_ids_json: string; variant: string; condition: string;
  threshold_cents: number; min_score: number; min_gap: number; location: string; status: SessionStatus;
  current_bulk_box_id: number | null; created_at: number; updated_at: number;
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id, gameId: row.game_id, gameName: row.game_name, setIds: JSON.parse(row.set_ids_json),
    variant: row.variant, condition: row.condition, thresholdCents: row.threshold_cents,
    minScore: row.min_score, minGap: row.min_gap, location: row.location, status: row.status,
    currentBulkBoxId: row.current_bulk_box_id, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

/**
 * Creates the session row, then pre-warms the catalog + embeddings for every scoped set
 * before returning. This is why scanCard() below needs zero network calls during an actual
 * run: TCGCSV gives a bulk per-set catalog+price source (unlike TCGTracking, which had none,
 * hence the old lazy per-scan product_cache design) and every candidate's reference image is
 * embedded once here rather than on first scan. For a brand-new set this can take real time
 * (fetching + embedding every candidate, ~150-250 typical) — acceptable for a one-time cost
 * per set, since tcgcsv_cache/embedding_cache persist across every future session on it.
 */
export async function createSession(config: SessionConfig): Promise<Session> {
  if (config.setIds.length === 0) {
    throw new Error('At least one set must be selected — unscoped runs are no longer supported (see plan).');
  }

  const now = Date.now();
  const id = crypto.randomUUID();
  insertSession.run({
    id, gameId: config.gameId, gameName: config.gameName, setIdsJson: JSON.stringify(config.setIds),
    variant: config.variant, condition: config.condition, thresholdCents: config.thresholdCents,
    minScore: config.minScore, minGap: config.minGap, location: config.location,
    status: 'active' as SessionStatus, createdAt: now, updatedAt: now,
  });

  const sets = await fetchSets(config.gameId);
  const setNameById = new Map(sets.map((s) => [s.id, s.name]));
  for (const groupId of config.setIds) {
    const groupName = setNameById.get(groupId) ?? String(groupId);
    const candidates = await prewarmSet(config.gameId, groupId, groupName);
    await prewarmEmbeddings(candidates);
  }

  return getSession(id)!;
}

export function getSession(id: string): Session | undefined {
  const row = selectSession.get(id) as SessionRow | undefined;
  return row ? toSession(row) : undefined;
}

export function resumeSession(id: string): Session {
  updateSessionStatus.run('active', Date.now(), id);
  const s = getSession(id);
  if (!s) throw new Error(`Session ${id} not found`);
  return s;
}

export function completeSession(id: string): Session {
  updateSessionStatus.run('complete', Date.now(), id);
  const s = getSession(id);
  if (!s) throw new Error(`Session ${id} not found`);
  return s;
}

// ---- bulk boxes ----

const insertBulkBox = db.prepare('INSERT INTO bulk_boxes (session_id, label, opened_at, card_count) VALUES (?, ?, ?, 0)');
const selectBulkBox = db.prepare('SELECT * FROM bulk_boxes WHERE id = ?');
const countBulkBoxesForSession = db.prepare('SELECT COUNT(*) as n FROM bulk_boxes WHERE session_id = ?');
const incrementBulkBoxCount = db.prepare('UPDATE bulk_boxes SET card_count = card_count + 1 WHERE id = ?');

interface BulkBoxRow { id: number; session_id: string; label: string; opened_at: number; card_count: number }

function toBulkBox(row: BulkBoxRow): BulkBox {
  return { id: row.id, sessionId: row.session_id, label: row.label, openedAt: row.opened_at, cardCount: row.card_count };
}

/** Opens a new bulk box and makes it the session's active box. Label defaults to a running
 *  "Box N" count (per-session) — box-only granularity per plan Decision #3, deliberately no
 *  ordinal position tracking since that desyncs on a single jam or double-feed. */
export function openBulkBox(sessionId: string, label?: string): BulkBox {
  const n = (countBulkBoxesForSession.get(sessionId) as { n: number }).n + 1;
  const finalLabel = label && label.trim() ? label.trim() : `Box ${n}`;
  const info = insertBulkBox.run(sessionId, finalLabel, Date.now());
  updateSessionBulkBox.run(info.lastInsertRowid, Date.now(), sessionId);
  return toBulkBox(selectBulkBox.get(info.lastInsertRowid) as BulkBoxRow);
}

function currentOrNewBulkBox(session: Session): BulkBox {
  if (session.currentBulkBoxId != null) {
    const row = selectBulkBox.get(session.currentBulkBoxId) as BulkBoxRow | undefined;
    if (row) return toBulkBox(row);
  }
  return openBulkBox(session.id);
}

// ---- cards ----

const insertCard = db.prepare(`
  INSERT INTO cards (session_id, seq, product_id, sku_id, name, score, runner_up_score,
    runner_up_product_id, runner_up_name, price_cents, decision, reason, bulk_box_id, scanned_at)
  VALUES (@sessionId, @seq, @productId, @skuId, @name, @score, @runnerUpScore,
    @runnerUpProductId, @runnerUpName, @priceCents, @decision, @reason, @bulkBoxId, @scannedAt)
`);
const nextSeq = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 as n FROM cards WHERE session_id = ?');

/** Picks a price for the session's declared variant from TCGCSV's per-printing price list.
 *  Exact subTypeName match first; falls back to the cheapest available printing (conservative)
 *  if the declared variant genuinely isn't valid for this card. Unlike the old TCGTracking SKU
 *  matrix, TCGCSV doesn't split price by condition — condition is stamped onto the export as
 *  metadata (session.condition) but no longer affects the price lookup itself. Returns null
 *  only if the product has no price data at all, in which case the caller treats it as
 *  low-confidence. */
function resolvePriceCents(prices: TCGCSVPrice[], variant: string): number | null {
  const exact = prices.find((p) => p.subTypeName === variant);
  if (exact?.marketPrice != null && Number.isFinite(exact.marketPrice)) {
    return Math.round(exact.marketPrice * 100);
  }

  const anyPrice = prices
    .map((p) => p.marketPrice)
    .filter((n): n is number => n !== null && Number.isFinite(n));
  if (anyPrice.length > 0) return Math.round(Math.min(...anyPrice) * 100);

  return null;
}

/**
 * TCGCSV has no real TCGPlayer SKU id (only productId) — see types.ts's ProductSku doc. The
 * CSV export's "TCGplayer Id" column needs one for TCGTracking's bulk import to work, and
 * TCGTracking's own /products/{id} still has it. So this one narrow call stays alive, but only
 * for CONFIRMED KEEPERS (not per scan, not per candidate) — a much smaller footprint than the
 * old system's per-scan dependency. Deliberately does NOT stall the session on failure: the
 * keeper/bulk routing decision is already made and correct by the time this runs, so a network
 * hiccup here shouldn't block the physical machine. It soft-fails to skuId=null, which
 * export.ts's existing ExcludedKeeper path already handles (same as "no SKU for this variant").
 */
async function resolveSkuForKeeper(productId: number, variant: string, condition: string): Promise<number | null> {
  try {
    const { skus } = await getProductCached(productId);
    return skus.find((s) => s.variant_name === variant && s.condition_name === condition)?.sku_id ?? null;
  } catch (err) {
    console.warn(`[session] SKU lookup failed for keeper product ${productId} — will export without a TCGplayer Id:`, err instanceof Error ? err.message : err);
    return null;
  }
}

export interface ScanCardResult {
  decision: Decision;
  reason: DecisionReason;
  card: CardRecord;
}

/**
 * The core per-card decision. Recognition (embeddings.ts) and pricing (tcgcsv.ts) are both
 * fully local — no network calls during a run, since everything was pre-warmed at session
 * creation. Throws StallError only for a genuinely unexpected failure upstream of the
 * decision; everything else (unrecognized card, ambiguous match, unpriceable card) resolves
 * to a logged 'bulk' decision per the project's fail-safe-to-bulk policy, never a guess
 * toward 'keeper'.
 */
export async function scanCard(sessionId: string, imageBuffer: Buffer): Promise<ScanCardResult> {
  const session = getSession(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);

  let top, runnerUp, candidates;
  try {
    // Scoped to the session's printing — a product with no price in this variant is not a
    // possible answer for this run, and leaving it in only manufactures ties (see tcgcsv.ts).
    candidates = getCandidatesForSets(session.setIds, session.variant);
    const match = await matchCard(imageBuffer, candidates);
    top = match.top;
    runnerUp = match.runnerUp;
  } catch (err) {
    updateSessionStatus.run('stalled', Date.now(), sessionId);
    throw new StallError(err instanceof Error ? err.message : 'recognition failed');
  }
  // A successful match clears any prior stall — see plan Decision #12 ("runs are resumable").
  if (session.status === 'stalled') updateSessionStatus.run('active', Date.now(), sessionId);

  const seq = (nextSeq.get(sessionId) as { n: number }).n;
  const scannedAt = Date.now();

  // Resolved once and stamped on every row, including confident ones. A confident scan's
  // runner-up is what makes the gap interpretable — "beat its own foil twin by 0.004" and
  // "beat an unrelated card by 0.004" are different problems, and only the identity says which.
  const runnerUpProductId = runnerUp?.productId ?? null;
  const runnerUpName = runnerUp ? candidates.find((c) => c.productId === runnerUp!.productId)?.name ?? null : null;

  const recordBulk = (reason: DecisionReason, productId: number | null, name: string | null, score: number | null, skuId: number | null, priceCents: number | null): ScanCardResult => {
    const box = currentOrNewBulkBox(session);
    incrementBulkBoxCount.run(box.id);
    const info = insertCard.run({
      sessionId, seq, productId, skuId, name, score, runnerUpScore: runnerUp?.score ?? null,
      runnerUpProductId, runnerUpName,
      priceCents, decision: 'bulk', reason, bulkBoxId: box.id, scannedAt,
    });
    return { decision: 'bulk', reason, card: getCard(info.lastInsertRowid as number) };
  };

  if (!top) {
    return recordBulk('low-confidence', null, null, null, null, null);
  }

  const name = candidates.find((c) => c.productId === top!.productId)?.name ?? null;

  // Server-side backstop for phantom captures — see AppSettings.minCardScore's doc. Checked
  // BEFORE the confidence gate, not folded into it: this is "did anything here resemble a card
  // at all", a different question from "which card, confidently". Never changes routing (both
  // reasons hit the same recordBulk path) — it only makes the manifest tell the two apart.
  if (top.score < getSettings().minCardScore) {
    return recordBulk('not-a-card', top.productId, name, top.score, null, null);
  }

  const confident = top.score >= session.minScore && (!runnerUp || top.score - runnerUp.score >= session.minGap);

  if (!confident) {
    // Log the best guess anyway — this is what makes the bulk pile searchable per plan
    // Decision #2, even though we don't trust it enough to act on it.
    return recordBulk('low-confidence', top.productId, name, top.score, null, null);
  }

  const priceCents = resolvePriceCents(getPricesForProduct(top.productId), session.variant);

  if (priceCents === null) {
    return recordBulk('low-confidence', top.productId, name, top.score, null, null);
  }

  const decision: Decision = priceCents >= session.thresholdCents ? 'keeper' : 'bulk';
  const reason: DecisionReason = decision === 'keeper' ? 'above-threshold' : 'below-threshold';

  if (decision === 'bulk') {
    return recordBulk(reason, top.productId, name, top.score, null, priceCents);
  }

  const skuId = await resolveSkuForKeeper(top.productId, session.variant, session.condition);
  const info = insertCard.run({
    sessionId, seq, productId: top.productId, skuId, name,
    score: top.score, runnerUpScore: runnerUp?.score ?? null, runnerUpProductId, runnerUpName,
    priceCents, decision: 'keeper', reason, bulkBoxId: null, scannedAt,
  });
  return { decision: 'keeper', reason, card: getCard(info.lastInsertRowid as number) };
}

const selectCard = db.prepare('SELECT * FROM cards WHERE id = ?');

interface CardRow {
  id: number; session_id: string; seq: number; product_id: number | null; sku_id: number | null;
  name: string | null; score: number | null; runner_up_score: number | null;
  runner_up_product_id: number | null; runner_up_name: string | null; price_cents: number | null;
  decision: Decision; reason: DecisionReason; bulk_box_id: number | null; scanned_at: number;
}

function toCard(row: CardRow): CardRecord {
  return {
    id: row.id, sessionId: row.session_id, seq: row.seq, productId: row.product_id, skuId: row.sku_id,
    name: row.name, score: row.score, runnerUpScore: row.runner_up_score,
    runnerUpProductId: row.runner_up_product_id, runnerUpName: row.runner_up_name,
    priceCents: row.price_cents,
    decision: row.decision, reason: row.reason, bulkBoxId: row.bulk_box_id, scannedAt: row.scanned_at,
  };
}

function getCard(id: number): CardRecord {
  return toCard(selectCard.get(id) as CardRow);
}

export function getCardsForSession(sessionId: string): CardRecord[] {
  const rows = db.prepare('SELECT * FROM cards WHERE session_id = ? ORDER BY seq').all(sessionId) as CardRow[];
  return rows.map(toCard);
}

export function getBulkBoxesForSession(sessionId: string): BulkBox[] {
  const rows = db.prepare('SELECT * FROM bulk_boxes WHERE session_id = ? ORDER BY id').all(sessionId) as BulkBoxRow[];
  return rows.map(toBulkBox);
}

/** Cross-session search — "which box did I put card X in?" per plan's GET /api/search route.
 *  Only searches bulk cards (keepers already left the system via CSV export + TCGTracking
 *  import, so they're not something you'd need to physically dig for). */
export interface SearchResult {
  card: CardRecord;
  sessionId: string;
  gameName: string;
  bulkBoxLabel: string | null;
}

export function searchBulkCards(query: string): SearchResult[] {
  const rows = db.prepare(`
    SELECT c.*, s.game_name as session_game_name, b.label as bulk_box_label
    FROM cards c
    JOIN sessions s ON s.id = c.session_id
    LEFT JOIN bulk_boxes b ON b.id = c.bulk_box_id
    WHERE c.decision = 'bulk' AND c.name LIKE ?
    ORDER BY c.scanned_at DESC
    LIMIT 100
  `).all(`%${query}%`) as (CardRow & { session_game_name: string; bulk_box_label: string | null })[];

  return rows.map((row) => ({
    card: toCard(row),
    sessionId: row.session_id,
    gameName: row.session_game_name,
    bulkBoxLabel: row.bulk_box_label,
  }));
}
