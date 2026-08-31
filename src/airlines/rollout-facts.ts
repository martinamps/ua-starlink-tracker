/**
 * Content-level rollout facts for the hub /airlines roster — every airline
 * with a Starlink program (or a notable non-Starlink choice), far beyond the
 * four we track at tail level. Accuracy-with-receipts is the positioning:
 * every fact carries the date it was true and the source that says so, and
 * pages render visible "as of" stamps. A claim without a date and source URL
 * does not belong in this file.
 *
 * The rule that keeps this honest: a fact may say only what the page at
 * `source.url` actually says. Citing a plausible article that happens not to
 * mention the sub-fleet, the count, or the negative you are publishing is the
 * failure mode this whole file exists to prevent — check the source, not your
 * memory of it. `summary` and `insteadOf` are held to the same standard: they
 * are the highest-traffic strings here (page sub-heading, meta and og
 * descriptions, /airlines index row, llms.txt roster line), so they may not
 * outrun the facts array, and a test pins that every number in them is one the
 * facts actually carry.
 *
 * Deliberately NOT AirlineConfig entries: these airlines have no tenant, no
 * reader scope, no jobs. Promoting one to tail-level tracking means adding it
 * to AIRLINE_DEFS and setting `trackedCode` here so the hub page picks up
 * live counts.
 */

import type { KnownAirlineCode } from "./registry";

export type RolloutFactsStatus =
  /** Announced program finished (per the airline's own stated scope). */
  | "complete"
  /** Equipped aircraft carrying passengers today, installs ongoing. */
  | "installing"
  /** Committed program, zero equipped aircraft flying yet. */
  | "announced"
  /** Trial aircraft only — no fleet commitment. */
  | "trial"
  /** No Starlink program; the page says what the airline runs instead. */
  | "not_starlink";

interface RolloutFactBase {
  /** The claim, written to stand alone. Say only what the cited page says:
   * a source that never mentions a sub-fleet cannot support a claim about it. */
  fact: string;
  /** `mirror` is a second, archived copy, for sources whose host turns some
   * clients away (airline newsrooms behind Cloudflare, wire pages that 403 a
   * bare fetch). A reader who hits that wall still has something to open,
   * which is the entire promise of this file — a citation nobody can read is
   * not a receipt. Only ever a snapshot confirmed to exist and return 200. */
  source: { label: string; url: string; mirror?: string };
}

/** A claim the source itself dates. Only these move the page's lastmod. */
interface DatedFact extends RolloutFactBase {
  /** Date the claim was true per the source — YYYY-MM-DD, or YYYY-MM when the
   * source supports only month precision. Never the page-render date. */
  asOf: string;
  accessed?: never;
}

/** A claim from an evergreen source that carries no date of its own (an
 * airline's own product page). Kept out of lastmod on purpose: re-reading a
 * page that never changed is not a content update, and stamping it as one is
 * exactly the dishonest-freshness signal this file exists to avoid. */
interface CheckedFact extends RolloutFactBase {
  accessed: string;
  asOf?: never;
}

export type RolloutFact = DatedFact | CheckedFact;

export interface AirlineFactsEntry {
  /** Canonical /airlines/{slug}. For tracked airlines this MUST equal
   * airlineSlug(cfg) so each airline keeps exactly one indexable URL. */
  slug: string;
  name: string;
  shortName: string;
  /** IATA code — used for slug-variant 301s, never as a canonical URL. */
  iata: string;
  /** Registry code when we track this airline at tail level; the detail page
   * then merges live DB stats with these dated facts. */
  trackedCode?: KnownAirlineCode;
  status: RolloutFactsStatus;
  statusLabel: string;
  /** One-liner for the /airlines index row. */
  summary: string;
  /** Question-form H1 override for pages that own a specific SERP
   * ("Does Delta Have Starlink?"). Derived from status when absent. */
  headline?: string;
  facts: RolloutFact[];
  /** not_starlink only. `chose` = the airline picked a different system, which
   * its own announcement confirms. `unannounced` = we have found no Starlink
   * announcement — an absence of evidence, not a verified negative. The two
   * get different headlines so silence is never published as a confirmed No. */
  negative?: "chose" | "unannounced";
  /** not_starlink only: what the airline chose or runs instead. */
  insteadOf?: string;
  /** Alternate slugs that 301 to the canonical one (constituent brands of a
   * group deal, common misspellings). Must not collide with any slug. */
  aliases?: string[];
}

