import express from 'express';
import multer from 'multer';
import path from 'path';
import { db } from './db';
import { fetchCategories, fetchSets, fetchVariants, fetchRarities, getCandidatesForSets } from './tcgcsv';
import { scoreCandidates } from './embeddings';
import sharp from 'sharp';
import { getSettings, updateSettings } from './settings';
import { StallError } from './errors';
import {
  createSession, getSession, resumeSession, completeSession,
  openBulkBox, getBulkBoxesForSession, getCardsForSession,
  scanCard, searchBulkCards,
} from './session';
import {
  createGoal, getGoal, listGoals, completeGoal, deleteGoal, getGoalProgress, getMissingList, adjustGoal,
  createGoalSession, getGoalSession, listGoalSessions, resumeGoalSession, completeGoalSession,
  saveCaptureSample, getCaptureSamples, getCaptureSampleFrame, fetchRaritySlotCounts,
  scanGoalCard, getGoalCardsForSession, getGoalCardThumb, setGoalCardVoid,
  getReviewStrip, getFilingList,
  getCaptureSampleContext, saveCaptureLabel, CaptureLabelVerdict,
} from './goals';
import { buildKeeperCsv, buildManifestCsv } from './export';
import { GoalConfig, SessionConfig } from './types';

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

// ══════════════════════ SET BUILDER MODE ══════════════════════
// Parallel to the session routes above, sharing only the catalog pickers (/api/games, /api/sets,
// /api/variants) and the upload middleware. See PRDs/card-sorter-set-builder.md.

/** Rarity vocabulary for a set — feeds the "exclude these rarities" picker at goal setup. */
/**
 * Rarity -> how many binder slots it would contribute, summed across every selected set.
 *
 * Distinct from /api/rarities, which returns bare names from the raw product list. This counts
 * through the same printed-number filter slot assignment uses, so the goal-creation preview can
 * state the real consequence of a selection — the trap being that "Exclude rarities" reads as
 * "collect these" and silently builds the exact inverse goal.
 */
app.get('/api/rarity-counts', async (req, res) => {
  const gameId = Number(req.query.game_id);
  const raw = String(req.query.set_ids ?? req.query.set_id ?? '');
  const setIds = raw.split(',').map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (!Number.isFinite(gameId) || setIds.length === 0) {
    res.status(400).json({ error: 'Missing/invalid game_id or set_ids query parameter.' });
    return;
  }
  try {
    res.json(await fetchRaritySlotCounts(gameId, setIds));
  } catch (err) {
    console.error('[rarity-counts]', err);
    res.status(502).json({ error: 'Failed to count rarities for those sets.' });
  }
});

app.get('/api/rarities', async (req, res) => {
  const gameId = Number(req.query.game_id);
  const setId = Number(req.query.set_id);
  if (!Number.isFinite(gameId) || !Number.isFinite(setId)) {
    res.status(400).json({ error: 'Missing/invalid game_id or set_id query parameter.' });
    return;
  }
  try {
    res.json(await fetchRarities(gameId, setId));
  } catch (err) {
    console.error('[rarities]', err);
    res.status(502).json({ error: 'Failed to determine rarities for that set.' });
  }
});

function requireGoal(req: express.Request, res: express.Response) {
  const goal = getGoal(req.params.id);
  if (!goal) {
    res.status(404).json({ error: `Goal ${req.params.id} not found` });
    return null;
  }
  return goal;
}

function requireGoalSession(req: express.Request, res: express.Response) {
  const session = getGoalSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: `Goal session ${req.params.id} not found` });
    return null;
  }
  return session;
}

app.get('/api/goals', (_req, res) => {
  res.json(listGoals());
});

