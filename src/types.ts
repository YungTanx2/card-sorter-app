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
/**
 * 'not-a-card' is distinct from 'low-confidence': low-confidence means "recognized something,
 * couldn't pick between candidates"; not-a-card means "didn't even clear the floor for THIS being
 * a card at all". The client-side presence check (capture.js) is the real fix for phantom
 * captures of bare platform — this is a backstop for whatever gets past it (a stray object, a
 * hand in frame, a rig whose baseline is stale). Kept as its own reason rather than folded into
 * low-confidence so the manifest can tell the two apart.
 */
export type DecisionReason = 'above-threshold' | 'below-threshold' | 'low-confidence' | 'not-a-card' | 'scan-error' | 'signal-conflict';

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
  /** WHICH card came second, not just how close it was. A gap below minGap is the single most
   *  common failure mode, and without the runner-up's identity the manifest cannot distinguish
   *  "lost to its own separately-listed foil printing" from "lost to a genuinely similar card" —
   *  the first is a catalog problem, the second a capture problem, and they need opposite fixes. */
  runnerUpProductId: number | null;
  runnerUpName: string | null;
  priceCents: number | null;
  decision: Decision;
  reason: DecisionReason;
  /** Which signal identified this card — see MatchSource. Null when nothing did. */
  matchSource: MatchSource | null;
  ocrSim: number | null;
  ocrRaw: string | null;
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
/** 'not-a-card' — see DecisionReason's doc; same distinction, same reasoning, applies here too. */
export type GoalReason = 'fills-slot' | 'slot-filled' | 'excluded-rarity' | 'not-a-set-slot' | 'low-confidence' | 'not-a-card' | 'signal-conflict';

/**
 * Which signal identified the card. Recorded on every row so a run's manifest shows not just what
 * was decided but WHICH evidence decided it — the two signals fail on disjoint cards, so a shift
 * in this distribution is the earliest visible sign that one of them has degraded.
 *
 * 'both' is the healthy majority case: embedding and OCR independently agreed.
 */
