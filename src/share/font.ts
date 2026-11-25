/**
 * A TrueType reader, just enough to draw text: character map, advance widths
 * and glyph outlines as flattened polygons. Written here because the share
 * pictures are drawn inside a request, where the nightly cards' headless
 * browser cannot run, and the image carries no font library and no fonts.
 *
 * Reads `glyf` outlines only (quadratic curves), which is what the two bundled
 * JetBrains Mono files hold. No hinting, kerning or shaping: the cards print
 * Latin text in a monospace face.
 */

/** One closed outline as flat [x0, y0, x1, y1, …], in font units, y up. */
type Contour = number[];

interface Glyph {
  advance: number;
  contours: Contour[];
}

/** Segments per quadratic curve. Glyphs are drawn at most ~200px tall, where
 * four chords leave an error far under a pixel. */
const CURVE_STEPS = 4;

const COMPOSITE_DEPTH = 4;

export class Font {
  readonly unitsPerEm: number;
  readonly capHeight: number;
  private readonly view: DataView;
  private readonly tables = new Map<string, number>();
  private readonly cmap = new Map<number, number>();
  private readonly glyphs = new Map<number, Glyph>();
  private readonly longLoca: boolean;
  private readonly hMetrics: number;
  private readonly glyphCount: number;

  constructor(bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const v = this.view;
    const numTables = v.getUint16(4);
    for (let i = 0; i < numTables; i++) {
      const rec = 12 + i * 16;
      const tag = String.fromCharCode(
        v.getUint8(rec),
        v.getUint8(rec + 1),
        v.getUint8(rec + 2),
        v.getUint8(rec + 3)
      );
      this.tables.set(tag, v.getUint32(rec + 8));
    }
    const head = this.table("head");
    this.unitsPerEm = v.getUint16(head + 18);
    this.longLoca = v.getInt16(head + 50) === 1;
    this.hMetrics = v.getUint16(this.table("hhea") + 34);
    this.glyphCount = v.getUint16(this.table("maxp") + 4);
    this.readCmap();
    const os2 = this.tables.get("OS/2");
    // sCapHeight exists from OS/2 version 2; 0.7em is the usual sans figure.
    const cap = os2 !== undefined && v.getUint16(os2) >= 2 ? v.getInt16(os2 + 88) : 0;
    this.capHeight = cap > 0 ? cap : this.unitsPerEm * 0.7;
  }

  private table(tag: string): number {
    const offset = this.tables.get(tag);
    if (offset === undefined) throw new Error(`font has no ${tag} table`);
    return offset;
  }

  /** The Unicode BMP subtable (format 4), which every Windows-usable font has. */
  private readCmap(): void {
    const v = this.view;
    const cmap = this.table("cmap");
    const n = v.getUint16(cmap + 2);
    let sub = -1;
    for (let i = 0; i < n; i++) {
      const rec = cmap + 4 + i * 8;
      const platform = v.getUint16(rec);
      const encoding = v.getUint16(rec + 2);
      const offset = cmap + v.getUint32(rec + 4);
      if (v.getUint16(offset) !== 4) continue;
      if ((platform === 3 && encoding === 1) || platform === 0) sub = offset;
    }
    if (sub < 0) throw new Error("font has no format 4 cmap");
    const segs = v.getUint16(sub + 6) / 2;
    const ends = sub + 14;
    const starts = ends + segs * 2 + 2;
    const deltas = starts + segs * 2;
    const ranges = deltas + segs * 2;
    for (let s = 0; s < segs; s++) {
      const end = v.getUint16(ends + s * 2);
      const start = v.getUint16(starts + s * 2);
      const delta = v.getInt16(deltas + s * 2);
      const range = v.getUint16(ranges + s * 2);
      if (start === 0xffff) break;
      for (let c = start; c <= end; c++) {
        let g: number;
        if (range === 0) {
          g = (c + delta) & 0xffff;
        } else {
          g = v.getUint16(ranges + s * 2 + range + (c - start) * 2);
          if (g !== 0) g = (g + delta) & 0xffff;
        }
        if (g !== 0) this.cmap.set(c, g);
      }
    }
  }

  has(codePoint: number): boolean {
    return this.cmap.has(codePoint);
  }

  /** The glyph for a character; the font's "missing" box when it has none. */
  glyph(codePoint: number): Glyph {
    return this.glyphById(this.cmap.get(codePoint) ?? 0, 0);
  }

  private glyphById(id: number, depth: number): Glyph {
    const cached = this.glyphs.get(id);
    if (cached) return cached;
    const v = this.view;
    const safe = id < this.glyphCount ? id : 0;
    const hmtx = this.table("hmtx");
    const advance = v.getUint16(hmtx + Math.min(safe, this.hMetrics - 1) * 4);
    const loca = this.table("loca");
    const at = (i: number) =>
      this.longLoca ? v.getUint32(loca + i * 4) : v.getUint16(loca + i * 2) * 2;
    const start = at(safe);
    const end = at(safe + 1);
    const glyph: Glyph = { advance, contours: [] };
    if (end > start) {
      const g = this.table("glyf") + start;
      const count = v.getInt16(g);
      glyph.contours =
        count >= 0
          ? this.simple(g, count)
          : depth < COMPOSITE_DEPTH
            ? this.composite(g, depth)
            : [];
    }
    this.glyphs.set(id, glyph);
    return glyph;
  }