app.post('/api/goals', async (req, res) => {
  const body = req.body as Partial<GoalConfig>;
  if (!body?.gameId || !Array.isArray(body.setIds) || body.setIds.length === 0 || !body.variant) {
    res.status(400).json({ error: 'gameId, at least one setId, and a variant are required.' });
    return;
  }
  try {
    // Like POST /api/session, this pre-warms catalog + embeddings for every scoped set before
    // returning — near-instant on a set either mode has used before, up to ~90s on a new one.
    const goal = await createGoal({
      name: body.name?.trim() || 'Untitled goal',
      gameId: body.gameId,
      gameName: body.gameName ?? String(body.gameId),
      setIds: body.setIds,
      variant: body.variant,
      targetCopies: body.targetCopies ?? 1,
      excludedRarities: body.excludedRarities ?? [],
      binderRows: body.binderRows ?? 3,
      binderCols: body.binderCols ?? 3,
    });
    res.json(goal);
  } catch (err) {
    console.error('[goal-create]', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to create goal.' });
  }
});

app.get('/api/goals/:id', (req, res) => {
  const goal = requireGoal(req, res);
  if (!goal) return;
  res.json({ goal, sessions: listGoalSessions(goal.id) });
});

app.get('/api/goals/:id/progress', (req, res) => {
  if (!requireGoal(req, res)) return;
  res.json(getGoalProgress(req.params.id));
});

app.get('/api/goals/:id/missing', (req, res) => {
  if (!requireGoal(req, res)) return;
  res.json(getMissingList(req.params.id));
});

app.post('/api/goals/:id/adjust', (req, res) => {
  if (!requireGoal(req, res)) return;
  const productId = Number(req.body?.productId);
  const delta = Number(req.body?.delta);
  if (!Number.isFinite(productId) || !Number.isInteger(delta) || delta === 0) {
    res.status(400).json({ error: 'productId and a non-zero integer delta are required.' });
    return;
  }
  try {
    res.json({ productId, owned: adjustGoal(req.params.id, productId, delta, req.body?.note) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Adjustment failed.' });
  }
});

app.post('/api/goals/:id/complete', (req, res) => {
  if (!requireGoal(req, res)) return;
  res.json(completeGoal(req.params.id));
});

app.delete('/api/goals/:id', (req, res) => {
  if (!requireGoal(req, res)) return;
  deleteGoal(req.params.id);
  res.json({ deleted: req.params.id });
});

/** dryRun defaults to TRUE — committing to goal state is opt-in. See goals.ts. */
app.post('/api/goals/:id/session', (req, res) => {
  if (!requireGoal(req, res)) return;
  res.json(createGoalSession(req.params.id, req.body?.dryRun !== false));
});

app.get('/api/goal-session/:id', (req, res) => {
  const session = requireGoalSession(req, res);
  if (!session) return;
  res.json({ session, goal: getGoal(session.goalId), cards: getGoalCardsForSession(session.id) });
});

app.post('/api/goal-session/:id/resume', (req, res) => {
  if (!requireGoalSession(req, res)) return;
  res.json(resumeGoalSession(req.params.id));
});

app.post('/api/goal-session/:id/complete', (req, res) => {
  if (!requireGoalSession(req, res)) return;
  res.json(completeGoalSession(req.params.id));
});

app.post('/api/goal-session/:id/scan',
  // 'fullFrame' is the optional uncropped companion to 'image', sent only while sample
  // collection is on. One request rather than two so the pair can never be associated wrongly.
  upload.fields([{ name: 'image', maxCount: 1 }, { name: 'fullFrame', maxCount: 1 }]),
  async (req, res) => {
  const session = requireGoalSession(req, res);
  if (!session) return;
  const files = req.files as Record<string, Express.Multer.File[]> | undefined;
  const image = files?.image?.[0];
  const fullFrame = files?.fullFrame?.[0];
  if (!image) {
    res.status(400).json({ error: 'No image uploaded (multipart field "image").' });
    return;
  }
  try {
    const result = await scanGoalCard(session.id, image.buffer);
    // After the scan, never before: a sample is only meaningful once there's a card row to hang
    // it on, and a storage failure must not cost us the routing decision.
    if (fullFrame) {
      const w = Number(req.body?.frameW) || 0;
      const h = Number(req.body?.frameH) || 0;
      let crop: unknown = null;
      try { crop = req.body?.crop ? JSON.parse(req.body.crop) : null; } catch { /* keep null */ }
      saveCaptureSample(result.card.id, fullFrame.buffer, w, h, crop);
    }
    res.json(result);
  } catch (err) {
    if (err instanceof StallError) {
      // Same contract as the price-sorter's /scan: 503 tells the frontend to stop arming and
      // show a retry banner rather than guess-routing a card the machine is still holding.
      res.status(503).json({ error: err.message, stalled: true });
      return;
    }
    console.error('[goal-scan]', err);
    res.status(500).json({ error: 'Scan failed.' });
  }
});

/** Calibration export: the stored samples for a run, with the review strip's verdict attached.
 *  Read-only and separate from the run's own endpoints — this is A/B data, not run data. */
app.get('/api/goal-session/:id/samples', (req, res) => {
  if (!requireGoalSession(req, res)) return;
  res.json(getCaptureSamples(req.params.id));
});

/** Mirrors capture.js's cropRectPx()/_triggerCapture() in absolute pixels, clamped so a
 *  degenerate stored crop (a sample from before crop tracking, or a corrupt row) can't produce
 *  a zero-size sharp.extract() and 500 the labelling view. */
function sampleCropRectPx(frameW: number, frameH: number, crop: { left: number; top: number; width: number; height: number } | null) {
  if (!crop) return { left: 0, top: 0, width: frameW, height: frameH };
  const left = Math.max(0, Math.min(frameW - 1, Math.round(crop.left * frameW)));
  const top = Math.max(0, Math.min(frameH - 1, Math.round(crop.top * frameH)));
  const width = Math.max(1, Math.min(frameW - left, Math.round(crop.width * frameW)));
  const height = Math.max(1, Math.min(frameH - top, Math.round(crop.height * frameH)));
  return { left, top, width, height };
}

/**
 * Re-scores a stored full frame against its own goal's candidate pool — the labelling view's
 * "what did recognition actually see" panel. Deliberately re-crops and re-resizes to match
 * capture.js's _triggerCapture() (crop, then cap width at 640) rather than embedding the whole
 * stored frame, so the top-K shown is the SAME input production recognition scored, not an
 * easier full-card view that would make failures look better than they are.
 */
app.get('/api/capture-sample/:id/candidates', async (req, res) => {
  const id = Number(req.params.id);
  const k = Math.min(Math.max(Number(req.query.k) || 8, 1), 24);
  const ctx = getCaptureSampleContext(id);
  if (!ctx) {
    res.status(404).json({ error: 'No sample with that id.' });
    return;
  }
  try {
    const rect = sampleCropRectPx(ctx.frameW, ctx.frameH, ctx.crop);
    const w = Math.min(rect.width, 640);
    const h = Math.max(1, Math.round(w * (rect.height / rect.width)));
    const cropped = await sharp(ctx.frame).extract(rect).resize({ width: w, height: h }).toBuffer();

    const candidates = getCandidatesForSets(ctx.goal.setIds, ctx.goal.variant);
    const scored = await scoreCandidates(cropped, candidates);
    const byId = new Map(candidates.map((c) => [c.productId, c]));

    res.json({
      goalId: ctx.goal.id,
      goalName: ctx.goal.name,
      candidates: scored.slice(0, k).map((s) => {
        const c = byId.get(s.productId);
        return {
          productId: s.productId, score: s.score,
          name: c?.name ?? null, number: c?.number ?? null, imageUrl: c?.imageUrl ?? null,
        };
      }),
    });
  } catch (err) {
    console.error('[capture-sample/candidates]', err);
    res.status(500).json({ error: 'Could not score this sample.' });
  }
});

const LABEL_VERDICTS: CaptureLabelVerdict[] = ['card', 'not-a-card', 'not-in-set'];

/** Records ground truth for one stored frame — see capture_labels' doc in db.ts. Idempotent:
 *  re-labelling the same sample overwrites rather than accumulating (the labelling view's Undo
 *  is just calling this again with a different verdict). */
app.post('/api/capture-sample/:id/label', (req, res) => {
  const id = Number(req.params.id);
  const verdict = req.body?.verdict as CaptureLabelVerdict;
  if (!LABEL_VERDICTS.includes(verdict)) {
    res.status(400).json({ error: `verdict must be one of: ${LABEL_VERDICTS.join(', ')}` });
    return;
  }
  const productId = verdict === 'card' ? Number(req.body?.productId) : null;
  if (verdict === 'card' && !Number.isFinite(productId)) {
    res.status(400).json({ error: 'productId is required when verdict is "card".' });
    return;
  }
  saveCaptureLabel(id, verdict, productId);
  res.json({ ok: true });
});

app.get('/api/capture-sample/:id/frame', (req, res) => {
  const frame = getCaptureSampleFrame(Number(req.params.id));
  if (!frame) {
    res.status(404).json({ error: 'No sample frame with that id.' });
    return;
  }
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.send(frame);
});

app.get('/api/goal-session/:id/filing-list', (req, res) => {
  if (!requireGoalSession(req, res)) return;
  res.json(getFilingList(req.params.id));
});

app.get('/api/goal-session/:id/review', (req, res) => {
  if (!requireGoalSession(req, res)) return;
  res.json(getReviewStrip(req.params.id));
});

app.get('/api/goal-card/:id/thumb', (req, res) => {
  const thumb = getGoalCardThumb(Number(req.params.id));
  if (!thumb) {
    res.status(404).json({ error: 'No thumbnail stored for that card.' });
    return;
  }
  res.setHeader('Content-Type', 'image/jpeg');
  // Thumbnails are immutable once written — a card row's capture never changes.
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.send(thumb);
});

app.post('/api/goal-card/:id/void', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'Invalid card id.' });
    return;
  }
  try {
    res.json(setGoalCardVoid(id, req.body?.voided !== false));
  } catch (err) {
    res.status(404).json({ error: 'Card not found.' });
  }
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

const server = app.listen(PORT, () => {
  console.log(`card-sorter-app listening on port ${PORT}`);
});

/**
 * Graceful shutdown. Railway sends SIGTERM whenever a container is replaced, which is every
 * single deploy — without a handler, Node dies by signal and the platform reports an ordinary
 * handover as a crashed deployment. (Worse before this change: the start command wrapped the
 * app in `npm start`, and npm turns its child's SIGTERM into `npm error signal SIGTERM` plus a
 * non-zero exit, so a clean stop was indistinguishable from a real failure — see railway.json.)
 *
 * Closing the database is the part that actually matters, not just the exit code: better-sqlite3
 * runs in WAL mode (db.ts), and an abrupt kill leaves the write-ahead log un-checkpointed.
 * SQLite recovers on next open, but now that a mounted volume holds Set Builder goal progress —
 * the first state in this app that can't be refetched from an API — checkpointing on the way out
 * is worth the few lines.
 */
let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received — closing server and database`);
  server.close(() => {
    try {
      db.close(); // checkpoints the WAL
    } catch (err) {
      console.warn('[shutdown] db close failed:', err instanceof Error ? err.message : err);
    }
    process.exit(0);
  });
  // Don't let an in-flight scan (embedding a capture can take a second or two) hold the
  // container open past the platform's grace period — exit anyway rather than be SIGKILLed,
  // which would skip the checkpoint entirely.
  setTimeout(() => {
    console.warn('[shutdown] forced exit after grace period');
    process.exit(0);
  }, 8000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
