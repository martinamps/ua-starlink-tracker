/**
 * /check-flight: the shared search form, plus a live re-check of a dated
 * permalink whose server-rendered answer was only a prediction. The server
 * answers from the database alone; /api/check-flight may also find the tail
 * from a live schedule lookup close to departure, which can firm the answer up.
 */
import { type AnswerContext, type CheckFlightBody, renderFlightAnswer } from "../flight-answer";
import { wireFlightSearchForms } from "../flight-search";

interface CheckFlightConfig extends Omit<AnswerContext, "zoneFor" | "nowSec"> {
  refresh: boolean;
  /** Zone → concatenated 3-letter IATA codes. */
  zones: Record<string, string>;
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
    zoneFor: zoneLookup(config.zones),
    nowSec: Math.floor(Date.now() / 1000),
  };
  target.setAttribute("aria-busy", "true");
  fetch(
    `/api/check-flight?flight_number=${encodeURIComponent(config.flightNumber)}&date=${encodeURIComponent(config.date)}`
  )
    .then((res) => res.json() as Promise<CheckFlightBody>)
    .then((body) => {
      // A failed live check keeps the server's answer rather than replacing it with an error.
      if (!body.error) target.innerHTML = renderFlightAnswer(body, ctx).html;
    })
    .catch(() => {})
    .finally(() => target.removeAttribute("aria-busy"));
}

function init(): void {
  wireFlightSearchForms();
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
    if (config.refresh) refreshAnswer(config);
  } catch {
    // Server-rendered answer stands.
  }
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
