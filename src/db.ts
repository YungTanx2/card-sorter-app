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

  -- ══════════════════════ SET BUILDER MODE ══════════════════════
  -- Deliberately SEPARATE tables from sessions/cards above, not extra columns on them. Set mode
  -- asks a different question of the same capture ("does this advance a set?" vs "is this worth
  -- money?") and shares only the recognition layer — tcgcsv_cache, embedding_cache, and the
  -- confidence knobs in app_settings. Keeping the schemas apart means a bug here cannot break
  -- the price-sorter, and set-mode rows carry no vestigial price/sku/bulk_box columns.

  -- A long-lived set-building target. Scoped to ONE printing (variant) because the recognition
  -- layer structurally cannot tell Normal from Reverse Holofoil — same product_id, same
  -- reference image (see tcgcsv.ts). A true Pokemon master set is therefore 2-3 goals.
  CREATE TABLE IF NOT EXISTS goals (
    id                     TEXT PRIMARY KEY,
    name                   TEXT NOT NULL,
    game_id                INTEGER NOT NULL,
    game_name              TEXT NOT NULL,
    set_ids_json           TEXT NOT NULL,
    variant                TEXT NOT NULL,
    target_copies          INTEGER NOT NULL,   -- 1 = master set, 4 = play set
    excluded_rarities_json TEXT NOT NULL DEFAULT '[]',
    binder_rows            INTEGER NOT NULL DEFAULT 3,
    binder_cols            INTEGER NOT NULL DEFAULT 3,
    status                 TEXT NOT NULL,      -- 'active' | 'complete'
    created_at             INTEGER NOT NULL,
    updated_at             INTEGER NOT NULL
  );

  -- One pile fed through the machine against one goal. Many sessions per goal — a set is built
  -- over weeks, which is exactly why progress cannot live on the session the way keeper/bulk does.
  CREATE TABLE IF NOT EXISTS goal_sessions (
    id         TEXT PRIMARY KEY,
    goal_id    TEXT NOT NULL REFERENCES goals(id),
    dry_run    INTEGER NOT NULL DEFAULT 1,
    status     TEXT NOT NULL,                  -- 'active' | 'stalled' | 'complete'
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_goal_sessions_goal ON goal_sessions(goal_id);

  -- The scan log, and the ONLY source of truth for goal progress — there is deliberately no
  -- owned-count column anywhere. A counter is a cache with no source of truth: a crash, a
  -- deleted session or a bug in the review path desyncs it silently with no way to rebuild.
  --
  -- Two columns are denormalized on purpose:
  --   goal_id            -- so the derived-count query is a single-table GROUP BY, no join
  --   counts_toward_goal -- frozen at insert time from the session's dry_run flag, so toggling
  --                         that flag later cannot retroactively rewrite history. Derived state
  --                         is only safe when its inputs are immutable.
  CREATE TABLE IF NOT EXISTS goal_cards (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_session_id    TEXT NOT NULL REFERENCES goal_sessions(id),
    goal_id            TEXT NOT NULL REFERENCES goals(id),
    seq                INTEGER NOT NULL,
    product_id         INTEGER,
    name               TEXT,
    number             TEXT,
    score              REAL,                   -- cosine similarity in [-1, 1]
    runner_up_score    REAL,
    outcome            TEXT NOT NULL,          -- 'needed' | 'extra'
    reason             TEXT NOT NULL,          -- 'fills-slot' | 'slot-filled' | 'excluded-rarity' | 'low-confidence'
    voided             INTEGER NOT NULL DEFAULT 0,
    counts_toward_goal INTEGER NOT NULL DEFAULT 0,
    thumb_jpeg         BLOB,                   -- accepted cards only — powers the review strip
    scanned_at         INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_goal_cards_goal ON goal_cards(goal_id);
  CREATE INDEX IF NOT EXISTS idx_goal_cards_session ON goal_cards(goal_session_id);
  CREATE INDEX IF NOT EXISTS idx_goal_cards_product ON goal_cards(product_id);

  -- Full UNCROPPED frames kept alongside a scan, so crop geometry can be re-tested offline.
  --
  -- Separate table rather than another BLOB column on goal_cards for two reasons: these are an
  -- order of magnitude larger than thumb_jpeg, and they are calibration data with a different
  -- lifetime from the run itself — deleting them must never touch a card's identity or the goal
  -- progress derived from it.
  --
  -- NOTE: this database does not enable PRAGMA foreign_keys, so the REFERENCES clause below is
  -- documentation, not enforcement — no cascade will fire. deleteGoal() in goals.ts clears these
  -- explicitly, matching how every other child table there is already handled. Since these rows
  -- are by far the largest in the schema, orphaning them would leak the most space of anything.
  --
  -- Written for EVERY outcome, not just accepted cards. The low-confidence extras are the most
  -- informative failures and currently leave no trace at all, which is exactly why we can't
  -- answer "would a different crop have recognised that one".
  CREATE TABLE IF NOT EXISTS capture_samples (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_card_id  INTEGER NOT NULL REFERENCES goal_cards(id),
    frame_jpeg    BLOB NOT NULL,
    frame_w       INTEGER NOT NULL,
    frame_h       INTEGER NOT NULL,
    -- The crop fractions in force when this frame was taken, so an export can reproduce exactly
    -- what production would have sent and use it as the A/B's baseline arm.
    crop_json     TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_capture_samples_card ON capture_samples(goal_card_id);

  -- Manual corrections that aren't tied to a scan — "I already own this one", "I sold that one".
  -- An append-only delta log rather than an editable count, for the same reason as above.
  CREATE TABLE IF NOT EXISTS goal_adjustments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_id    TEXT NOT NULL REFERENCES goals(id),
    product_id INTEGER NOT NULL,
    delta      INTEGER NOT NULL,
    note       TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_goal_adjustments_goal ON goal_adjustments(goal_id);
`);
