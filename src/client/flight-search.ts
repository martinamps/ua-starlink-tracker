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
import { probLabel, shareLabel } from "../components/ui/format";
import { esc } from "./esc";
import { shareControlHtml } from "./share";

/** The viewer's local calendar day; toISOString() is the UTC day, which is
 * already tomorrow for US evenings. */
const localToday = () => new Date().toLocaleDateString("en-CA");

function permalinkFor(rules: FlightInputRules, raw: string, date: string): string {
  // An unparseable entry still goes to the router, which explains itself.
  const fn = canonicalFlightFor(rules, raw) ?? canonicalFlightInput(raw);
  return `/check-flight/${encodeURIComponent(fn)}${date ? `/${encodeURIComponent(date)}` : ""}`;
}

/** The dated fact /api/check-any-flight adds for an airline it doesn't answer
 * by flight (UntrackedAirlineInfo, the part the page prints). */
interface AirlineInfo {
  lead: string;
  dated: string;
  fact: string;
  caveat: string;
  airline: string;
  source: { label: string; url: string };
  page: string;
  how_to_check?: { text: string; source: { label: string; url: string } };
}

/** The server's leads that a label already says (statement-rule.ts): for a
 * route or type its airline's statement covers, and for a type rule with no
 * type stated. The sentence printed after the label drops them. */
const SAID_BY_LABEL = ["Likely yes. ", "It depends on the aircraft. "];

const STATEMENT_LABELS: Record<string, [string, string]> = {
  likely: ["Likely yes", "text-accent"],
  needs_route: ["Route needed", "text-muted"],
  not_covered: ["No answer for this route", "text-muted"],
  needs_type: ["Depends on the aircraft", "text-muted"],
  unclear_type: ["No answer for this aircraft type", "text-muted"],
  other_type: ["No answer for this aircraft type", "text-muted"],
  outside_dates: ["No answer for this date", "text-muted"],
};

export interface CheckAnyBody {
  error?: string;
  airline_info?: AirlineInfo;
  /** An airline answered from its own dated statement, by route. */
  airline_statement?: {
    answer: string;
    source: { label: string; url: string };
    /** "aircraft_type" when the statement is about one type, not routes. */
    by?: string;
  };
  hasStarlink?: boolean | null;
  probability?: number;
  confidence?: string;
  basis?: unknown;
  airline?: string;
  reason?: string;
  message?: string;
  flights?: unknown;
}

/**
 * One line for a check-any answer. A firm yes or no leads; a probability with
 * a basis is a floor ("≥40%"), without one an estimate ("40%"). Community
 * answers state only a firm yes: everything else is the server's own sentence.
 */
// Inside a <p>, so the page's rule for a link in a sentence underlines it at rest.
const sourceLink = (source: { label: string; url: string }) =>
  `<a href="${esc(source.url)}" rel="noopener" class="text-accent hover:underline">${esc(source.label)}</a>`;

/** What is known about an airline with no per-flight answer: never a verdict,
 * so it sits under the refusal in body text, not in a verdict colour. */
export function airlineInfoHtml(info: AirlineInfo): string {
  const how = info.how_to_check
    ? `<p class="mt-2 text-secondary">To check for yourself: ${esc(info.how_to_check.text)} (${sourceLink(info.how_to_check.source)})</p>`
    : "";
  return [
    `<span class="mt-2 block text-primary">${esc(info.lead)}.</span>`,
    `<p class="text-secondary">${esc(info.dated)}: ${esc(info.fact)} (${sourceLink(info.source)})</p>`,
    `<span class="mt-2 block text-muted">${esc(info.caveat)}</span>`,
    how,
    `<a href="${esc(info.page)}" class="mt-1 block py-2 text-accent hover:underline">${esc(info.airline)} and Starlink: every dated fact →</a>`,
  ].join("");
}

/** A number with no flight history behind it is a share of aircraft, and
 * rounds down as the sentence beside it does: a subfleet's share ("type"), or
 * the estimate for a flight number never seen, which this body marks only in
 * its sentence. */
const fleetFigure = (d: CheckAnyBody) =>
  d.confidence === "type" || /No history for \S+ yet/.test(d.reason ?? "");

