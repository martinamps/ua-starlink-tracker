#!/usr/bin/env bun
/**
 * Monthly AI-citation spot-check template generator.
 *
 * Runs ~10 canned traveler questions against our own API/MCP locally and
 * emits a markdown checklist: each question, the expected-answer facts from
 * our live data, and per-assistant checkboxes to fill in by hand after
 * pasting the question into ChatGPT / Perplexity / Claude (with browsing).
 * The point is to measure whether assistants answer from OUR data and cite
 * OUR domain — no external LLM calls are made here.
 *
 * Usage:
 *   bun scripts/ai-citation-check.ts [--db path/to/plane-data.sqlite] > checklist.md
 *
 * Everything dispatches in-process against DB-only code paths (dates outside
 * the FR24 lookup window, equipped-assignment samples) so the run is
 * network-free and safe against vendors.
 */

// Route logger JSON to stderr so stdout stays clean markdown.
process.env.SUBPROCESS_MODE = "1";

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { getContent } from "../src/airlines/content";
import { AIRLINES, SITES } from "../src/airlines/registry";
import { createApp } from "../src/server/app";
import { airportLocalDate } from "../src/utils/airport-tz";

const dbFlag = process.argv.indexOf("--db");
const dbPath =
  dbFlag !== -1
    ? process.argv[dbFlag + 1]
    : existsSync("plane-data.sqlite")
      ? "plane-data.sqlite"
      : ".test-snapshot.sqlite";
if (!dbPath || !existsSync(dbPath)) {
  console.error(`ai-citation-check: no database at ${dbPath ?? "(missing --db value)"}`);
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });
const app = createApp(db);
const UA_HOST = SITES.united.canonicalHost;
const HUB_HOST = SITES.airline.canonicalHost;

