/**
 * Opens a board row's odds history (components/odds-history.ts): hover with a
 * mouse, focus from the keyboard, tap on touch. Delegated from the document,
 * so the planner's boards, drawn after load, need no rewiring. Escape or a tap
 * elsewhere closes it. The card opens below the cell, so it never covers the
 * row's own number; it flips above when the viewport has no room below.
 *
 * A board marked data-history-src (the route page) ships its cells without
 * cards; the first open fetches that board once and draws every card from it.
 */
import type { RouteFlightBoard } from "../api/route-flights";
import { oddsCardBody, oddsCardId, oddsCardShell } from "../components/odds-history";

const OPEN_DELAY_MS = 80;
const CLOSE_DELAY_MS = 150;
const GAP_PX = 8;

let wired = false;

const boards = new Map<string, Promise<RouteFlightBoard>>();

function loadBoard(src: string): Promise<RouteFlightBoard> {
  let p = boards.get(src);
  if (!p) {
    p = fetch(src).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<RouteFlightBoard>;
    });
    // A failed load is retried on the next open, not cached.
    p.catch(() => boards.delete(src));
    boards.set(src, p);
  }
  return p;
}

const cardNote = (text: string) => `<p class="text-xs text-muted">${text}</p>`;

/** Draws a lazy row's card: a placeholder now, the history once the board arrives. */
function drawCard(root: HTMLElement, onReady: (card: HTMLElement) => void): HTMLElement | null {
  const src = root.closest<HTMLElement>("[data-history-src]")?.dataset.historySrc;
  const fn = root.dataset.fn;
  if (!src || !fn) return null;
  root.insertAdjacentHTML("beforeend", oddsCardShell(oddsCardId(fn), cardNote("Loading…")));
  const card = root.querySelector<HTMLElement>(".js-odds-card");
  if (!card) return null;
  loadBoard(src)
    .then((board) => {
      const row = board.flights.find((f) => f.flight_number === fn);
      card.innerHTML = row?.history
        ? oddsCardBody(row, row.history)
        : cardNote("No history for this flight.");
    })
    .catch(() => {
      card.remove();
    })
    .finally(() => onReady(card));
  return card;
}

export function wireOddsHistory(): void {
  if (wired) return;
  wired = true;

  let open: HTMLElement | null = null;
  let pinned = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cardOf = (root: HTMLElement) => root.querySelector<HTMLElement>(".js-odds-card");
  const rootOf = (t: EventTarget | null) =>
    t instanceof Element ? t.closest<HTMLElement>(".js-odds-hist") : null;

  function place(root: HTMLElement, card: HTMLElement): void {
    card.classList.add("top-full", "mt-2");
    card.classList.remove("bottom-full", "mb-2");
    const trigger = root.getBoundingClientRect();
    const height = card.offsetHeight;
    if (trigger.bottom + GAP_PX + height > window.innerHeight && trigger.top > height + GAP_PX) {
      card.classList.remove("top-full", "mt-2");
      card.classList.add("bottom-full", "mb-2");
    }
  }

  function hide(): void {
    clearTimeout(timer);
    if (open) {
      const card = cardOf(open);
      if (card) card.hidden = true;
    }
    open = null;
    pinned = false;
  }

  function show(root: HTMLElement, pin: boolean): void {
    clearTimeout(timer);
    if (open !== root) hide();
    const card =
      cardOf(root) ??
      drawCard(root, (drawn) => {
        if (open === root && drawn.isConnected) place(root, drawn);
      });
    if (!card) return;
    card.hidden = false;
    place(root, card);
    open = root;
    pinned = pinned || pin;
  }

  const later = (fn: () => void, ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };

  document.addEventListener("pointerover", (e) => {
    if (e.pointerType !== "mouse") return;
    const root = rootOf(e.target);
    if (root && root !== open) later(() => show(root, false), OPEN_DELAY_MS);
    else if (root) clearTimeout(timer);
  });
  document.addEventListener("pointerout", (e) => {
    if (e.pointerType !== "mouse" || !open || pinned) return;
    if (rootOf(e.relatedTarget) === open) return;
    later(hide, CLOSE_DELAY_MS);
  });
  document.addEventListener("focusin", (e) => {
    const root = rootOf(e.target);
    if (root) show(root, false);
  });
  document.addEventListener("focusout", (e) => {
    if (!open || pinned || rootOf(e.relatedTarget) === open) return;
    hide();
  });
  // A tap focuses (opens) then clicks (pins); a second tap on the cell closes.
  document.addEventListener("click", (e) => {
    const root = rootOf(e.target);
    const onTrigger = e.target instanceof Element && e.target.closest(".js-odds-trigger") !== null;
    if (root && onTrigger) {
      if (open === root && pinned) hide();
      else show(root, true);
      return;
    }
    if (open && root !== open) hide();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && open) hide();
  });
}
