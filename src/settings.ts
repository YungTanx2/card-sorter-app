import fs from 'fs';
import path from 'path';
import { db } from './db';
import { AppSettings } from './types';

// Bundled defaults — a fresh checkout / fresh deploy always has sane values even before
// app_settings has a row. config/settings.json also documents, in one readable place, the
// exact shape editable via PUT /api/settings (e.g. csvColumns, whose real TCGTracking-side
// contract is undocumented and may need hand-tuning per plan Decision #8).
const DEFAULTS_PATH = path.join(__dirname, '..', 'config', 'settings.json');
const bundledDefaults: AppSettings = JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf-8'));

/**
 * The settings that belong to a GAME rather than to the rig.
 *
 * Recognition thresholds are tuned against one game's cards (Lorcana's minGap came from Lorcana
 * runs; 121 cream-and-ink Zeta cards will want their own), and run defaults are per game by
 * nature. Everything else — capture timing, the calibrated crop, the empty-platform baseline,
 * sound, CSV columns — describes the physical rig and the phone, which do not change when the
 * pile does, so those stay shared.
 */
export const GAME_SCOPED_KEYS = [
  'minScore', 'minGap', 'minCardScore', 'ocrEnabled', 'ocrMinSim', 'ocrMinTitleChars',
  'straightenEnabled', 'defaultThresholdCents', 'defaultCondition',
] as const;
type GameScopedKey = typeof GAME_SCOPED_KEYS[number];
const isGameScoped = (k: string): k is GameScopedKey => (GAME_SCOPED_KEYS as readonly string[]).includes(k);

/**
 * Games that keep their own copy of the scoped settings. Lorcana is deliberately NOT listed: it
 * owns the top-level values, so every saved Lorcana tuning stays exactly where it already is and
 * nothing about a Lorcana run changes. Other games (Pokemon, One Piece...) share Lorcana's.
 */
const PROFILED_GAMES = new Set(Object.keys(bundledDefaults.gameOverrides ?? {}).map(Number));

const selectRow = db.prepare('SELECT json FROM app_settings WHERE id = 1');
const upsertRow = db.prepare(`
  INSERT INTO app_settings (id, json, updated_at) VALUES (1, ?, ?)
  ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at
`);

let cache: AppSettings | null = null;

/** The stored settings, before any game is applied. */
function getStored(): AppSettings {
  if (cache) return cache;
  const row = selectRow.get() as { json: string } | undefined;
  const saved = row ? JSON.parse(row.json) as Partial<AppSettings> : {};
  // gameOverrides is merged per game and per key, not replaced wholesale like every other
  // setting. A saved row predating Magic has no gameOverrides at all, and a whole-key spread would
  // be fine for that; but once ONE Magic value is saved, a wholesale replace would silently drop
  // every bundled Magic default the user never touched — the same saved-row shadowing trap that
  // has bitten this project twice, aimed at the new key.
  const overrides: Record<string, Partial<AppSettings>> = {};
  for (const src of [bundledDefaults.gameOverrides ?? {}, saved.gameOverrides ?? {}]) {
    for (const [g, o] of Object.entries(src)) overrides[g] = { ...overrides[g], ...o };
  }
  cache = { ...bundledDefaults, ...saved, gameOverrides: overrides };
  return cache;
}

/**
 * The settings a run of `gameId` should use: the shared values with that game's own on top.
 * Called without a game (or for a game with no profile) it returns the top-level values, which
 * are Lorcana's.
 */
export function getSettings(gameId?: number | null): AppSettings {
  const stored = getStored();
  const own = gameId != null ? stored.gameOverrides[String(gameId)] : undefined;
  return own ? { ...stored, ...own } : stored;
}

/** What GET /api/settings returns: one game's effective values, without the override map — the
 *  browser edits one game at a time, and never seeing the map means a page that PUTs back the
 *  whole object it was given cannot clobber another game's values. */
export function getPublicSettings(gameId?: number | null): Omit<AppSettings, 'gameOverrides'> {
  const { gameOverrides: _omit, ...rest } = getSettings(gameId);
  return rest;
}

/**
 * Checks a PUT /api/settings body before it is merged. Returns an error message, or null if the
 * patch is fine. Every key must be one config/settings.json defines, and each value must have the
 * same type as its bundled default: a typo'd key or a number sent as "" would otherwise be stored
 * silently and only show up as odd behaviour mid-run. Keys whose default is null (the Calibrate
 * baseline) take anything.
 */
export function validateSettingsPatch(patch: unknown): string | null {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return 'Settings must be a JSON object.';
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'gameOverrides') return 'Per-game settings are saved with ?game_id=, not as "gameOverrides".';
    if (!(key in bundledDefaults)) return `Unknown setting "${key}".`;
    const def = (bundledDefaults as unknown as Record<string, unknown>)[key];
    if (def === null) continue;
    if (typeof def === 'number' && !(typeof value === 'number' && Number.isFinite(value))) return `"${key}" must be a number.`;
    if (typeof def === 'boolean' && typeof value !== 'boolean') return `"${key}" must be true or false.`;
    if (typeof def === 'string' && typeof value !== 'string') return `"${key}" must be text.`;
    if (Array.isArray(def) && !Array.isArray(value)) return `"${key}" must be a list.`;
  }
  return null;
}

/**
 * Saves a patch. For a game with its own profile, the game-scoped keys go to that game's
 * overrides and the rest to the shared values; for any other game (or none) everything is shared.
 */
export function updateSettings(patch: Partial<AppSettings>, gameId?: number | null): AppSettings {
  const stored = getStored();
  const shared: Record<string, unknown> = {};
  const own: Record<string, unknown> = {};
  const profiled = gameId != null && PROFILED_GAMES.has(gameId);
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'gameOverrides') continue;
    if (profiled && isGameScoped(k)) own[k] = v; else shared[k] = v;
  }
  const gameOverrides = { ...stored.gameOverrides };
  if (profiled && Object.keys(own).length) {
    gameOverrides[String(gameId)] = { ...gameOverrides[String(gameId)], ...own };
  }
  const merged: AppSettings = { ...stored, ...shared, gameOverrides };
  upsertRow.run(JSON.stringify(merged), Date.now());
  cache = merged;
  return getSettings(gameId);
}
