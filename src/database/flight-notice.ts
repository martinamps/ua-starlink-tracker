/**
 * "Tell me if this changes": browser notices for one flight on one date.
 *
 * A browser that asks is stored as its push endpoint and keys, with the
 * flight number and date it asked about, and nothing else: no visitor
 * address, no agent, no account. The notice is decided where the aircraft
 * log is written (logFlightAssignments calls noteAssignmentWrites), by
 * comparing what each subscription was last told with the newest stored
 * aircraft on each leg. A change leaves one message waiting on the row, and
 * the sender job (sendFlightNotices) posts it; the write itself never waits
 * on the network.
 *
 * Off unless the meta row `ALL:flight_notice_enabled` is "1". It is read at
 * every step: with it off nothing is queued, nothing is sent, no key is made,
 * and the page shows no control (noticeOfferKey answers null).
 */

import type { Database } from "bun:sqlite";
import { buildFlightLookupVariants } from "../airlines/flight-number";
import { AIRLINES, withOperatingPartners } from "../airlines/registry";
import { toIata } from "../utils/airport-code";
import { error as logError } from "../utils/logger";
import {
  type BrowserKeys,
  type PushResult,
  type VapidKeys,
  generateVapidKeys,
  isPushEndpoint,
  sendPush,
} from "../utils/web-push";
import { airlineIn, placeholders } from "./sql/fragments";

export const FLIGHT_NOTICE_DDL = `
  CREATE TABLE IF NOT EXISTS flight_notice_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    airline TEXT NOT NULL,
    flight_number TEXT NOT NULL,
    dep_date TEXT NOT NULL,
    origin TEXT,
    told TEXT NOT NULL DEFAULT '{}',
    pending TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    UNIQUE (endpoint, airline, flight_number, dep_date)
  );
  CREATE INDEX IF NOT EXISTS idx_fns_dep_date ON flight_notice_subscriptions(dep_date);
  CREATE INDEX IF NOT EXISTS idx_fns_pending ON flight_notice_subscriptions(pending)
    WHERE pending IS NOT NULL;
  CREATE TABLE IF NOT EXISTS flight_notice_keys (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    public_key TEXT NOT NULL,
    private_jwk TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`;

/** The switch. Set to "1" by hand; any other value, or none, is off. */
export const NOTICE_SWITCH_KEY = "ALL:flight_notice_enabled";

/** One browser follows at most this many flights; the table at most TOTAL. */
export const MAX_PER_ENDPOINT = 10;
export const MAX_TOTAL = 20_000;
/** A message that keeps failing is dropped after this many tries. */
const MAX_ATTEMPTS = 5;
/** Kept a little past the scheduled departure: a late swap still reaches the gate. */
const AFTER_DEPARTURE_SEC = 3600;

/** The `sub` claim: who to reach about our pushes, as a push service reads it. */
const VAPID_SUBJECT = "https://unitedstarlinktracker.com/methodology";

export function noticesEnabled(db: Database): boolean {
  try {
    const row = db.query("SELECT value FROM meta WHERE key = ?").get(NOTICE_SWITCH_KEY) as {
      value: string | null;
    } | null;
    return row?.value === "1";
  } catch {
    return false;
  }
}

function readKeys(db: Database): VapidKeys | null {
  try {
    const row = db
      .query("SELECT public_key, private_jwk FROM flight_notice_keys WHERE id = 1")
      .get() as { public_key: string; private_jwk: string } | null;
    return row ? { publicKey: row.public_key, privateJwk: row.private_jwk } : null;
  } catch {
    return null;
  }
}

/** The public key a page hands the browser; null while off or before the
 * sender has made the pair. The private half never leaves this module. */
export function noticeOfferKey(db: Database): string | null {
  return noticesEnabled(db) ? (readKeys(db)?.publicKey ?? null) : null;
}

/** Make the pair once, on the first sender tick with the switch on. */
async function ensureKeys(db: Database, nowSec: number): Promise<VapidKeys> {
  const held = readKeys(db);
  if (held) return held;
  const made = await generateVapidKeys();
  db.query(
    "INSERT OR IGNORE INTO flight_notice_keys (id, public_key, private_jwk, created_at) VALUES (1, ?, ?, ?)"
  ).run(made.publicKey, made.privateJwk, nowSec);
  return readKeys(db) ?? made;
}

/** What a subscription was last told, per departure airport. */
type Told = Record<string, { tail: string; starlink: number | null }>;

interface CurrentLeg {
  departure_airport: string;
  arrival_airport: string | null;
  tail_number: string;
  starlink: number | null;
  departure_time: number | null;
  aircraft_type: string | null;
}

