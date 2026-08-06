import { db } from './db';
import { getSettings } from './settings';
import { CandidateCard, TCGCSVPrice } from './types';

// TCGCSV.com — free TCGPlayer product/price mirror. Replaces TCGTracking for catalog browsing
// (games/sets/variants) and as the reference-image source for embedding matching, per the plan.
// Ported and generalized from lorcana-seller-csv/src/tcgcsv.ts (categoryId parameterized
// instead of hardcoded to Lorcana). REQUIRES a User-Agent header — confirmed live during
// research (research_tcgcsv-api.md): requests without one get a 401.
const BASE = 'https://tcgcsv.com/tcgplayer';
const HEADERS = { 'User-Agent': 'card-sorter-app/1.0' };

export interface Category {
  id: number;
  name: string;
  displayName: string;
}

export interface GameSet {
  id: number;
  name: string;
  abbreviation: string | null;
}

interface ExtendedDataEntry {
  name: string;
  displayName: string;
  value: string;
}

interface TCGProduct {
  productId: number;
  name: string;
  imageUrl?: string;
  extendedData?: ExtendedDataEntry[];
}

interface RawTCGPrice {
  productId: number;
  subTypeName: string;
  marketPrice: number | null;
  lowPrice: number | null;
}

/** Card number, e.g. "125/207" (Lorcana/Pokemon/Magic) or "OP07-001"/"BT22-043 U" (One
 *  Piece/Digimon — confirmed live for all 5 supported games during planning). Digimon's
 *  trailing rarity-ish suffix (" U") is left as-is here — it doesn't affect number-based
 *  matching since this app matches by embedding similarity, not by parsing the number. */
function extractField(extendedData: ExtendedDataEntry[] | undefined, field: string): string | null {
  return extendedData?.find((e) => e.name === field)?.value?.trim() ?? null;
}

/** Real singles only — a product with a Rarity extendedData entry. Filters out sealed
 *  product, promos, and puzzle-insert filler (confirmed live: those lack Rarity and often
 *  404 on their imageUrl anyway — see prewarmSet's per-image error handling). */
function isSingleCard(p: TCGProduct): boolean {
  return extractField(p.extendedData, 'Rarity') !== null;
}

export async function fetchCategories(): Promise<Category[]> {
  const res = await fetch(`${BASE}/categories`, { headers: HEADERS });
  if (!res.ok) throw new Error(`TCGCSV /categories failed: ${res.status}`);
  const data = (await res.json()) as { results: { categoryId: number; name: string; displayName: string }[] };
  return (data.results ?? []).map((c) => ({ id: c.categoryId, name: c.name, displayName: c.displayName }));
}

export async function fetchSets(categoryId: number): Promise<GameSet[]> {
  const res = await fetch(`${BASE}/${categoryId}/groups`, { headers: HEADERS });
  if (!res.ok) throw new Error(`TCGCSV /${categoryId}/groups failed: ${res.status}`);
  const data = (await res.json()) as { results: { groupId: number; name: string; abbreviation?: string }[] };
  return (data.results ?? []).map((g) => ({ id: g.groupId, name: g.name, abbreviation: g.abbreviation ?? null }));
}

async function fetchProducts(categoryId: number, groupId: number): Promise<TCGProduct[]> {
  const res = await fetch(`${BASE}/${categoryId}/${groupId}/products`, { headers: HEADERS });
  if (!res.ok) throw new Error(`TCGCSV /${categoryId}/${groupId}/products failed: ${res.status}`);
  const data = (await res.json()) as { results: TCGProduct[] };
  return (data.results ?? []).filter((p) => isSingleCard(p) && !!p.imageUrl);
}

async function fetchPrices(categoryId: number, groupId: number): Promise<RawTCGPrice[]> {
  const res = await fetch(`${BASE}/${categoryId}/${groupId}/prices`, { headers: HEADERS });
  if (!res.ok) throw new Error(`TCGCSV /${categoryId}/${groupId}/prices failed: ${res.status}`);
  const data = (await res.json()) as { results: RawTCGPrice[] };
  return data.results ?? [];
}

/** Samples one card's prices to discover its valid variant vocabulary (Normal / Holofoil /
 *  Cold Foil / ...) for the setup screen — no per-game hardcoded table. Unlike TCGTracking's
 *  sku_dimensions (which needed one product fetched to learn this), TCGCSV's /prices already
 *  returns every product's prices for the whole group in one call, so this just reads distinct
 *  subTypeName values off it directly. */
