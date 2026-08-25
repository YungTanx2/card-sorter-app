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

  -- CLIP embedding per (candidate card, model, variant), reused across every future session that
  -- scopes the same set, since re-embedding is the compute-expensive step. embedding is
  -- JSON.stringify(number[]).
  --
  -- The key is a COMPOSITE for two reasons, both of which were silent-corruption bugs when the
  -- key was product_id alone (its comment claimed "per (product, embedding model)" while the
  -- schema enforced no such thing):
  --
  --   model_id  Swapping embedding models would score new query vectors against old candidate
  --             vectors from a different model. Cosine similarity between two unrelated vector
  --             spaces returns a number, not an error, so every match would be garbage with
  --             nothing anywhere reporting a problem.
  --   variant   A card can need MORE THAN ONE embedding. Lorcana Location cards are printed with
  --             landscape artwork but fed through the machine portrait like every other card, so
  --             their TCGCSV reference image (200x143) is rotated 90 degrees relative to every
  --             capture of them. Measured on the 2026-08-24 corpus: all 3 Location frames ranked
  --             207th, 159th and 34th of 217 — worse than chance, and the source of the only
  --             silent misroute in 57 labelled cards. The fix is to ALSO store rotated variants
  --             and match against whichever scores best, which needs room for several rows per
  --             product. 'base' is the reference image as TCGCSV serves it.
  CREATE TABLE IF NOT EXISTS embedding_cache (
    product_id INTEGER NOT NULL,
    model_id   TEXT NOT NULL,
    variant    TEXT NOT NULL,
    embedding  TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (product_id, model_id, variant)
  );

  -- Whether a candidate's TCGCSV reference art is landscape, so embeddings.ts knows if it needs
  -- rotated variants (see embedding_cache's comment) WITHOUT re-downloading the image to look.
  --
  -- This exists purely to make the rotation backfill idempotent and cheap. Without it, the
  -- "does this product need rotations?" check has to fetch the image every time, which turns
  -- every session/goal creation into a re-download of the whole set's reference art — ~261
  -- images for one Lorcana set, on every single run, forever. With it, that cost is paid once.
  CREATE TABLE IF NOT EXISTS reference_meta (
    product_id   INTEGER PRIMARY KEY,
    is_landscape INTEGER NOT NULL,
    checked_at   INTEGER NOT NULL
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
    -- The runner-up's IDENTITY, not just its distance. Without this, a low-confidence row says
    -- "something scored within minGap of the winner" but never what, so the single most common
    -- cause (two catalog products that are the same card — a foil printing split into its own
    -- productId) is invisible in the manifest and can only be inferred offline.
    runner_up_product_id INTEGER,
    runner_up_name   TEXT,
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
    runner_up_product_id INTEGER,              -- see the cards table for why identity is kept
    runner_up_name     TEXT,
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

  -- Ground truth for capture_samples, entered through the labelling view (public/labels.html).
  --
  -- Why this can't just reuse the review strip's verdict (goal_cards.voided): the review strip
  -- only shows 'needed' outcomes, so it has an opinion on roughly half the samples and none at
  -- all on 'low-confidence' extras — precisely the failures a recognition A/B most needs ground
  -- truth for. scripts/export-samples.ts's OLD labelled rule (!voided && outcome === 'needed')
  -- could therefore only ever measure successes: a change that "rescues" a low-confidence frame
  -- to the WRONG card would score as a pure win, because nothing recorded what it actually was.
  --
  -- One row per sample (capture_sample_id is the primary key, not a separate id) — labelling is
  -- meant to converge to a single verdict, and a second pass overwrites rather than accumulating.
  -- verdict: 'card' (product_id is the true identity) | 'not-a-card' (nothing there — hand,
  -- platform, packaging) | 'not-in-set' (a real card, but not one of this goal's candidates —
  -- still a valid frame for testing whether recognition correctly abstains on it).
  CREATE TABLE IF NOT EXISTS capture_labels (
    capture_sample_id INTEGER PRIMARY KEY REFERENCES capture_samples(id),
    verdict           TEXT NOT NULL,
    product_id        INTEGER,
    labelled_at       INTEGER NOT NULL
  );

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

/**
 * Idempotent column adds, for databases that already exist.
 *
 * CREATE TABLE IF NOT EXISTS above only shapes a FRESH database — it is a no-op against a
 * volume that already holds a table, so a column added to the DDL never reaches production.
 * On Railway the volume outlives every deploy, which means the schema block above describes
 * what a new install gets and this block is what actually migrates the running one. Any new
 * column must be added in BOTH places or the two diverge silently.
 *
 * SQLite's ALTER TABLE ADD COLUMN is cheap (metadata only, no table rewrite) and existing rows
 * get NULL, which is the honest value here: those scans genuinely did not record a runner-up.
 */
function addColumn(table: string, column: string, decl: string): void {
  const cols = db.prepare('SELECT name FROM pragma_table_info(?)').all(table) as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  console.log(`[db] migrated: added ${table}.${column}`);
}

addColumn('cards', 'runner_up_product_id', 'INTEGER');
addColumn('cards', 'runner_up_name', 'TEXT');
addColumn('goal_cards', 'runner_up_product_id', 'INTEGER');
addColumn('goal_cards', 'runner_up_name', 'TEXT');

/**
 * embedding_cache: product_id PRIMARY KEY -> (product_id, model_id, variant) PRIMARY KEY.
 *
 * SQLite cannot ALTER a primary key, so this is the standard create-copy-swap. Wrapped in a
 * transaction because a half-finished swap would leave the app with no embedding cache at all —
 * recoverable (it would just re-embed) but a slow, confusing first run on every set.
 *
 * Existing rows are PRESERVED rather than dropped: they are genuine CLIP ViT-B/32 embeddings of
 * the base reference image, which is exactly what ('Xenova/clip-vit-base-patch32', 'base') means
 * under the new key. Re-embedding a whole catalog costs ~90s per set, so throwing them away would
 * be a real cost for no benefit.
 */
function migrateEmbeddingCacheKey(): void {
  const cols = db.prepare('SELECT name FROM pragma_table_info(?)').all('embedding_cache') as { name: string }[];
  if (cols.length === 0 || cols.some((c) => c.name === 'model_id')) return; // fresh DB, or already migrated

  const LEGACY_MODEL = 'Xenova/clip-vit-base-patch32';
  db.transaction(() => {
    db.exec('ALTER TABLE embedding_cache RENAME TO embedding_cache_legacy');
    db.exec(`
      CREATE TABLE embedding_cache (
        product_id INTEGER NOT NULL,
        model_id   TEXT NOT NULL,
        variant    TEXT NOT NULL,
        embedding  TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        PRIMARY KEY (product_id, model_id, variant)
      )
    `);
    db.prepare(`
      INSERT INTO embedding_cache (product_id, model_id, variant, embedding, fetched_at)
      SELECT product_id, ?, 'base', embedding, fetched_at FROM embedding_cache_legacy
    `).run(LEGACY_MODEL);
    db.exec('DROP TABLE embedding_cache_legacy');
  })();

  const n = (db.prepare('SELECT COUNT(*) AS n FROM embedding_cache').get() as { n: number }).n;
  console.log(`[db] migrated: embedding_cache re-keyed to (product_id, model_id, variant); ${n} rows carried over as ${LEGACY_MODEL}/base`);
}
migrateEmbeddingCacheKey();
