// Shared types for the card-sorter app. See the plan at
// ~/.claude/plans/familiarize-yourself-with-the-abstract-patterson.md for the recognition-layer
// rewrite (TCGTracking /scan -> self-hosted CLIP embedding matching + TCGCSV catalog), and
// ~/.claude/plans/sunny-whistling-abelson.md for the original Phase 1 architecture.

export type Decision = 'keeper' | 'bulk';

/**
 * Why a card was routed where it was. Distinguishes an intentional bulk call
 * (correctly priced below threshold) from a fail-safe bulk call (the app
 * wasn't sure) and from a hard scan failure — this is what makes the bulk
 * pile searchable/auditable rather than just a black box.
 */
export type DecisionReason = 'above-threshold' | 'below-threshold' | 'low-confidence' | 'scan-error';

export type SessionStatus = 'active' | 'stalled' | 'complete';

/** One candidate card in a session's scope, resolved once from TCGCSV at session creation
 *  and cached (tcgcsv.ts) — this is the full "known cards" list the embedding matcher scores
 *  a capture against. Not a live API response shape; a local, pre-warmed record. */
export interface CandidateCard {
  productId: number;
  name: string;
  number: string | null; // e.g. "125/207" (Lorcana/Pokemon/Magic) or "OP07-001" (One Piece/Digimon)
  rarity: string | null;
  imageUrl: string | null; // TCGCSV reference photo — embedding source AND the CSV export's Photo URL
  setId: number;
  setName: string;
}

/** One (productId, printing) price row from TCGCSV's /prices — unlike TCGTracking's SKU matrix,
 *  TCGCSV does not split price by condition (it's a blended market rate per printing). */
export interface TCGCSVPrice {
  subTypeName: string; // "Normal" | "Holofoil" | "Cold Foil" | ... — equivalent of session.variant
  marketPrice: number | null;
  lowPrice: number | null;
}

/** A candidate's cosine-similarity score against a captured photo. score is in [-1, 1]
 *  (in practice ~0.4-0.95 for CLIP on card photos) — NOT the old 0-100 TCGTracking scale. */
export interface EmbeddingMatch {
  productId: number;
  score: number;
}

/**
 * TCGTracking-sourced types (ProductSku/ProductDetail/ProductCacheRow) — kept narrowly for
 * one purpose after the recognition-layer rewrite: TCGCSV's free API has no real TCGPlayer
 * SKU id (only productId), but the CSV export's "TCGplayer Id" column needs one for
 * TCGTracking's bulk import to actually work. TCGTracking's own /products/{id} still has
 * it. So this path stays alive, called once per CONFIDENT KEEPER (not per scan, not per
 * candidate) purely to resolve the real sku_id — see session.ts's resolveSkuForKeeper().
 */
export interface ProductSku {
  sku_id: number;
  product_id: number;
  condition_name: string; // "Near Mint" | "Lightly Played" | ...
  variant_name: string;   // "Normal" | "Holofoil" | "Reverse Holofoil" | "Cold Foil" | ...
  language_name: string;
  market_price: string | number | null;
  lowest_price?: string | number | null;
}

export interface ProductDetail {
  success: boolean;
  product_id: number;
  product: {
    product_id: number;
    category_id: number;
    group_id: number;
    name: string;
    ext_number: string | null;
    ext_rarity: string | null;
    set_name: string;
    set_abbr: string;
    market_price: string | number | null;
    category_name: string;
    image_url: string | null;
  };
  skus: ProductSku[];
  sku_dimensions: {
    variants: { id: number; name: string }[];
    conditions: { id: number; name: string }[];
    languages: { id: number; name: string }[];
  };
}

/** Cached product record — populated lazily from /products/{id}, persists across runs (see db.ts). */
export interface ProductCacheRow {
  product_id: number;
  name: string;
  set_id: number;
  set_name: string;
  number: string | null;
  rarity: string | null;
  market_price: number | null; // blended TCGPlayer market_price — last-resort pricing fallback
  image_url: string | null;
  skus_json: string; // JSON.stringify(ProductSku[])
  fetched_at: number;
}

export interface SessionConfig {
  gameId: number;   // TCGCSV categoryId — same numbering TCGTracking used (71=Lorcana, 3=Pokemon, ...)
  gameName: string;
  /** REQUIRED, >=1 groupId (TCGCSV's set id). Unscoped runs are no longer supported: the
   *  embedding matcher scores a capture against every candidate in scope, so an unscoped
   *  session would mean matching against the whole game's catalog — exactly the unbounded
   *  search that made TCGTracking's (broken-scoping) /scan unreliable in the first place. */
  setIds: number[];
  variant: string;        // TCGCSV subTypeName, e.g. "Normal", "Cold Foil", "Holofoil" — declared for the whole run
  condition: string;      // stamped onto the CSV export's Condition column; TCGCSV prices aren't split by condition
  thresholdCents: number; // keeper if price >= this
  minScore: number;       // confidence gate — cosine similarity in [-1, 1], NOT the old 0-100 scale
  minGap: number;         // confidence gate: top score - runner-up score, same scale as minScore
  location: string;       // TCGTracking location string for this run's keepers, e.g. "A-1-A"
}