export async function fetchVariants(categoryId: number, groupId: number): Promise<string[]> {
  const prices = await fetchPrices(categoryId, groupId);
  return [...new Set(prices.map((p) => p.subTypeName))];
}

const upsertCatalog = db.prepare(`
  INSERT INTO tcgcsv_cache (product_id, name, set_id, set_name, number, rarity, image_url, prices_json, fetched_at)
  VALUES (@productId, @name, @setId, @setName, @number, @rarity, @imageUrl, @pricesJson, @fetchedAt)
  ON CONFLICT(product_id) DO UPDATE SET
    name = excluded.name, set_id = excluded.set_id, set_name = excluded.set_name,
    number = excluded.number, rarity = excluded.rarity, image_url = excluded.image_url,
    prices_json = excluded.prices_json, fetched_at = excluded.fetched_at
`);
const selectCatalogRow = db.prepare('SELECT * FROM tcgcsv_cache WHERE product_id = ?');

interface CatalogRow {
  product_id: number; name: string; set_id: number; set_name: string;
  number: string | null; rarity: string | null; image_url: string | null;
  prices_json: string; fetched_at: number;
}

/**
 * Bulk pre-warm for one set: fetches the full product+price list in 2 HTTP calls (TCGCSV has
 * no per-card endpoint the way TCGTracking didn't have a per-set one — this is the inverse
 * problem, and the reason product_cache was a *lazy* per-scan cache before is exactly why
 * this one doesn't need to be: everything for the whole set is knowable up front). Writes
 * every candidate into tcgcsv_cache and returns the resolved CandidateCard list session.ts
 * needs to build embeddings and run the matcher against — this is what makes scanCard() do
 * zero network calls during an actual run.
 */
export async function prewarmSet(categoryId: number, groupId: number, groupName: string): Promise<CandidateCard[]> {
  const [products, prices] = await Promise.all([fetchProducts(categoryId, groupId), fetchPrices(categoryId, groupId)]);
  const pricesByProduct = new Map<number, RawTCGPrice[]>();
  for (const p of prices) {
    const list = pricesByProduct.get(p.productId) ?? [];
    list.push(p);
    pricesByProduct.set(p.productId, list);
  }

  const now = Date.now();
  const candidates: CandidateCard[] = [];
  for (const product of products) {
    const number = extractField(product.extendedData, 'Number');
    const rarity = extractField(product.extendedData, 'Rarity');
    const imageUrl = product.imageUrl ?? null;
    upsertCatalog.run({
      productId: product.productId, name: product.name, setId: groupId, setName: groupName,
      number, rarity, imageUrl, pricesJson: JSON.stringify(pricesByProduct.get(product.productId) ?? []), fetchedAt: now,
    });
    candidates.push({ productId: product.productId, name: product.name, number, rarity, imageUrl, setId: groupId, setName: groupName });
  }
  return candidates;
}

export function getCatalogRow(productId: number): CatalogRow | undefined {
  return selectCatalogRow.get(productId) as CatalogRow | undefined;
}

function rowToCandidate(row: CatalogRow): CandidateCard {
  return {
    productId: row.product_id, name: row.name, number: row.number, rarity: row.rarity,
    imageUrl: row.image_url, setId: row.set_id, setName: row.set_name,
  };
}

/** Reads back the pre-warmed candidate list for a session's scoped sets — this is what
 *  session.ts's scanCard() matches a capture against, entirely from the local cache. */
export function getCandidatesForSets(setIds: number[]): CandidateCard[] {
  if (setIds.length === 0) return [];
  const placeholders = setIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM tcgcsv_cache WHERE set_id IN (${placeholders})`).all(...setIds) as CatalogRow[];
  return rows.map(rowToCandidate);
}

export function getPricesForProduct(productId: number): TCGCSVPrice[] {
  const row = getCatalogRow(productId);
  if (!row) return [];
  return (JSON.parse(row.prices_json) as RawTCGPrice[]).map((p) => ({
    subTypeName: p.subTypeName, marketPrice: p.marketPrice, lowPrice: p.lowPrice,
  }));
}

/** True once tcgcsv_cache has data for the set within the settings TTL — used to decide
 *  whether a session create needs to re-pre-warm or can trust the existing cache/embeddings. */
export function isSetFresh(groupId: number): boolean {
  const row = db.prepare('SELECT MIN(fetched_at) as oldest FROM tcgcsv_cache WHERE set_id = ?').get(groupId) as { oldest: number | null };
  if (!row.oldest) return false;
  const ttlMs = getSettings().cacheTtlHours * 60 * 60 * 1000;
  return Date.now() - row.oldest < ttlMs;
}
