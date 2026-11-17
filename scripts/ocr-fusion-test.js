/**
 * Unit tests for the peer-fusion decision and the fuzzy title matcher (src/ocr.ts).
 *
 * These are the parts that decide routing, and they are pure — no camera, no Tesseract, no
 * database. The conflict branch in particular has never fired on real data (0 occurrences across
 * the 57-frame corpus), which is exactly why it needs a test: nothing else would catch it
 * regressing into "silently prefer the embedding".
 *
 * Run: node scripts/ocr-fusion-test.js   (requires `npm run build` first)
 */
const { fuseSignals, substringSimilarity, normalizeTitle, printedTitle } = require('../dist/ocr');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ok    ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`); failed++; }
}
function eq(name, actual, expected) {
  check(name, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const S = { minScore: 0.65, minGap: 0.02, ocrMinSim: 0.80 };
const clip = (productId, score) => ({ productId, score });
const ocrOf = (productId, sim) => ({ productId, productIds: [productId], sim, margin: 0.3, raw: 'RAW' });
/** A title printed several times (Zeta: white / black / misprint share one name). */
const ocrTitle = (productIds, sim) => ({ productId: productIds[0], productIds, sim, margin: 0.3, raw: 'RAW' });

console.log('\nfuseSignals — both signals confident');
{
  const f = fuseSignals({ top: clip(1, 0.90), runnerUp: clip(2, 0.50), ocr: ocrOf(1, 0.95), ...S });
  eq('agreeing signals resolve to the shared card', f.productId, 1);
  eq('...and are sourced as "both"', f.source, 'both');
  eq('...with no conflict', f.conflict, false);
}
{
  const f = fuseSignals({ top: clip(1, 0.90), runnerUp: clip(2, 0.50), ocr: ocrOf(99, 0.95), ...S });
  eq('DISAGREEING signals route nothing', f.productId, null);
  eq('...and are flagged as a conflict', f.conflict, true);
  eq('...and have no source', f.source, null);
  check('...and do NOT silently prefer the embedding', f.productId !== 1);
}

console.log('\nfuseSignals — one signal only');
{
  const f = fuseSignals({ top: clip(7, 0.90), runnerUp: clip(2, 0.50), ocr: null, ...S });
  eq('embedding alone carries the card', f.productId, 7);
  eq('...sourced as clip', f.source, 'clip');
}
{
  // The rescue case: a gap far under minGap, which the embedding gate alone would reject.
  const f = fuseSignals({ top: clip(3, 0.74), runnerUp: clip(4, 0.738), ocr: ocrOf(9, 0.88), ...S });
  eq('OCR alone carries a card the gap rejected', f.productId, 9);
  eq('...sourced as ocr', f.source, 'ocr');
  eq('...and the embedding is correctly judged unconfident', f.clipConfident, false);
}
{
  const f = fuseSignals({ top: null, runnerUp: null, ocr: ocrOf(5, 0.99), ...S });
  eq('OCR carries a card even with no embedding match at all', f.productId, 5);
}

console.log('\nfuseSignals — thresholds');
{
  const f = fuseSignals({ top: clip(1, 0.64), runnerUp: clip(2, 0.10), ocr: null, ...S });
  eq('score below minScore is not confident despite a huge gap', f.productId, null);
}
{
  const f = fuseSignals({ top: clip(1, 0.90), runnerUp: clip(2, 0.885), ocr: null, ...S });
  eq('gap below minGap is not confident despite a high score', f.productId, null);
}
{
  const f = fuseSignals({ top: clip(1, 0.90), runnerUp: null, ocr: null, ...S });
  eq('a lone candidate has no runner-up to clear', f.productId, 1);
}
{
  const f = fuseSignals({ top: null, runnerUp: null, ocr: ocrOf(5, 0.799), ...S });
  eq('OCR just under ocrMinSim does not route', f.productId, null);
  const g = fuseSignals({ top: null, runnerUp: null, ocr: ocrOf(5, 0.80), ...S });
  eq('OCR exactly at ocrMinSim does route (inclusive bound)', g.productId, 5);
}
{
  const f = fuseSignals({ top: null, runnerUp: null, ocr: null, ...S });
  eq('neither signal routes nothing', f.productId, null);
  eq('...and that is not a conflict', f.conflict, false);
}

console.log('\nfuseSignals — one title, several printings (Magic Zeta)');
// Urborg: 121 white ($81), 242 black ($240), 363 misprint. OCR reads the name; it cannot see the
// treatment, so CLIP's scores among those three decide which one it is.
const URBORG = [121, 242, 363];
{
  // The regression this guards: the first printing used to stand in for the title, so a correct
  // CLIP match on the black copy disagreed with OCR's "white copy" and went to bulk as a conflict.
  const f = fuseSignals({ top: clip(242, 0.90), runnerUp: clip(121, 0.80), ocr: ocrTitle(URBORG, 0.95), ...S });
  eq('CLIP on a non-first printing AGREES with the title, no conflict', f.conflict, false);
  eq('...and keeps the printing CLIP chose', f.productId, 242);
  eq('...sourced as both', f.source, 'both');
}
{
  const f = fuseSignals({ top: clip(500, 0.90), runnerUp: clip(242, 0.80), ocr: ocrTitle(URBORG, 0.95), ...S });
  eq('CLIP on a card OUTSIDE the title is still a conflict', f.conflict, true);
}
{
  // The rescue: CLIP is torn between two sibling white cards (gap 0.003), but among Urborg's own
  // printings the black copy clearly leads.
  const scored = [clip(77, 0.812), clip(242, 0.809), clip(121, 0.70), clip(363, 0.66)];
  const f = fuseSignals({ top: scored[0], runnerUp: scored[1], ocr: ocrTitle(URBORG, 0.9), scored, ...S });
  eq('OCR name + CLIP treatment identifies the printing', f.productId, 242);
  eq('...sourced as ocr', f.source, 'ocr');
}
{
  const scored = [clip(77, 0.812), clip(242, 0.809), clip(121, 0.80), clip(363, 0.66)];
  const f = fuseSignals({ top: scored[0], runnerUp: scored[1], ocr: ocrTitle(URBORG, 0.9), scored, ...S });
  eq('printings within minGap of each other stay unidentified', f.productId, null);
  eq('...and that is not a conflict', f.conflict, false);
}
{
  const f = fuseSignals({ top: clip(77, 0.812), runnerUp: clip(242, 0.809), ocr: ocrTitle(URBORG, 0.9), ...S });
  eq('without the ranking, a shared title cannot pick a printing', f.productId, null);
}
{
  const f = fuseSignals({ top: null, runnerUp: null, ocr: ocrOf(5, 0.95), scored: [], ...S });
  eq('a single-printing title still routes on OCR alone (Lorcana unchanged)', f.productId, 5);
}

console.log('\nprintedTitle — catalog annotations are not printed on the card');
eq('strips (Enchanted)', printedTitle('Mike Wazowski - Heroic Climber (Enchanted)'), 'Mike Wazowski - Heroic Climber');
eq('strips (Foil)', printedTitle('Robin Hood - Created by the Vine (Foil)'), 'Robin Hood - Created by the Vine');
eq('leaves a plain name alone', printedTitle('Roz - Always Watching'), 'Roz - Always Watching');
eq('only strips a TRAILING parenthetical', printedTitle('Attack of the Vine! Puzzle Insert (Top Left)'), 'Attack of the Vine! Puzzle Insert');
eq('strips a Zeta collector number, so all three printings share one title', printedTitle('Urborg, Tomb of Yawgmoth (0242)'), 'Urborg, Tomb of Yawgmoth');

console.log('\nsubstringSimilarity — tolerant of OCR junk around a good read');
{
  const target = normalizeTitle('Omnidroid - Scanning for Threats');
  check('clean read scores 1.0', substringSimilarity(target, target) === 1);
  // Real Tesseract output for this card during the feasibility run. It measures 0.852 — the
  // assertion is against the production threshold (ocrMinSim 0.80) rather than a prettier
  // number, because "would this route" is the only question that matters. The 0.05 of headroom
  // is also the honest picture of how tight this signal is: junk costs real similarity.
  const noisy = normalizeTitle('] OMNIDROID QL) Scanning for Threats ~ Storyborn * Robot');
  check('read with leading AND trailing junk still clears ocrMinSim',
    substringSimilarity(noisy, target) >= 0.80, 'got ' + substringSimilarity(noisy, target).toFixed(3));
  const wrong = normalizeTitle('Jasmine - Vine Expert');
  check('an unrelated title scores low',
    substringSimilarity(noisy, wrong) < 0.5, 'got ' + substringSimilarity(noisy, wrong).toFixed(3));
}
{
  // The failure that motivated ocrMinTitleChars: a 4-char title finds a cheap window in noise.
  const noise = normalizeTitle('a . . a 4 ~ pai N.13 4/70)] RAHR-ish gibberish');
  check('SHORT titles match noise — which is why they are excluded from the index',
    substringSimilarity(noise, 'RAHR') > 0.5, 'got ' + substringSimilarity(noise, 'RAHR').toFixed(3));
}
{
  check('single-character transposition is forgiven',
    substringSimilarity(normalizeTitle('MUIAN CREATED BY THE VINE'), normalizeTitle('Mulan - Created by the Vine')) >= 0.9);
  check('empty pattern scores 0', substringSimilarity('ANYTHING', '') === 0);
  check('empty text against a real pattern scores 0 or less', substringSimilarity('', 'MULAN') <= 0);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