// Ordered roughly by how far along each program is; the index groups by
// status, so order only matters within a group.
export const AIRLINE_FACTS: AirlineFactsEntry[] = [
  // ── Tracked at tail level (registry airlines) ──────────────────────────────
  {
    slug: "united",
    name: "United Airlines",
    shortName: "United",
    iata: "UA",
    trackedCode: "UA",
    status: "installing",
    statusLabel: "Installing",
    summary:
      "450 aircraft equipped per United's Q2 2026 release; targeting close to 1,000 by the end of 2026 and the full fleet by the end of 2027.",
    facts: [
      {
        fact: "Starlink is installed on 450 United mainline and United Express aircraft, per United's Q2 2026 results release; the airline expects nearly 1,000 by the end of 2026 and says it remains on track to bring Starlink to the whole fleet by the end of 2027.",
        asOf: "2026-07-15",
        source: {
          label: "United Q2 2026 results (PR Newswire)",
          url: "https://www.prnewswire.com/news-releases/united-posts-q2-results-above-wall-street-expectations-and-raises-full-year-2026-adjusted-eps-guidance-despite-a-nearly-6-billion-increase-in-anticipated-fuel-costs-302826793.html",
        },
      },
      {
        // The whole-fleet-by-2027 clause lives on fact 1: it is in the Q2
        // release, not this one.
        fact: "United's first Starlink-equipped widebody entered transatlantic service in June 2026 — the first of nearly 60 United widebody aircraft expected to have Starlink during the year — with the entire widebody fleet expected to be outfitted by the following summer.",
        asOf: "2026-06-22",
        source: {
          label: "United press release (PR Newswire)",
          url: "https://www.prnewswire.com/news-releases/united-accelerates-starlink-wi-fi-rollout-with-first-widebody-transatlantic-flight-302806746.html",
        },
      },
    ],
  },
  {
    slug: "alaska",
    name: "Alaska Airlines",
    shortName: "Alaska",
    iata: "AS",
    trackedCode: "AS",
    status: "installing",
    statusLabel: "Installing",
    summary:
      "Roughly 150 aircraft equipped across Alaska, Hawaiian, and Horizon — every Alaska Air Group regional aircraft plus about 50 mainline jets — with the announced E175, 737, and 787 program targeted to finish in early 2027. Free for Atmos Rewards members via T-Mobile.",
    facts: [
      {
        // "All of its regional aircraft" is Alaska AIR GROUP's statement —
        // group regional is Horizon and SkyWest, not an Alaska-mainline subset.
        fact: "Starlink is available on approximately 150 aircraft across Alaska, Hawaiian, and Horizon: Alaska Air Group says all of its regional aircraft are now equipped, along with about 50 mainline jets. Alaska Airlines expects its entire widebody fleet equipped by the fall of 2026.",
        asOf: "2026-06-25",
        source: {
          label: "AirlineGeeks",
          url: "https://airlinegeeks.com/2026/06/25/alaska-hawaiian-expand-starlink-wifi-to-around-150-aircraft/",
        },
      },
      {
        fact: "Starlink Wi-Fi is free for Atmos Rewards members, sponsored by T-Mobile; there is no fee to join the loyalty program.",
        asOf: "2026-06-25",
        source: {
          label: "AirlineGeeks",
          url: "https://airlinegeeks.com/2026/06/25/alaska-hawaiian-expand-starlink-wifi-to-around-150-aircraft/",
        },
      },
      {
        // "Now live" is all the source says about the start; the old wording's
        // December 2025 date was read off the article's own dateline, and its
        // past-tense narration of 2026 outran a source published in 2025.
        fact: "Alaska's announced Starlink scope is its Boeing 787s, Boeing 737s, and Embraer E175s. In mid-December 2025 the service went live with the first four E175s flying, with Starlink expected to debut on the 737s in early 2026 and the 787s later in 2026, and the project complete by early 2027.",
        asOf: "2025-12-15",
        source: {
          label: "One Mile at a Time",
          url: "https://onemileatatime.com/news/alaska-airlines-free-starlink-wi-fi/",
        },
      },
    ],
  },
  {
    slug: "hawaiian",
    name: "Hawaiian Airlines",
    shortName: "Hawaiian",
    iata: "HA",
    trackedCode: "HA",
    status: "complete",
    statusLabel: "Airbus fleet done",
    summary:
      "Every A330 and A321neo has had free Starlink since September 2024 — Hawaiian was the first major U.S. carrier to debut Starlink and the first major airline to offer it at no cost. The 787-9s are next in line; Hawaiian does not plan to offer connectivity on its 717 interisland jets.",
    facts: [
      {
        fact: "Hawaiian completed Starlink installation across its 24 A330s, having become the first major U.S. carrier to debut Starlink in February 2024 on its A321neos — and, per the same release, the first major airline to offer travelers Starlink at no cost.",
        asOf: "2024-09-24",
        source: {
          label: "Hawaiian Airlines newsroom (Alaska Air Group)",
          url: "https://news.alaskaair.com/releases/hawaiian-airlines-now-offering-fast-and-free-starlink-wi-fi-across-entire-airbus-fleet/",
        },
      },
      {
        fact: "With the A321neos and A330-200s done, the Boeing 787-9 fleet is next in line for installation. Hawaiian's only other type is the Boeing 717, and the airline does not plan to offer connectivity on those aircraft — they fly short interisland routes.",
        asOf: "2025-08-20",
        source: {
          label: "One Mile at a Time",
          url: "https://onemileatatime.com/news/hawaiian-airlines-free-starlink-wi-fi/",
        },
      },
      {
        fact: "Alaska Airlines expects its entire widebody fleet to be equipped with Starlink by the fall of 2026.",
        asOf: "2026-06-25",
        source: {
          label: "AirlineGeeks",
          url: "https://airlinegeeks.com/2026/06/25/alaska-hawaiian-expand-starlink-wifi-to-around-150-aircraft/",
        },
      },
    ],
  },
  {
    slug: "qatar",
    name: "Qatar Airways",
    shortName: "Qatar",
    iata: "QR",
    trackedCode: "QR",
    status: "installing",
    statusLabel: "Widebodies nearly done",
    summary:
      "150 Starlink widebodies as of August 2026 — the completed 777, A350, and 787-8 programmes plus the world's first 787-9 — with the 787 programme finishing by the end of 2026. The A330s and A380s are not in the announced programme and Qatar has not said whether they ever will be.",
    facts: [
      {
        fact: "Qatar Airways reached 150 Starlink-equipped widebodies, including the world's first Starlink-equipped Boeing 787-9 and the completed 787-8 sub-fleet, and remains on track to finish the 787 rollout by the end of 2026. The 777 programme was completed in nine months and the A350 programme in eight.",
        asOf: "2026-08-21",
        source: {
          label: "Qatar Airways press release",
          url: "https://www.qatarairways.com/press-releases/en-WW/269475-qatar-airways-150-starlink-equipped-widebody-aircraft-now-include-world-s-first-starlink-equipped-boeing-787-9/",
        },
      },
      {
        fact: "Starlink is deployed across the Boeing 777, Airbus A350, and Boeing 787-8 fleets. Qatar Airways has not confirmed whether its remaining widebodies — the Airbus A330s and A380s — will receive it. Complimentary Wi-Fi runs the whole journey via Privilege Club authentication or enrolment, though gate-to-gate access can be unavailable at some airports for local regulatory reasons.",
        asOf: "2026-08-27",
        source: {
          label: "Travel Tomorrow",
          url: "https://traveltomorrow.com/qatar-airways-reaches-150-starlink-equipped-planes-with-worlds-first-boeing-787-9/",
        },
      },
    ],
  },

  // ── Installing (content-level) ─────────────────────────────────────────────
  {
    slug: "emirates",
    name: "Emirates",
    shortName: "Emirates",
    iata: "EK",
    status: "installing",
    statusLabel: "Installing",
    summary:
      "Installing since November 2025 at roughly 14 aircraft a month; about 150 aircraft targeted by the end of 2026 and all 232 777s and A380s by mid-2027. Free in every cabin, no login.",
    facts: [
      {
        fact: "Emirates began Starlink installs on its Boeing 777s in November 2025 and will equip its entire in-service fleet of 232 777s and A380s by mid-2027, at roughly 14 aircraft per month, with installation on the A380 fleet commencing in February 2026. Access is free in all cabins with no payment or Skywards login required.",
        asOf: "2025-11",
        source: {
          label: "Emirates media centre",
          url: "https://www.emirates.com/media-centre/gaining-speed-at-40000-feet-emirates-set-to-operate-the-worlds-largest-starlink-enabled-international-wide-body-fleet-bringing-ultra-fast-connectivity-on-232-boeing-777-and-a380-aircraft/",
          mirror:
            "https://web.archive.org/web/20260210102756/https://www.emirates.com/media-centre/gaining-speed-at-40000-feet-emirates-set-to-operate-the-worlds-largest-starlink-enabled-international-wide-body-fleet-bringing-ultra-fast-connectivity-on-232-boeing-777-and-a380-aircraft/",
        },
      },
      {
        fact: "Emirates expects about 150 aircraft to carry free Starlink Wi-Fi by the end of 2026; the rollout began with the installation of Starlink on 10 Boeing 777s.",
        asOf: "2026-01-28",
        source: {
          label: "Gulf News",
          url: "https://gulfnews.com/business/aviation/dubais-emirates-to-offer-free-starlink-wi-fi-on-150-aircraft-by-end-of-2026-1.500423320",
        },
      },
    ],
  },
  {
    slug: "lufthansa",
    name: "Lufthansa Group",
    shortName: "Lufthansa",
    iata: "LH",
    status: "installing",
    statusLabel: "First aircraft flying",
    // One aircraft out of ~850 is a Yes only in the narrowest sense; the
    // derived "Yes — Rollout Under Way" would imply a fleet you can plan around.
    headline: "Does Lufthansa Have Starlink? Just Started — One Aircraft Flying",
    summary:
      "First Starlink flight on August 19, 2026 (A320neo D-AINM, Frankfurt–Rome); rolling out to some 850 aircraft group-wide by 2029.",
    facts: [
      {
        fact: "Lufthansa operated its first Starlink flight on August 19, 2026 — A320neo D-AINM on LH234 Frankfurt–Rome — with up to ten more A320-family aircraft planned for 2026 and a group-wide rollout to some 850 aircraft by 2029. Access is free for Miles & More members and Travel ID users.",
        asOf: "2026-08-19",
        source: {
          label: "Lufthansa Group newsroom",
          url: "https://newsroom.lufthansagroup.com/en/lufthansa-takes-off-with-starlink-high-speed-internet-for-the-first-time/",
        },
      },
      {
        // The release names no individual carrier — only "all our airlines" —
        // so this says group-wide and stops there.
        fact: "The Lufthansa Group–Starlink agreement covers all of the group's around 850 aircraft across all its airlines, with gradual introduction beginning in the second half of 2026 and the entire fleet equipped by 2029.",
        asOf: "2026-01-13",
        source: {
          label: "Lufthansa Group newsroom",
          url: "https://newsroom.lufthansagroup.com/en/new-lufthansa-group-collaboration-with-starlink-high-speed-internet-on-all-fleets-across-all-airlines/",
        },
      },
    ],
  },
  {
    slug: "iag",
    // Brand-led naming: the searchable query is "does British Airways have
    // Starlink", and the constituent brands 301 here — a page titled for the
    // holding company answers a question nobody types.
    name: "British Airways, Iberia, Aer Lingus, Vueling & LEVEL (IAG)",
    shortName: "British Airways",
    iata: "BA",
    status: "installing",
    statusLabel: "5 aircraft, installs paused",
    // Five aircraft out of a fleet of 300-plus, with installs stopped: the
    // derived "Yes — Rollout Under Way" is the wrong answer for all but a
    // rounding error of BA passengers. Same call as Southwest and Lufthansa.
    headline:
      "Does British Airways Have Starlink? Barely — 5 Aircraft, Installs Paused Until October",
    summary:
      "500+ aircraft committed across British Airways, Iberia, Aer Lingus, Vueling, and LEVEL (announced November 2025), and free in every cabin where it is fitted — but British Airways equipped just five aircraft before pausing installs in June 2026, and they are expected to resume in October 2026.",
    aliases: ["british-airways", "iberia", "aer-lingus", "vueling", "level"],
    facts: [
      {
        // The old wording's "no paid tiers or loyalty gates" was sourced to a
        // Runway Girl article no client can open, and it does not survive
        // checking: IAG's release says nothing about pricing or cabins at all.
        // The free-in-every-cabin promise is British Airways' own, below.
        fact: "IAG announced a partnership to implement Starlink-enabled high-speed Wi-Fi on Aer Lingus, British Airways, Iberia, LEVEL and Vueling aircraft — more than 500 across the group — with the first aircraft due to go live in early 2026.",
        asOf: "2025-11-06",
        source: {
          label: "IAG press release",
          url: "https://www.iairgroup.com/press-releases/2025/iag-announces-strategic-investment-in-wifi/",
        },
      },
      {
        fact: "British Airways says Starlink is available to all customers, in every cabin, free of charge, and that its entire fleet of more than 300 aircraft will have it within two years — covering its long-haul and short-haul fleets but excluding BA Cityflyer.",
        asOf: "2026-03-19",
        source: {
          label: "British Airways media centre",
          url: "https://mediacentre.britishairways.com/news/19032026/british-airways-first-starlink-flight-takes-off-making-the-airline-the-first-in-the-uk-to-launch-the-fastest-wi-fi-in-the-sky",
        },
      },
      {
        fact: "British Airways was the first UK airline to install Starlink; its first equipped aircraft, Boeing 787-8 G-ZBJJ, was due to fly BA197 London Heathrow–Houston on March 19, 2026.",
        asOf: "2026-03-19",
        source: {
          label: "Head for Points",
          url: "https://www.headforpoints.com/2026/03/19/british-airways-debuts-high-speed-starlink-wi-fi-today/",
        },
      },
      {
        fact: "British Airways paused Starlink installations after equipping just five aircraft — G-ZBJA, G-ZBJI, G-ZBJJ, G-ZBJK and G-ZBJM — since the rollout began in March 2026. The airline says installations are expected to resume in October 2026 after the busy summer season, because the programme is aligned with scheduled maintenance, and that the technology will reach its whole fleet of more than 300 aircraft over roughly two years.",
        asOf: "2026-06-07",
        source: {
          label: "Simple Flying",
          url: "https://simpleflying.com/british-airways-suspends-starlink-installations-later-this-year/",
        },
      },
    ],
  },
  {
    slug: "air-france",
    name: "Air France",
    shortName: "Air France",
    iata: "AF",
    status: "installing",
    statusLabel: "Majority done",
    summary:
      "Nearly 60% of the fleet had Starlink installed as of June 2026, with the rollout due to complete by the end of 2026. Free in every cabin with a Flying Blue login.",
    facts: [
      {
        fact: "Nearly 60% of Air France's fleet has Starlink installed, with the airline hoping to complete the rollout by the end of 2026.",
        asOf: "2026-06-08",
        source: {
          label: "One Mile at a Time",
          url: "https://onemileatatime.com/news/air-france-free-starlink-wi-fi/",
        },
      },
      {
        // corporate.airfrance.com sits behind a Cloudflare challenge that no
        // automated client clears (the path is right — a Wayback capture proves
        // the page exists — it is bot-blocked, not dead). This is the same Air
        // France release carried verbatim on a wire that is readable.
        fact: "Air France chose Starlink for its onboard Wi-Fi, offering it completely free of charge in all travel cabins, accessible by logging into a Flying Blue account — which customers without one can create onboard in a few clicks, free.",
        asOf: "2024-09-27",
        source: {
          label: "Air France press release (WebWire)",
          url: "https://www.webwire.com/ViewPressRel.asp?aId=327474",
          mirror:
            "https://web.archive.org/web/20260703071359/https://corporate.airfrance.com/en/press-releases/complimentary-high-speed-wifi-now-available-board-air-france-flights",
        },
      },
    ],
  },
  {
    slug: "sas",
    name: "SAS Scandinavian Airlines",
    shortName: "SAS",
    iata: "SK",
    status: "installing",
    statusLabel: "Installing",
    summary:
      "Live since March 24, 2026, starting with the A320 fleet and expanding across the fleet during 2026. Free gate-to-gate for EuroBonus members.",
    facts: [
      {
        fact: "SAS went live with Starlink on March 24, 2026 — the first airline in Europe to introduce it on an Airbus A320 — rolling out across the A320 fleet first, with additional aircraft types to follow later in the year subject to regulatory approvals.",
        asOf: "2026-03-24",
        source: {
          label: "SAS Group press release",
          url: "https://www.sasgroup.net/newsroom/press-releases/2026/sas-goes-live-with-starlink-high-speed-wifi/",
        },
      },
      {
        // Was cited to flysas.com, an undated product page that 403s to every
        // automated client — so it was neither datable nor checkable. SAS's own
        // release carries the same claim verbatim and is readable.
        fact: "SAS gives EuroBonus members free gate-to-gate connectivity, enabled from March 24, 2026 through a partnership with mobile network operator 3.",
        asOf: "2026-03-24",
        source: {
          label: "SAS Group press release",
          url: "https://www.sasgroup.net/newsroom/press-releases/2026/sas-goes-live-with-starlink-high-speed-wifi/",
        },
      },
    ],
  },
  {
    slug: "westjet",
    name: "WestJet",
    shortName: "WestJet",
    iata: "WS",
    status: "installing",
    statusLabel: "737 fleet nearly done",
    summary:
      "The 100th equipped 737 was celebrated in October 2025 — the world's largest Starlink-equipped 737 fleet — with 787 installs due to finish by the end of 2026. Free for WestJet Rewards members via TELUS.",
    facts: [
      {
        fact: "WestJet equipped its 100th aircraft with Wi-Fi presented by TELUS and powered by Starlink — the world's largest fleet of Starlink-equipped 737s — free for WestJet Rewards members.",
        asOf: "2025-10-09",
        source: {
          label: "WestJet media room",
          url: "https://westjet.mediaroom.com/2025-10-09-SKY-HIGH-STREAMING-ALERT-WestJet-equips-its-100th-aircraft-with-WestJet-Wi-Fi,-presented-by-TELUS,-free-for-WestJet-Rewards-members",
        },
      },
      {
        // Announcement-day piece, never updated since; the plan it reports is
        // the only thing it can support, so the fact is framed as one.
        fact: "When WestJet announced the TELUS/Starlink partnership in July 2024 it said Boeing 787 installations would follow the 737 fleet and should be complete by the end of 2026.",
        asOf: "2024-07-24",
        source: {
          label: "One Mile at a Time",
          url: "https://onemileatatime.com/news/westjet-free-starlink-wi-fi/",
        },
      },
    ],
  },
  {
    slug: "virgin-atlantic",
    name: "Virgin Atlantic",
    shortName: "Virgin Atlantic",
    iata: "VS",
    status: "installing",
    statusLabel: "A350 fleet done",
    summary:
      "All 12 A350s completed on June 2, 2026 — five months ahead of schedule. The 787 project starts in the second half of 2026 and A330neo installs commence in 2027, when Virgin plans 100% fleet connectivity.",
    facts: [
      {
        fact: "Virgin Atlantic completed Starlink across all 12 of its A350s, five months ahead of schedule; 75% of customers now connect during an A350 flight, compared with 10% across the rest of the fleet.",
        asOf: "2026-06-02",
        source: {
          label: "Head for Points",
          url: "https://www.headforpoints.com/2026/06/02/virgin-atlantic-completes-a350-starlink-rollout/",
        },
      },
      {
        // The source says A330neo installs COMMENCE in 2027; the old wording
        // said they complete by then, inverting it.
        fact: "Virgin Atlantic's Boeing 787 Starlink project is not expected to start until the second half of 2026, and A330neo installs are expected to commence at some point in 2027, after the 787 project completes. The airline says it plans to deliver 100% Starlink connectivity across its fleet in 2027.",
        asOf: "2026-06-02",
        source: {
          label: "One Mile at a Time",
          url: "https://onemileatatime.com/news/virgin-atlantic-free-starlink-wi-fi/",
        },
      },
    ],
  },
  {
    slug: "copa",
    name: "Copa Airlines",
    shortName: "Copa",
    iata: "CM",
    status: "installing",
    statusLabel: "Installing",
    summary:
      "First Starlink carrier in Latin America — first flight July 4, 2026 (737 MAX 9 HP-9901CMP) — with the fleet due complete by Q1 2027. Free for ConnectMiles elite tiers and business class; other passengers pay.",
    facts: [
      {
        // copaair.com returns 401 to every automated client and has no archive
        // snapshot, so both facts are re-sourced to reachable trade press.
        fact: "Copa's first Starlink-equipped aircraft — a Boeing 737 MAX 9, registration HP-9901CMP — made its inaugural flight on July 4, 2026, with implementation across the fleet planned for the first quarter of 2027.",
        asOf: "2026-07-06",
        source: {
          label: "Aviación al Día",
          url: "https://aviacionaldia.com/en/2026/07/copa-airlines-revolutionizes-inflight-connectivity-in-latin-america-first-starlink-high-speed-internet-equipped-aircraft-takes-off.html/amp",
        },
      },
      {
        fact: "Copa became the first airline in Latin America to offer Starlink Wi-Fi, with the rollout expected to complete during the first quarter of 2027. Access is complimentary for ConnectMiles PreferMember Gold, Platinum and Presidential members, for Business Class passengers, and for customers with Starlink Residential or Starlink Roam subscriptions; all other passengers buy access through Starlink's onboard portal.",
        asOf: "2026-07-11",
        source: {
          label: "Future Travel Experience",
          url: "https://www.futuretravelexperience.com/2026/07/copa-airlines-becomes-first-in-latin-america-to-offer-starlink-inflight-connectivity/",
        },
      },
    ],
  },
  {
    slug: "airbaltic",
    name: "airBaltic",
    shortName: "airBaltic",
    iata: "BT",
    status: "installing",
    statusLabel: "Installing",
    summary:
      "First European airline to fly Starlink (February 2025), installing across its A220-300 fleet — free with no login on equipped aircraft. airBaltic itself publishes no completed-fleet count; treat third-party completed-fleet claims as unverified.",
    facts: [
      {
        fact: "airBaltic became the first European airline to launch Starlink, with its first equipped A220-300 flying in February 2025 and installation continuing across the fleet.",
        asOf: "2025-02-21",
        source: {
          label: "airBaltic",
          url: "https://careers.airbaltic.com/en/news/articles/airbaltic-makes-history-as-the-first-european-airline-to-launch-spacex-s-starlink-in-flight-connectivity",
        },
      },
      {
        fact: "airBaltic advertises free Starlink internet from boarding through the flight, but publishes no count of how much of the A220 fleet is finished — third-party claims of a completed fleet are not confirmed by the airline.",
        // airBaltic's product page carries no date of its own; this is when we
        // last read it, and it deliberately does not move the page's lastmod.
        accessed: "2026-08-29",
        source: {
          label: "airBaltic — internet on board",
          url: "https://www.airbaltic.com/en/extra-services/fast-and-free-internet-on-board",
        },
      },
    ],
  },
  {
    slug: "southwest",
    name: "Southwest Airlines",
    shortName: "Southwest",
    iata: "WN",
    status: "installing",
    statusLabel: "First aircraft flying",
    // One aircraft out of ~800: an unqualified "Yes" would be the wrong answer
    // for all but a rounding error of Southwest passengers.
    headline: "Does Southwest Have Starlink? Barely — One Aircraft So Far",
    summary:
      "One confirmed Starlink aircraft (N8543Z, first flight June 22, 2026), with 300+ of Southwest's 800-plus aircraft targeted by the end of 2026. Free for Rapid Rewards members via T-Mobile; Southwest has published no timeline for the rest of the fleet, and Viasat-equipped jets are not in the Starlink plan.",
    facts: [
      {
        fact: "Southwest's first Starlink-equipped 737, N8543Z, carried passengers on June 22, 2026 (Dallas to Albuquerque) — the first of more than 300 aircraft Southwest aims to equip by the end of 2026. Southwest has over 800 aircraft in its fleet and says it eventually plans to bring Starlink to all of them, though no timeline has been given for the full rollout.",
        asOf: "2026-06-22",
        source: {
          label: "Upgraded Points",
          url: "https://upgradedpoints.com/news/southwest-airlines-first-starlink-equipped-flight/",
        },
      },
      {
        fact: "Wi-Fi is free for Rapid Rewards members under Southwest's T-Mobile partnership ($8 per device per flight otherwise). Aircraft not yet retrofitted keep Southwest's older Wi-Fi providers, Viasat and Anuvu.",
        asOf: "2026-06-23",
        source: {
          label: "Simple Flying",
          url: "https://simpleflying.com/southwest-first-starlink-wifi-flight-300-jets-2026/",
        },
      },
      {
        // Why "300+" is not a step toward the whole fleet: the Viasat-equipped
        // half of the fleet is out of scope, which is the part the roster's
        // old unsourced "has NOT committed its full fleet" line was reaching for.
        fact: "William Blair analysts reported that Viasat confirmed Southwest will not install Starlink on its Viasat-equipped aircraft: Starlink replaces the Anuvu system on older jets, while new 737 MAX deliveries continue to have Viasat's system line-fit.",
        asOf: "2026-02-12",
        source: {
          label: "Via Satellite",
          url: "https://www.satellitetoday.com/mobility/2026/02/12/southwest-airlines-plans-to-put-starlink-on-more-than-300-aircraft/",
        },
      },
    ],
  },

  // ── Complete (content-level) ───────────────────────────────────────────────
  {
    slug: "zipair",
    name: "ZIPAIR",
    shortName: "ZIPAIR",
    iata: "ZG",
    status: "complete",
    statusLabel: "Complete",
    summary:
      "All eight Boeing 787s equipped — the first fully Starlink-enabled fleet in Asia. Free for every passenger, in every cabin.",
    facts: [
      {
        // The March source is a forecast ("will be completed"), so it cannot
        // carry the completion claim — that rests on the CEO fact below.
        fact: "ZIPAIR began Starlink installation across its Boeing 787 fleet in early February 2026, with completion planned by spring 2026 — free of charge for all passengers, and set to make ZIPAIR the first airline in Asia to operate a fully Starlink-enabled fleet.",
        asOf: "2026-03-02",
        source: {
          label: "Future Travel Experience",
          url: "https://www.futuretravelexperience.com/2026/03/zipair-enhancing-cx-with-free-high-speed-starlink-connectivity-across-its-boeing-787-fleet/",
        },
      },
      {
        fact: "ZIPAIR CEO Yasuhiro Fukada said the airline completed Starlink installation across its entire fleet of eight Boeing 787s, giving passengers in all cabin classes free high-speed Wi-Fi.",
        asOf: "2026-07-29",
        source: {
          label: "CAPA — Centre for Aviation",
          url: "https://centreforaviation.com/news/zipair-ceo-we-completed-installation-of-starlink-inflight-connectivity-on-entire-fleet-1367868",
        },
      },
    ],
  },
  {
    slug: "jsx",
    name: "JSX",
    shortName: "JSX",
    iata: "XE",
    status: "complete",
    statusLabel: "Complete",
    summary:
      "The first air carrier to adopt Starlink — its entire active fleet of 40 Embraer jets equipped by May 2023, complimentary on every flight with no login.",
    facts: [
      {
        // Was "first airline in the world to COMPLETE a Starlink rollout",
        // sourced to a Runway Girl page no client can open. No reachable source
        // states that; the joint JSX/SpaceX release says "first air carrier to
        // adopt", which is what this now says.
        fact: "JSX became the first air carrier to adopt Starlink, with the service offered to all JSX customers at no charge and with no login required.",
        asOf: "2022-04-25",
        source: {
          label: "SpaceNews (JSX/SpaceX release)",
          url: "https://spacenews.com/hop-on-jet-service-jsx-becomes-the-first-air-carrier-to-adopt-revolutionary-starlink-high-speed-internet-service/",
        },
      },
      {
        fact: "JSX fully installed Starlink across its entire active fleet of 40 Embraer jets, with complimentary connectivity on all flights. It is Starlink's global launch customer, under an agreement to outfit up to 100 aircraft.",
        asOf: "2023-05-08",
        source: {
          label: "Private Jet Card Comparisons",
          url: "https://privatejetcardcomparisons.com/2023/05/08/by-the-seat-private-jet-jsx-completes-starlink-wifi-installation/",
        },
      },
    ],
  },

  // ── Announced, not flying yet ──────────────────────────────────────────────
  {
    slug: "flydubai",
    name: "flydubai",
    shortName: "flydubai",
    iata: "FZ",
    // Committed, nothing flying: the announcement promises installs "in 2026"
    // and flydubai has published no equipped aircraft, so this is `announced`
    // by the definition above — `installing` would answer the page's own
    // question ("does flydubai have Starlink?") with a Yes no source supports.
    status: "announced",
    statusLabel: "Rolling out in 2026",
    summary:
      "Signed with SpaceX at the Dubai Airshow (November 18, 2025) to put Starlink on 100 Boeing 737s during 2026.",
    facts: [
      {
        fact: "flydubai announced Starlink as its inflight connectivity partner on November 18, 2025, with installation across 100 Boeing 737s to be rolled out during 2026.",
        asOf: "2025-11-18",
        source: {
          label: "flydubai newsroom",
          url: "https://news.flydubai.com/flydubai-announces-starlink-as-its-inflight-connectivity-partner",
        },
      },
    ],
  },
  {
    slug: "american",
    name: "American Airlines",
    shortName: "American",
    iata: "AA",
    status: "announced",
    statusLabel: "Installs begin Q1 2027",
    headline: "Does American Have Starlink? Not Yet — Airbus Installs Begin in 2027",
    summary:
      "500+ Airbus narrowbodies only, announced May 26, 2026, with installs beginning in Q1 2027. No other American aircraft is in the Starlink program as announced; AAdvantage members already get free Wi-Fi on more than 900 Viasat- or Intelsat-equipped aircraft, sponsored by AT&T.",
    facts: [
      {
        // Re-sourced from Runway Girl (403s every client) to American's own
        // newsroom. The release makes no statement about what flies today, so
        // neither does this fact — the "not yet" answer is the Q1 2027 start.
        fact: "American announced the installation of Starlink on more than 500 narrowbody aircraft beginning in Q1 2027, updating the Wi-Fi offering on its fleet of more than 500 Airbus aircraft including new A321XLR and A321neo deliveries.",
        asOf: "2026-05-26",
        source: {
          label: "American Airlines newsroom",
          url: "https://news.aa.com/news/news-details/2026/American-to-install-Starlink-the-fastest-Wi-Fi-in-the-sky-MKG-OB-05/default.aspx",
        },
      },
      {
        fact: "The announced scope is the A320 family only — A319s, A320s, A321s, A321neos, and A321XLRs — with no official plans to extend Starlink to any other American aircraft. American runs Viasat on most of its narrowbodies today and Panasonic on most of its widebodies; neither is part of the Starlink program as announced.",
        asOf: "2026-05-26",
        source: {
          label: "One Mile at a Time",
          url: "https://onemileatatime.com/news/american-airlines-free-starlink-wi-fi/",
        },
      },
      {
        // The release gives no percentage — the old "~90%" was derived, not
        // quoted. Its own figures are the count and the fleet-share wording.
        fact: "In January 2026 American began rolling out free inflight Wi-Fi for AAdvantage members, sponsored by AT&T and powered by Viasat and Intelsat: more than 900 mainline aircraft are equipped, covering 100% of its narrowbody and dual-class regional fleets.",
        asOf: "2026-01-06",
        source: {
          label: "American Airlines newsroom",
          url: "https://news.aa.com/news/news-details/2026/American-Airlines-launches-FREE-high-speed-Wi-Fi-sponsored-by-ATT-available-on-more-aircraft-than-any-other-carrier-in-the-world/default.aspx",
          mirror:
            "https://web.archive.org/web/20260805102424/https://news.aa.com/news/news-details/2026/American-Airlines-launches-FREE-high-speed-Wi-Fi-sponsored-by-ATT-available-on-more-aircraft-than-any-other-carrier-in-the-world/default.aspx",
        },
      },
    ],
  },
  {
    slug: "singapore",
    name: "Singapore Airlines",
    shortName: "Singapore",
    iata: "SQ",
    status: "announced",
    statusLabel: "From Q1 2027",
    summary:
      "Confirmed May 4, 2026 for the A350-900 long-haul/ULR and A380 fleets (roughly 53 aircraft), with rollout from Q1 2027 through 2029. The 737/777/787 fleets are not included.",
    facts: [
      {
        fact: "Singapore Airlines selected Starlink for its A350-900 long-haul, A350-900 ULR, and A380 aircraft, with progressive rollout beginning in the first quarter of 2027 and completing by the end of 2029.",
        asOf: "2026-05-04",
        source: {
          label: "Singapore Airlines press release",
          url: "https://www.singaporeair.com/en_UK/sg/corporate/newsroom/press-release/2026/april---june-2026/sia_starlink/",
        },
      },
      {
        fact: "The program covers roughly 53 aircraft; 737 MAX 8s, 777-300ERs, 787-10s, and medium-haul A350s are not part of the announced Starlink scope.",
        asOf: "2026-05-04",
        source: {
          label: "Mainly Miles",
          url: "https://mainlymiles.com/2026/05/04/singapore-airlines-confirms-starlink-as-its-new-wi-fi-provider/",
        },
      },
    ],
  },
  {
    slug: "cebu-pacific-indigo",
    // Same brand-led rule as IAG: Frontier and Wizz Air carry the search
    // volume that the group name absorbs but can never rank for.
    name: "Frontier, Wizz Air, Volaris, JetSMART & Cebu Pacific (Indigo Partners)",
    shortName: "Frontier + Cebu Pacific",
    iata: "5J",
    status: "announced",
    statusLabel: "From 2027",
    headline: "Do Frontier, Wizz Air & Cebu Pacific Have Starlink? Not Yet — Committed",
    summary:
      "Frontier, Wizz Air, Volaris, JetSMART, and Cebu Pacific — the Indigo Partners portfolio — expect Starlink on more than 1,000 aircraft, with Frontier's first equipped aircraft due in early 2027.",
    aliases: ["cebu-pacific", "frontier", "wizz-air", "volaris", "jetsmart"],
    facts: [
      {
        fact: "Cebu Pacific will be Southeast Asia's first low-cost carrier with Starlink, part of an Indigo Partners portfolio deal (Frontier, Wizz Air, Volaris, JetSMART, Cebu Pacific) covering more than 1,000 aircraft.",
        asOf: "2026-07-14",
        source: {
          label: "PR Newswire",
          url: "https://www.prnewswire.com/apac/news-releases/cebu-pacific-to-become-southeast-asias-first-low-cost-airline-to-introduce-starlink-the-fastest-wi-fi-in-the-sky-302824918.html",
        },
      },
      {
        // The "first of the Indigo carriers" framing is not what the release
        // claims — Frontier says "first US airline", with its own qualifier.
        fact: "Frontier plans to launch its first Starlink-equipped aircraft in early 2027 and says it will be the first US airline to offer passengers Starlink access through a new system managed directly by Starlink.",
        asOf: "2026-07-14",
        source: {
          label: "Frontier Airlines newsroom",
          url: "https://news.flyfrontier.com/frontier-airlines-to-offer-starlink-the-fastest-wifi-in-the-sky/",
        },
      },
    ],
  },
  {
    slug: "air-canada",
    name: "Air Canada",
    shortName: "Air Canada",
    iata: "AC",
    // Was `announced`, which derives "Not Yet — It's Committed" and the body
    // line "no Air Canada aircraft flies with Starlink today". Both were false:
    // the Jetz charter A320s were fitted in summer 2025. The old entry also
    // read the Q400 count off the wrong programme — 25 is the seat retrofit,
    // the Wi-Fi fit is nine aircraft — and every specific it published was
    // sourced to a Runway Girl article no automated client can open. That
    // citation is gone; what follows is what readable sources actually say.
    status: "installing",
    statusLabel: "Charter jets + some Q400s",
    headline: "Does Air Canada Have Starlink? Only on Charter Jets and Some Regional Q400s",
    summary:
      "Not on the mainline fleet. Air Canada's four Jetz charter A320s were fitted with Starlink in summer 2025, and nine Jazz-operated Dash 8-400s at Billy Bishop were due to start flying from October 2025 with free Wi-Fi sponsored by Bell. The widely quoted 25 is the cabin refit, not the Wi-Fi fit.",
    facts: [
      {
        fact: "Air Canada's Jetz fleet — four A320s configured for charter operations — had Starlink inflight internet installed over the summer of 2025, with limited commercial availability.",
        asOf: "2025-09-11",
        source: {
          label: "PaxEx.Aero",
          url: "https://paxex.aero/air-canada-jetz-starlink-service/",
        },
      },
      {
        // The 25 is the CABIN programme; Wi-Fi is "on select aircraft
        // initially". Reading 25 as the Starlink count is the error the old
        // entry made, and Air Canada's own release settles it in one sentence.
        fact: "Air Canada announced that 25 De Havilland Dash 8-400s operated for Air Canada Express by Jazz Aviation will undergo a full cabin redesign with new seating and interiors and, on select aircraft initially flying from Billy Bishop Toronto City Airport, onboard Fast, Free Wi-Fi sponsored by Bell — an industry first for the type, beginning in October. Installation of Wi-Fi on the balance of the Dash 8-400 fleet is still being determined. Air Canada's own release does not name Starlink.",
        asOf: "2025-09-17",
        source: {
          label: "Air Canada media release",
          url: "https://www.aircanada.com/media/air-canada-elevates-the-regional-flying-experience-with-reimagined-q-400-amenities-offering-new-standards-of-comfort/",
        },
      },
      {
        fact: "De Havilland Canada announced Starlink in-flight internet on the Dash 8-400 the same day, as a factory option or a retrofit for in-service aircraft — the first De Havilland Canada aircraft in the world to deliver the service, with gate-to-gate internet access even in remote regions.",
        asOf: "2025-09-17",
        source: {
          label: "De Havilland Canada",
          url: "https://dehavilland.com/partnerships/de-havilland-canada-brings-starlink-in-flight-internet-on-dash-8-fleet/",
        },
      },
      {
        fact: "Air Canada planned to fit nine of the Dash 8-400s initially — enough to cover Billy Bishop flights to Ottawa and Montreal plus spares — with the first aircraft expected to enter passenger service in October 2025.",
        asOf: "2025-09-17",
        source: {
          label: "PaxEx.Aero",
          url: "https://paxex.aero/air-canada-q400-starlink/",
        },
      },
    ],
  },

  // ── Trials ─────────────────────────────────────────────────────────────────
  {
    slug: "air-new-zealand",
    name: "Air New Zealand",
    shortName: "Air NZ",
    iata: "NZ",
    status: "trial",
    statusLabel: "Trial only",
    summary:
      "Trialling Starlink since June 2025 on one A320 (ZK OXE), with an ATR turboprop joining later that month — the first airline in the world to trial Wi-Fi on a turboprop. Air NZ says it is still weighing connectivity options for its domestic fleet.",
    facts: [
      {
        // The release says only "an ATR" — never "ATR 72-600" — and its
        // first-ever claim is about trialling Wi-Fi on a turboprop, not about
        // installing Starlink on one. ZK OXE is the A320, not the turboprop.
        fact: "Air New Zealand began a domestic Starlink trial on June 10, 2025 with Airbus A320 ZK OXE, an ATR turboprop to follow later that month — in the airline's words, the first airline in the world to trial Wi-Fi on a turboprop. Wi-Fi is free during the trial, and customer feedback will guide the airline's decision-making as it considers connectivity options for its domestic fleet.",
        asOf: "2025-06-10",
        source: {
          label: "Air New Zealand newsroom",
          url: "https://www.airnewzealandnewsroom.com/onboard-starlink-wi-fi-trial-taking-connectivity-to-the-skies",
        },
      },
    ],
  },

  // ── Not Starlink — the negative pages ──────────────────────────────────────
  {
    slug: "delta",
    name: "Delta Air Lines",
    shortName: "Delta",
    iata: "DL",
    status: "not_starlink",
    negative: "chose",
    statusLabel: "Chose Amazon Leo",
    headline: "Does Delta Have Starlink? No — Here's What They Chose Instead",
    insteadOf:
      "Amazon Leo (LEO satellites) from 2028; free Viasat/Hughes-powered Delta Sync Wi-Fi for SkyMiles members meanwhile",
    summary:
      "No. Delta signed with Amazon Leo — Amazon's LEO satellite constellation — for an initial 500 aircraft with installs beginning in 2028, free for SkyMiles members. Until then Delta's free Delta Sync Wi-Fi runs on Viasat and Hughes.",
    facts: [
      {
        fact: "Delta signed with Amazon Leo (Amazon's low-Earth-orbit constellation, formerly Project Kuiper) rather than Starlink, with an initial installation on 500 aircraft beginning in 2028.",
        asOf: "2026-03-31",
        source: {
          label: "Delta News Hub",
          url: "https://news.delta.com/delta-amazon-leo-sign-agreement-deliver-next-era-connected-travel-and-digital-experiences",
        },
      },
      {
        fact: "Leo-powered in-flight Wi-Fi will remain free for all Delta SkyMiles members.",
        asOf: "2026-03-31",
        source: {
          label: "Amazon Leo announcement",
          url: "https://www.aboutamazon.com/news/amazon-leo/amazon-leo-delta-in-flight-wifi-2028",
        },
      },
      {
        fact: "Until Leo arrives, Delta's existing free Wi-Fi (Delta Sync, free for SkyMiles members) continues on Viasat and Hughes satellite service across most of the mainline fleet — fast enough for browsing and streaming, but not a LEO system.",
        asOf: "2026-03-31",
        source: {
          label: "CNBC",
          url: "https://www.cnbc.com/2026/03/31/delta-air-lines-amazon-leo-inflight-wi-fi.html",
        },
      },
    ],
  },
  {
    slug: "latam",
    name: "LATAM Airlines",
    shortName: "LATAM",
    iata: "LA",
    status: "not_starlink",
    negative: "chose",
    statusLabel: "Chose SES multi-orbit",
    insteadOf: "SES multi-orbit (GEO + Eutelsat OneWeb LEO) on 60+ new Airbus and Embraer aircraft",
    summary:
      "No Starlink deal announced. LATAM expanded its SES deal instead — multi-orbit GEO plus Eutelsat OneWeb LEO connectivity — investing over US$25 million to equip more than 60 new Airbus and Embraer aircraft.",
    facts: [
      {
        // The SES release carries the aircraft scope and nothing else: no
        // dollar figure, no orbit architecture, no mention of Starlink. Those
        // three live on the facts below, each with the source that says them.
        fact: "LATAM selected SES multi-orbit inflight connectivity: more than 60 Airbus (A320neo and A321XLR) and Embraer (E195-E2) aircraft will be equipped with SES services in the coming years.",
        asOf: "2026-07-29",
        source: {
          label: "SES press release",
          url: "https://www.ses.com/news/press-release/ses-launches-multiorbit-satellite-connectivity-on-latam-airbus-embraer-fleet",
        },
      },
      {
        fact: "The LATAM system is the Gilat Sidewinder electronically steered antenna, giving access to SES's global constellation of GEO satellites plus leased capacity on the Eutelsat OneWeb LEO constellation.",
        asOf: "2026-07-29",
        source: {
          label: "PaxEx.Aero",
          url: "https://paxex.aero/latam-inflight-internet-ses-multiorbit/",
        },
      },
      {
        // The negative is phrased as a checkable property of the cited pages —
        // neither names Starlink — rather than a claim about the world that no
        // source asserts. Same pattern on the other negative entries.
        fact: "LATAM said on August 25, 2026 that it will invest more than US$25 million in the programme and offer the service free of charge to LATAM Pass members. Neither this announcement nor the SES release names Starlink.",
        asOf: "2026-08-25",
        source: {
          label: "Air Data News",
          url: "https://www.airdatanews.com/latam-invests-us-25-million-in-multi-orbit-wi-fi-for-new-aircraft/",
        },
      },
    ],
  },
  {
    slug: "ana",
    name: "ANA (All Nippon Airways)",
    shortName: "ANA",
    iata: "NH",
    status: "not_starlink",
    negative: "chose",
    statusLabel: "Chose Viasat Amara",
    insteadOf:
      "Viasat Amara on six 767-300ERs plus 18 777-9s and 19 787-9s; free international Wi-Fi",
    summary:
      "No Starlink deal announced. ANA picked Viasat's next-generation Amara system instead — all six 767-300ERs during FY2026, then 18 Boeing 777-9s and 19 Boeing 787-9s — offering free Wi-Fi in all classes on international routes.",
    facts: [
      {
        // The type breakdown is published only in the release's fleet table
        // image, which is why the old "37 on-order widebodies" wording found no
        // support in the page text — and why it totalled 37 rather than 43.
        fact: "ANA selected Viasat Amara, launching free high-speed Wi-Fi in all classes on international routes. Its published fleet table covers 43 aircraft: all six B767-300ERs during FY2026, plus 18 B777-9s and 19 B787-9s from FY2026. ANA targets free Wi-Fi on more than 80% of its international fleet by the end of 2030. The release does not name Starlink.",
        asOf: "2025-08-05",
        source: {
          label: "ANA Group press release",
          url: "https://www.anahd.co.jp/group/en/pr/202508/20250805.html",
        },
      },
    ],
  },
  {
    slug: "etihad",
    name: "Etihad Airways",
    shortName: "Etihad",
    iata: "EY",
    status: "not_starlink",
    negative: "chose",
    statusLabel: "Chose Viasat Amara",
    insteadOf: "Viasat Amara across the majority of the fleet",
    summary:
      "No Starlink deal announced. Etihad expanded its Viasat partnership in November 2025, deploying Viasat Amara across the majority of its widebody and narrowbody fleet.",
    facts: [
      {
        // The release gives no 2026 timeline of any kind (the old wording's
        // "equipped through 2026" was not in it), and etihad.com is unreachable
        // to every automated client — so this cites Viasat's copy of the same
        // release, which is readable and carries the identical text.
        fact: "Etihad announced an expanded Viasat partnership deploying the next-generation Viasat Amara solution across the majority of its fleet, widebody and narrowbody. Its A321LRs, in service since August 2025, and its A350 deliveries from April 2025 are factory-installed with Viasat's system, joining 787s in service since 2023. The release does not name Starlink.",
        asOf: "2025-11-18",
        source: {
          label: "Viasat newsroom (Etihad release)",
          url: "https://www.viasat.com/news/latest-news/aviation/2025/etihad-airways-selects-viasat-amara-for-full-fleet/",
        },
      },
    ],
  },
  {
    slug: "turkish",
    name: "Turkish Airlines",
    shortName: "Turkish",
    iata: "TK",
    status: "not_starlink",
    negative: "unannounced",
    statusLabel: "No Starlink commitment",
    insteadOf:
      "Anuvu Dedicated Space upgrades across 100+ narrowbodies; no Starlink deal announced",
    summary:
      "No Starlink commitment. Turkish is upgrading more than 100 narrowbodies with Anuvu's Dedicated Space service instead, and has announced no Starlink agreement.",
    facts: [
      {
        // Past tense: a future-dated April 2026 target published in August 2026
        // reads as pending. The source has had no follow-up, so the fact says
        // what was said and when, not what is true now.
        fact: "In March 2026 Turkish Airlines partnered with Anuvu on a performance upgrade of inflight connectivity across more than 100 narrowbody aircraft. Anuvu's CEO said the service had been deployed across 65 aircraft at that point, with full implementation scheduled for completion by April 2026.",
        asOf: "2026-03-30",
        source: {
          label: "Future Travel Experience",
          url: "https://www.futuretravelexperience.com/2026/03/turkish-airlines-elevates-inflight-connectivity-with-anuvus-dedicated-space-technology/",
        },
      },
      {
        fact: "Turkish Airlines announced plans for free Wi-Fi in July 2024, signing an MoU with TCI Aircraft Interiors and Turksat, and has made no further announcement since; free unlimited Wi-Fi is still limited to its highest Miles & Smiles elite tiers. Turksat's coverage is not global, and Starlink is named only as one provider Turkish could have chosen to fill the gaps. Treat any 'Turkish has Starlink' claim as unconfirmed until the airline says so.",
        asOf: "2026-04-29",
        source: {
          label: "AwardWallet — Turkish Airlines Wi-Fi guide",
          url: "https://awardwallet.com/airlines/turkish-airlines-wifi/",
        },
      },
    ],
  },
  {
    slug: "philippine-airlines",
    name: "Philippine Airlines",
    shortName: "Philippine Airlines",
    iata: "PR",
    status: "not_starlink",
    negative: "unannounced",
    statusLabel: "No Starlink program",
    insteadOf:
      "Paid myPAL Wi-Fi plans with free 10 MB and chat tiers; no Starlink agreement announced",
    summary:
      "No Starlink program announced. Philippine Airlines sells myPAL Wi-Fi by plan on select international flights — a free 10 MB plan for everyone, free unlimited chat for Mabuhay Miles members, a 100 MB plan in business class, and paid Unlimited, Standard, and Light plans.",
    facts: [
      {
        fact: "Philippine Airlines sells myPAL Wi-Fi plans on select international flights and aircraft types: an Unlimited plan at USD 24.98, a 3-hour Standard plan at USD 15.98, and a 1-hour Light plan at USD 9.98. Three tiers are free — a 10 MB plan for all passengers, unlimited chat for Mabuhay Miles members, and a 100 MB plan for business class and Mabuhay Miles Million Milers. The page lists no Starlink service.",
        // The airline's own product page carries no date of its own — see
        // CheckedFact. Replaces an undated third-party aggregator whose plan
        // list had gone stale (it still listed a paid chat plan PAL has dropped).
        accessed: "2026-08-31",
        source: {
          label: "Philippine Airlines — myPAL Wi-Fi",
          url: "https://www.philippineairlines.com/ph/en/mypal-travel-boost/mypal-wifi.html",
        },
      },
    ],
  },
];

