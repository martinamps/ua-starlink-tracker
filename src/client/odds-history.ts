/**
 * Opens a board row's odds history (components/odds-history.ts): hover with a
 * mouse, focus from the keyboard, tap on touch. Delegated from the document,
 * so the planner's boards, drawn after load, need no rewiring. Escape or a tap
 * elsewhere closes it. The card opens below the cell, so it never covers the
 * row's own number; it flips above when the viewport has no room below.
 */

const OPEN_DELAY_MS = 80;
const CLOSE_DELAY_MS = 150;
const GAP_PX = 8;

let wired = false;

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
    const card = cardOf(root);
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
