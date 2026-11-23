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
  confidence?: string;
  basis?: unknown;
  airline?: string;
  reason?: string;
  message?: string;
}

/**
 * One line for a check-any answer. A firm yes or no leads; a probability with
 * a basis is a floor ("≥40%"), without one an estimate ("40%"). Community
 * answers state only a firm yes: everything else is the server's own sentence.
 */
function checkAnyHtml(d: CheckAnyBody, community: boolean): string {
  if (d.error) return `<span class="text-warn">${esc(d.error)}</span>`;
  const sentence = esc(d.reason || d.message || "");
  if (community) {
    return `${d.hasStarlink === true ? '<span class="text-success">Starlink (listed, not yet verified)</span> · ' : ""}${sentence}`;
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
              ? [`${probLabel(p)} Starlink`, "text-accent"]
              : d.confidence === "type"
                ? ["Depends on aircraft", "text-muted"]
                : ["Unknown", "text-muted"];
  return `<span class="${cls}">${label}</span> · ${esc(d.airline || "")} · ${sentence}`;
}

export type CheckPages = Record<string, { url: string; site: string }>;

/**
 * The hub answers from stored schedules alone; the airline's own page names
 * the aircraft and re-checks close to departure, so a hub answer hands off to it.
 */
export function checkPageLink(
  d: CheckAnyBody,
  pages: CheckPages,
  raw: string,
  date: string
): string {
  const page = d.airline ? pages[d.airline] : undefined;
  const fn = canonicalFlightInput(raw);
  if (!page || d.error || !/^[A-Z0-9]+$/.test(fn)) return "";
  const href = `${page.url}/${encodeURIComponent(fn)}/${encodeURIComponent(date)}`;
  return `<a href="${esc(href)}" class="mt-1 block py-2 text-accent hover:underline">See ${esc(fn)} on ${esc(page.site)} →</a>`;
}

/** An error on an entry that isn't code-plus-number shaped ("hello", "1736")
 * gets a worked example; a well-formed number of an untracked airline does not. */
export function shapeHint(raw: string, example: string): string {
  if (!example || /^[A-Z][A-Z0-9]{1,2}\d{1,4}$/.test(canonicalFlightInput(raw))) return "";
  return `<span class="block text-muted">Type the airline code and number together, like ${esc(example)}.</span>`;
}

function wireCheckAny(form: HTMLFormElement): void {
  const out = document.getElementById(`${form.id}-result`);
  if (!out) return;
  const community = form.dataset.answer === "community";
  let pages: CheckPages = {};
  try {
    pages = JSON.parse(form.dataset.checkPages ?? "{}");
  } catch {
    // No hand-off links; the answer itself still prints.
  }
  const number = form.querySelector('input[name="flight_number"]') as HTMLInputElement | null;
  const button = form.querySelector('button[type="submit"]') as HTMLButtonElement | null;
  // The placeholder lists real examples ("UA1736, HA51…"); the first one is the hint.
  const example = number?.placeholder.split(",")[0].replace(/…$/, "").trim() ?? "";
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const params = new URLSearchParams();
    new FormData(form).forEach((v, k) => {
      if (v) params.set(k, String(v));
    });
    const typed = params.get("flight_number") ?? "";
    // Submitting from the keyboard leaves it open over the answer on a phone.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    out.classList.remove("hidden");
    out.textContent = "Checking…";
    out.setAttribute("aria-busy", "true");
    if (button) button.disabled = true;
    fetch(`/api/check-any-flight?${params}`)
      .then((r) => r.json() as Promise<CheckAnyBody>)
      .then((d) => {
        out.innerHTML =
          checkAnyHtml(d, community) +
          (d.error ? shapeHint(typed, example) : "") +
          checkPageLink(d, pages, typed, params.get("date") ?? "");
      })
      .catch(() => {
        out.textContent = "Couldn't get an answer. Check your connection and try again.";
      })
      .finally(() => {
        out.removeAttribute("aria-busy");
        if (button) button.disabled = false;
        out.scrollIntoView({ block: "nearest" });
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
