/**
 * A small RGB canvas: anti-aliased polygon fill, text through `Font`, and a
 * PNG encoder over node:zlib. No native code and no package, so a picture can
 * be drawn inside a request on the image the server already runs on.
 */

import { deflateSync } from "node:zlib";
import type { Font } from "./font";

export type Rgb = readonly [number, number, number];

export function hexRgb(hex: string): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  const n = m ? Number.parseInt(m[1] as string, 16) : 0x0ea5e9;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Flat [x0, y0, x1, y1, …] in pixels, y down; closed implicitly. */
type Polygon = ArrayLike<number>;

export class Canvas {
  readonly pixels: Uint8Array;

  constructor(
    readonly width: number,
    readonly height: number,
    background: Rgb
  ) {
    this.pixels = new Uint8Array(width * height * 3);
    for (let i = 0; i < this.pixels.length; i += 3) {
      this.pixels[i] = background[0];
      this.pixels[i + 1] = background[1];
      this.pixels[i + 2] = background[2];
    }
  }

  rect(x: number, y: number, w: number, h: number, color: Rgb, alpha = 1): void {
    this.fill([[x, y, x + w, y, x + w, y + h, x, y + h]], color, alpha);
  }

  roundRect(x: number, y: number, w: number, h: number, r: number, color: Rgb, alpha = 1): void {
    const k = Math.min(r, w / 2, h / 2);
    const poly: number[] = [];
    const corner = (cx: number, cy: number, from: number) => {
      for (let s = 0; s <= 6; s++) {
        const a = from + (s / 6) * (Math.PI / 2);
        poly.push(cx + Math.cos(a) * k, cy + Math.sin(a) * k);
      }
    };
    corner(x + w - k, y + k, -Math.PI / 2);
    corner(x + w - k, y + h - k, 0);
    corner(x + k, y + h - k, Math.PI / 2);
    corner(x + k, y + k, Math.PI);
    this.fill([poly], color, alpha);
  }

