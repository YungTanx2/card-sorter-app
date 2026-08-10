/**
 * Assertions for src/ordering.ts — run with `npx ts-node scripts/ordering-check.ts`.
 *
 * Standalone like scripts/calibrate.ts and scripts/embedding-harness.ts: no server, no SQLite,
 * no network. Exists because binder layout is entirely downstream of number parsing, and the
 * failure mode is silent — a bad parse shifts every subsequent card by a pocket rather than
 * throwing anything.
 */
import { parseCardNumber, compareCardNumbers, assignSlots } from '../src/ordering';
import { CandidateCard } from '../src/types';

let failures = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}\n         expected ${e}\n         actual   ${a}`);
  }
}

console.log('\nparseCardNumber — real formats from all five supported games');
check('Lorcana/Pokemon "125/207"', parseCardNumber('125/207'), { group: 0, prefix: '', num: 125, suffix: '', raw: '125/207' });
check('Pokemon secret rare "199/191"', parseCardNumber('199/191'), { group: 0, prefix: '', num: 199, suffix: '', raw: '199/191' });
check('Pokemon Trainer Gallery "TG12/TG30"', parseCardNumber('TG12/TG30'), { group: 1, prefix: 'TG', num: 12, suffix: '', raw: 'TG12/TG30' });
check('Pokemon Shiny Vault "SV045/SV122"', parseCardNumber('SV045/SV122'), { group: 1, prefix: 'SV', num: 45, suffix: '', raw: 'SV045/SV122' });
check('One Piece "OP07-001"', parseCardNumber('OP07-001'), { group: 1, prefix: 'OP07-', num: 1, suffix: '', raw: 'OP07-001' });
check('Digimon "BT22-043 U"', parseCardNumber('BT22-043 U'), { group: 1, prefix: 'BT22-', num: 43, suffix: 'U', raw: 'BT22-043 U' });
check('Magic variant "125a"', parseCardNumber('125a'), { group: 0, prefix: '', num: 125, suffix: 'A', raw: '125a' });
check('null number', parseCardNumber(null), { group: 2, prefix: '', num: 0, suffix: '', raw: '' });
check('no digits at all "PROMO"', parseCardNumber('PROMO'), { group: 2, prefix: '', num: 0, suffix: '', raw: 'PROMO' });

console.log('\ncompareCardNumbers — the orderings that actually matter');
const sorted = (nums: string[]) => nums.slice().sort((a, b) => compareCardNumbers(parseCardNumber(a), parseCardNumber(b)));

check(
  'secret rares sort AFTER the base set total',
  sorted(['199/191', '1/191', '191/191', '150/191']),
  ['1/191', '150/191', '191/191', '199/191'],
);
check(
  'prefixed subsets group after the whole base set',
  sorted(['TG12/TG30', '5/191', 'TG01/TG30', '191/191']),
  ['5/191', '191/191', 'TG01/TG30', 'TG12/TG30'],
);
check(
  'two different prefixed subsets stay separated',
  sorted(['SV010/SV122', 'TG05/TG30', 'SV002/SV122', 'TG01/TG30']),
  ['SV002/SV122', 'SV010/SV122', 'TG01/TG30', 'TG05/TG30'],
);
check(
  'zero-padding is not lexicographic',
  sorted(['OP07-010', 'OP07-002', 'OP07-100', 'OP07-001']),
  ['OP07-001', 'OP07-002', 'OP07-010', 'OP07-100'],
);
check(
  'unparseable numbers sort last, deterministically',
  sorted(['PROMO', '5/191', 'ALT', '1/191']),
  ['1/191', '5/191', 'ALT', 'PROMO'],
);

console.log('\nassignSlots — binder pagination and rarity exclusion');
const card = (productId: number, number: string, rarity: string, setId = 1): CandidateCard => ({
  productId, name: `Card ${number}`, number, rarity, imageUrl: null, setId, setName: 'Test Set',
});

const ten = Array.from({ length: 10 }, (_, i) => card(i + 1, `${i + 1}/10`, 'Common'));
const slots3x3 = assignSlots(ten, [1], 3, 3);
check('10 cards at 3x3 -> last card is page 2 pocket 1', [slots3x3[9].page, slots3x3[9].pocket], [2, 1]);
check('3x3 pocket 9 is page 1', [slots3x3[8].page, slots3x3[8].pocket], [1, 9]);
const slots4x3 = assignSlots(ten, [1], 4, 3);
check('same 10 cards at 4x3 -> card 10 lands page 1 pocket 10', [slots4x3[9].page, slots4x3[9].pocket], [1, 10]);

const withChase = [...ten, card(99, '11/10', 'Enchanted')];
const excluded = assignSlots(withChase, [1], 3, 3, ['enchanted']);
check('excluded rarity is removed, not left as a hole', excluded.length, 10);
check('exclusion is case-insensitive', excluded.some((s) => s.productId === 99), false);
check('excluding does not shift surviving cards', [excluded[9].page, excluded[9].pocket], [2, 1]);

const twoSets = [card(200, '1/5', 'Common', 2), card(100, '1/10', 'Common', 1)];
check(
  'sets do not interleave; goal setIds order wins',
  assignSlots(twoSets, [1, 2], 3, 3).map((s) => s.productId),
  [100, 200],
);
check(
  'reversing the goal setIds reverses the set order',
  assignSlots(twoSets, [2, 1], 3, 3).map((s) => s.productId),
  [200, 100],
);

console.log(failures === 0 ? '\nAll ordering checks passed.\n' : `\n${failures} ordering check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
