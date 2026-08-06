import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// On Railway, DATABASE_PATH points at a mounted volume (e.g. /data/card-sorter.db) so the
// product cache, session history, and bulk-box manifest survive redeploys. This is not
// optional the way it might be for a stateless app: the product cache is what keeps repeat
// runs on the same sets fast (there is no bulk SKU source — see tcgtracking.ts), and the
// bulk-box manifest is only useful if it outlives the process that wrote it.
const DB_PATH = process.env.DATABASE_PATH ?? path.join(__dirname, '..', 'card-sorter.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Runs at import time so the schema exists before any other module's module-level
// db.prepare() calls run — same convention as lorcana-seller-csv/src/db.ts.
db.exec(`
  CREATE TABLE IF NOT EXISTS product_cache (
    product_id   INTEGER PRIMARY KEY,
    name         TEXT NOT NULL,
    set_id       INTEGER NOT NULL,
    set_name     TEXT NOT NULL,
    number       TEXT,
    rarity       TEXT,
    market_price REAL,
    image_url    TEXT,
    skus_json    TEXT NOT NULL,
    fetched_at   INTEGER NOT NULL
  );

  -- TCGCSV-sourced catalog cache — deliberately a SEPARATE table from product_cache above.
  -- product_cache is written by tcgtracking.ts's getProductCached() in TCGTracking's own SKU
  -- shape (skus_json = per-condition/variant SKU matrix, still used narrowly to resolve real
  -- TCGPlayer sku_ids for the CSV export — see types.ts's ProductSku doc). tcgcsv_cache is
  -- written by tcgcsv.ts in TCGCSV's shape (prices_json = per-printing blended market price,
  -- no condition split, no sku_id). Sharing one table between two incompatible schemas keyed
  -- by the same product_id would silently corrupt whichever wrote second — see the plan.
  CREATE TABLE IF NOT EXISTS tcgcsv_cache (
    product_id   INTEGER PRIMARY KEY,
    name         TEXT NOT NULL,
    set_id       INTEGER NOT NULL,
    set_name     TEXT NOT NULL,
    number       TEXT,
    rarity       TEXT,
    image_url    TEXT,
    prices_json  TEXT NOT NULL,
    fetched_at   INTEGER NOT NULL
  );

  -- CLIP embedding per candidate card, keyed by TCGCSV product_id — populated once per
  -- (product, embedding model) and reused across every future session that scopes the same
  -- set, since re-embedding is the compute-expensive step. embedding is JSON.stringify(number[]).
  CREATE TABLE IF NOT EXISTS embedding_cache (
    product_id INTEGER PRIMARY KEY,
    embedding  TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id                 TEXT PRIMARY KEY,
    game_id            INTEGER NOT NULL,
    game_name          TEXT NOT NULL,
    set_ids_json       TEXT NOT NULL,
    variant            TEXT NOT NULL,
    condition          TEXT NOT NULL,
    threshold_cents    INTEGER NOT NULL,
    min_score          INTEGER NOT NULL,
    min_gap            INTEGER NOT NULL,
    location           TEXT NOT NULL,
    status             TEXT NOT NULL,
    current_bulk_box_id INTEGER,
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS bulk_boxes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL REFERENCES sessions(id),
    label       TEXT NOT NULL,
    opened_at   INTEGER NOT NULL,
    card_count  INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_bulk_boxes_session ON bulk_boxes(session_id);

  CREATE TABLE IF NOT EXISTS cards (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id       TEXT NOT NULL REFERENCES sessions(id),
    seq              INTEGER NOT NULL,
    product_id       INTEGER,
    sku_id           INTEGER,
    name             TEXT,
    score            INTEGER,
    runner_up_score  INTEGER,
    price_cents      INTEGER,
    decision         TEXT NOT NULL,
    reason           TEXT NOT NULL,
    bulk_box_id      INTEGER REFERENCES bulk_boxes(id),
    scanned_at       INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_cards_session ON cards(session_id);
  CREATE INDEX IF NOT EXISTS idx_cards_name ON cards(name);
  CREATE INDEX IF NOT EXISTS idx_cards_product ON cards(product_id);

  -- Single-row table: runtime-editable settings (confidence knobs, CSV column mapping, etc).
  -- Seeded from config/settings.json on first boot by settings.ts; overrides persist here so
  -- they survive a redeploy without editing the bundled config file.
  CREATE TABLE IF NOT EXISTS app_settings (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    json       TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);
