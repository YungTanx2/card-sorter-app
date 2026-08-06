import { db } from './db';
import { getSettings } from './settings';
import { ProductCacheRow, ProductDetail, ProductSku } from './types';

// tcgtracking.com is reachable from a Node server via plain fetch/curl but is blocked for
// browser-based tools in this dev environment — confirmed live during planning. No auth,
// no rate-limit headers observed. Scheduled deprecation ~Sept 30 2026 per TCGTracking's own
// docs, migrating to openapi.tcgtracking.com — if this app breaks after that date, that's why.
//
// Trimmed down (2026-08-05, see the recognition-layer-rewrite plan) to the ONE thing this
// module still does: resolve a real TCGPlayer sku_id for a confirmed keeper, via /products/{id}.
// Everything else that used to live here — catalog browsing (/categories, /sets) and card
// recognition (/scan) — has moved to tcgcsv.ts (catalog) and embeddings.ts (recognition),
// because live testing proved /scan's set_ids scoping doesn't work and its results only ever
// draw from a 5-candidate window of the whole unscoped catalog. TCGCSV's free API has no
// real sku_id, though (only productId) — that's the one thing left that only TCGTracking has.
const BASE = 'https://tcgtracking.com/tcgapi/v1';

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
 * Cache-aside lookup for a product's real SKU matrix (the only remaining reason this file
 * exists — see the module doc above). Called once per confirmed keeper, not per scan, so the
 * caching here matters less than it used to, but still avoids re-fetching on repeat cards
 * within the same set across sessions.
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