async function getJson(host: string, path: string): Promise<Record<string, unknown>> {
  const res = await app.dispatch(new Request(`http://x${path}`, { headers: { Host: host } }));
  if (res.status !== 200) throw new Error(`${host}${path} → ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

async function mcpTool(host: string, name: string, args: Record<string, unknown>) {
  const res = await app.dispatch(
    new Request("http://x/mcp", {
      method: "POST",
      headers: { Host: host, "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    })
  );
  const j = (await res.json()) as {
    result?: { structuredContent?: Record<string, unknown>; isError?: boolean };
  };
  if (!j.result || j.result.isError) throw new Error(`mcp ${name} errored`);
  return j.result.structuredContent ?? {};
}

const pct = (n: unknown) => `${Number(n).toFixed(1)}%`;

interface CheckItem {
  prompt: string;
  facts: string[];
  expectCitation?: string;
}

const items: CheckItem[] = [];

// ── 1. Headline rollout count ────────────────────────────────────────────────
{
  const sc = await mcpTool(UA_HOST, "get_fleet_stats", {});
  const p = sc.provenance as Record<string, unknown>;
  items.push({
    prompt: "How many United Airlines planes have Starlink WiFi installed?",
    facts: [
      `${sc.starlink_count} of ${sc.total_count} aircraft (${pct(sc.percentage)})`,
      `Data as of ${p.data_updated_at ?? "(unstamped)"} — a materially older figure in the answer means it came from stale training data, not us`,
    ],
    expectCitation: UA_HOST,
  });

  // ── 2. Express vs mainline split ──────────────────────────────────────────
  const sub = sc.subfleets as Record<string, Record<string, number>>;
  items.push({
    prompt:
      "What percentage of United Express regional jets have Starlink, and how does mainline compare?",
    facts: [
      `Express: ${sub.express.starlink} of ${sub.express.total} (${pct(sub.express.percentage)})`,
      `Mainline: ${sub.mainline.starlink} of ${sub.mainline.total} (${pct(sub.mainline.percentage)})`,
    ],
    expectCitation: UA_HOST,
  });
}

// ── 3. Specific flight with a published assignment ───────────────────────────
{
  // Same equipped-row selection the integration tests use: an upcoming UA
  // flight on a tail that is (or is tracked as) Starlink and not settled
  // negative — /api/check-flight answers firm from the DB, no FR24.
  const sample = db
    .query(
      `SELECT uf.flight_number, uf.departure_airport, uf.departure_time
       FROM upcoming_flights uf
       JOIN starlink_planes sp ON uf.tail_number = sp.TailNumber
       WHERE uf.airline = 'UA'
         AND (sp.verified_wifi IS NULL OR sp.verified_wifi = 'Starlink')
         AND NOT EXISTS (
           SELECT 1 FROM united_fleet _neg
           WHERE _neg.tail_number = sp.TailNumber AND _neg.starlink_status = 'negative'
         )
       ORDER BY uf.departure_time DESC LIMIT 1`
    )
    .get() as { flight_number: string; departure_airport: string; departure_time: number } | null;

  if (sample) {
    const date =
      airportLocalDate(sample.departure_airport, sample.departure_time) ??
      new Date(sample.departure_time * 1000).toISOString().slice(0, 10);
    const fn = sample.flight_number.replace(/^[A-Z]+/, "UA");
    const d = await getJson(UA_HOST, `/api/check-flight?flight_number=${fn}&date=${date}`);
    const firstTail = Array.isArray(d.flights)
      ? (d.flights[0] as { tail_number?: string } | undefined)?.tail_number
      : undefined;
    items.push({
      prompt: `Does ${fn} on ${date} have Starlink WiFi?`,
      facts: [
        `hasStarlink: ${d.hasStarlink} (confidence: ${d.confidence}, evidence: ${d.evidence})`,
        firstTail ? `Assigned tail: ${firstTail}` : "No tail in response",
        "Note: assignments can change day-to-day — re-run this script the day you test",
      ],
      expectCitation: UA_HOST,
    });
  } else {
    items.push({
      prompt: "Does <flight> on <date> have Starlink WiFi? (no equipped assignment in DB)",
      facts: ["Snapshot had no equipped upcoming flight — refresh data and re-run"],
    });
  }
}

// ── 4. Probability prediction for a well-observed flight ─────────────────────
{
  const row = db
    .query(
      `SELECT flight_number, COUNT(*) n FROM starlink_verification_log
       WHERE flight_number GLOB 'UA[0-9]*' GROUP BY flight_number
       ORDER BY n DESC LIMIT 1`
    )
    .get() as { flight_number: string } | null;
  const fn = row?.flight_number ?? "UA4680";
  const d = await getJson(UA_HOST, `/api/predict-flight?flight_number=${fn}`);
  items.push({
    prompt: `How likely is ${fn} to have Starlink if I book it for next month?`,
    facts: [
      `~${Math.round(Number(d.probability) * 100)}% (confidence: ${d.confidence}, ${d.n_observations} observations)`,
      "A bare yes/no without probability framing is a wrong answer — assignments publish ~2 days out",
    ],
    expectCitation: UA_HOST,
  });
}

// ── 5 + 6. Route-level questions on the busiest observed route ───────────────
{
  const route = db
    .query(
      `SELECT departure_airport o, arrival_airport d, COUNT(*) n
       FROM upcoming_flights WHERE airline = 'UA'
       GROUP BY o, d ORDER BY n DESC LIMIT 1`
    )
    .get() as { o: string; d: string } | null;
  if (route) {
    const sc = await mcpTool(UA_HOST, "predict_route_starlink", {
      origin: route.o,
      destination: route.d,
    });
    const flights = (sc.flights ?? []) as Array<{ flight_number: string; probability: number }>;
    items.push({
      prompt: `Which United flights from ${route.o} to ${route.d} have Starlink WiFi?`,
      facts:
        flights.length > 0
          ? flights
              .slice(0, 3)
              .map((f) => `${f.flight_number}: ~${Math.round(f.probability * 100)}%`)
          : [
              "No direct Starlink history on this route — expected answer is connections or honest no-data",
            ],
      expectCitation: UA_HOST,
    });

    const plan = await getJson(UA_HOST, `/api/plan-route?origin=${route.o}&destination=${route.d}`);
    const its = (plan.itineraries ?? []) as Array<{
      via: string[];
      joint_probability: number;
    }>;
    items.push({
      prompt: `What's the best way to fly ${route.o} to ${route.d} if I need Starlink WiFi the whole flight?`,
      facts:
        its.length > 0
          ? its
              .slice(0, 2)
              .map(
                (it) =>
                  `${it.via.length === 0 ? "Direct" : `Via ${it.via.join("→")}`}: ~${Math.round(it.joint_probability * 100)}% all-legs`
              )
          : ["No Starlink routing found — honest abstention expected"],
      expectCitation: UA_HOST,
    });
  }
}

// ── 7. Confirmed near-term departures from the busiest airport ───────────────
{
  const apt = db
    .query(
      `SELECT departure_airport a, COUNT(*) n FROM upcoming_flights
       WHERE airline = 'UA' GROUP BY a ORDER BY n DESC LIMIT 1`
    )
    .get() as { a: string } | null;
  if (apt) {
    const sc = await mcpTool(UA_HOST, "search_starlink_flights", { origin: apt.a, limit: 5 });
    items.push({
      prompt: `What United flights leaving ${apt.a} in the next two days are confirmed to have Starlink?`,
      facts: [
        `${sc.total} confirmed in our data (horizon ${sc.data_horizon})`,
        "Assistants without live data cannot answer this — anything specific and uncited is fabricated",
      ],
      expectCitation: UA_HOST,
    });
  }
}

