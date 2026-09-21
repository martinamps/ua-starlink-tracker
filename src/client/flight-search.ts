/**
 * Browser behavior for every FlightSearchForm (see its header for the modes).
 * Permalink forms normalize the typed number with the router's own rules and
 * navigate; check-any forms ask /api/check-any-flight and print the verdict.
 */
import {
  type FlightInputRules,
  canonicalFlightFor,
  canonicalFlightInput,
} from "../airlines/flight-input";
import { probLabel } from "../components/ui/format";
import { esc } from "./esc";

/** The viewer's local calendar day; toISOString() is the UTC day, which is
 * already tomorrow for US evenings. */
const localToday = () => new Date().toLocaleDateString("en-CA");

function permalinkFor(rules: FlightInputRules, raw: string, date: string): string {
  // An unparseable entry still goes to the router, which explains itself.
  const fn = canonicalFlightFor(rules, raw) ?? canonicalFlightInput(raw);
  return `/check-flight/${encodeURIComponent(fn)}${date ? `/${encodeURIComponent(date)}` : ""}`;
}

interface CheckAnyBody {
  error?: string;
  hasStarlink?: boolean | null;
  probability?: number;
  basis?: unknown;
  airline?: string;
  reason?: string;
  message?: string;
}

/**
 * One line for a check-any answer. A firm yes or no leads; a probability with
 * a basis is a floor ("≥40%"), without one an estimate ("~40%"). Community
 * answers state only a firm yes: everything else is the server's own sentence.
 */
function checkAnyHtml(d: CheckAnyBody, community: boolean): string {
  if (d.error) return `<span class="text-warn">${esc(d.error)}</span>`;
  const sentence = esc(d.reason || d.message || "");
  if (community) {
    return `${d.hasStarlink === true ? '<span class="text-success">Starlink (likely)</span> · ' : ""}${sentence}`;
  }
  const p = typeof d.probability === "number" ? d.probability : null;
  const [label, cls] =
    d.hasStarlink === true
      ? ["Starlink", "text-success"]
      : d.hasStarlink === false
        ? ["No Starlink", "text-muted"]
        : p !== null && d.basis && p === 0
          ? ["Unlikely", "text-muted"]
          : p !== null && d.basis
            ? [`≥${Math.floor(p * 100)}% Starlink`, "text-accent"]
            : p !== null
              ? [`~${probLabel(p)} Starlink`, "text-accent"]
              : ["Unknown", "text-muted"];
  return `<span class="${cls}">${label}</span> · ${esc(d.airline || "")} · ${sentence}`;
}

function wireCheckAny(form: HTMLFormElement): void {
  const out = document.getElementById(`${form.id}-result`);
  if (!out) return;
  const community = form.dataset.answer === "community";
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const params = new URLSearchParams();
    new FormData(form).forEach((v, k) => {
      if (v) params.set(k, String(v));
    });
    out.classList.remove("hidden");
    out.textContent = "Checking…";
    fetch(`/api/check-any-flight?${params}`)
      .then((r) => r.json() as Promise<CheckAnyBody>)
      .then((d) => {
        out.innerHTML = checkAnyHtml(d, community);
      })
      .catch(() => {
        out.textContent = "Lookup failed.";
      });
  });
}

export function wireFlightSearchForms(): void {
  for (const el of Array.from(document.querySelectorAll("form[data-flight-search]"))) {
    const form = el as HTMLFormElement;
    // Wired once even when a page loads the script twice.
    if (form.dataset.wired !== undefined) continue;
    form.dataset.wired = "";
    const number = form.querySelector('input[name="flight_number"]') as HTMLInputElement | null;
    const date = form.querySelector('input[name="date"]') as HTMLInputElement | null;
    if (!number) continue;
    if (date && !date.value && form.dataset.prefillDate !== undefined) date.value = localToday();
    const mode = form.dataset.flightSearch;
    if (mode === "check-any") {
      wireCheckAny(form);
      continue;
    }
    if (mode !== "permalink") continue;
    let rules: FlightInputRules;
    try {
      rules = JSON.parse(form.dataset.rules ?? "");
    } catch {
      continue;
    }
    form.addEventListener("submit", (e: Event) => {
      e.preventDefault();
      const raw = number.value.trim();
      if (!raw) {
        number.focus();
        return;
      }
      window.location.href = permalinkFor(rules, raw, date?.value ?? "");
    });
  }
}