interface SubscriptionRow {
  id: number;
  endpoint: string;
  airline: string;
  flight_number: string;
  dep_date: string;
  origin: string | null;
  told: string;
  pending: string | null;
  expires_at: number;
}

/**
 * The newest aircraft stored on each departure of the flight that date: the
 * later sighting wins, and a sighting a later lookup withdrew stands for
 * nothing. A leg with no current aircraft is left out, never read as a change.
 */
function currentLegs(
  db: Database,
  airline: string,
  flightNumber: string,
  depDate: string,
  origin: string | null
): CurrentLeg[] {
  const cfg = AIRLINES[airline];
  if (!cfg) return [];
  const variants = buildFlightLookupVariants(cfg, flightNumber);
  const a = airlineIn(withOperatingPartners([airline]), "l.airline");
  const rows = db
    .query(
      `SELECT l.departure_airport, l.arrival_airport, l.tail_number, l.starlink,
              l.departure_time, l.withdrawn_at,
              (SELECT f.aircraft_type FROM united_fleet f WHERE f.tail_number = l.tail_number
               LIMIT 1) AS aircraft_type
       FROM flight_assignment_log l
       WHERE ${a.sql} AND l.flight_number IN (${placeholders(variants)}) AND l.dep_date = ?
       ORDER BY l.last_seen DESC, l.first_seen DESC`
    )
    .all(...a.params, ...variants, depDate) as Array<CurrentLeg & { withdrawn_at: number | null }>;
  const seen = new Set<string>();
  const legs: CurrentLeg[] = [];
  for (const r of rows) {
    const at = toIata(r.departure_airport);
    if (seen.has(at)) continue;
    seen.add(at);
    if (r.withdrawn_at !== null) continue;
    if (origin && at !== origin) continue;
    legs.push({
      ...r,
      departure_airport: at,
      arrival_airport: r.arrival_airport && toIata(r.arrival_airport),
    });
  }
  return legs;
}

const dateEnd = (depDate: string) =>
  Math.floor(Date.parse(`${depDate}T00:00:00Z`) / 1000) + 36 * 3600;

function expiresAt(depDate: string, legs: CurrentLeg[]): number {
  const times = legs.map((l) => l.departure_time).filter((t): t is number => typeof t === "number");
  return times.length > 0 ? Math.max(...times) + AFTER_DEPARTURE_SEC : dateEnd(depDate);
}

const toldOf = (legs: CurrentLeg[]): Told =>
  Object.fromEntries(
    legs.map((l) => [l.departure_airport, { tail: l.tail_number, starlink: l.starlink }])
  );

const starlinkWords = (s: number | null) =>
  s === 1
    ? "It has Starlink."
    : s === 0
      ? "It doesn't have Starlink."
      : "We don't know its Wi-Fi yet.";

export interface NoticePayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

/** The message for what changed, or null when nothing a traveller cares about did. */
export function noticeFor(
  sub: Pick<SubscriptionRow, "flight_number" | "dep_date" | "origin">,
  told: Told,
  legs: CurrentLeg[]
): NoticePayload | null {
  const lines: string[] = [];
  const kinds = new Set<"assigned" | "swap" | "answer">();
  for (const leg of legs) {
    const before = told[leg.departure_airport];
    const plane = `${leg.tail_number}${leg.aircraft_type ? ` (${leg.aircraft_type})` : ""}`;
    const where =
      legs.length > 1 && leg.arrival_airport
        ? `${leg.departure_airport} → ${leg.arrival_airport}: `
        : "";
    if (!before) {
      kinds.add("assigned");
      lines.push(`${where}${plane} is assigned. ${starlinkWords(leg.starlink)}`);
    } else if (before.tail !== leg.tail_number) {
      kinds.add("swap");
      lines.push(
        `${where}Plane changed from ${before.tail} to ${plane}. ${starlinkWords(leg.starlink)}`
      );
    } else if (before.starlink !== leg.starlink) {
      kinds.add("answer");
      lines.push(`${where}${plane}: ${starlinkWords(leg.starlink)}`);
    }
  }
  if (kinds.size === 0) return null;
  // A swap is the news a traveller acts on, so it names the message.
  const what = kinds.has("swap")
    ? "plane changed"
    : kinds.has("assigned")
      ? "plane assigned"
      : "Starlink answer changed";
  const query = sub.origin ? `?origin=${encodeURIComponent(sub.origin)}` : "";
  return {
    title: `${sub.flight_number} on ${sub.dep_date}: ${what}`,
    body: lines.join(" "),
    url: `/check-flight/${encodeURIComponent(sub.flight_number)}/${encodeURIComponent(sub.dep_date)}${query}`,
    tag: `${sub.flight_number}-${sub.dep_date}`,
  };
}

