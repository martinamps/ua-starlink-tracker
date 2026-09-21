/**
 * The homepage aircraft list (components/home/aircraft-list.tsx): search and
 * subfleet filters over the rendered rows, mirrored into ?q= and ?filter=;
 * "+N" pill expansion; and flight-number tooltips on hover devices.
 */

export const FILTER_BUTTON =
  "js-filter-btn font-mono text-xs px-3 py-2 rounded border transition-all";
export const FILTER_ACTIVE = "bg-accent/20 border-accent text-accent";
export const FILTER_INACTIVE =
  "bg-transparent border-subtle text-secondary hover:border-accent/50 hover:text-accent";

/** A complete US registration (n37502): a miss can jump straight to its /fleet entry. */
const US_TAIL = /^n\d{1,5}[a-z]{0,2}$/;

/** One search term against a row: a route (sfo-lax, sfo-, -lax) or a substring. */
function matchesTerm(term: string, row: HTMLElement): boolean {
  const d = row.dataset;
  const routes = (d.routes || "").split(" ");
  if (/^[a-z]{3}-[a-z]{3}$/.test(term)) return routes.includes(term);
  if (/^[a-z]{3}-$/.test(term)) return routes.some((r) => r.startsWith(term));
  if (/^-[a-z]{3}$/.test(term)) return routes.some((r) => r.endsWith(term));
  return [d.tail, d.aircraft, d.operator, d.airports, d.flights].some((v) =>
    (v || "").includes(term)
  );
}

function wireSearch(): void {
  const input = document.getElementById("aircraft-search") as HTMLInputElement | null;
  const clear = document.getElementById("search-clear");
  const count = document.getElementById("search-count");
  const empty = document.getElementById("list-empty");
  const fleetLink = document.getElementById("list-empty-fleet") as HTMLAnchorElement | null;
  const rows = Array.from(document.querySelectorAll<HTMLElement>(".js-aircraft-row"));
  const buttons = Array.from(document.querySelectorAll<HTMLElement>(".js-filter-btn"));
  const params = new URLSearchParams(window.location.search);
  let filter = params.get("filter") || "all";

  const paintButtons = () => {
    for (const b of buttons) {
      b.className = `${FILTER_BUTTON} ${b.dataset.filter === filter ? FILTER_ACTIVE : FILTER_INACTIVE}`;
    }
  };

  const apply = () => {
    const query = (input?.value || "").toLowerCase().trim();
    const terms = query.split(/\s+/).filter(Boolean);
    let visible = 0;
    for (const row of rows) {
      const show =
        terms.every((t) => matchesTerm(t, row)) &&
        (filter === "all" || row.dataset.fleet === filter || row.dataset.airline === filter);
      row.style.display = show ? "" : "none";
      if (show) visible++;
    }
    if (count) {
      const filtered = query || filter !== "all";
      count.textContent = filtered ? `${visible} of ${rows.length}` : count.dataset.default || "";
      count.style.display = count.textContent ? "" : "none";
    }
    if (empty) empty.hidden = visible > 0 || rows.length === 0;
    if (fleetLink) {
      const base = fleetLink.dataset.href || "/fleet";
      fleetLink.href = US_TAIL.test(query) ? `${base}#t-${query.toUpperCase()}` : base;
    }
    clear?.classList.toggle("hidden", !query);
    const url = new URL(window.location.href);
    if (query) url.searchParams.set("q", query);
    else url.searchParams.delete("q");
    if (filter !== "all") url.searchParams.set("filter", filter);
    else url.searchParams.delete("filter");
    window.history.replaceState({}, "", url);
  };

  if (input) {
    input.value = params.get("q") || input.value;
    input.addEventListener("input", apply);
  }
  if (params.get("filter")) paintButtons();
  apply();

  clear?.addEventListener("click", () => {
    if (!input) return;
    input.value = "";
    input.focus();
    apply();
  });
  document.addEventListener("keydown", (e) => {
    const active = document.activeElement;
    if (
      e.key === "/" &&
      active !== input &&
      !["INPUT", "TEXTAREA"].includes(active?.tagName ?? "")
    ) {
      e.preventDefault();
      input?.focus();
    }
    if (e.key === "Escape" && input && active === input) {
      input.value = "";
      input.blur();
      apply();
    }
  });
  for (const b of buttons) {
    b.addEventListener("click", () => {
      filter = b.dataset.filter || "all";
      paintButtons();
      apply();
    });
  }
}

function wireExpand(): void {
  document.addEventListener("click", (e) => {
    const btn = (e.target as Element | null)?.closest?.(".expand-flights");
    const row = btn?.closest('[id^="flights-"]');
    if (!btn || !row) return;
    const expanded = row.hasAttribute("data-expanded");
    if (expanded) row.removeAttribute("data-expanded");
    else row.setAttribute("data-expanded", "");
    btn.setAttribute("aria-expanded", expanded ? "false" : "true");
  });
}

/** Flight-number tooltips, only where there is hover (not touch). */
function wireTooltips(): void {
  if (!window.matchMedia("(hover: hover)").matches) return;
  let tip: HTMLDivElement | null = null;
  let current: Element | null = null;
  const remove = () => {
    tip?.remove();
    tip = null;
  };
  document.addEventListener("mouseover", (e) => {
    const pill = (e.target as Element | null)?.closest?.(
      "[data-flight-tooltip]"
    ) as HTMLElement | null;
    if (!pill || pill === current) return;
    remove();
    current = pill;
    const text = pill.dataset.flightTooltip;
    if (!text) return;
    tip = document.createElement("div");
    tip.textContent = text;
    tip.style.cssText =
      "position:fixed;padding:4px 8px;background:var(--color-accent);color:var(--color-base);font-size:11px;font-weight:600;font-family:var(--font-mono);border-radius:4px;pointer-events:none;z-index:9999;white-space:nowrap;box-shadow:0 4px 6px rgba(0,0,0,0.3);";
    document.body.appendChild(tip);
    const rect = pill.getBoundingClientRect();
    tip.style.left = `${rect.left + rect.width / 2 - tip.offsetWidth / 2}px`;
    tip.style.top = `${rect.top - tip.offsetHeight - 6}px`;
  });
  document.addEventListener("mouseout", (e) => {
    const pill = (e.target as Element | null)?.closest?.("[data-flight-tooltip]");
    if (!pill) return;
    const related = e.relatedTarget as Node | null;
    if (related && pill.contains(related)) return;
    remove();
    current = null;
  });
}

export function wireAircraftList(): void {
  wireSearch();
  wireExpand();
  wireTooltips();
}
