/**
 * Pull a page's own publication date out of its markup.
 *
 * This is what turns `asOf` from an assertion into a checkable claim. Five of
 * the thirteen citation blockers on this branch were dates nobody could have
 * derived from the cited page — 44, 46, 63, 90 and 429 days off its actual
 * dateline — and every one of those pages published the real date in machine
 * readable form. Nothing here parses prose: an unfindable date is reported as
 * unfindable, never guessed.
 */

export interface FoundDate {
  iso: string;
  /** Which mechanism produced it — printed in the report so a surprising date
   * can be traced back to the markup that claimed it. */
  via: string;
}

/**
 * EVERY date the page declares, best evidence first — not just one.
 *
 * A page does not have "a date". A news article carries a publication date AND
 * an update date, and a claim may honestly be dated to either: the Hawaiian
 * citation is dated to the day its article was revised, which is the correct
 * date for what the fact says, and a single-date model calls that 331 days
 * wrong. A press-release page carries a `<time>` for the release and often
 * another for the teaser above it, and taking the first one called the LATAM
 * citation 280 days wrong when it is exact. So the caller compares `asOf`
 * against the whole set and matches any of them; the first entry is what gets
 * reported when none matches, because it is the page's best claim about itself.
 */
export function extractPublishedDates(html: string): FoundDate[] {
  const found: FoundDate[] = [
    ...fromJsonLd(html),
    ...fromMeta(
      html,
      /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)/gi
    ),
    ...fromMeta(
      html,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']article:(?:published|modified)_time["']/gi
    ),
    ...fromMeta(
      html,
      /<meta[^>]+itemprop=["']date(?:Published|Modified)["'][^>]+content=["']([^"']+)/gi
    ),
    ...fromMeta(
      html,
      /<meta[^>]+name=["'](?:date|pubdate|publish-date|last-modified)["'][^>]+content=["']([^"']+)/gi
    ),
    // Bounded: a listing page can carry dozens of teaser <time> elements, and
    // "some date on the page matches" stops being evidence past a handful.
    ...fromMeta(html, /<time[^>]+datetime=["']([^"']+)/gi).slice(0, 8),
  ];
  const seen = new Set<string>();
  return found.filter((d) => !seen.has(d.iso) && seen.add(d.iso));
}

/** The page's single best claim about its own date, or null. */
export function extractPublishedDate(html: string): FoundDate | null {
  return extractPublishedDates(html)[0] ?? null;
}

function fromMeta(html: string, re: RegExp): FoundDate[] {
  const out: FoundDate[] = [];
  for (const m of html.matchAll(re)) {
    const iso = toIso(m[1]);
    if (iso) out.push({ iso, via: re.source.slice(0, 36) });
  }
  return out;
}

/** JSON-LD carries the date a publisher actually stands behind, and every
 * mis-dated citation in the review had one. Blocks are scanned individually so
 * a single unparseable graph doesn't hide the rest. */
function fromJsonLd(html: string): FoundDate[] {
  const blocks = [
    ...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi),
  ].map((m) => m[1]);
  const out: FoundDate[] = [];
  for (const key of ["datePublished", "dateCreated", "dateModified"]) {
    for (const block of blocks) {
      const iso = toIso(findKey(block, key));
      if (iso) out.push({ iso, via: `json-ld ${key}` });
    }
  }
  return out;
}

/** Regex rather than JSON.parse: real-world JSON-LD blocks are frequently
 * malformed (unescaped quotes in descriptions), and a throw would lose the
 * date the block does carry. */
function findKey(json: string, key: string): string | undefined {
  return json.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`))?.[1];
}

function toIso(raw: string | undefined): string | null {
  if (!raw) return null;
  const t = Date.parse(raw.trim());
  if (!Number.isFinite(t)) return null;
  const iso = new Date(t).toISOString().slice(0, 10);
  // A "publication date" in the future, or before the web, is markup noise.
  const year = Number(iso.slice(0, 4));
  if (year < 1995 || t > Date.now() + 86_400_000) return null;
  return iso;
}

/**
 * Days between an `asOf` and the source's own date. Month-precision `asOf`
 * ("2025-11") is measured from the closest day in that month, because a fact
 * that says "November 2025" of a release dated Nov 17 is not 16 days wrong.
 */
export function dateSkewDays(asOf: string, sourceIso: string): number {
  const source = Date.parse(sourceIso);
  if (/^\d{4}-\d{2}$/.test(asOf)) {
    const start = Date.parse(`${asOf}-01`);
    const end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + 1);
    if (source >= start && source < end.getTime()) return 0;
    const nearest = source < start ? start : end.getTime() - 86_400_000;
    return Math.round(Math.abs(source - nearest) / 86_400_000);
  }
  return Math.round(Math.abs(source - Date.parse(asOf)) / 86_400_000);
}