export function checkAnyHtml(d: CheckAnyBody, community: boolean): string {
  if (d.error) {
    return `<span class="text-warn">${esc(d.error)}</span>${d.airline_info ? airlineInfoHtml(d.airline_info) : ""}`;
  }
  const sentence = esc(d.reason || d.message || "");
  if (community) {
    return `${d.hasStarlink === true ? '<span class="text-success">Starlink (listed, not yet verified)</span> · ' : ""}${sentence}`;
  }
  const stated = d.airline_statement ? STATEMENT_LABELS[d.airline_statement.answer] : undefined;
  if (d.airline_statement && stated) {
    const reason = d.reason ?? "";
    const lead = SAID_BY_LABEL.find((l) => reason.startsWith(l)) ?? "";
    const rest = reason.slice(lead.length);
    return `<span class="${stated[1]}">${stated[0]}</span> · ${esc(d.airline || "")} · ${esc(rest)} (${sourceLink(d.airline_statement.source)})`;
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
              ? [`${fleetFigure(d) ? shareLabel(p) : probLabel(p)} Starlink`, "text-accent"]
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
function checkPageHref(d: CheckAnyBody, pages: CheckPages, raw: string, date: string) {
  const page = d.airline ? pages[d.airline] : undefined;
  const fn = canonicalFlightInput(raw);
  if (!page || d.error || !/^[A-Z0-9]+$/.test(fn)) return null;
  return {
    fn,
    site: page.site,
    href: `${page.url}/${encodeURIComponent(fn)}/${encodeURIComponent(date)}`,
  };
}

export function checkPageLink(
  d: CheckAnyBody,
  pages: CheckPages,
  raw: string,
  date: string
): string {
  const page = checkPageHref(d, pages, raw, date);
  if (!page) return "";
  return `<a href="${esc(page.href)}" class="mt-1 block py-2 text-accent hover:underline">See ${esc(page.fn)} on ${esc(page.site)} →</a>`;
}

/**
 * The share control for a hub answer. The hub's answer has no address of its
 * own, so what is shared is the airline site's page for the same flight and
 * date: the page the hand-off link above opens. An answer with no such page
 * gets no control, since the hub's own address would show the reader nothing.
 */
export function checkPageShare(
  d: CheckAnyBody,
  pages: CheckPages,
  raw: string,
  date: string
): string {
  const page = /^\d{4}-\d{2}-\d{2}$/.test(date) ? checkPageHref(d, pages, raw, date) : null;
  return page ? shareControlHtml(page.href) : "";
}

/** A note for a typed number whose airline code no longer sells flights (an
 * old Hawaiian HA number), keyed by that code. */
export function numberNoteHtml(notes: Record<string, string>, raw: string): string {
  const code = canonicalFlightInput(raw).match(/^([A-Z][A-Z0-9]|\d[A-Z])\d/)?.[1];
  const note = code ? notes[code] : undefined;
  return note ? `<span class="mt-2 block text-warn">${esc(note)}</span>` : "";
}

/** The airline code a typed flight number opens with, or "". */
export function carrierCode(raw: string): string {
  return canonicalFlightInput(raw).match(/^([A-Z][A-Z0-9]|\d[A-Z])/)?.[1] ?? "";
}

/** An error on an entry that isn't code-plus-number shaped ("hello", "1736")
 * gets a worked example; a well-formed number of an untracked airline does not. */
export function shapeHint(raw: string, example: string): string {
  if (!example || /^[A-Z][A-Z0-9]{1,2}\d{1,4}$/.test(canonicalFlightInput(raw))) return "";
  return `<span class="block text-muted">Type the airline code and number together, like ${esc(example)}.</span>`;
}

/** A check-any form's answer, as it was asked: for a page that keeps the visitor's checks. */
export type OnChecked = (
  form: HTMLFormElement,
  asked: URLSearchParams,
  answer: CheckAnyBody
) => void;

function wireCheckAny(form: HTMLFormElement, onChecked?: OnChecked): void {
  const out = document.getElementById(`${form.id}-result`);
  if (!out) return;
  const community = form.dataset.answer === "community";
  let pages: CheckPages = {};
  try {
    pages = JSON.parse(form.dataset.checkPages ?? "{}");
  } catch {
    // No hand-off links; the answer itself still prints.
  }
  let notes: Record<string, string> = {};
  try {
    notes = JSON.parse(form.dataset.numberNotes ?? "{}");
  } catch {
    // No notes; the answer itself still prints.
  }
  const number = form.querySelector('input[name="flight_number"]') as HTMLInputElement | null;
  const button = form.querySelector('button[type="submit"]') as HTMLButtonElement | null;
  // The route fields, and the aircraft-type field, belong to the airline that
  // asked for them: another airline's number must not be scoped by airports,
  // or answered for a type, typed for the last one.
  const askBlock = (suffix: string) => {
    const block = document.getElementById(`${form.id}-${suffix}`);
    const inputs = Array.from(block?.querySelectorAll("input") ?? []);
    return {
      heldFor: () => block?.dataset.routeFor ?? "",
      show: (code: string | null) => {
        if (!block) return;
        block.classList.toggle("hidden", code === null);
        block.dataset.routeFor = code ?? "";
        for (const input of inputs) {
          input.disabled = code === null;
          if (code === null) input.value = "";
        }
      },
    };
  };
  const route = askBlock("route");
  const type = askBlock("type");
  // The placeholder lists real examples ("UA1736, AS118…"); the first one is the hint.
  const example = number?.placeholder.split(",")[0].replace(/…$/, "").trim() ?? "";
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    for (const block of [route, type]) {
      if (block.heldFor() !== carrierCode(number?.value ?? "")) block.show(null);
    }
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
        const byType = d.airline_statement?.by === "aircraft_type";
        const code = d.airline_statement ? carrierCode(typed) : null;
        route.show(byType ? null : code);
        type.show(byType ? code : null);
        out.innerHTML =
          checkAnyHtml(d, community) +
          (d.error ? shapeHint(typed, example) : numberNoteHtml(notes, typed)) +
          checkPageLink(d, pages, typed, params.get("date") ?? "") +
          checkPageShare(d, pages, typed, params.get("date") ?? "");
        onChecked?.(form, params, d);
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

export function wireFlightSearchForms(onChecked?: OnChecked): void {
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
      wireCheckAny(form, onChecked);
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
