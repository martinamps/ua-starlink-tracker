/**
 * Hosts that refuse automated clients, and the reason each one is here.
 *
 * A citation on one of these hosts cannot be machine-verified, so
 * verify-citations reports it as SKIPPED — never as a pass. That distinction is
 * the whole point: nine of the fifty citations on this branch were unreadable
 * by any client at review time, and because nothing said so, "unverified" and
 * "verified" looked identical in the output.
 *
 * Adding a host here is a deliberate, dated exception. Every entry must say
 * what was actually observed (which clients, which status), and how the claims
 * resting on it were confirmed instead — because a citation nobody has read is
 * not a receipt, it is a hope. `tests/citation-integrity.test.ts` fails when an
 * entry goes stale, when its confirmation ages past MAX_CONFIRMATION_AGE_DAYS,
 * or when a host sits here that no citation uses any more.
 *
 * Before adding: try `bun run verify-citations --audit-allowlist`, which
 * re-fetches every blocked host to see whether the block has lifted. Prefer
 * adding a `source.mirror` (an archive snapshot) over adding a host here — a
 * mirror keeps the claim checkable by both the script and the reader.
 *
 * THIS LIST IS FOR HOSTS THAT REFUSE, not for sources that are merely awkward.
 * A host answering 200 with a PDF, or with a shell that renders its text in the
 * browser, is reported as UNREAD — a separate, louder finding, because unlike a
 * 403 it currently looks checked. The fix for those is a mirror or a different
 * URL. Allowlisting one would convert a fixable problem into a standing
 * exemption, which is the opposite of what this file is for.
 */

export interface BlockedHost {
  /** What the host does to an automated client, in one line. */
  reason: string;
  /** What was actually observed, with which clients. Evidence, not assertion. */
  evidence: string;
  /** When this host was first found to be blocking (YYYY-MM-DD). */
  addedOn: string;
  /** When a human last confirmed the claims resting on it, by opening the page
   * in a real browser. This is the date that expires. */
  claimsConfirmedOn: string;
  /** How they were confirmed — which client, or which corroborating source. */
  claimsConfirmedBy: string;
}

/**
 * An unverifiable citation is a recurring obligation, not a permanent hole:
 * past this many days, the offline test fails until someone re-opens the page
 * and re-dates the entry (or replaces the citation with a readable one).
 */
export const MAX_CONFIRMATION_AGE_DAYS = 180;

export const BLOCKED_HOSTS: Record<string, BlockedHost> = {
  "www.qatarairways.com": {
    reason: "Bot protection drops the connection before any response.",
    evidence:
      "curl exits 000 (empty reply) on browser, Googlebot and mobile UAs over both HTTP/1.1 and HTTP/2; WebFetch returns 403. No Wayback snapshot exists for the release.",
    addedOn: "2026-08-31",
    claimsConfirmedOn: "2026-08-31",
    claimsConfirmedBy:
      "Read end-to-end through a non-curl client during the citation review; both Qatar facts (777/A350 programme completion, Privilege Club access) matched the release text.",
  },
  "news.aa.com": {
    reason: "Returns 403 to curl-family clients; readable in a browser.",
    evidence:
      "403 to curl on every UA tried, including Googlebot. The same URL renders normally in a browser and through WebFetch, so the page is live and indexed — this is edge filtering, not link rot.",
    addedOn: "2026-08-31",
    claimsConfirmedOn: "2026-08-31",
    claimsConfirmedBy:
      "Read through a browser-class client during the citation review; the 900-aircraft and 100%-narrowbody figures were checked against the release's own wording.",
  },
};

/**
 * Hosts that used to be here and are no longer cited by anything. Kept as a
 * record so the next person to reach for one of these URLs knows what happened
 * rather than rediscovering the block — but deliberately NOT in BLOCKED_HOSTS,
 * because an allowlist entry that protects nothing is just noise that ages.
 * If a citation on one of these returns, promote it back with fresh evidence.
 */
export const RETIRED_BLOCKS: Record<string, string> = {
  "runwaygirlnetwork.com":
    "403 to every automated client (browser UA, Googlebot UA, REST API, RSS). Six citations replaced with readable sources during the 2026-08-31 citation pass.",
  "www.flysas.com":
    "403 domain-wide to automated clients. Replaced with sasgroup.net, which serves the same announcements.",
  "www.etihad.com":
    "Connection-layer timeouts. Replaced with the identical release on Viasat's newsroom.",
  "corporate.airfrance.com":
    "Cloudflare interstitial, and the cited path may never have resolved. Replaced during the same pass.",
};