  /**
   * Fill polygons with exact-area coverage (the signed-area accumulation that
   * font rasterizers use): each edge adds its covered area to the pixels it
   * crosses, and a running sum along the row turns that into coverage.
   */
  fill(polygons: readonly Polygon[], color: Rgb, alpha = 1): void {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const p of polygons) {
      for (let i = 0; i + 1 < p.length; i += 2) {
        const x = p[i] as number;
        const y = p[i + 1] as number;
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (!(maxX > minX) || !(maxY > minY)) return;
    // Clamp the work to the canvas: a shape far outside it costs nothing.
    const ox = Math.max(0, Math.floor(minX));
    const oy = Math.max(0, Math.floor(minY));
    const w = Math.min(this.width, Math.ceil(maxX) + 1) - ox;
    const h = Math.min(this.height, Math.ceil(maxY) + 1) - oy;
    if (w <= 0 || h <= 0) return;
    const stride = w + 2;
    const acc = new Float32Array(stride * h);

    const edge = (ax: number, ay: number, bx: number, by: number) => {
      if (ay === by) return;
      const dir = ay < by ? 1 : -1;
      let x0 = ax;
      let y0 = ay;
      let x1 = bx;
      let y1 = by;
      if (dir < 0) {
        x0 = bx;
        y0 = by;
        x1 = ax;
        y1 = ay;
      }
      const dxdy = (x1 - x0) / (y1 - y0);
      let x = x0;
      if (y0 < 0) x -= y0 * dxdy;
      const yEnd = Math.min(h, Math.ceil(y1));
      for (let y = Math.max(0, Math.floor(y0)); y < yEnd; y++) {
        const row = y * stride;
        const dy = Math.min(y + 1, y1) - Math.max(y, y0);
        const xNext = x + dxdy * dy;
        const d = dy * dir;
        // Horizontal clamp: area left of the buffer lands in column 0, which
        // still carries the winding to every pixel on its right.
        const lo = Math.min(Math.max(Math.min(x, xNext), 0), w);
        const hi = Math.min(Math.max(Math.max(x, xNext), 0), w);
        const loFloor = Math.floor(lo);
        const hiCeil = Math.ceil(hi);
        if (hiCeil <= loFloor + 1) {
          const mid = 0.5 * (lo + hi) - loFloor;
          acc[row + loFloor] += d - d * mid;
          acc[row + loFloor + 1] += d * mid;
        } else {
          const s = 1 / (hi - lo);
          const f0 = lo - loFloor;
          const a0 = 0.5 * s * (1 - f0) * (1 - f0);
          const f1 = hi - hiCeil + 1;
          const am = 0.5 * s * f1 * f1;
          acc[row + loFloor] += d * a0;
          if (hiCeil === loFloor + 2) {
            acc[row + loFloor + 1] += d * (1 - a0 - am);
          } else {
            const a1 = s * (1.5 - f0);
            acc[row + loFloor + 1] += d * (a1 - a0);
            for (let xi = loFloor + 2; xi < hiCeil - 1; xi++) acc[row + xi] += d * s;
            const a2 = a1 + (hiCeil - loFloor - 3) * s;
            acc[row + hiCeil - 1] += d * (1 - a2 - am);
          }
          acc[row + hiCeil] += d * am;
        }
        x = xNext;
      }
    };

    for (const p of polygons) {
      const n = p.length & ~1;
      if (n < 6) continue;
      let px = (p[n - 2] as number) - ox;
      let py = (p[n - 1] as number) - oy;
      for (let i = 0; i < n; i += 2) {
        const qx = (p[i] as number) - ox;
        const qy = (p[i + 1] as number) - oy;
        edge(px, py, qx, qy);
        px = qx;
        py = qy;
      }
    }

    const out = this.pixels;
    for (let y = 0; y < h; y++) {
      let sum = 0;
      let o = ((oy + y) * this.width + ox) * 3;
      const row = y * stride;
      for (let x = 0; x < w; x++, o += 3) {
        sum += acc[row + x] as number;
        const cover = Math.min(Math.abs(sum), 1) * alpha;
        if (cover < 0.004) continue;
        out[o] = (out[o] as number) + (color[0] - (out[o] as number)) * cover;
        out[o + 1] = (out[o + 1] as number) + (color[1] - (out[o + 1] as number)) * cover;
        out[o + 2] = (out[o + 2] as number) + (color[2] - (out[o + 2] as number)) * cover;
      }
    }
  }

  /** Draw one line of text with its baseline at `y`. `size` is the em height
   * in pixels; `tracking` is extra space per character, in ems. */
  text(
    font: Font,
    str: string,
    x: number,
    y: number,
    size: number,
    color: Rgb,
    tracking = 0
  ): void {
    const scale = size / font.unitsPerEm;
    const polygons: number[][] = [];
    let pen = x;
    for (const ch of str) {
      const glyph = font.glyph(ch.codePointAt(0) as number);
      for (const c of glyph.contours) {
        const poly = new Array<number>(c.length);
        for (let i = 0; i < c.length; i += 2) {
          poly[i] = pen + (c[i] as number) * scale;
          poly[i + 1] = y - (c[i + 1] as number) * scale;
        }
        polygons.push(poly);
      }
      pen += glyph.advance * scale + tracking * size;
    }
    this.fill(polygons, color);
  }

  png(): Uint8Array {
    const { width, height, pixels } = this;
    const rowBytes = width * 3;
    const raw = new Uint8Array((rowBytes + 1) * height);
    for (let y = 0; y < height; y++) {
      // Filter 0 on every row: the cards are flat colour, which deflate
      // already folds to almost nothing.
      raw.set(pixels.subarray(y * rowBytes, (y + 1) * rowBytes), y * (rowBytes + 1) + 1);
    }
    const header = new Uint8Array(13);
    const hv = new DataView(header.buffer);
    hv.setUint32(0, width);
    hv.setUint32(4, height);
    header[8] = 8; // bit depth
    header[9] = 2; // truecolour
    const data = deflateSync(raw, { level: 6 });
    const parts = [
      PNG_SIGNATURE,
      chunk("IHDR", header),
      chunk("IDAT", data),
      chunk("IEND", new Uint8Array(0)),
    ];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
}

/** Width of `str` in pixels at `size`, with `tracking` ems between characters. */
export function textWidth(font: Font, str: string, size: number, tracking = 0): number {
  const scale = size / font.unitsPerEm;
  let w = 0;
  let n = 0;
  for (const ch of str) {
    w += font.glyph(ch.codePointAt(0) as number).advance * scale;
    n++;
  }
  return w + Math.max(0, n - 1) * tracking * size;
}

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, Bun.hash.crc32(out.subarray(4, 8 + data.length)));
  return out;
}
