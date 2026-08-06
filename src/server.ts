import express from 'express';
import multer from 'multer';
import path from 'path';
import { fetchCategories, fetchSets, fetchVariants } from './tcgcsv';
import { getSettings, updateSettings } from './settings';
import {
  createSession, getSession, resumeSession, completeSession,
  openBulkBox, getBulkBoxesForSession, getCardsForSession,
  scanCard, StallError, searchBulkCards,
} from './session';
import { buildKeeperCsv, buildManifestCsv } from './export';
import { SessionConfig } from './types';

const app = express();
const PORT = process.env.PORT ?? 3010;
// Captures are downscaled client-side to stay under TCGTracking's 100KB decoded image cap
// (see plan) — 2MB is generous headroom, not a real expected size.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

function requireSession(req: express.Request, res: express.Response) {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: `Session ${req.params.id} not found` });
    return null;
  }
  return session;
}

// ---- catalog browsing (game/set/variant pickers on the setup screen) ----

// The physical sort only ever covers these 5 TCGs — TCGCSV's /categories returns ~90
// (sleeves, playmats, storage albums, etc. included), which would swamp a one-handed mobile
// picker. IDs (not name matching) so a display-name change on TCGCSV's side can't silently
// drop or add a game; confirmed live via `scripts/calibrate.ts --list-sets` (2026-08-04) —
// TCGCSV and TCGTracking use the same TCGPlayer categoryId numbering. Order here is the
// dropdown order.
const ALLOWED_GAME_IDS = [71, 63, 3, 1, 68]; // Disney Lorcana, Digimon Card Game, Pokemon, Magic: The Gathering, One Piece Card Game

// TCGCSV's free API has no per-card condition data (its prices are a blended market rate per
// printing, not split by condition — see types.ts's TCGCSVPrice doc). Condition is now purely
// a label stamped onto the CSV export, not something the API can discover — standard
// TCGPlayer condition set, in the order sellers usually see them.
const STANDARD_CONDITIONS = ['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged'];

app.get('/api/games', async (_req, res) => {
  try {
    const categories = await fetchCategories();
    const allowed = ALLOWED_GAME_IDS.map((id) => categories.find((c) => c.id === id)).filter((c): c is NonNullable<typeof c> => !!c);
    if (allowed.length < ALLOWED_GAME_IDS.length) {
      console.warn(`[games] only resolved ${allowed.length}/${ALLOWED_GAME_IDS.length} allowed game ids — TCGCSV may have renumbered a category`);
    }
    res.json(allowed);
  } catch (err) {
    console.error('[games]', err);
    res.status(502).json({ error: 'Failed to reach TCGCSV.' });
  }
});

app.get('/api/sets', async (req, res) => {
  const gameId = Number(req.query.game_id);
  if (!Number.isFinite(gameId)) {
    res.status(400).json({ error: 'Missing/invalid game_id query parameter.' });
    return;
  }
  try {
    res.json(await fetchSets(gameId));
  } catch (err) {
    console.error('[sets]', err);
    res.status(502).json({ error: 'Failed to reach TCGCSV.' });
  }
});

/** Discovers valid variant names (Normal / Holofoil / Cold Foil / ...) for a set — TCGCSV's
 *  /prices already returns every product's prices for the whole group in one call, so unlike
 *  the old TCGTracking approach (sample one real card via a separate endpoint), this just
 *  reads distinct subTypeName values directly. See plan: no per-game variant table. */
app.get('/api/variants', async (req, res) => {
  const gameId = Number(req.query.game_id);
  const setId = Number(req.query.set_id);
  if (!Number.isFinite(gameId) || !Number.isFinite(setId)) {
    res.status(400).json({ error: 'Missing/invalid game_id or set_id query parameter.' });
    return;
  }
  try {
    const variants = await fetchVariants(gameId, setId);
    if (variants.length === 0) {
      res.status(404).json({ error: 'No priced cards found in that set.' });
      return;
    }
    res.json({ variants, conditions: STANDARD_CONDITIONS });
  } catch (err) {
    console.error('[variants]', err);
    res.status(502).json({ error: 'Failed to determine variants for that set.' });
  }
});

// ---- sessions ----