export interface NoticeSubscription {
  endpoint: string;
  keys: BrowserKeys;
  airline: string;
  flightNumber: string;
  depDate: string;
  origin?: string | null;
}

export type SubscribeResult = "stored" | "off" | "invalid" | "full";

const B64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Store one browser for one flight and date. What the log holds now is what
 * it has been told, so the first notice is for a change after the tap.
 */
export function subscribeNotice(
  db: Database,
  sub: NoticeSubscription,
  nowSec: number
): SubscribeResult {
  if (!noticesEnabled(db)) return "off";
  const { p256dh, auth } = sub.keys ?? ({} as BrowserKeys);
  if (
    !isPushEndpoint(sub.endpoint) ||
    typeof p256dh !== "string" ||
    typeof auth !== "string" ||
    p256dh.length < 80 ||
    p256dh.length > 100 ||
    auth.length < 16 ||
    auth.length > 32 ||
    !B64URL.test(p256dh) ||
    !B64URL.test(auth) ||
    !AIRLINES[sub.airline]
  ) {
    return "invalid";
  }
  const origin = sub.origin ? toIata(sub.origin) : null;
  const legs = currentLegs(db, sub.airline, sub.flightNumber, sub.depDate, origin);
  const expires = expiresAt(sub.depDate, legs);
  if (expires <= nowSec) return "invalid";
  return db.transaction((): SubscribeResult => {
    const mine = db
      .query("SELECT COUNT(*) AS n FROM flight_notice_subscriptions WHERE endpoint = ?")
      .get(sub.endpoint) as { n: number };
    const total = db.query("SELECT COUNT(*) AS n FROM flight_notice_subscriptions").get() as {
      n: number;
    };
    const held = db
      .query(
        "SELECT 1 FROM flight_notice_subscriptions WHERE endpoint = ? AND airline = ? AND flight_number = ? AND dep_date = ?"
      )
      .get(sub.endpoint, sub.airline, sub.flightNumber, sub.depDate);
    if (!held && (mine.n >= MAX_PER_ENDPOINT || total.n >= MAX_TOTAL)) return "full";
    db.query(
      `INSERT INTO flight_notice_subscriptions
         (endpoint, p256dh, auth, airline, flight_number, dep_date, origin, told, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (endpoint, airline, flight_number, dep_date) DO UPDATE SET
         p256dh = excluded.p256dh, auth = excluded.auth, origin = excluded.origin`
    ).run(
      sub.endpoint,
      p256dh,
      auth,
      sub.airline,
      sub.flightNumber,
      sub.depDate,
      origin,
      JSON.stringify(toldOf(legs)),
      nowSec,
      expires
    );
    return "stored";
  })();
}

export function unsubscribeNotice(
  db: Database,
  endpoint: string,
  airline: string,
  flightNumber: string,
  depDate: string
): boolean {
  return (
    db
      .query(
        "DELETE FROM flight_notice_subscriptions WHERE endpoint = ? AND airline = ? AND flight_number = ? AND dep_date = ?"
      )
      .run(endpoint, airline, flightNumber, depDate).changes > 0
  );
}

/** One leg the aircraft log just wrote. */
export interface AssignmentWrite {
  flight_number: string;
  dep_date: string;
}

/**
 * Called by the log's writer after it stored sightings. For each subscription
 * on a written flight and date, a change from what it was told leaves one
 * waiting message (a newer change replaces an unsent one, so the browser
 * hears the state now, not a stale step). Never throws into the writer.
 */
export function noteAssignmentWrites(db: Database, writes: readonly AssignmentWrite[]): void {
  if (writes.length === 0) return;
  try {
    if (!noticesEnabled(db)) return;
    const dates = [...new Set(writes.map((w) => w.dep_date))];
    const subs = db
      .query(
        `SELECT id, endpoint, airline, flight_number, dep_date, origin, told, pending, expires_at
         FROM flight_notice_subscriptions WHERE dep_date IN (${placeholders(dates)})`
      )
      .all(...dates) as SubscriptionRow[];
    if (subs.length === 0) return;
    const written = new Set(writes.map((w) => `${w.flight_number}|${w.dep_date}`));
    const update = db.query(
      "UPDATE flight_notice_subscriptions SET told = ?, pending = ?, attempts = 0, expires_at = ? WHERE id = ?"
    );
    for (const sub of subs) {
      const cfg = AIRLINES[sub.airline];
      if (!cfg) continue;
      const touched = buildFlightLookupVariants(cfg, sub.flight_number).some((v) =>
        written.has(`${v}|${sub.dep_date}`)
      );
      if (!touched) continue;
      const legs = currentLegs(db, sub.airline, sub.flight_number, sub.dep_date, sub.origin);
      const told = JSON.parse(sub.told) as Told;
      const notice = noticeFor(sub, told, legs);
      if (!notice) continue;
      update.run(
        JSON.stringify({ ...told, ...toldOf(legs) }),
        JSON.stringify(notice),
        expiresAt(sub.dep_date, legs),
        sub.id
      );
    }
  } catch (err) {
    logError("flight notice: change check failed", err);
  }
}

