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

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const merged = { ...getSettings(), ...patch };
  upsertRow.run(JSON.stringify(merged), Date.now());
  cache = merged;
  return merged;
}
