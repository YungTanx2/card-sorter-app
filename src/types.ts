// Shared types for the card-sorter app. See the plan at
// ~/.claude/plans/sunny-whistling-abelson.md for the full architecture writeup.

export type Decision = 'keeper' | 'bulk';

/**
 * Why a card was routed where it was. Distinguishes an intentional bulk call
 * (correctly priced below threshold) from a fail-safe bulk call (the app
 * wasn't sure) and from a hard scan failure — this is what makes the bulk
 * pile searchable/auditable rather than just a black box.
 */
export type DecisionReason = 'above-threshold' | 'below-threshold' | 'low-confidence' | 'scan-error';

export type SessionStatus = 'active' | 'stalled' | 'complete';

/** One row from TCGTracking's /scan results[] array. Not guaranteed to be sorted by score. */
export interface ScanMatch {
  product_id: number;
  score: number;
  name: string;
  number: string;
  printing: string; // unreliable — do not use for variant/pricing decisions, see plan
  set_id: number;
}

export interface ScanResponse {
  success: boolean;
  game_id: number;
  set_ids: number[];
  cropped_image?: string;
  results: ScanMatch[];
}

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
  gameId: number;
  gameName: string;
  setIds: number[];       // empty = unscoped (whole game)
  variant: string;        // e.g. "Normal", "Cold Foil", "Holofoil" — declared by user for the whole run
  condition: string;      // assumed condition for pricing, default "Near Mint"
  thresholdCents: number; // keeper if price >= this
  minScore: number;       // confidence gate
  minGap: number;         // confidence gate: top score - runner-up score
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
  skuId: number | null;
  name: string | null;
  score: number | null;
  runnerUpScore: number | null;
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
  minScore: number;
  minGap: number;
  defaultThresholdCents: number;
  defaultCondition: string;
  captureIntervalMs: number;
  stableFrames: number;
  frameDiffThreshold: number;
  hopperEmptyTimeoutMs: number;
  scanMaxRetries: number;
  scanRetryBackoffMs: number;
  cacheTtlHours: number;
  csvColumns: CsvColumnMapping[];
}