  private simple(g: number, count: number): Contour[] {
    const v = this.view;
    const endPts: number[] = [];
    for (let i = 0; i < count; i++) endPts.push(v.getUint16(g + 10 + i * 2));
    const points = count > 0 ? (endPts[count - 1] as number) + 1 : 0;
    let p = g + 10 + count * 2;
    p += 2 + v.getUint16(p);
    const flags = new Uint8Array(points);
    for (let i = 0; i < points; ) {
      const f = v.getUint8(p++);
      flags[i++] = f;
      if (f & 8) {
        let repeat = v.getUint8(p++);
        while (repeat-- > 0 && i < points) flags[i++] = f;
      }
    }
    const read = (shortBit: number, sameBit: number): Int32Array => {
      const out = new Int32Array(points);
      let value = 0;
      for (let i = 0; i < points; i++) {
        const f = flags[i] as number;
        if (f & shortBit) {
          const d = v.getUint8(p++);
          value += f & sameBit ? d : -d;
        } else if (!(f & sameBit)) {
          value += v.getInt16(p);
          p += 2;
        }
        out[i] = value;
      }
      return out;
    };
    const xs = read(2, 16);
    const ys = read(4, 32);

    const contours: Contour[] = [];
    let first = 0;
    for (const last of endPts) {
      const n = last - first + 1;
      if (n >= 2) contours.push(flatten(xs, ys, flags, first, n));
      first = last + 1;
    }
    return contours;
  }

  private composite(g: number, depth: number): Contour[] {
    const v = this.view;
    const contours: Contour[] = [];
    let p = g + 10;
    for (;;) {
      const flags = v.getUint16(p);
      const id = v.getUint16(p + 2);
      p += 4;
      let dx = 0;
      let dy = 0;
      if (flags & 1) {
        if (flags & 2) {
          dx = v.getInt16(p);
          dy = v.getInt16(p + 2);
        }
        p += 4;
      } else {
        if (flags & 2) {
          dx = v.getInt8(p);
          dy = v.getInt8(p + 1);
        }
        p += 2;
      }
      let a = 1;
      let b = 0;
      let c = 0;
      let d = 1;
      const f2 = (o: number) => v.getInt16(o) / 16384;
      if (flags & 8) {
        a = d = f2(p);
        p += 2;
      } else if (flags & 0x40) {
        a = f2(p);
        d = f2(p + 2);
        p += 4;
      } else if (flags & 0x80) {
        a = f2(p);
        b = f2(p + 2);
        c = f2(p + 4);
        d = f2(p + 6);
        p += 8;
      }
      for (const part of this.glyphById(id, depth + 1).contours) {
        const moved: Contour = new Array(part.length);
        for (let i = 0; i < part.length; i += 2) {
          const x = part[i] as number;
          const y = part[i + 1] as number;
          moved[i] = a * x + c * y + dx;
          moved[i + 1] = b * x + d * y + dy;
        }
        contours.push(moved);
      }
      if (!(flags & 0x20)) break;
    }
    return contours;
  }
}

/** A TrueType contour as a polygon: off-curve points are quadratic controls,
 * and two in a row imply an on-curve point midway. */
function flatten(
  xs: Int32Array,
  ys: Int32Array,
  flags: Uint8Array,
  first: number,
  n: number
): Contour {
  const on = (i: number) => ((flags[first + (i % n)] as number) & 1) === 1;
  const px = (i: number) => xs[first + (i % n)] as number;
  const py = (i: number) => ys[first + (i % n)] as number;

  // Start on an on-curve point, or on the midpoint of two controls.
  let start = 0;
  while (start < n && !on(start)) start++;
  let x0: number;
  let y0: number;
  let i: number;
  if (start < n) {
    x0 = px(start);
    y0 = py(start);
    i = start + 1;
  } else {
    x0 = (px(0) + px(n - 1)) / 2;
    y0 = (py(0) + py(n - 1)) / 2;
    i = 0;
    start = 0;
  }
  const out: Contour = [x0, y0];
  let cx = x0;
  let cy = y0;
  const curveTo = (qx: number, qy: number, ex: number, ey: number) => {
    for (let s = 1; s <= CURVE_STEPS; s++) {
      const t = s / CURVE_STEPS;
      const u = 1 - t;
      out.push(u * u * cx + 2 * u * t * qx + t * t * ex, u * u * cy + 2 * u * t * qy + t * t * ey);
    }
    cx = ex;
    cy = ey;
  };
  const stop = i + n;
  while (i < stop) {
    if (on(i)) {
      cx = px(i);
      cy = py(i);
      out.push(cx, cy);
      i++;
      continue;
    }
    const qx = px(i);
    const qy = py(i);
    if (i + 1 >= stop) {
      curveTo(qx, qy, x0, y0);
      i++;
    } else if (on(i + 1)) {
      curveTo(qx, qy, px(i + 1), py(i + 1));
      i += 2;
    } else {
      curveTo(qx, qy, (qx + px(i + 1)) / 2, (qy + py(i + 1)) / 2);
      i++;
    }
  }
  return out;
}
