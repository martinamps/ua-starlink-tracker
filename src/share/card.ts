/**
 * The share picture of one page: its subject, the answer in a word or a
 * figure, the page's own sentence, and the date the data behind it was true.
 * 1200x630 PNG, drawn in-process (see raster.ts) in the nightly cards' palette.
 *
 * Every string is drawn as glyph outlines, never as markup, so nothing printed
 * here can break out of anything; `printable` only keeps unknown characters
 * from rendering as boxes.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { Tone } from "../components/ui/tone-classes";
import { Font } from "./font";
import { Canvas, type Rgb, hexRgb, textWidth } from "./raster";

export const SHARE_CARD_WIDTH = 1200;
export const SHARE_CARD_HEIGHT = 630;

export interface ShareCard {
  /** Site label, top left: "UNITED STARLINK TRACKER". */
  label: string;
  domain: string;
  /** Brand accent, "#0ea5e9". */
  accent: string;
  /** YYYY-MM-DD of the data behind the card. */
  asOf: string;
  /** What the page is about: "UA123", "N12345", "ORD". */
  subject: string;
  /** Beside the subject: the date asked about, the aircraft type. */
  context: string | null;
  /** The answer, large: "YES", "74%", "NOT YET". */
  figure: string;
  tone: Tone;
  /** What the figure counts or means, small capitals under it. */
  caption: string | null;
  /** The page's own answer sentence(s). */
  sentence: string;
}

const BG = hexRgb("#0a0f1a");
const RULE = hexRgb("#232c40");
const TEXT = hexRgb("#f3f6fb");
const SECONDARY = hexRgb("#aab6c8");
const MUTED = hexRgb("#7b8aa3");
// index.html's tones. A neutral answer (a plain no) reads in the primary text
// colour, as on the answer card.
const TONE_RGB: Partial<Record<Tone, Rgb>> = {
  success: hexRgb("#22c55e"),
  warn: hexRgb("#f59e0b"),
};

const MARGIN = 64;
const INNER = SHARE_CARD_WIDTH - MARGIN * 2;
const FIGURE_SIZE = 136;
const SENTENCE_SIZE = 24;
const SENTENCE_LINES = 3;

let fonts: { bold: Font; medium: Font } | undefined;

function loadFonts() {
  if (!fonts) {
    const read = (file: string) =>
      new Font(readFileSync(path.join(import.meta.dir, "fonts", file)));
    fonts = {
      bold: read("JetBrainsMono-ExtraBold.ttf"),
      medium: read("JetBrainsMono-Medium.ttf"),
    };
  }
  return fonts;
}

/** Text the font can draw: whitespace runs fold to one space, a character it
 * has no glyph for becomes "?". */
function printable(font: Font, raw: string): string {
  let out = "";
  for (const ch of raw.replace(/\s+/g, " ").trim()) {
    out += font.has(ch.codePointAt(0) as number) ? ch : "?";
  }
  return out;
}

/** The largest size up to `max` at which `str` fits `width`. */
function fitSize(font: Font, str: string, max: number, width: number, tracking = 0): number {
  const at1 = textWidth(font, str, 1, tracking);
  return at1 > 0 ? Math.min(max, width / at1) : max;
}

/**
 * Whole sentences, wrapped, as many as fit: a sentence cut short can turn its
 * meaning ("…lists N1 with Starlink" without the "but"). Only a first sentence
 * too long for the box on its own is cut, at a word, with an ellipsis.
 */
export function wrapSentences(text: string, perLine: number, maxLines: number): string[] {
  const wrap = (s: string): string[] => {
    const lines: string[] = [];
    let line = "";
    for (const word of s.split(" ")) {
      if (!line) line = word;
      else if (line.length + 1 + word.length <= perLine) line += ` ${word}`;
      else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
    return lines;
  };
  // Split after a full stop that ends a word, so "united.com" stays whole.
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  let kept = "";
  for (const s of sentences) {
    const next = kept ? `${kept} ${s}` : s;
    if (wrap(next).length > maxLines) break;
    kept = next;
  }
  if (kept) return wrap(kept);
  const lines = wrap(text).slice(0, maxLines);
  const last = lines.length - 1;
  if (last >= 0) lines[last] = `${(lines[last] as string).slice(0, perLine - 1).trimEnd()}…`;
  return lines;
}

export function drawShareCard(card: ShareCard): Uint8Array {
  const { bold, medium } = loadFonts();
  const canvas = new Canvas(SHARE_CARD_WIDTH, SHARE_CARD_HEIGHT, BG);
  const accent = hexRgb(card.accent);
  const tone = TONE_RGB[card.tone] ?? TEXT;

  canvas.rect(0, 0, 12, SHARE_CARD_HEIGHT, accent);

  canvas.text(medium, printable(medium, card.label.toUpperCase()), MARGIN, 80, 22, MUTED, 0.32);

  const subject = printable(bold, card.subject);
  const subjectSize = fitSize(bold, subject, 76, INNER * 0.6);
  canvas.text(bold, subject, MARGIN, 172, subjectSize, TEXT);
  if (card.context) {
    const x = MARGIN + textWidth(bold, subject, subjectSize) + 28;
    const context = printable(medium, card.context);
    const size = fitSize(medium, context, 30, SHARE_CARD_WIDTH - MARGIN - x);
    canvas.text(medium, context, x, 172, size, MUTED);
  }

  const figure = printable(bold, card.figure.toUpperCase());
  const figureSize = fitSize(bold, figure, FIGURE_SIZE, INNER, -0.02);
  // Sit every figure on one cap-height band, so a long one that was scaled
  // down doesn't float above the caption.
  const figureBase = 226 + (FIGURE_SIZE * bold.capHeight) / bold.unitsPerEm;
  canvas.text(bold, figure, MARGIN - figureSize * 0.02, figureBase, figureSize, tone, -0.02);

  canvas.roundRect(MARGIN, figureBase + 24, 420, 5, 3, accent);
  let y = figureBase + 68;
  if (card.caption) {
    const caption = printable(medium, card.caption.toUpperCase());
    canvas.text(medium, caption, MARGIN, y, fitSize(medium, caption, 22, INNER, 0.22), MUTED, 0.22);
    y += 42;
  }

  const perLine = Math.floor(INNER / textWidth(medium, "0", SENTENCE_SIZE));
  for (const line of wrapSentences(printable(medium, card.sentence), perLine, SENTENCE_LINES)) {
    canvas.text(medium, line, MARGIN, y, SENTENCE_SIZE, SECONDARY);
    y += 34;
  }

  canvas.rect(MARGIN, 542, INNER, 1, RULE);
  canvas.text(medium, printable(medium, card.domain), MARGIN, 586, 20, MUTED, 0.04);
  const stamp = `AS OF ${card.asOf}`;
  const stampWidth = textWidth(medium, stamp, 20, 0.12);
  canvas.text(medium, stamp, SHARE_CARD_WIDTH - MARGIN - stampWidth, 586, 20, TEXT, 0.12);

  return canvas.png();
}
