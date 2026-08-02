import { db } from './db';
import { getSettings } from './settings';
import { stringifyCsvRow } from './csv';
import { Session } from './types';

interface KeeperRow {
  seq: number;
  sku_id: number | null;
  name: string | null;
  price_cents: number | null;
  number: string | null;
  rarity: string | null;
  set_name: string | null;
  image_url: string | null;
}

/** Fields available to a CsvColumnMapping's `field` string. Keep in sync with the lookup
 *  in fieldValue() below — this is the full vocabulary the configurable column mapping
 *  (plan Decision #8) can address. */
interface ExportFieldValues {
  skuId: number | null;
  productLine: string;
  setName: string | null;
  productName: string | null;
  number: string | null;
  rarity: string | null;
  condition: string;
  marketPrice: string;
  lowPrice: string;
  quantity: number;
  photoUrl: string | null;
  location: string;
}

function fieldValue(values: ExportFieldValues, field: string): string | number | null {
  switch (field) {
    case '': return '';
    case 'skuId': return values.skuId;
    case 'productLine': return values.productLine;
    case 'setName': return values.setName;
    case 'productName': return values.productName;
    case 'number': return values.number;
    case 'rarity': return values.rarity;
    case 'condition': return values.condition;
    case 'marketPrice': return values.marketPrice;
    case 'lowPrice': return values.lowPrice;
    case 'quantity': return values.quantity;
    case 'photoUrl': return values.photoUrl;
    case 'location': return values.location;
    default: return '';
  }
}

export interface ExcludedKeeper {
  seq: number;
  name: string | null;
  reason: string;
}

/**
 * Builds the keeper import CSV. Column set is fully configurable via settings.csvColumns
 * (config/settings.json, editable through GET/PUT /api/settings) because TCGTracking's CSV
 * import contract is undocumented (per the user's own testing, it can define a location, but
 * the exact column names/order are unverified) — default mapping mirrors a real TCGPlayer
 * Seller Portal "Pricing" export header plus a trailing Location column, adjust in settings
 * once the real import screen is in front of you.
 *
 * One row per physical card scanned (not de-duplicated/summed by SKU) — each row is
 * Add to Quantity=1, so N copies of the same card produce N rows. Simpler and more literal
 * than aggregating, and avoids silently hiding a mis-scan inside a summed count.
 *
 * Keepers with no sku_id are EXCLUDED from the CSV body, not emitted with a blank id — this
 * happens routinely, not as an edge case: a run declared "Normal" (per plan Decision #4) will
 * still turn up ex/full-art cards that only exist as Holofoil, priced correctly via fallback
 * in session.ts but with no matching (declared variant, condition) SKU. A broken/blank
 * TCGplayer Id would silently corrupt an import; reporting it (same pattern as
 * lorcana-seller-csv's ExcludedCard) lets you fix those rows by hand instead.
 */
export function buildKeeperCsv(session: Session): { csv: string; excluded: ExcludedKeeper[] } {
  const settings = getSettings();
  const rows = db.prepare(`
    SELECT c.seq, c.sku_id, c.name, c.price_cents,
           p.number, p.rarity, p.set_name, p.image_url
    FROM cards c
    LEFT JOIN product_cache p ON p.product_id = c.product_id
    WHERE c.session_id = ? AND c.decision = 'keeper'
    ORDER BY c.seq
  `).all(session.id) as KeeperRow[];

  const header = settings.csvColumns.map((c) => c.header);
  const lines = [stringifyCsvRow(header)];
  const excluded: ExcludedKeeper[] = [];

  for (const row of rows) {
    if (row.sku_id === null) {
      excluded.push({ seq: row.seq, name: row.name, reason: `no SKU for the declared variant "${session.variant}" — likely only exists as a different printing` });
      continue;
    }
    const price = row.price_cents !== null ? (row.price_cents / 100).toFixed(2) : '';
    const values: ExportFieldValues = {
      skuId: row.sku_id,
      productLine: session.gameName,
      setName: row.set_name,
      productName: row.name,
      number: row.number,
      rarity: row.rarity,
      condition: session.condition,
      marketPrice: price,
      lowPrice: '', // per-SKU lowest_price isn't cached (see ProductSku) — left blank rather than guessed
      quantity: 1,
      photoUrl: row.image_url,
      location: session.location,
    };
    lines.push(stringifyCsvRow(settings.csvColumns.map((c) => fieldValue(values, c.field))));
  }

  return { csv: lines.join('\r\n') + '\r\n', excluded };
}

interface ManifestRow {
  seq: number; name: string | null; decision: string; reason: string;
  score: number | null; runner_up_score: number | null; price_cents: number | null;
  bulk_box_label: string | null; scanned_at: number;
}

/**
 * Full session log — both piles, every reason code. Not an import file (fixed columns, not
 * configurable) — this is the audit trail that makes the bulk pile searchable/reviewable and
 * is what you'd use to calibrate minScore/minGap after a dry run (plan Decision #9).
 */
export function buildManifestCsv(session: Session): string {
  const rows = db.prepare(`
    SELECT c.seq, c.name, c.decision, c.reason, c.score, c.runner_up_score, c.price_cents,
           b.label as bulk_box_label, c.scanned_at
    FROM cards c
    LEFT JOIN bulk_boxes b ON b.id = c.bulk_box_id
    WHERE c.session_id = ?
    ORDER BY c.seq
  `).all(session.id) as ManifestRow[];

  const header = ['Seq', 'Name', 'Decision', 'Reason', 'Score', 'Runner-Up Score', 'Price', 'Bulk Box', 'Scanned At'];
  const lines = [stringifyCsvRow(header)];

  for (const row of rows) {
    lines.push(stringifyCsvRow([
      row.seq,
      row.name ?? '(unrecognized)',
      row.decision,
      row.reason,
      row.score,
      row.runner_up_score,
      row.price_cents !== null ? (row.price_cents / 100).toFixed(2) : '',
      row.bulk_box_label ?? '',
      new Date(row.scanned_at).toISOString(),
    ]));
  }

  return lines.join('\r\n') + '\r\n';
}
