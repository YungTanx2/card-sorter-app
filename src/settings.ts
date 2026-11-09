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

const selectRow = db.prepare('SELECT json FROM app_settings WHERE id = 1');
const upsertRow = db.prepare(`
  INSERT INTO app_settings (id, json, updated_at) VALUES (1, ?, ?)
  ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at
`);

let cache: AppSettings | null = null;

export function getSettings(): AppSettings {
  if (cache) return cache;
  const row = selectRow.get() as { json: string } | undefined;
  const resolved: AppSettings = row ? { ...bundledDefaults, ...JSON.parse(row.json) } : bundledDefaults;
  cache = resolved;
  return resolved;
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

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const merged = { ...getSettings(), ...patch };
  upsertRow.run(JSON.stringify(merged), Date.now());
  cache = merged;
  return merged;
}