app.post('/api/session', async (req, res) => {
  const b = req.body ?? {};
  const settings = getSettings();
  const setIds = Array.isArray(b.setIds) ? b.setIds.map(Number) : [];
  if (!b.gameId || !b.gameName || !b.variant || !b.location) {
    res.status(400).json({ error: 'Body requires gameId, gameName, variant, location.' });
    return;
  }
  if (setIds.length === 0) {
    // Set selection is required now, not optional — the embedding matcher scores a capture
    // against every candidate in scope, so an unbounded (whole-game) session would mean
    // matching against the entire catalog, the same unscoped search that made TCGTracking's
    // (broken-scoping) /scan unreliable in the first place. See plan.
    res.status(400).json({ error: 'At least one set must be selected.' });
    return;
  }
  const config: SessionConfig = {
    gameId: Number(b.gameId),
    gameName: String(b.gameName),
    setIds,
    variant: String(b.variant),
    condition: b.condition ? String(b.condition) : settings.defaultCondition,
    thresholdCents: Number.isFinite(b.thresholdCents) ? Number(b.thresholdCents) : settings.defaultThresholdCents,
    minScore: Number.isFinite(b.minScore) ? Number(b.minScore) : settings.minScore,
    minGap: Number.isFinite(b.minGap) ? Number(b.minGap) : settings.minGap,
    location: String(b.location),
  };
  try {
    // Pre-warms the catalog + embeddings for every selected set (see session.ts) — can take
    // real time the first time a set is used (fetching + embedding every candidate), which is
    // why this is a real try/catch here rather than a fire-and-forget: a slow-but-working first
    // run on a new set is fine, a silently-hung request is not.
    res.json(await createSession(config));
  } catch (err) {
    console.error('[session/create]', err);
    res.status(502).json({ error: err instanceof Error ? err.message : 'Failed to prepare the selected set(s) — check the connection and try again.' });
  }
});

app.get('/api/session/:id', (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  res.json({
    session,
    cards: getCardsForSession(session.id),
    bulkBoxes: getBulkBoxesForSession(session.id),
  });
});

app.post('/api/session/:id/resume', (req, res) => {
  if (!requireSession(req, res)) return;
  res.json(resumeSession(req.params.id));
});

app.post('/api/session/:id/complete', (req, res) => {
  if (!requireSession(req, res)) return;
  res.json(completeSession(req.params.id));
});

app.post('/api/session/:id/bulk-box', (req, res) => {
  if (!requireSession(req, res)) return;
  res.json(openBulkBox(req.params.id, req.body?.label));
});

app.post('/api/session/:id/scan', upload.single('image'), async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  if (!req.file) {
    res.status(400).json({ error: 'No image uploaded (multipart field "image").' });
    return;
  }
  try {
    const result = await scanCard(session.id, req.file.buffer);
    res.json(result);
  } catch (err) {
    if (err instanceof StallError) {
      // 503 signals the frontend to stop arming for the next card and show a retry banner —
      // the X1PRO is holding the card, waiting for a tone we're deliberately not sending
      // (plan Decision #12: never guess-route on a hard scan failure).
      res.status(503).json({ error: err.message, stalled: true });
      return;
    }
    console.error('[scan]', err);
    res.status(500).json({ error: 'Scan failed.' });
  }
});

app.get('/api/session/:id/export.csv', (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  // Rows excluded from the CSV (see export.ts) aren't surfaced here — HTTP header values
  // reject non-Latin1 characters (an em-dash in the reason string triggered ERR_INVALID_CHAR
  // in testing), and a file-download response is the wrong place to smuggle JSON regardless.
  // The frontend instead re-derives the same list from GET /api/session/:id's cards[].
  const { csv } = buildKeeperCsv(session);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="keepers-${session.id}.csv"`);
  res.send(csv);
});

app.get('/api/session/:id/manifest.csv', (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="manifest-${session.id}.csv"`);
  res.send(buildManifestCsv(session));
});

// ---- cross-session bulk search ----

app.get('/api/search', (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) {
    res.status(400).json({ error: 'Missing required "q" query parameter.' });
    return;
  }
  res.json(searchBulkCards(q));
});

// ---- settings ----

app.get('/api/settings', (_req, res) => {
  res.json(getSettings());
});

app.put('/api/settings', (req, res) => {
  res.json(updateSettings(req.body ?? {}));
});

app.listen(PORT, () => {
  console.log(`card-sorter-app listening on port ${PORT}`);
});
