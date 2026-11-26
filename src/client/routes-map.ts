/**
 * Taps on the /routes map by finger, and any click at phone widths. The server's links alone can't be
 * trusted there: most dots are 2 to 4 px wide, and the browser moves a tap to
 * whichever link it finds near the finger, so a tap on Dulles opened Newark.
 * This reads where the finger really landed (the pointer event, which the
 * browser doesn't move) and decides itself: one airport under the finger
 * opens; several are offered by code in a small chooser; none does nothing.
 * It never opens an airport the finger wasn't on.
 *
 * A mouse on a wider screen keeps the server's links untouched, and so does a
 * link activated with no pointer (keyboard, most screen readers). A finger is
 * caught at every width: a phone held sideways is wider than `sm`.
 */
import {
  CHOOSER_MAX,
  FINGER_RADIUS_PX,
  type MapDot,
  airportsUnderTap,
  tapIsOurs,
} from "./routes-map-pick";

/** Tailwind's `sm`: from here up a mouse click is the server's own links'. */
const WIDE = "(min-width: 40rem)";
/** A click this soon after a pointerup on the map is that tap's click. */
const TAP_FRESH_MS = 1000;
const GAP_PX = 8;

const CHIP =
  "flex min-h-11 flex-col items-center justify-center rounded border border-neutral bg-surface px-1 font-mono text-sm leading-tight text-primary transition-colors hover:border-accent hover:text-accent focus:outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/50";
const CHIP_COUNT = "text-xs text-muted tabular-nums";

type Dot = MapDot & { link: SVGAElement };

export function wireRoutesMap(): void {
  const map = document.querySelector<HTMLElement>(".js-map");
  const svg = map?.querySelector("svg");
  const chooser = document.querySelector<HTMLDialogElement>(".js-map-chooser");
  const list = chooser?.querySelector<HTMLElement>(".js-map-chooser-list");
  const more = chooser?.querySelector<HTMLElement>(".js-map-chooser-more");
  const ring = map?.querySelector<HTMLElement>(".js-map-ring");
  if (!map || !svg || !chooser || !list || !more || !ring) return;
  wire(map, svg, chooser, list, more, ring);
}

