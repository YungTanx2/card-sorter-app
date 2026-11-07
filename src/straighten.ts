import sharp from 'sharp';

/**
 * Finds the card in a capture, rotates it upright and crops to it, before CLIP sees it.
 *
 * Why: CLIP scores the whole crop, platform included, after squashing it to a 224px square. Since
 * Bluetooth mode (2026-11), cards land tilted and off-centre far more often, and the confidence
 * gate fails on exactly those: in the Hyper/sr run, 54% of cards tilted >=10 degrees were
 * low-confidence vs 11% of straight ones. Offline on that run's 284 captures, straightening took
 * confident matches from 180 to 232; every new match was checked by eye, 230 right and 2 wrong.
 *
 * Detection runs on a DETECT_W-wide copy (the scale the thresholds were tuned at), and the
 * resulting rotation and crop are applied to the full-resolution input. Any failure returns the
 * input unchanged, so this can only ever fall back to pre-straightening behaviour.
 */

const DETECT_W = 200;
/** The rig's dark backdrop shows across the top of every frame; treated as platform. */
const TOP_STRIP = 0.08;
/** A card box smaller than this share of the frame is treated as "no card found". */
const MIN_BOX_FRAC = 0.2;
const PLATFORM = [222, 222, 222];

type Pt = [number, number];

/**
 * Card = dark OR saturated. Deliberately stricter than ocr.ts's detectCard (165 / 0.28): at that
 * threshold the platform's grey grooves join up with the card's outline, and the "card" becomes
 * most of the frame.
 */
function cardMask(data: Buffer, W: number, H: number, top: number): Uint8Array {
  const m = new Uint8Array(W * H);
  for (let y = top; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, R = data[i * 3], G = data[i * 3 + 1], B = data[i * 3 + 2];
    const mx = Math.max(R, G, B), mn = Math.min(R, G, B), sat = mx ? (mx - mn) / mx : 0;
    if (mx < 120 || sat > 0.35) m[i] = 1;
  }
  return m;
}

