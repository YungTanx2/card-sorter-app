import { CandidateCard } from './types';

/**
 * Card-number parsing and binder-slot assignment for Set Builder mode.
 *
 * This looks trivial and isn't. Printed collector numbers are not a numeric field — every game
 * (and several subsets within a game) writes them differently, and the binder's entire pocket
 * layout is downstream of getting the ordering right. A wrong parse doesn't produce one wrong
 * card, it shifts every card after it by a pocket.
 *
 * Formats confirmed live across the five supported games (see tcgcsv.ts's extractField doc):
 *   "125/207"      Lorcana / Pokemon / Magic  -> plain number, denominator is noise
 *   "199/191"      Pokemon secret rare        -> numbered ABOVE the set total; must sort last,
 *                                               which falls out of numeric ordering for free
 *   "TG12/TG30"    Pokemon Trainer Gallery    -> a prefixed subset; must group after the base
 *   "SV045/SV122"  Pokemon Shiny Vault        -> same, and zero-padded
 *   "OP07-001"     One Piece                  -> set-code prefix, hyphenated
 *   "BT22-043 U"   Digimon                    -> set-code prefix PLUS a trailing rarity letter
 *   "125a"         Magic variants             -> letter suffix on the number itself
 */

/** Sort key for one printed card number. `group` is the coarse bucket: plain numbers first,
 *  prefixed subsets next, unparseable last — so a card whose number we can't read never
 *  displaces a card we can. */
export interface CardNumberKey {
  group: 0 | 1 | 2; // 0 = plain numeric, 1 = prefixed subset, 2 = unparseable
  prefix: string;
  num: number;
  suffix: string;
  raw: string;
}

/**
 * Splits a printed number into a comparable key. Never throws — an unrecognized string becomes
 * a group-2 key ordered by its raw text, which keeps sorting deterministic rather than
 * arbitrary. That matters more than being clever: a nondeterministic sort would silently
 * reshuffle an entire binder between two views of the same goal.
 */
export function parseCardNumber(raw: string | null | undefined): CardNumberKey {
  const text = (raw ?? '').trim();
  if (!text) return { group: 2, prefix: '', num: 0, suffix: '', raw: '' };

  // Everything after the first slash is the set total ("/207", "/TG30") — pure noise for
  // ordering, and actively harmful to parse since secret rares exceed it.
  const head = text.split('/')[0].trim();

  // Lazy prefix so the LAST number in the head wins: "OP07-001" must yield 1, not 7.
  const m = head.match(/^(.*?)(\d+)\s*([A-Za-z]*)\s*$/);
  if (!m) return { group: 2, prefix: '', num: 0, suffix: '', raw: text };

  const prefix = m[1].trim().toUpperCase();
  return {
    group: prefix === '' ? 0 : 1,
    prefix,
    num: Number(m[2]), // Number() drops zero-padding: "045" -> 45
    suffix: m[3].toUpperCase(),
    raw: text,
  };
}

/** Total ordering over card numbers. The final `raw` comparison exists purely so two cards that
 *  are otherwise identical still sort deterministically. */
export function compareCardNumbers(a: CardNumberKey, b: CardNumberKey): number {
  if (a.group !== b.group) return a.group - b.group;
  if (a.prefix !== b.prefix) return a.prefix < b.prefix ? -1 : 1;
  if (a.num !== b.num) return a.num - b.num;
  if (a.suffix !== b.suffix) return a.suffix < b.suffix ? -1 : 1;
  if (a.raw !== b.raw) return a.raw < b.raw ? -1 : 1;
  return 0;
}

export interface BinderSlot {
  productId: number;
  name: string;
  number: string | null;
  rarity: string | null;
  imageUrl: string | null;
  setId: number;
  setName: string;
  index: number;  // 0-based position across the whole goal
  page: number;   // 1-based
  pocket: number; // 1-based within the page, row-major
}

function isExcluded(rarity: string | null, excludedRarities: string[]): boolean {
  if (!rarity) return false;
  const r = rarity.trim().toLowerCase();
  return excludedRarities.some((e) => e.trim().toLowerCase() === r);
}

/**
 * Orders a goal's candidates and assigns each one a binder page and pocket.
 *
 * Excluded rarities are removed BEFORE indexing, not hidden afterward — an excluded card must
 * not leave a permanent hole in the binder, since the whole point of excluding it is that you
 * were never going to obtain it. Multiple sets don't interleave: they're ordered by their
 * position in the goal's own setIds array, so a base set plus its promo group reads in the
 * order the goal declared them.
 */
export function assignSlots(
  candidates: CandidateCard[],
  setIds: number[],
  rows: number,
  cols: number,
  excludedRarities: string[] = [],
): BinderSlot[] {
  const perPage = Math.max(1, rows * cols);
  const setRank = new Map(setIds.map((id, i) => [id, i]));

  const ordered = candidates
    .filter((c) => !isExcluded(c.rarity, excludedRarities))
    .map((c) => ({ card: c, key: parseCardNumber(c.number) }))
    .sort((a, b) => {
      const ra = setRank.get(a.card.setId) ?? Number.MAX_SAFE_INTEGER;
      const rb = setRank.get(b.card.setId) ?? Number.MAX_SAFE_INTEGER;
      if (ra !== rb) return ra - rb;
      const byNumber = compareCardNumbers(a.key, b.key);
      if (byNumber !== 0) return byNumber;
      // Same printed number in the same set: fall back to name, then productId, so the order
      // is stable across processes rather than dependent on SQLite's row order.
      if (a.card.name !== b.card.name) return a.card.name < b.card.name ? -1 : 1;
      return a.card.productId - b.card.productId;
    });

  return ordered.map(({ card }, index) => ({
    productId: card.productId,
    name: card.name,
    number: card.number,
    rarity: card.rarity,
    imageUrl: card.imageUrl,
    setId: card.setId,
    setName: card.setName,
    index,
    page: Math.floor(index / perPage) + 1,
    pocket: (index % perPage) + 1,
  }));
}
