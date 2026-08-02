/**
 * Minimal RFC-4180 CSV serializer. Same approach as lorcana-seller-csv/src/csv.ts — hand-rolled
 * instead of a dependency so we have exact control over quoting, since the export target
 * (TCGTracking's CSV import) has an undocumented column contract we're already guessing at
 * (see export.ts); no reason to add a second unknown by trusting a library's quoting quirks.
 */

function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function stringifyCsvRow(fields: (string | number | null | undefined)[]): string {
  return fields.map(csvField).join(',');
}
