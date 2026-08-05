import express from 'express';
import multer from 'multer';
import path from 'path';
import { fetchCategories, fetchSets, fetchFirstCardProductId, getProductCached } from './tcgtracking';
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

// The physical sort only ever covers these 5 TCGs — TCGTracking's /categories returns ~90
// (sleeves, playmats, storage albums, etc. included), which would swamp a one-handed mobile
// picker. IDs (not name matching) so a display-name change on TCGTracking's side can't
// silently drop or add a game; confirmed live via `scripts/calibrate.ts --list-sets` (2026-08-04).
// Order here is the dropdown order.
const ALLOWED_GAME_IDS = [71, 63, 3, 1, 68]; // Disney Lorcana, Digimon Card Game, Pokemon, Magic: The Gathering, One Piece Card Game

app.get('/api/games', async (_req, res) => {
  try {
    const categories = await fetchCategories();
    const allowed = ALLOWED_GAME_IDS.map((id) => categories.find((c) => c.id === id)).filter((c): c is NonNullable<typeof c> => !!c);
    if (allowed.length < ALLOWED_GAME_IDS.length) {
      console.warn(`[games] only resolved ${allowed.length}/${ALLOWED_GAME_IDS.length} allowed game ids — TCGTracking may have renumbered a category`);
    }
    res.json(allowed);
  } catch (err) {
    console.error('[games]', err);
    res.status(502).json({ error: 'Failed to reach TCGTracking.' });
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
    res.status(502).json({ error: 'Failed to reach TCGTracking.' });
  }
});

/** Samples one card from the set to discover its valid variant names (Normal / Holofoil /
 *  Cold Foil / ...) — see plan: no per-game variant table, discovered dynamically. */
app.get('/api/variants', async (req, res) => {
  const gameId = Number(req.query.game_id);
  const setId = Number(req.query.set_id);
  if (!Number.isFinite(gameId) || !Number.isFinite(setId)) {
    res.status(400).json({ error: 'Missing/invalid game_id or set_id query parameter.' });
    return;
  }
  try {
    const productId = await fetchFirstCardProductId(gameId, setId);
    if (!productId) {
      res.status(404).json({ error: 'No cards found in that set.' });
      return;
    }
    const { skus } = await getProductCached(productId);
    const conditions = [...new Set(skus.map((s) => s.condition_name))];
    const variants = [...new Set(skus.map((s) => s.variant_name))];
    res.json({ variants, conditions });
  } catch (err) {
    console.error('[variants]', err);
    res.status(502).json({ error: 'Failed to determine variants for that set.' });
  }
});

// ---- sessions ----

app.post('/api/session', (req, res) => {
  const b = req.body ?? {};
  const settings = getSettings();
  if (!b.gameId || !b.gameName || !b.variant || !b.location) {
    res.status(400).json({ error: 'Body requires gameId, gameName, variant, location.' });
    return;
  }
  const config: SessionConfig = {
    gameId: Number(b.gameId),
    gameName: String(b.gameName),
    setIds: Array.isArray(b.setIds) ? b.setIds.map(Number) : [],
    variant: String(b.variant),
    condition: b.condition ? String(b.condition) : settings.defaultCondition,
    thresholdCents: Number.isFinite(b.thresholdCents) ? Number(b.thresholdCents) : settings.defaultThresholdCents,
    minScore: Number.isFinite(b.minScore) ? Number(b.minScore) : settings.minScore,
    minGap: Number.isFinite(b.minGap) ? Number(b.minGap) : settings.minGap,
    location: String(b.location),
  };
  res.json(createSession(config));
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