export interface Session extends SessionConfig {
  id: string;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
  currentBulkBoxId: number | null;
}

export interface CardRecord {
  id: number;
  sessionId: string;
  seq: number;
  productId: number | null;
  skuId: number | null; // resolved via TCGTracking /products/{id}, only for keepers — see ProductSku doc above
  name: string | null;
  score: number | null;         // cosine similarity in [-1, 1] against the top candidate
  runnerUpScore: number | null; // cosine similarity against the #2 candidate
  priceCents: number | null;
  decision: Decision;
  reason: DecisionReason;
  bulkBoxId: number | null;
  scannedAt: number;
}

export interface BulkBox {
  id: number;
  sessionId: string;
  label: string;
  openedAt: number;
  cardCount: number;
}

// ══════════════════════════ SET BUILDER MODE ══════════════════════════
// A different question asked of the same capture: not "is this worth money?" but "does this
// advance a set I'm building?". Shares the recognition layer (embeddings.ts + tcgcsv.ts) and
// nothing else — no pricing, no SKUs, no TCGTracking. See PRDs/card-sorter-set-builder.md.

/** Where a scanned card physically goes. Two piles, matching the X1PRO's two bins. */
export type GoalOutcome = 'needed' | 'extra';

/**
 * Why a card went where it did. The distinction that matters most is `low-confidence` vs
 * `slot-filled`: both send the card to the extras pile, but only the latter means we actually
 * know what it was. A low-confidence card leaves the goal still reporting that slot missing,
 * which is what makes the failure self-healing — you'll re-run the pile and get another shot.
 */
export type GoalReason = 'fills-slot' | 'slot-filled' | 'excluded-rarity' | 'not-a-set-slot' | 'low-confidence';

export type GoalStatus = 'active' | 'complete';

export interface GoalConfig {
  name: string;
  gameId: number;
  gameName: string;
  /** REQUIRED, >=1 groupId — same reasoning as SessionConfig.setIds: the matcher scores against
   *  every candidate in scope, so an unscoped goal means matching the whole game's catalog. */
  setIds: number[];
  /** TCGCSV subTypeName. A goal is scoped to ONE printing because recognition structurally
   *  cannot distinguish them (same productId, same reference image) — so a true Pokemon master
   *  set is 2-3 goals and the operator pre-splits foils by eye. */
  variant: string;
  /** 1 = master set, 4 = play set. One flat number for the whole goal. */
  targetCopies: number;
  /** Rarities that don't count toward this goal at all — removed from the binder layout, not
   *  left as permanent holes. Without this, a targetCopies=4 play-set goal would demand four
   *  Enchanteds forever and route every chase card to the needed pile run after run. */
  excludedRarities: string[];
  binderRows: number;
  binderCols: number;
}

export interface Goal extends GoalConfig {
  id: string;
  status: GoalStatus;
  createdAt: number;
  updatedAt: number;
}

export interface GoalSession {
  id: string;
  goalId: string;
  /** When true, scans are logged and reviewable but do NOT count toward the goal. The gate that
   *  lets set mode ship before recognition has been validated on physical cards. */
  dryRun: boolean;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
}

export interface GoalCard {
  id: number;
  goalSessionId: string;
  goalId: string;
  seq: number;
  productId: number | null;
  name: string | null;
  number: string | null;
  score: number | null;         // cosine similarity in [-1, 1]
  runnerUpScore: number | null;
  outcome: GoalOutcome;
  reason: GoalReason;
  /** Set by the review strip when a capture turns out not to match the card it filled. Voiding
   *  is the only way a slot un-fills, and the derived count follows automatically. */
  voided: boolean;
  /** Frozen at insert time from the session's dryRun flag — see db.ts. Derived state is only
   *  safe when its inputs are immutable. */
  countsTowardGoal: boolean;
  hasThumb: boolean;
  scannedAt: number;
}

/** One binder pocket: a candidate card plus how many copies of it the goal currently has. */
export interface GoalSlot {
  productId: number;
  name: string;
  number: string | null;
  rarity: string | null;
  imageUrl: string | null;
  setId: number;
  setName: string;
  page: number;
  pocket: number;
  owned: number;
  target: number;
}

