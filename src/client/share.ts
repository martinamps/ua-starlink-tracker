/**
 * The share control under a flight answer: one link to the answer's own page.
 *
 * It is a plain link, so it works with no script (open it, or long-press to
 * copy). With the script a tap opens the phone's share sheet where the
 * browser has one and the pointer is a finger, and copies the address
 * everywhere else. A desktop browser's share sheet is slower than a copy, so
 * a mouse always copies.
 *
 * Nothing is added to the address: what is shared is the page's canonical
 * URL, with its date and leg, and no marker that follows whoever opens it.
 */
import { esc } from "./esc";

// Matches the calendar buttons in the card it sits in (flight-answer.ts).
const SHARE_BUTTON =
  "inline-flex min-h-11 items-center rounded border border-neutral bg-base px-3 text-sm text-primary transition-colors hover:border-accent hover:text-accent focus:outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/50";

const SHARE_LABEL = "Share this answer";
const COPIED = "Link copied.";

/** How a tap was served: the two words the tap count is split by. */
export type ShareMethod = "sheet" | "copy";

/**
 * The control's markup. The status line sits inside the answer's live region
 * (both callers render into one), so a screen reader hears "Link copied."
 */
export function shareControlHtml(url: string): string {
  return ` <p class="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"><a href="${esc(url)}" rel="nofollow" data-share class="${SHARE_BUTTON}">${SHARE_LABEL}</a> <span data-share-status class="text-secondary"></span></p>`;
}

type ShareData = { title?: string; url: string };
type ShareNavigator = {
  share?: (data: ShareData) => Promise<void>;
  clipboard?: { writeText?: (text: string) => Promise<void> };
};

/** For a page that is not a secure context, where the Clipboard API is absent. */
function legacyCopy(url: string): boolean {
  const field = document.createElement("textarea");
  field.value = url;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.appendChild(field);
  field.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  field.remove();
  return copied;
}

async function copyLink(url: string, nav: ShareNavigator): Promise<boolean> {
  try {
    if (nav.clipboard?.writeText) {
      await nav.clipboard.writeText(url);
      return true;
    }
  } catch {
    // Permission refused or the document lost focus: try the older way.
  }
  return legacyCopy(url);
}

// In pieces so the bundle holds no address a crawler can lift and request.
const TAP_PATH = ["", "static", "share", "tap"];

/** Count the tap: one word, to our own host. Nothing about the page or the visitor is sent. */
function countTap(method: ShareMethod): void {
  try {
    navigator.sendBeacon?.(TAP_PATH.join("/"), method);
  } catch {
    // Counting never gets in the way of sharing.
  }
}

async function onTap(link: HTMLAnchorElement, title: string | undefined): Promise<void> {
  const url = link.href;
  const nav = navigator as unknown as ShareNavigator;
  const status = link.parentElement?.querySelector("[data-share-status]");
  const say = (text: string) => {
    if (status) status.textContent = text;
  };
  say("");
  const finger = window.matchMedia?.("(pointer: coarse)").matches === true;
  if (finger && typeof nav.share === "function") {
    countTap("sheet");
    try {
      await nav.share(title ? { title, url } : { url });
      return;
    } catch (err) {
      // Closing the sheet is an answer; anything else falls through to a copy.
      if ((err as { name?: string } | null)?.name === "AbortError") return;
    }
  } else {
    countTap("copy");
  }
  say((await copyLink(url, nav)) ? COPIED : `Couldn't copy. The link is ${url}`);
}

/**
 * One listener for every share control on the page, present now or rendered
 * later (a live re-check and the hub's answer both replace the markup).
 * `title` is the page's own title, for pages that are the answer shared.
 */
export function wireShareControls(title?: () => string): void {
  document.addEventListener("click", (e) => {
    const link = (e.target as Element | null)?.closest?.(
      "a[data-share]"
    ) as HTMLAnchorElement | null;
    // A modified click keeps its own meaning (new tab, save link), and a
    // script's click() is no tap.
    if (!link || !e.isTrusted || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    void onTap(link, title?.());
  });
}
