/**
 * The hub's route comparer: /api/compare-route per airline, one bar each. The
 * form and its preset chips are RouteComparePanel (content/hub.tsx).
 */
import { esc } from "./esc";
import { meterHtml } from "./meter";

interface Breakdown {
  label?: string;
  hint?: string;
  pct: number;
  equipped?: number | null;
  total?: number;
}

interface CompareResult {
  kind: string;
  name: string;
  shortName?: string;
  reason?: string;
  probability: number;
  accentText?: string;
  accentColor?: string;
  routePlannerBase?: string | null;
  breakdown?: Breakdown[];
}

interface CompareBody {
  error?: string;
  origin?: string;
  destination?: string;
  results?: CompareResult[];
}

function pill(href: string, text: string, color: string): string {
  const c = esc(color);
  return `<a href="${esc(href)}" class="ml-2 font-mono text-[9px] px-1.5 py-0.5 rounded-full whitespace-nowrap hover:underline" style="color:${c};background:color-mix(in srgb,${c} 14%,transparent);border:1px solid color-mix(in srgb,${c} 40%,transparent)">${esc(text)} →</a>`;
}

const shorten = (label?: string) =>
  String(label || "")
    .replace(/\s*Fleet$/i, "")
    .trim();

const fleetTip = (a: CompareResult, b: Breakdown) =>
  `${esc(b.total)} ${esc(shorten(b.label))} aircraft in ${esc(a.shortName || a.name)}’s fleet — ${esc(b.equipped)} have Starlink`;

function tip(cls: string, tipText: string, inner: string): string {
  if (!tipText) return `<span class="${cls}">${inner}</span>`;
  return `<span class="${cls} tip" tabindex="0" data-tip="${tipText}">${inner}</span>`;
}

function renderResult(a: CompareResult, O: string, D: string): string {
  const color = a.accentText || a.accentColor || "var(--color-accent)";
  const rp = a.routePlannerBase ? `${a.routePlannerBase}/${O}/${D}` : null;
  if (a.kind === "no_data") {
    return `<div class="mb-3 opacity-60"><div class="flex justify-between items-center font-mono text-xs"><span class="text-muted">${esc(a.name)}${rp ? pill(rp, "check route planner", color) : ""}</span><span class="text-muted">—</span></div><div class="font-mono text-xs text-muted">No route data yet</div></div>`;
  }
  if (a.kind === "observed_mixed") {
    const head = `<div class="flex justify-between items-center font-mono text-xs"><span class="text-primary">${esc(a.name)}</span></div><div class="font-mono text-xs text-muted">${esc(a.reason)}</div>`;
    const rows = (a.breakdown || [])
      .map((b, i) => {
        const pct = Math.round(b.pct * 100);
        const best =
          i === 0 && pct >= 50
            ? ` ${tip("text-[8px] px-1 py-px rounded no-underline", "Pick a flight in this group for the best Starlink odds", `<span style="background:color-mix(in srgb,${esc(color)} 18%,transparent);color:${esc(color)};padding:1px 4px;border-radius:3px">best bet</span>`)}`
            : "";
        const counts = b.equipped != null ? `${esc(b.equipped)}/${esc(b.total)} aircraft · ` : "";
        return `<div class="mt-1.5 ml-3"><div class="flex justify-between font-mono text-xs"><span>${tip("text-secondary", b.hint ? `Flight numbers ${esc(b.hint)}` : "", esc(shorten(b.label)))}${best}</span>${tip("text-accent tip-l", b.equipped != null ? fleetTip(a, b) : "", `${counts}${pct}%`)}</div>${meterHtml(pct / 100, { color })}</div>`;
      })
      .join("");
    return `<div class="mb-3">${head}${rows}</div>`;
  }
  const pct = Math.round(a.probability * 100);
  const first = (a.breakdown || [])[0];
  const pctTip = first && first.equipped != null ? fleetTip(a, first) : "";
  const chip = pct < 50 && a.kind !== "type_rule" && rp ? pill(rp, "try a connection", color) : "";
  return `<div class="mb-3"><div class="flex justify-between items-center font-mono text-xs"><span class="text-primary">${esc(a.name)}${chip}</span>${tip("text-accent tip-l", pctTip, `${pct}%`)}</div><div class="font-mono text-xs text-muted">${esc(a.reason)}</div>${meterHtml(pct / 100, { color, dotted: a.kind === "inferred_absent" })}</div>`;
}

export function wireRouteCompare(): void {
  const form = document.getElementById("hub-compare-route") as HTMLFormElement | null;
  const out = document.getElementById("hub-compare-result");
  if (!form || !out) return;
  const footer = document.getElementById("hub-compare-footer");
  const plannerLink = document.getElementById("hub-compare-rp") as HTMLAnchorElement | null;
  const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;

  const compare = (origin: string, dest: string) => {
    out.classList.remove("hidden");
    out.textContent = "Comparing…";
    fetch(
      `/api/compare-route?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(dest)}`
    )
      .then((r) => r.json() as Promise<CompareBody>)
      .then((d) => {
        if (d.error) {
          out.innerHTML = `<span class="text-warn font-mono text-xs">${esc(d.error)}</span>`;
          return;
        }
        const O = esc((d.origin || "").toUpperCase());
        const D = esc((d.destination || "").toUpperCase());
        out.innerHTML =
          (d.results || []).map((r) => renderResult(r, O, D)).join("") ||
          `<span class="font-mono text-xs text-muted">No tracked airline shows a Starlink-equipped nonstop on ${O} ⇄ ${D} yet.</span>`;
        footer?.classList.remove("hidden");
        // The hub has no planner of its own; United's is the one that exists.
        if (plannerLink)
          plannerLink.href = `${plannerLink.href.replace(/\/route-planner.*$/, "/route-planner")}/${O}/${D}`;
      })
      .catch(() => {
        out.textContent = "Lookup failed.";
      });
  };

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    compare(field("origin").value, field("destination").value);
  });
  for (const btn of Array.from(document.querySelectorAll<HTMLElement>("[data-preset-origin]"))) {
    btn.addEventListener("click", () => {
      const o = btn.dataset.presetOrigin || "";
      const d = btn.dataset.presetDest || "";
      field("origin").value = o;
      field("destination").value = d;
      compare(o, d);
    });
  }
}