/** Largest 4-connected component, as pixel indices. */
function largestComponent(m: Uint8Array, W: number, H: number): number[] {
  const seen = new Uint8Array(W * H);
  let best: number[] = [];
  for (let s = 0; s < W * H; s++) {
    if (!m[s] || seen[s]) continue;
    const comp: number[] = [];
    const stack = [s];
    seen[s] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      comp.push(p);
      const x = p % W, y = (p / W) | 0;
      if (x > 0 && m[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
      if (x < W - 1 && m[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
      if (y > 0 && m[p - W] && !seen[p - W]) { seen[p - W] = 1; stack.push(p - W); }
      if (y < H - 1 && m[p + W] && !seen[p + W]) { seen[p + W] = 1; stack.push(p + W); }
    }
    if (comp.length > best.length) best = comp;
  }
  return best;
}

function convexHull(pix: number[], W: number): Pt[] {
  // Only each row's extreme pixels can be on the hull.
  const rowMin = new Map<number, number>(), rowMax = new Map<number, number>();
  for (const p of pix) {
    const x = p % W, y = (p / W) | 0;
    if (!rowMin.has(y) || x < rowMin.get(y)!) rowMin.set(y, x);
    if (!rowMax.has(y) || x > rowMax.get(y)!) rowMax.set(y, x);
  }
  const pts: Pt[] = [];
  for (const [y, x] of rowMin) pts.push([x, y]);
  for (const [y, x] of rowMax) pts.push([x, y]);
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [], upper: Pt[] = [];
  for (const q of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (let i = pts.length - 1; i >= 0; i--) { const q = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/**
 * The card's tilt, as the sharp.rotate() angle (clockwise-positive) that uprights it.
 *
 * Every hull edge votes for its direction, folded mod 90 so all four sides agree, weighted by
 * length. Edges lying along the frame border are skipped: a card cut off by the frame edge would
 * otherwise vote for 0 degrees. Two simpler methods failed on real captures — a min-area bounding
 * box (pinned at its search limit on cut-off cards) and a Sobel orientation histogram (pixel
 * staircases in a binary mask vote for 0/45 degrees).
 */
export function tiltFromHull(hull: Pt[], W: number, H: number, topY: number): number {
  const onBorder = (q: Pt) => q[0] <= 2 || q[0] >= W - 3 || q[1] >= H - 3 || q[1] <= topY + 3;
  const edges: { a: number; len: number }[] = [];
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    if (onBorder(a) && onBorder(b)) continue;
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
    edges.push({ a: ((ang % 90) + 135) % 90 - 45, len: Math.hypot(b[0] - a[0], b[1] - a[1]) });
  }
  const diff = (x: number, y: number) => { const d = Math.abs(x - y) % 90; return Math.min(d, 90 - d); };
  let best = 0, bestV = -1;
  for (let c = -45; c < 45; c += 0.25) {
    let v = 0;
    for (const e of edges) if (diff(e.a, c) <= 2) v += e.len;
    if (v > bestV) { bestV = v; best = c; }
  }
  // Refine with the length-weighted mean of the edges that agreed.
  let sw = 0, sa = 0;
  for (const e of edges) {
    if (diff(e.a, best) > 2) continue;
    let a = e.a;
    if (a - best > 45) a -= 90;
    if (best - a > 45) a += 90;
    sw += e.len; sa += e.len * a;
  }
  return -(sw ? sa / sw : best);
}

export interface StraightenResult {
  image: Buffer;
  /** Null when no card was found and the input was returned unchanged. */
  angle: number | null;
}

export async function straightenCard(input: Buffer): Promise<StraightenResult> {
  try {
    const full = await sharp(input).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
    const FW = full.info.width, FH = full.info.height;
    const small = await sharp(full.data, { raw: { width: FW, height: FH, channels: 3 } })
      .resize({ width: DETECT_W }).raw().toBuffer({ resolveWithObject: true });
    const W = small.info.width, H = small.info.height, top = Math.floor(H * TOP_STRIP);

    const comp = largestComponent(cardMask(small.data, W, H, top), W, H);
    if (!comp.length) return { image: input, angle: null };
    const hull = convexHull(comp, W);
    const angle = tiltFromHull(hull, W, H, top);

    // Paint the top strip out at full resolution too, then rotate. rotate() grows the canvas
    // around the same centre, so the card's box is the hull rotated the same way — no second
    // segmentation pass (re-segmenting the rotated image split light-art cards in two).
    const topFull = Math.floor(FH * TOP_STRIP);
    for (let i = 0; i < FW * topFull; i++) full.data.set(PLATFORM, i * 3);
    const rotated = await sharp(full.data, { raw: { width: FW, height: FH, channels: 3 } })
      .rotate(angle, { background: { r: 0, g: 0, b: 0 } }).raw().toBuffer({ resolveWithObject: true });
    const RW = rotated.info.width, RH = rotated.info.height;
    const t = angle * Math.PI / 180, c = Math.cos(t), s = Math.sin(t), k = FW / W;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [hx, hy] of hull) {
      const dx = hx * k - FW / 2, dy = hy * k - FH / 2;
      const u = dx * c - dy * s + RW / 2, v = dx * s + dy * c + RH / 2;
      x0 = Math.min(x0, u); x1 = Math.max(x1, u); y0 = Math.min(y0, v); y1 = Math.max(y1, v);
    }
    if ((x1 - x0) * (y1 - y0) < FW * FH * MIN_BOX_FRAC) return { image: input, angle: null };

    const pad = 1.5 * k;
    const left = Math.max(0, Math.floor(x0 - pad)), topY = Math.max(0, Math.floor(y0 - pad));
    const width = Math.min(RW, Math.ceil(x1 + pad + 1)) - left, height = Math.min(RH, Math.ceil(y1 + pad + 1)) - topY;
    const box = await sharp(rotated.data, { raw: { width: RW, height: RH, channels: 3 } })
      .extract({ left, top: topY, width, height }).raw().toBuffer();
    // Blank everything that came from outside the original frame (or the painted-out strip).
    // Left platform-grey, the wedge where a card hung off the frame edge made straightened cards
    // look like the rotated reference of a landscape Location card: 3 confident misroutes, all
    // to the same Location, gone to 1 with black.
    for (let yy = 0; yy < height; yy++) for (let xx = 0; xx < width; xx++) {
      const dx = left + xx - RW / 2, dy = topY + yy - RH / 2;
      const ox = dx * c + dy * s + FW / 2, oy = -dx * s + dy * c + FH / 2;
      if (ox < 0 || oy < topFull || ox >= FW || oy >= FH) box.fill(0, (yy * width + xx) * 3, (yy * width + xx) * 3 + 3);
    }
    const image = await sharp(box, { raw: { width, height, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
    return { image, angle };
  } catch (err) {
    console.warn('[straighten] falling back to the unstraightened capture:', err instanceof Error ? err.message : err);
    return { image: input, angle: null };
  }
}