function wire(
  map: HTMLElement,
  svg: SVGSVGElement,
  chooser: HTMLDialogElement,
  list: HTMLElement,
  more: HTMLElement,
  ring: HTMLElement
): void {
  const allAirports = document.querySelector<HTMLDetailsElement>(".js-map-list");
  const all = chooser.querySelector<HTMLElement>(".js-map-chooser-all");
  const wide = matchMedia(WIDE);
  const links = [...svg.querySelectorAll<SVGAElement>('a[href^="/routes/"]')];
  const codeOf = (link: Element) => (link.getAttribute("href") ?? "").slice("/routes/".length);

  /** Dot centres in viewport pixels, read fresh: the map scales with the page. */
  function dots(): Dot[] {
    const box = svg.getBoundingClientRect();
    const scale = box.width / svg.viewBox.baseVal.width;
    return links.flatMap((link) => {
      const dot = link.querySelector("circle:last-child");
      if (!dot) return [];
      return {
        code: codeOf(link),
        x: box.left + Number(dot.getAttribute("cx")) * scale,
        y: box.top + Number(dot.getAttribute("cy")) * scale,
        link,
      };
    });
  }

  let marked: SVGAElement[] = [];
  let returnFocus: HTMLElement | null = null;

  function close(restoreFocus = false): void {
    if (!chooser.open) return;
    chooser.open = false;
    ring.hidden = true;
    for (const link of marked) link.removeAttribute("data-near");
    marked = [];
    if (restoreFocus) returnFocus?.focus({ preventScroll: true });
    returnFocus = null;
  }

  function chip(dot: Dot): HTMLAnchorElement {
    const a = document.createElement("a");
    a.href = `/routes/${dot.code}`;
    a.className = CHIP;
    const label = dot.link.getAttribute("aria-label");
    if (label) a.setAttribute("aria-label", label);
    a.append(dot.code);
    // The formatted count the list under the map already carries.
    const count = allAirports?.querySelector(`a[href="/routes/${dot.code}"] span`)?.textContent;
    if (count) {
      const n = document.createElement("span");
      n.className = CHIP_COUNT;
      n.textContent = count;
      a.append(n);
    }
    return a;
  }

  function offer(near: Dot[], x: number, y: number): void {
    close();
    const shown = near.slice(0, CHOOSER_MAX);
    list.replaceChildren(...shown.map(chip));
    const left = near.length - shown.length;
    more.hidden = left === 0;
    // A mouse-first screen with a touch panel hides the list: offer none.
    const listShown = !!allAirports?.getClientRects().length;
    more.textContent =
      left > 0 ? `${left} more under your finger${listShown ? " are in the full list" : ""}.` : "";
    if (all) all.hidden = !listShown;
    marked = near.map((d) => d.link);
    for (const link of marked) link.setAttribute("data-near", "");

    const mapBox = map.getBoundingClientRect();
    ring.style.left = `${x - mapBox.left}px`;
    ring.style.top = `${y - mapBox.top}px`;
    ring.hidden = false;

    chooser.open = true;
    const frame = (chooser.offsetParent ?? map).getBoundingClientRect();
    // Narrower than its frame (wider screens): centred on the tap, kept inside.
    const width = chooser.offsetWidth;
    const room = frame.width - width - 2 * GAP_PX;
    chooser.style.left =
      room > 0
        ? `${GAP_PX + Math.min(Math.max(x - frame.left - width / 2 - GAP_PX, 0), room)}px`
        : "";
    const height = chooser.offsetHeight;
    const below = y + FINGER_RADIUS_PX + GAP_PX;
    const above = y - FINGER_RADIUS_PX - GAP_PX - height;
    // Under the finger's spot unless that runs off the screen and above fits.
    const top = below + height > window.innerHeight && above >= 0 ? above : below;
    chooser.style.top = `${top - frame.top}px`;

    const active = document.activeElement;
    returnFocus = active instanceof HTMLElement && active !== document.body ? active : null;
    list.querySelector<HTMLElement>("a")?.focus({ preventScroll: true });
    chooser.scrollIntoView({ block: "nearest" });
  }

  let tap: { x: number; y: number; at: number; pointer: string } | null = null;
  document.addEventListener(
    "pointerup",
    (e) => {
      const onMap = e.target instanceof Node && map.contains(e.target);
      tap = onMap ? { x: e.clientX, y: e.clientY, at: e.timeStamp, pointer: e.pointerType } : null;
    },
    true
  );
  document.addEventListener("pointercancel", () => {
    tap = null;
  });

  document.addEventListener(
    "click",
    (e) => {
      const fromTap = tap && e.timeStamp - tap.at < TAP_FRESH_MS ? tap : null;
      tap = null;
      if (!tapIsOurs(wide.matches, fromTap?.pointer ?? null)) return;
      const target = e.target instanceof Element ? e.target : null;
      // The click of a tap that began on the map is the map's, wherever the
      // browser then sent it. With no pointer it is the focused link's own.
      if (!fromTap && (e.detail === 0 || !target || !map.contains(target))) return;
      const point = fromTap ?? { x: e.clientX, y: e.clientY };
      const near = airportsUnderTap(dots(), point.x, point.y);
      const only = near.length === 1 ? near[0] : null;
      // The browser's own choice stands when it is the one airport under the
      // finger, so new-tab clicks and the like keep working.
      if (only && target?.closest("a") === (only.link as Element)) return;
      e.preventDefault();
      e.stopPropagation();
      if (only) location.assign(`/routes/${only.code}`);
      else if (near.length > 1) offer(near, point.x, point.y);
      else close();
    },
    true
  );

  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!(e.target instanceof Node && chooser.contains(e.target))) close();
    },
    true
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close(true);
  });
  chooser.addEventListener("focusout", (e) => {
    if (e.relatedTarget instanceof Node && !chooser.contains(e.relatedTarget)) close();
  });
  chooser.querySelector(".js-map-chooser-close")?.addEventListener("click", () => close(true));
  all?.addEventListener("click", () => {
    close();
    if (!allAirports) return;
    allAirports.open = true;
    allAirports.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
    allAirports.scrollIntoView({ block: "nearest" });
  });
  window.addEventListener("resize", () => close());
  // Back from an airport's page, the restored map shouldn't still be asking.
  window.addEventListener("pagehide", () => close());
}
