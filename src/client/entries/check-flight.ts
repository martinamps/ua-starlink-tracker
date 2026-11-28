/**
 * /check-flight: the shared search form, plus a live re-check of a dated
 * permalink whose server-rendered answer was only a prediction. The server
 * answers from the database alone; /api/check-flight may also find the tail
 * from a live schedule lookup close to departure, which can firm the answer up.
 */
import {
  type AnswerContext,
  type CheckFlightBody,
  answerShown,
  renderFlightAnswer,
} from "../flight-answer";
import { wireFlightSearchForms } from "../flight-search";
import { onReady } from "../ready";
import { type Shown, browserStore, rememberCheck } from "../recent-checks";
import { wireShareControls } from "../share";

interface CheckFlightConfig extends Omit<AnswerContext, "zoneFor" | "nowSec"> {
  refresh: boolean;
  /** Zone → concatenated 3-letter IATA codes. */
  zones: Record<string, string>;
  /** The leg the page answers; absent asks for every leg, as the page did. */
  leg?: { origin?: string; destination?: string };
  /** What the served answer said, for the homepage's "Your flights"; absent
   * for an answer not worth coming back to (an error, a date already over). */
  seen?: Shown;
}

/** Keep this flight, and what its answer just said, in this browser. */
function remember(config: CheckFlightConfig, shown: Shown): void {
  const keep = () =>
    rememberCheck(
      browserStore(),
      {
        f: config.flightNumber,
        d: config.date,
        o: config.leg?.origin,
        a: config.leg?.destination,
        h: shown.headline,
        seen: {
          tone: shown.tone,
          firm: shown.firm,
          tails: shown.tails,
          ...(shown.odds ? { odds: shown.odds } : {}),
        },
      },
      Math.floor(Date.now() / 1000)
    );
  // A page the browser drew ahead of a tap that may never come was not looked at.
  const doc = document as Document & { prerendering?: boolean };
  if (doc.prerendering) document.addEventListener("prerenderingchange", keep, { once: true });
  else keep();
}

function zoneLookup(zones: Record<string, string>): (airport: string) => string | undefined {
  const byCode: Record<string, string> = {};
  for (const [zone, codes] of Object.entries(zones)) {
    for (let i = 0; i < codes.length; i += 3) byCode[codes.slice(i, i + 3)] = zone;
  }
  return (airport) => byCode[airport];
}

function refreshAnswer(config: CheckFlightConfig): void {
  const target = document.getElementById("flight-answer");
  if (!target) return;
  const ctx: AnswerContext = {
    ...config,
    // The answer fetched below is made now; the served one's sighting date goes.
    seenAt: undefined,
    zoneFor: zoneLookup(config.zones),
    nowSec: Math.floor(Date.now() / 1000),
  };
  target.setAttribute("aria-busy", "true");
  const query = new URLSearchParams({ flight_number: config.flightNumber, date: config.date });
  if (config.leg?.origin) query.set("origin", config.leg.origin);
  if (config.leg?.destination) query.set("destination", config.leg.destination);
  fetch(`/api/check-flight?${query}`)
    .then((res) => res.json() as Promise<CheckFlightBody>)
    .then((body) => {
      // A failed live check keeps the server's answer rather than replacing it with an error.
      if (body.error) return;
      const answer = renderFlightAnswer(body, ctx);
      target.innerHTML = answer.html;
      if (config.seen) {
        remember(config, answerShown(answer, body));
      }
    })
    .catch(() => {})
    .finally(() => target.removeAttribute("aria-busy"));
}

function init(): void {
  wireFlightSearchForms();
  // The dated page is the answer shared, so its title goes to the share sheet.
  wireShareControls(() => document.title);
  const answer = document.getElementById("flight-answer");
  answer?.addEventListener("click", (e) => {
    const link = (e.target as Element | null)?.closest?.("[data-watch]");
    const plausible = (window as unknown as { plausible?: (n: string, o: unknown) => void })
      .plausible;
    if (link && plausible)
      plausible("Watch", { props: { client: link.getAttribute("data-watch") } });
  });
  const raw = document.getElementById("check-flight-config")?.textContent;
  if (!raw) return;
  try {
    const config = JSON.parse(raw) as CheckFlightConfig;
    if (config.seen) remember(config, config.seen);
    if (config.refresh) refreshAnswer(config);
  } catch {
    // Server-rendered answer stands.
  }
}

onReady(init);
