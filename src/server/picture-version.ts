/**
 * Content versions for the pictures the daily picture job redraws
 * (`static/social-image*.webp`, `static/share-card-*.png`).
 *
 * Their names are fixed — the job overwrites them and committed pages, chat
 * apps and other sites already point at those names — so the version rides a
 * query string the handlers ignore. Cloudflare keys its cache on the query, so
 * a redrawn file gets a fresh address on the first page rendered after the
 * deploy instead of waiting out the edge's copy of the bare name. The bare
 * name keeps answering, under DAILY_PICTURE_CACHE.
 */

import fs from "node:fs";
import path from "node:path";
import { CACHE } from "./respond";

/** Basenames the picture job writes. Anything else under /static keeps its own policy. */
const DAILY_PICTURE = /^(?:social-image(?:-[a-z]+)?\.webp|share-card-[a-z]+\.png)$/;

export const isDailyPicture = (basename: string): boolean => DAILY_PICTURE.test(basename);

/**
 * An hour, not a day: a link cached before this change, or pasted from an old
 * page, asks for the bare name, and must reach the redrawn file within the
 * hour of a deploy. The versioned address changes with the bytes, so it needs
 * no longer life to be right.
 */
export const DAILY_PICTURE_CACHE = CACHE.hour;

const memo = new Map<string, { stamp: string; version: string }>();

/**
 * `urlPath` with `?v=<hash of the file's bytes>`, or `urlPath` unchanged when
 * the file can't be read. Re-hashed only when mtime or size moves, so a file
 * landing mid-run (dev, or a redraw without a restart) is picked up.
 */
export function versionedPicture(staticDir: string, urlPath: string): string {
  const file = path.join(staticDir, path.basename(urlPath));
  let stamp: string;
  try {
    const s = fs.statSync(file);
    stamp = `${s.mtimeMs}:${s.size}`;
  } catch {
    return urlPath;
  }
  let held = memo.get(file);
  if (held?.stamp !== stamp) {
    try {
      held = { stamp, version: Bun.hash(fs.readFileSync(file)).toString(36) };
    } catch {
      return urlPath;
    }
    memo.set(file, held);
  }
  return `${urlPath}?v=${held.version}`;
}
