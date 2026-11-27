/**
 * The homepage aircraft list (components/home/aircraft-list.tsx): search and
 * subfleet filters over the rendered rows, mirrored into ?q= and ?filter=,
 * and "+N" pill expansion.
 */

export const FILTER_BUTTON =
  "js-filter-btn font-mono text-xs px-3 py-2 rounded border transition-all";
export const FILTER_ACTIVE = "bg-accent/20 border-accent text-accent";
export const FILTER_INACTIVE =
  "bg-transparent border-neutral text-secondary hover:border-accent hover:text-accent";

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
      const on = b.dataset.filter === filter;
      b.className = `${FILTER_BUTTON} ${on ? FILTER_ACTIVE : FILTER_INACTIVE}`;
      // The chosen filter is otherwise told by colour alone.
      b.setAttribute("aria-pressed", String(on));
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

export function wireAircraftList(): void {
  wireSearch();
  wireExpand();
}