export type MatchSource = 'clip' | 'ocr' | 'both';

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
  /** See CardRecord.runnerUpProductId — same reasoning, same diagnostic value. */
  runnerUpProductId: number | null;
  runnerUpName: string | null;
  outcome: GoalOutcome;
  reason: GoalReason;
  /** Which signal identified this card — null when nothing did (low-confidence, not-a-card). */
  matchSource: MatchSource | null;
  /** OCR's fuzzy title similarity in [0, 1], or null when OCR produced no read at all. Kept on
   *  every row, including ones the embedding decided, so a disagreement is diagnosable after
   *  the fact rather than only in the logs. */
  ocrSim: number | null;
  /** Exactly what Tesseract returned. The single most useful field when an OCR miss needs
   *  explaining — "it read MULAN as MUIAN" is actionable in a way a similarity score is not. */
  ocrRaw: string | null;
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
  /**
   * Server-side backstop for phantom captures — see DecisionReason's 'not-a-card' doc. The
   * client-side presence check in capture.js is the real fix (it prevents the capture, and
   * therefore the tone, entirely); this only relabels whatever slips past it — a session with no
   * baseline configured, or a baseline made stale by a crop change. Deliberately NOT
   * session/goal-scoped like minScore/minGap: it is a floor beneath "is this even a card", not a
   * per-run recognition tuning knob.
   *
   * IMPORTANT: this reason never changes ROUTING. recordBulk()/record() always send the card to
   * bulk/extras regardless of which DecisionReason is attached — 'not-a-card' vs 'low-confidence'
   * is purely a manifest label for diagnosis. That is what makes 0.60 an acceptable choice despite
   * one known false-positive case: CFSortingRun2 had 7 phantom captures scored 0.54-0.56 (cleanly
   * separated from the run's real distribution, whose p10 was 0.715), but sample 53 in that same
   * run was a genuine Location card — whose reference art is landscape while the machine feeds it
   * portrait (see [[project_tcg-card-sorter]] "Fix Location cards") — scored 0.5717, just under
   * this floor. Until that orientation bug is fixed, Location cards will be labelled
   * 'not-a-card' instead of 'low-confidence' in the manifest; they still land in the correct pile
   * either way. Revisit this value once Location scores recover.
   */
  minCardScore: number;
  /**
   * OCR peer signal (src/ocr.ts). Reads the printed title and resolves it against the same
   * variant-scoped candidate pool the embedding matcher uses.
   *
   * ocrMinSim 0.80 comes from the 57-frame labelled corpus of the 2026-08-17 dry run, where it
   * was the loosest threshold that still held 100% rescue precision:
   *
   *     sim>=0.90   4 rescued, 0 wrong      sim>=0.80  13 rescued,  0 wrong
   *     sim>=0.85   9 rescued, 0 wrong      sim>=0.75  15 rescued,  1 wrong  <- precision breaks
   *
   * Overall that moved the gate from 56% recall / 97% precision to 79% / 98%. Caveat worth
   * keeping in view: 13 rescues with zero errors cannot distinguish 100% precision from ~80% —
   * the 95% lower bound is around 75%. Tighten to 0.85 at the first sign of a wrong route.
   *
   * ocrEnabled is a kill switch, not a tuning knob. Turning it off restores exact pre-OCR
   * behaviour, which is what makes this safe to ship before the foil-glare case has been
   * measured (a Cold Foil run is still untested — see [[project_tcg-card-sorter]]).
   */
  ocrEnabled: boolean;
  ocrMinSim: number;
  /**
   * Titles shorter than this are excluded from the OCR index entirely. Fuzzy substring matching
   * will find a low-distance window for a 4-character title inside almost any noise — during the
   * feasibility run "RAHR" was confidently matched against reads that contained no letters from
   * it at all. 6 keeps every real card name while removing that whole failure class.
   */
  ocrMinTitleChars: number;
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
  /**
   * Card-presence gate (public/capture.js). The confirmation gate above proves the scene stopped
   * MOVING; this proves something is actually there. An empty platform is perfectly still, so
   * without this a capture fires into the gap between one card leaving and the next arriving.
   *
   * Measured on CFSortingRun2: 7 of 178 scans fired 2.75-2.99s after the previous one against a
   * 4.21s median, all scoring 0.54-0.56. Because the machine holds until it hears a tone, each of
   * those toned on nothing and the arriving card was then ejected unscanned.
   *
   * A NOTE ON WHY THERE IS NO SERVER-SIDE SCORE FLOOR to back this up: it looked obvious (the
   * phantom scores sat in a clean 0.54-0.56 band) until a real Location card — Ring of Stones,
   * capture sample 53 — was measured at 0.5717. Real cards and phantoms overlap on score, so any
   * floor that catches the phantoms also rejects legitimate cards. The client-side check is not a
   * convenience here; it is the only place the two are separable.
   *
   * emptyPlatformBaseline is a base64 64x48 grayscale sample of the bare platform, captured in
   * Calibrate. emptyPlatformCrop records the crop it was taken under — a baseline describes one
   * region of the frame, so it is discarded rather than trusted if the capture window has moved.
   */
  emptyPlatformBaseline: string | null;
  /** The crop geometry as getCrop() returns it — NOT the vpos setting. */
  emptyPlatformCrop: { left: number; top: number; width: number; height: number } | null;
  /** Mean abs grayscale difference from the baseline below which we call it "no card". */
  cardPresenceMinDiff: number;
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
  soundPack: 'machine' | 'synth' | 'tones';
  /**
   * Frequencies for the 'tones' pack, in Hz. Settings rather than constants because the right
   * pair is a property of the rig, not of the software — the X1PRO's Sound Learn rejected both
   * the vendor's own 1000/2000Hz pair and the synth cues as "too close" on this hardware, so
   * retuning must not require a deploy.
   *
   * Two rules when changing them. Keep both in roughly 800-2500Hz, where a phone micro-speaker
   * is efficient. And keep them NON-HARMONIC: a phone speaker at volume produces several percent
   * 2nd-harmonic distortion, so a 1000/2000Hz pair means the lower tone physically emits the
   * upper one. Defaults are DTMF frequencies, a set designed so no frequency is an integer
   * multiple of another. public/audio.js harmonicRisk() checks a pair and the Sound check panel
   * shows its verdict.
   */
  toneAcceptHz: number;
  toneRejectHz: number;
  /** How long each tone holds, in ms. Must be comfortably shorter than toneSettleMs, or the run
   *  re-arms while the tone is still sounding — the pages guard this, but keep it sane anyway. */
  toneDurationMs: number;
  /**
   * Fade in/out of a `tones` cue, in ms. The single most important detection parameter here.
   *
   * A setting rather than a constant because this rig has now refuted several tone
   * recommendations, and retuning must not need a deploy.
   *
   * WHY IT MATTERS: the machine misreads the accept cue as reject specifically when it reacts
   * EARLY. A gentle fade radiates less onset transient — the ~600-900Hz ring a speaker cone makes
   * when accelerating from rest, which is IDENTICAL on both cues and therefore carries no
   * information — and it delays the point at which the cue is loud enough to trigger a detector at
   * all, so the detector is more likely to be measuring steady state.
   *
   * ⚠ THE VALUE ONLY MEANT WHAT IT SAYS FROM 2026-08-27 ONWARD. Until then audio.js faded with
   * exponentialRampToValueAtTime over a 5000x range, which is so back-loaded that the effective
   * 10-90% rise was about a QUARTER of the nominal figure (25ms -> 6.4ms, 60ms -> 15.5ms) with a
   * peak slope 8.5x that of an equivalent linear fade. Raising this setting 25 -> 60 therefore
   * bought ~9ms of real softening, which is why it appeared to do nothing. It is now a raised
   * cosine, zero-slope at both ends. Any tuning history from before that date is not comparable.
   *
   * At >= 60ms the onset is taken to be gentle enough that a cue may sit INSIDE the resonance band
   * — which is what lets the pair go back to 941/1477, the only pair Sound Learn has accepted.
   * See audio.js resonanceRisk() for why avoiding the band was the wrong trade.
   */
  toneRampMs: number;
  /**
   * How long a decision is held — banner shown, cue ringing — before the rig re-arms for the
   * next card. Was a duplicated hardcoded 700ms in both mode pages; it becomes a real setting
   * here because Phase 2 makes it the window the X1PRO has to hear a tone and route, which is a
   * physical property of the machine rather than a UI preference.
   */
  toneSettleMs: number;
}
