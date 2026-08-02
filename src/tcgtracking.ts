import { db } from './db';
import { getSettings } from './settings';
import { ProductCacheRow, ProductDetail, ProductSku, ScanMatch, ScanResponse } from './types';

// tcgtracking.com is reachable from a Node server via plain fetch/curl but is blocked for
// browser-based tools in this dev environment — confirmed live during planning. No auth,
// no rate-limit headers observed. Scheduled deprecation ~Sept 30 2026 per TCGTracking's own
// docs, migrating to openapi.tcgtracking.com — if this app breaks after that date, that's why.
const BASE = 'https://tcgtracking.com/tcgapi/v1';

export interface Category {
  id: number;
  name: string;
  display_name: string;
  product_count: number;
  set_count: number;
}

export interface GameSet {
  id: number;
  name: string;
  abbreviation: string | null;
}

export async function fetchCategories(): Promise<Category[]> {
  const res = await fetch(`${BASE}/categories`);
  if (!res.ok) throw new Error(`TCGTracking /categories failed: ${res.status}`);
  const data = await res.json() as { categories: Category[] };
  return data.categories ?? [];
}

export async function fetchSets(gameId: number): Promise<GameSet[]> {
  const res = await fetch(`${BASE}/${gameId}/sets`);
  if (!res.ok) throw new Error(`TCGTracking /${gameId}/sets failed: ${res.status}`);
  const data = await res.json() as { sets?: GameSet[]; results?: GameSet[] };
  return data.sets ?? data.results ?? [];
}

/**
 * Finds one real single card in a set, for sampling its SKU/variant vocabulary on the setup
 * screen. Originally this cross-referenced TCGCSV (see git history / plan doc) because the
 * only by-set endpoints found during planning 404'd — but building against the real API
 * surfaced /{game_id}/sets/{set_id}/cards, which planning missed. `number` (collector number)
 * reliably distinguishes real cards from sealed product/code cards in that response (code
 * cards report rarity:"Code Card" but number:null) — cleaner than a rarity blocklist, and it
 * keeps everything on TCGTracking's own API instead of a second service.
 */
export async function fetchFirstCardProductId(gameId: number, setId: number): Promise<number | null> {
  const res = await fetch(`${BASE}/${gameId}/sets/${setId}/cards`);
  if (!res.ok) throw new Error(`TCGTracking /${gameId}/sets/${setId}/cards failed: ${res.status}`);
  const data = await res.json() as { products: Array<{ id: number; number: string | null }> };
  const card = (data.products ?? []).find((p) => p.number);
  return card?.id ?? null;
}

/**
 * Calls /scan with a card image. IMPORTANT: TCGTracking does NOT sort results by score —
 * observed live as [100, 94, 53, 53, 56] — so callers must never trust results[0] without
 * this sort. `printing` on each match is also unreliable (a Holofoil-only card can report
 * "Normal") and must not be used for pricing; see ProductSku-based pricing in session.ts.
 */
export async function scanImage(gameId: number, imageBuffer: Buffer, setIds: number[]): Promise<ScanMatch[]> {
  const form = new FormData();
  form.set('game_id', String(gameId));
  if (setIds.length > 0) form.set('set_ids', JSON.stringify(setIds));
  form.set('image', new Blob([imageBuffer], { type: 'image/jpeg' }), 'capture.jpg');

  const res = await fetch(`${BASE}/scan`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`TCGTracking /scan failed: ${res.status}`);
  const data = await res.json() as ScanResponse;
  if (!data.success) throw new Error('TCGTracking /scan returned success:false');

  return [...(data.results ?? [])].sort((a, b) => b.score - a.score);
}

/** Retry wrapper around scanImage — 3 attempts w/ backoff by default, per the plan's
 *  "retry then stall" policy (session.ts decides what "stall" means at the session level). */
export async function scanImageWithRetry(gameId: number, imageBuffer: Buffer, setIds: number[]): Promise<ScanMatch[]> {
  const settings = getSettings();
  let lastErr: unknown;
  for (let attempt = 0; attempt < settings.scanMaxRetries; attempt++) {
    try {
      return await scanImage(gameId, imageBuffer, setIds);
    } catch (err) {
      lastErr = err;
      if (attempt < settings.scanMaxRetries - 1) {
        await new Promise((r) => setTimeout(r, settings.scanRetryBackoffMs * (attempt + 1)));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('TCGTracking /scan failed after retries');
}

async function fetchProductDetail(productId: number): Promise<ProductDetail> {
  const res = await fetch(`${BASE}/products/${productId}`);
  if (!res.ok) throw new Error(`TCGTracking /products/${productId} failed: ${res.status}`);
  const data = await res.json() as ProductDetail;
  if (!data.success) throw new Error(`TCGTracking /products/${productId} returned success:false`);
  return data;
}

const selectCached = db.prepare('SELECT * FROM product_cache WHERE product_id = ?');
const upsertCached = db.prepare(`
  INSERT INTO product_cache (product_id, name, set_id, set_name, number, rarity, market_price, image_url, skus_json, fetched_at)
  VALUES (@product_id, @name, @set_id, @set_name, @number, @rarity, @market_price, @image_url, @skus_json, @fetched_at)
  ON CONFLICT(product_id) DO UPDATE SET
    name = excluded.name, set_id = excluded.set_id, set_name = excluded.set_name,
    number = excluded.number, rarity = excluded.rarity, market_price = excluded.market_price,
    image_url = excluded.image_url, skus_json = excluded.skus_json, fetched_at = excluded.fetched_at
`);

/**
 * Cache-aside lookup for a product's SKU/price matrix. There is NO bulk SKU source anywhere
 * (confirmed live: TCGCSV product records have no skus[] key, and TCGTracking has no by-set
 * product listing endpoint) — sku_id and per-variant pricing are only obtainable one product
 * at a time via /products/{id}. So this cache is load-bearing, not an optimization: without
 * it, sorting the same set twice would re-pay the full per-card fetch cost every run. Persists
 * in SQLite (db.ts) specifically so it warms ACROSS runs, not just within one.
 */
export async function getProductCached(productId: number): Promise<{ row: ProductCacheRow; skus: ProductSku[] }> {
  const settings = getSettings();
  const ttlMs = settings.cacheTtlHours * 60 * 60 * 1000;
  const cached = selectCached.get(productId) as ProductCacheRow | undefined;

  if (cached && Date.now() - cached.fetched_at < ttlMs) {
    return { row: cached, skus: JSON.parse(cached.skus_json) as ProductSku[] };
  }

  const detail = await fetchProductDetail(productId);
  const marketPrice = detail.product.market_price === null || detail.product.market_price === undefined
    ? null
    : Number(detail.product.market_price);
  const row: ProductCacheRow = {
    product_id: detail.product_id,
    name: detail.product.name,
    set_id: detail.product.group_id,
    set_name: detail.product.set_name,
    number: detail.product.ext_number,
    rarity: detail.product.ext_rarity,
    market_price: Number.isFinite(marketPrice as number) ? marketPrice : null,
    image_url: detail.product.image_url,
    skus_json: JSON.stringify(detail.skus),
    fetched_at: Date.now(),
  };
  upsertCached.run(row);
  return { row, skus: detail.skus };
}