/** Subscriptions whose flight has left. */
export function expireNotices(db: Database, nowSec: number): number {
  return db.query("DELETE FROM flight_notice_subscriptions WHERE expires_at <= ?").run(nowSec)
    .changes;
}

export interface SendTally {
  sent: number;
  gone: number;
  failed: number;
  expired: number;
}

export interface SendOptions {
  nowSec?: number;
  fetch?: typeof fetch;
  /** One tick sends at most this many; the rest wait for the next. */
  limit?: number;
  onResult?: (airline: string, result: PushResult | "expired") => void;
}

/**
 * The sender job's tick: drop departed subscriptions, then post each waiting
 * message once. A 404 or 410 from the push service removes every
 * subscription of that browser. With the switch off it sends nothing and
 * makes no key; waiting messages stay until it is turned on or they expire.
 */
export async function sendFlightNotices(db: Database, opts: SendOptions = {}): Promise<SendTally> {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const tally: SendTally = { sent: 0, gone: 0, failed: 0, expired: 0 };
  tally.expired = expireNotices(db, nowSec);
  if (!noticesEnabled(db)) return tally;
  const keys = await ensureKeys(db, nowSec);
  const due = db
    .query(
      `SELECT id, endpoint, p256dh, auth, airline, pending, expires_at FROM flight_notice_subscriptions
       WHERE pending IS NOT NULL ORDER BY id LIMIT ?`
    )
    .all(opts.limit ?? 200) as Array<{
    id: number;
    endpoint: string;
    p256dh: string;
    auth: string;
    airline: string;
    pending: string;
    expires_at: number;
  }>;
  for (const row of due) {
    // Read again at send time: the switch can go off mid-tick.
    if (!noticesEnabled(db)) break;
    const payload = JSON.parse(row.pending) as NoticePayload;
    const result = await sendPush(
      keys,
      VAPID_SUBJECT,
      {
        endpoint: row.endpoint,
        keys: { p256dh: row.p256dh, auth: row.auth },
        payload,
        ttlSec: Math.max(60, row.expires_at - nowSec),
        topic: Bun.hash(payload.tag).toString(36).slice(0, 32),
      },
      { fetch: opts.fetch, nowSec }
    );
    tally[result]++;
    opts.onResult?.(row.airline, result);
    if (result === "sent") {
      // Only the message that went: a change noted meanwhile stays waiting.
      db.query(
        "UPDATE flight_notice_subscriptions SET pending = NULL, attempts = 0 WHERE id = ? AND pending = ?"
      ).run(row.id, row.pending);
    } else if (result === "gone") {
      db.query("DELETE FROM flight_notice_subscriptions WHERE endpoint = ?").run(row.endpoint);
    } else {
      db.query(
        `UPDATE flight_notice_subscriptions
         SET attempts = attempts + 1,
             pending = CASE WHEN attempts + 1 >= ? THEN NULL ELSE pending END
         WHERE id = ?`
      ).run(MAX_ATTEMPTS, row.id);
    }
  }
  return tally;
}

/** The notice's database steps, bound to one handle, for the HTTP layer
 * (which takes no raw Database). */
export interface NoticeStore {
  enabled(): boolean;
  offerKey(): string | null;
  subscribe(sub: NoticeSubscription, nowSec: number): SubscribeResult;
  unsubscribe(endpoint: string, airline: string, flightNumber: string, depDate: string): boolean;
}

export function noticeStore(db: Database): NoticeStore {
  return {
    enabled: () => noticesEnabled(db),
    offerKey: () => noticeOfferKey(db),
    subscribe: (sub, nowSec) => subscribeNotice(db, sub, nowSec),
    unsubscribe: (endpoint, airline, fn, date) =>
      unsubscribeNotice(db, endpoint, airline, fn, date),
  };
}
