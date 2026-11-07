/**
 * Synthetic checks for src/straighten.ts: a dark-bordered "card" drawn on a light platform at known
 * angles, including one hanging off the frame edge (the case that broke a min-area-box approach).
 *
 * Run: npx ts-node scripts/straighten-check.ts
 */
import sharp from 'sharp';
import { straightenCard } from '../src/straighten';

const FW = 640, FH = 920, CW = 380, CH = 532;

/** A card centred at (cx, cy), rotated `deg` clockwise, on a platform with a dark top strip. */
function frame(deg: number, cx = FW / 2, cy = FH / 2 + 30): Promise<Buffer> {
  const svg = `<svg width="${FW}" height="${FH}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="rgb(225,226,228)"/>
    <rect width="100%" height="${Math.round(FH * 0.05)}" fill="rgb(40,30,30)"/>
    <line x1="60" y1="0" x2="60" y2="${FH}" stroke="rgb(190,190,195)" stroke-width="2"/>
    <g transform="rotate(${deg} ${cx} ${cy})">
      <rect x="${cx - CW / 2}" y="${cy - CH / 2}" width="${CW}" height="${CH}" rx="14" fill="rgb(20,20,22)"/>
      <rect x="${cx - CW / 2 + 12}" y="${cy - CH / 2 + 12}" width="${CW - 24}" height="${CH * 0.55}" fill="rgb(60,90,200)"/>
      <rect x="${cx - CW / 2 + 12}" y="${cy + CH * 0.08}" width="${CW - 24}" height="${CH * 0.38}" fill="rgb(235,225,195)"/>
    </g></svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
}

let failed = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
  if (!ok) failed++;
}

(async () => {
  for (const deg of [0, 6, -12, 20]) {
    const r = await straightenCard(await frame(deg));
    const m = await sharp(r.image).metadata();
    const aspect = (m.height ?? 0) / (m.width ?? 1);
    // Upright: the uprighting rotation cancels the tilt, and the crop has the card's own shape.
    check(`tilt ${deg}`, r.angle != null && Math.abs(r.angle + deg) < 1.5 && Math.abs(aspect - CH / CW) < 0.08,
      `angle ${r.angle?.toFixed(2)}, crop ${m.width}x${m.height}, aspect ${aspect.toFixed(3)}`);
  }

  // Hanging off the right edge: frame-border hull edges must not vote, or this reads as ~0.
  const cut = await straightenCard(await frame(15, FW - 120));
  check('tilt 15, cut off at frame edge', cut.angle != null && Math.abs(cut.angle + 15) < 2, `angle ${cut.angle?.toFixed(2)}`);

  // Off-frame wedge is blanked black, not platform-grey.
  const { data, info } = await sharp(cut.image).raw().toBuffer({ resolveWithObject: true });
  const px = (x: number, y: number) => data[(y * info.width + x) * info.channels];
  check('off-frame wedge is black', px(info.width - 3, Math.floor(info.height * 0.5)) < 30, `edge pixel ${px(info.width - 3, Math.floor(info.height * 0.5))}`);

  const emptyIn = await sharp({ create: { width: FW, height: FH, channels: 3, background: { r: 225, g: 226, b: 228 } } }).jpeg().toBuffer();
  const empty = await straightenCard(emptyIn);
  check('empty platform falls back untouched', empty.angle === null && empty.image === emptyIn, `angle ${empty.angle}`);

  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