const bySlug = new Map<string, AirlineFactsEntry>();
const aliasToSlug = new Map<string, string>();
for (const entry of AIRLINE_FACTS) {
  bySlug.set(entry.slug, entry);
  for (const alias of entry.aliases ?? []) aliasToSlug.set(alias, entry.slug);
}

export function factsBySlug(slug: string): AirlineFactsEntry | null {
  return bySlug.get(slug) ?? null;
}

/** Canonical slug for an alias (constituent brand, etc.); null when unknown. */
export function factsAliasTarget(slug: string): string | null {
  return aliasToSlug.get(slug) ?? null;
}

export function factsForCode(code: string): AirlineFactsEntry | null {
  return AIRLINE_FACTS.find((e) => e.trackedCode === code) ?? null;
}

/** Entries with no tail-level tracking — the content-only part of the roster. */
export function contentOnlyFacts(): AirlineFactsEntry[] {
  return AIRLINE_FACTS.filter((e) => !e.trackedCode);
}

/** Newest asOf across an entry's facts — the honest lastmod for its page (the
 * date its content last actually changed, never the request clock). Empty when
 * every fact rests on an undated source: `accessed` dates are deliberately
 * excluded, so re-reading an evergreen page can never fake a content update. */
export function latestFactDate(entry: AirlineFactsEntry): string {
  return newest(entry.facts.map((f) => f.asOf));
}

