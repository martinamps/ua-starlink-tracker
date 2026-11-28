/**
 * Previous builds' fingerprinted assets, kept on the data volume so a page
 * rendered by one build keeps working after the next deploy.
 *
 * The server bundles its scripts at boot and holds only the current build in
 * memory, so a deploy that changes a bundle made the old name 404 at once. A
 * page already open still asks for it: the route planner fetches the airport
 * picker only when a box is first touched, and the not-found page is stored at
 * the edge for an hour with the previous build's names in it. Measured on a
 * stand-in deploy, the open planner then found no airports for "Chicago".
 *
 * Every build writes its assets here under their own names. A name is the
 * hash of its bytes, so a file never changes and two containers running side
 * by side during a deploy can both write without harm. A running build
 * re-stamps its own files every hour, so a file's mtime is the last time some
 * build served it as current; boot prunes what no build has served for
 * KEEP_MS. That keeps a previous build's files for a week after it stopped
 * serving, however long it ran. About 200 KB per deploy that changes
 * everything, so a busy week stays within tens of MB.
 */
import fs from "node:fs";
import path from "node:path";
import { ASSET_ARCHIVE_DIR } from "../utils/constants";
import { error as logError } from "../utils/logger";

/** The address shape every fingerprinted asset has: one segment, name.hash.ext. */
export const FINGERPRINTED_ASSET = /^\/static\/[a-z0-9-]+\.[0-9a-z]+\.(?:js|css|svg)$/;

const KEEP_MS = 7 * 24 * 3600 * 1000;
const RESTAMP_MS = 3600 * 1000;

const TYPES: Record<string, string> = {
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
};

export interface AssetArchive {
  /** Store a current asset under its fingerprinted href and mark it current. */
  keep(href: string, body: string | Uint8Array): void;
  /** The stored file for a fingerprinted pathname, or null. */
  find(pathname: string): { file: string; contentType: string } | null;
}

export function openAssetArchive(
  dir: string,
  opts: { keepMs?: number; now?: () => number } = {}
): AssetArchive {
  const keepMs = opts.keepMs ?? KEEP_MS;
  const now = opts.now ?? Date.now;
  const current = new Set<string>();
  let restamp: ReturnType<typeof setInterval> | null = null;

  const stamp = (file: string) => {
    const t = new Date(now());
    fs.utimesSync(file, t, t);
  };

  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      const stat = fs.statSync(file);
      if (stat.isFile() && now() - stat.mtimeMs > keepMs) fs.rmSync(file, { force: true });
    }
  } catch (err) {
    logError(`Asset archive at ${dir} could not be pruned`, err);
  }

  return {
    keep(href, body) {
      if (!FINGERPRINTED_ASSET.test(href)) return;
      const file = path.join(dir, path.basename(href));
      try {
        if (!fs.existsSync(file)) {
          // Written whole then renamed, so a reader never sees half a file.
          const tmp = `${file}.${process.pid}.tmp`;
          fs.writeFileSync(tmp, body);
          fs.renameSync(tmp, file);
        }
        stamp(file);
        current.add(file);
      } catch (err) {
        logError(`Asset archive could not keep ${href}`, err);
        return;
      }
      restamp ??= setInterval(() => {
        for (const f of current) {
          try {
            stamp(f);
          } catch (err) {
            logError(`Asset archive could not restamp ${f}`, err);
          }
        }
      }, RESTAMP_MS);
      restamp.unref?.();
    },
    find(pathname) {
      if (!FINGERPRINTED_ASSET.test(pathname)) return null;
      const name = path.basename(pathname);
      const file = path.join(dir, name);
      const contentType = TYPES[path.extname(name).slice(1)];
      if (!contentType) return null;
      try {
        return fs.statSync(file).isFile() ? { file, contentType } : null;
      } catch {
        return null;
      }
    },
  };
}

/** The process's archive; null where none is configured (dev and tests). */
export const assetArchive: AssetArchive | null = ASSET_ARCHIVE_DIR
  ? openAssetArchive(ASSET_ARCHIVE_DIR)
  : null;
