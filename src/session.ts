import crypto from 'crypto';
import { db } from './db';
import { getProductCached, scanImageWithRetry } from './tcgtracking';
import { BulkBox, CardRecord, Decision, DecisionReason, ProductSku, Session, SessionConfig, SessionStatus } from './types';

/** Thrown when /scan fails after retries — a genuine "can't reach a decision" state, distinct
 *  from a low-confidence match. Per plan Decision #12: never guess-route on this, stall the
 *  session instead. The physical card is still sitting on the X1PRO holding for a tone that
 *  we're intentionally not sending, so nothing is lost — server.ts turns this into a 503 and
 *  the frontend shows a retry banner instead of arming for the next card. */
export class StallError extends Error {}

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

export function createSession(config: SessionConfig): Session {
  const now = Date.now();
  const id = crypto.randomUUID();
  insertSession.run({
    id, gameId: config.gameId, gameName: config.gameName, setIdsJson: JSON.stringify(config.setIds),
    variant: config.variant, condition: config.condition, thresholdCents: config.thresholdCents,
    minScore: config.minScore, minGap: config.minGap, location: config.location,
    status: 'active' as SessionStatus, createdAt: now, updatedAt: now,
  });
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
    price_cents, decision, reason, bulk_box_id, scanned_at)
  VALUES (@sessionId, @seq, @productId, @skuId, @name, @score, @runnerUpScore,
    @priceCents, @decision, @reason, @bulkBoxId, @scannedAt)
`);
const nextSeq = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 as n FROM cards WHERE session_id = ?');

/** Picks a price for the session's declared (variant, condition) from a product's SKU matrix.
 *  Exact match first; falls back to the declared condition with any variant (cheapest, to stay
 *  conservative) if the declared variant genuinely isn't a valid printing for this card; falls
 *  back to the product's blended market_price as a last resort. Returns null only if the
 *  product has no price data at all, in which case the caller treats it as low-confidence. */
function resolvePriceCents(skus: ProductSku[], variant: string, condition: string, blendedMarketPrice: string | number | null): number | null {
  const toNum = (v: string | number | null | undefined): number | null => {
    if (v === null || v === undefined) return null;
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };

  const exact = skus.find((s) => s.variant_name === variant && s.condition_name === condition);
  const exactPrice = toNum(exact?.market_price);
  if (exactPrice !== null) return Math.round(exactPrice * 100);

  const sameCondition = skus
    .filter((s) => s.condition_name === condition)
    .map((s) => toNum(s.market_price))
    .filter((n): n is number => n !== null);
  if (sameCondition.length > 0) return Math.round(Math.min(...sameCondition) * 100);

  const blended = toNum(blendedMarketPrice);
  if (blended !== null) return Math.round(blended * 100);

  return null;
}

export interface ScanCardResult {
  decision: Decision;
  reason: DecisionReason;
  card: CardRecord;
}

/**
 * The core per-card decision. Throws StallError if TCGTracking is unreachable after retries —
 * everything else (unrecognized card, ambiguous match, unpriceable card) resolves to a logged
 * 'bulk' decision per the project's fail-safe-to-bulk policy, never a guess toward 'keeper'.
 */
export async function scanCard(sessionId: string, imageBuffer: Buffer): Promise<ScanCardResult> {
  const session = getSession(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);

  let matches;
  try {
    matches = await scanImageWithRetry(session.gameId, imageBuffer, session.setIds);
  } catch (err) {
    updateSessionStatus.run('stalled', Date.now(), sessionId);
    throw new StallError(err instanceof Error ? err.message : 'scan failed');
  }
  // A successful scan clears any prior stall — see plan Decision #12 ("runs are resumable").
  if (session.status === 'stalled') updateSessionStatus.run('active', Date.now(), sessionId);

  const top = matches[0];
  const runnerUp = matches[1];
  const seq = (nextSeq.get(sessionId) as { n: number }).n;
  const scannedAt = Date.now();

  const recordBulk = (reason: DecisionReason, productId: number | null, name: string | null, score: number | null, skuId: number | null, priceCents: number | null): ScanCardResult => {
    const box = currentOrNewBulkBox(session);
    incrementBulkBoxCount.run(box.id);
    const info = insertCard.run({
      sessionId, seq, productId, skuId, name, score, runnerUpScore: runnerUp?.score ?? null,
      priceCents, decision: 'bulk', reason, bulkBoxId: box.id, scannedAt,
    });
    return { decision: 'bulk', reason, card: getCard(info.lastInsertRowid as number) };
  };

  if (!top) {
    return recordBulk('low-confidence', null, null, null, null, null);
  }

  const confident = top.score >= session.minScore && (!runnerUp || top.score - runnerUp.score >= session.minGap);
  if (!confident) {
    // Log the best guess anyway — this is what makes the bulk pile searchable per plan
    // Decision #2, even though we don't trust it enough to act on it.
    return recordBulk('low-confidence', top.product_id, top.name, top.score, null, null);
  }

  const { row: product, skus } = await getProductCached(top.product_id);
  const priceCents = resolvePriceCents(skus, session.variant, session.condition, product.market_price);
  const sku = skus.find((s) => s.variant_name === session.variant && s.condition_name === session.condition);

  if (priceCents === null) {
    return recordBulk('low-confidence', top.product_id, product.name, top.score, sku?.sku_id ?? null, null);
  }

  const decision: Decision = priceCents >= session.thresholdCents ? 'keeper' : 'bulk';
  const reason: DecisionReason = decision === 'keeper' ? 'above-threshold' : 'below-threshold';

  if (decision === 'bulk') {
    return recordBulk(reason, top.product_id, product.name, top.score, sku?.sku_id ?? null, priceCents);
  }

  const info = insertCard.run({
    sessionId, seq, productId: top.product_id, skuId: sku?.sku_id ?? null, name: product.name,
    score: top.score, runnerUpScore: runnerUp?.score ?? null, priceCents, decision: 'keeper',
    reason, bulkBoxId: null, scannedAt,
  });
  return { decision: 'keeper', reason, card: getCard(info.lastInsertRowid as number) };
}

const selectCard = db.prepare('SELECT * FROM cards WHERE id = ?');

interface CardRow {
  id: number; session_id: string; seq: number; product_id: number | null; sku_id: number | null;
  name: string | null; score: number | null; runner_up_score: number | null; price_cents: number | null;
  decision: Decision; reason: DecisionReason; bulk_box_id: number | null; scanned_at: number;
}

function toCard(row: CardRow): CardRecord {
  return {
    id: row.id, sessionId: row.session_id, seq: row.seq, productId: row.product_id, skuId: row.sku_id,
    name: row.name, score: row.score, runnerUpScore: row.runner_up_score, priceCents: row.price_cents,
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