function newest(dates: Array<string | undefined>): string {
  return (
    dates
      .filter((d): d is string => Boolean(d))
      .sort()
      .at(-1) ?? ""
  );
}

/** How one fact is stamped: a dated claim reads "as of", a claim resting on an
 * undated evergreen source reads "checked" — the reader can tell them apart. */
export function factStamp(fact: RolloutFact):
  | { label: "as of"; date: string }
  | {
      label: "checked";
      date: string;
    } {
  return fact.asOf
    ? { label: "as of", date: fact.asOf }
    : { label: "checked", date: fact.accessed as string };
}

/** The page's visible freshness stamp. "updated" only when a dated claim backs
 * it — an entry built entirely on undated sources says "checked" instead and
 * contributes no sitemap lastmod at all. */
export function factsStamp(entry: AirlineFactsEntry): {
  label: "updated" | "checked";
  date: string;
} {
  const dated = latestFactDate(entry);
  return dated
    ? { label: "updated", date: dated }
    : { label: "checked", date: newest(entry.facts.map((f) => f.accessed)) };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-08-21" → "Aug 21, 2026"; "2025-11" → "Nov 2025". Month-precision
 * inputs stay month-precision — never invent a day the source doesn't give. */
export function formatFactDate(asOf: string): string {
  const [y, m, d] = asOf.split("-");
  const month = MONTHS[Number.parseInt(m, 10) - 1];
  if (!month) return asOf;
  return d ? `${month} ${Number.parseInt(d, 10)}, ${y}` : `${month} ${y}`;
}