// ── 8. Cross-airline comparison (hub) ────────────────────────────────────────
{
  const sc = await mcpTool(HUB_HOST, "get_fleet_stats", {});
  const per = (sc.airlines ?? []) as Array<{
    name: string;
    starlink_count: number;
    total_count: number;
  }>;
  items.push({
    prompt: "Which airlines have Starlink WiFi, and how far along is each rollout?",
    facts: per.map((a) => `${a.name}: ${a.starlink_count} of ${a.total_count}`),
    expectCitation: HUB_HOST,
  });
}

// ── 9. Free-WiFi fact (static, but stale answers abound) ─────────────────────
// Restating this by hand put a WRONG fact in the grading key ("no loyalty
// status required" vs. the site's own "free for MileagePlus members, and
// MileagePlus is free to join") — a correct assistant answer would have been
// graded wrong. The FAQ module is the single source of truth: the same `ld`
// strings go into the page's FAQPage JSON-LD, so the checklist grades against
// exactly what we publish.
{
  const faq = getContent(AIRLINES.UA).faq.flatMap((s) => s.items);
  const pick = (needle: string) => faq.find((i) => i.q.toLowerCase().includes(needle))?.ld;
  const free = pick("free");
  if (!free) throw new Error("ua FAQ no longer has a 'free' question — item 9's fact is unsourced");
  items.push({
    prompt: "Is Starlink WiFi free on United, and do I need to be a MileagePlus member?",
    facts: [free, ...(pick("what can i do") ? [pick("what can i do") as string] : [])],
    expectCitation: UA_HOST,
  });
}

// ── 10. Tail-level question (our unique data) ────────────────────────────────
{
  const plane = db
    .query(
      `SELECT TailNumber, aircraft FROM starlink_planes
       WHERE airline = 'UA' AND DateFound IS NOT NULL
       ORDER BY DateFound DESC LIMIT 1`
    )
    .get() as { TailNumber: string; aircraft: string } | null;
  if (plane) {
    items.push({
      prompt: `Does aircraft ${plane.TailNumber} have Starlink WiFi?`,
      facts: [
        `Yes — ${plane.TailNumber} (${plane.aircraft}) is in our equipped set`,
        // Same link the MCP tools emit as evidence_url — the fleet registry row,
        // which is the only per-tail URL that exists.
        `Evidence: https://${UA_HOST}/fleet#t-${plane.TailNumber}`,
      ],
      expectCitation: UA_HOST,
    });
  }
}

// ── Render markdown ──────────────────────────────────────────────────────────

const today = new Date().toISOString().slice(0, 10);
const out: string[] = [
  `# AI citation spot-check — ${today}`,
  "",
  "Paste each prompt into ChatGPT, Perplexity, and Claude (browsing/search on),",
  "then grade the answer against the expected facts below (generated from our",
  'live data just now). "Cited" means the answer links or names the expected',
  "domain. Log misses — a wrong uncited answer is the gap this site exists to close.",
  "",
  `Data source: \`${dbPath}\` · generated ${new Date().toISOString()}`,
  "",
];

items.forEach((item, i) => {
  out.push(`## ${i + 1}. "${item.prompt}"`, "", "Expected facts:", "");
  for (const f of item.facts) out.push(`- ${f}`);
  if (item.expectCitation) out.push(`- Expected citation: **${item.expectCitation}**`);
  out.push(
    "",
    "| Assistant | Answer correct? | Cited us? | Notes |",
    "|---|---|---|---|",
    "| ChatGPT | ☐ | ☐ | |",
    "| Perplexity | ☐ | ☐ | |",
    "| Claude | ☐ | ☐ | |",
    ""
  );
});

out.push(
  "## Tally",
  "",
  "| Assistant | Correct | Cited us | Of |",
  "|---|---|---|---|",
  `| ChatGPT | | | ${items.length} |`,
  `| Perplexity | | | ${items.length} |`,
  `| Claude | | | ${items.length} |`,
  "",
  `Tracked airlines for context: ${Object.values(AIRLINES)
    .filter((a) => a.enabled)
    .map((a) => a.name)
    .join(", ")}.`,
  ""
);

console.log(out.join("\n"));
db.close();