export interface CsvColumnMapping {
  header: string;
  /**
   * Field name pulled from the export row (see export.ts ExportRow), or '' for a
   * blank column. Kept as plain strings (not a union) so this stays editable from
   * config/settings.json or the settings UI without a code change — the actual
   * TCGTracking import column contract is undocumented, so this must be tunable.
   */
  field: string;
}

export interface AppSettings {
  /** Cosine similarity in [-1, 1] (typically ~0.4-0.95 for CLIP on real card photos), NOT the
   *  old 0-100 TCGTracking scale. Defaults below come from the 2026-08-05 Phase A embedding
   *  harness run (scripts/embedding-harness.ts): 5/6 real photos correct, correct-match scores
   *  0.74-0.88 with gaps 0.03-0.17; the one miss scored 0.82 but with gap only 0.02 — below
   *  every genuine match's gap. minGap is the more reliable signal on this evidence. Still only
   *  n=6 from one set — a real dry run should retune these, not just trust the starting point. */
  minScore: number;
  minGap: number;
  defaultThresholdCents: number;
  defaultCondition: string;
  captureIntervalMs: number;
  stableFrames: number;
  frameDiffThreshold: number;
  /**
   * Confirmation gate (public/capture.js). Once stableFrames quiet ticks have passed, the frame
   * is compared against an ANCHOR taken at the start of that quiet window rather than against
   * the previous tick, and the capture only happens if they still match.
   *
   * The long baseline is the point. frameDiffThreshold only asks "did it move in the last
   * captureIntervalMs", so a card creeping into position stays under it on every tick while
   * travelling a long way overall — which is how scans were firing mid-placement. Comparing
   * across the whole window is the only way to see that drift.
   */
  confirmMinSpanMs: number;   // minimum anchor age before confirming; below this we wait
  confirmMaxDrift: number;    // mean abs gray diff vs anchor still considered "at rest"
  confirmMaxAttempts: number; // failed confirmations before stalling as 'unsettled'
  hopperEmptyTimeoutMs: number;
  scanMaxRetries: number;
  scanRetryBackoffMs: number;
  cacheTtlHours: number;
  csvColumns: CsvColumnMapping[];
  /**
   * Client-side capture crop, as two slider values the frontend maps to a crop rectangle
   * (see public/index.html's getCrop()) — NOT raw fractions, so the crop math lives in one
   * place. Default 100/51 reproduces the exact crop validated in the 2026-08-04 calibration
   * run (scripts/calibrate.ts): full uncropped frames scored 0/3 correct against real
   * TCGTracking /scan calls, cropped-to-card scored 2/3 with a clean score/gap separation.
   * The server never interprets these — it only stores/returns them like any other setting.
   */
  captureCropZoomPct: number; // 100 = the validated default crop; sliders run roughly 50-150
  captureCropVPosPct: number; // 0 = crop touches top of frame, 100 = touches bottom
  /**
   * Audio cues (public/audio.js). Purely client-side like the crop knobs above — the server
   * stores and returns them, never interprets them.
   *
   * These matter beyond operator feedback: the X1PRO routes on an audio cue it has been taught
   * ("Sound Learn"), so in Phase 2 these same tones become the machine's control signal. The
   * cues are synthesized rather than sampled specifically so that retuning is a settings edit.
   */
  soundEnabled: boolean;
  soundVolume: number; // 0-1, master gain
  /**
   * Which sound pack the decision cues use.
   *
   * `machine` plays the X1PRO's own tones, taken from the vendor's operating-instructions page
   * where they're published for teaching the machine ("Sound Learn") and stored in
   * `public/sounds/`. Measured: HIGH VALUE is a pure 2000Hz sine, NORMAL a pure 1000Hz sine,
   * both ~0.6s, everything else under 4% of peak — one octave apart with no harmonic clutter,
   * which is what makes them easy for a cheap mic and a threshold detector to tell apart.
   *
   * `synth` plays the ka-ching/thunk generated in audio.js. Pleasanter over a 250-card pile, but
   * NOT what the machine was taught — a decorative sound layered onto a control tone is how you
   * make a naive detector misfire. Use it only while no machine is listening.
   */
  soundPack: 'machine' | 'synth';
  /**
   * How long a decision is held — banner shown, cue ringing — before the rig re-arms for the
   * next card. Was a duplicated hardcoded 700ms in both mode pages; it becomes a real setting
   * here because Phase 2 makes it the window the X1PRO has to hear a tone and route, which is a
   * physical property of the machine rather than a UI preference.
   */
  toneSettleMs: number;
}
