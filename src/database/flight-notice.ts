/**
 * "Tell me if this changes": browser notices for one flight on one date.
 *
 * A browser that asks is stored as its push endpoint and keys, with the
 * flight number and date it asked about, and nothing else: no visitor
 * address, no agent, no account. A notice is decided only from what the
 * dated page answers (a NoticeDecider, built over the page's own path in
 * server/app.ts), compared with what that browser was last told, so it can
 * never say what the page doesn't. The sender job (sendFlightNotices) decides
 * a subscription again when the aircraft log's writer touched its flight
 * (noteAssignmentWrites marks it), when our Starlink check read one of its
 * aircraft, and in any case every SWEEP_SEC. It decides right before it
 * sends, and a write never waits on the network. A new subscription is first
 * sent one confirmation: an endpoint that can't take it is removed.
 *
 * Off unless the meta row `ALL:flight_notice_enabled` is "1". It is read at
 * every step: with it off nothing is queued, nothing is sent, no key is made,
 * and the page shows no control (noticeOfferKey answers null).
 */

import type { Database } from "bun:sqlite";
import { buildFlightLookupVariants } from "../airlines/flight-number";
import { AIRLINES } from "../airlines/registry";
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
import { placeholders } from "./sql/fragments";

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
    confirmed INTEGER NOT NULL DEFAULT 0,
    recheck INTEGER NOT NULL DEFAULT 0,
    checked_at INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    UNIQUE (endpoint, airline, flight_number, dep_date)
  );
  CREATE INDEX IF NOT EXISTS idx_fns_dep_date ON flight_notice_subscriptions(dep_date);
  CREATE INDEX IF NOT EXISTS idx_fns_endpoint ON flight_notice_subscriptions(endpoint);
  CREATE INDEX IF NOT EXISTS idx_fns_due ON flight_notice_subscriptions(checked_at);
  CREATE TABLE IF NOT EXISTS flight_notice_keys (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    public_key TEXT NOT NULL,
    private_jwk TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`;

/** The switch. Set to "1" by hand; any other value, or none, is off. */
export const NOTICE_SWITCH_KEY = "ALL:flight_notice_enabled";

/** One browser follows at most this many flights; one flight and date has
 * at most PER_FLIGHT_DATE browsers; the table holds at most TOTAL confirmed. */
export const MAX_PER_ENDPOINT = 10;
export const MAX_PER_FLIGHT_DATE = 500;
export const MAX_TOTAL = 20_000;
/** Rows whose first push hasn't gone through: a made-up endpoint never gets
 * past this, and its row is gone within the life below. */
export const UNCONFIRMED_TOTAL = 1_000;
const UNCONFIRMED_LIFE_SEC = 600;
/** Every subscription is decided again at least this often, whatever wrote
 * the change (a sheet sync, the fleet's own reconcile). */
export const SWEEP_SEC = 15 * 60;
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

/**
 * One leg of a dated page's answer, as the page shows it: the aircraft it
 * names on that departure and whether that aircraft has Starlink (null where
 * the page doesn't know). Only legs the page names an aircraft for are here.
 */
export interface NoticeLeg {
  dep: string;
  arr: string | null;
  tail: string;
  aircraft: string | null;
  starlink: boolean | null;
  departure_time: number | null;
}

export interface NoticeQuery {
  airline: string;
  flightNumber: string;
  depDate: string;
  origin: string | null;
}

/**
 * What the dated page for this flight, date and leg answers right now, from
 * the same path the page renders (server/app.ts builds it over
 * resolveFlightVerdict). Null when the page has no answer to give. A notice
 * is only ever decided from this, so it can't say what the page doesn't.
 */
export type NoticeDecider = (q: NoticeQuery) => Promise<NoticeLeg[] | null>;

/** What a subscription was last told, per departure airport. */
type Told = Record<string, { tail: string; starlink: boolean | null }>;

interface SubscriptionRow {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  airline: string;
  flight_number: string;
  dep_date: string;
  origin: string | null;
  told: string;
  pending: string | null;
  attempts: number;
  confirmed: number;
  expires_at: number;
}

const queryOf = (sub: SubscriptionRow): NoticeQuery => ({
  airline: sub.airline,
  flightNumber: sub.flight_number,
  depDate: sub.dep_date,
  origin: sub.origin,
});

const dateEnd = (depDate: string) =>
  Math.floor(Date.parse(`${depDate}T00:00:00Z`) / 1000) + 36 * 3600;

function expiresAt(depDate: string, legs: NoticeLeg[]): number {
  const times = legs.map((l) => l.departure_time).filter((t): t is number => typeof t === "number");
  return times.length > 0 ? Math.max(...times) + AFTER_DEPARTURE_SEC : dateEnd(depDate);
}

const toldOf = (legs: NoticeLeg[]): Told =>
  Object.fromEntries(legs.map((l) => [l.dep, { tail: l.tail, starlink: l.starlink }]));

const starlinkWords = (s: boolean | null) =>
  s === true
    ? "It has Starlink."
    : s === false
      ? "It doesn't have Starlink."
      : "We don't know its Wi-Fi yet.";

export interface NoticePayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

const pageUrl = (sub: Pick<SubscriptionRow, "flight_number" | "dep_date" | "origin">) =>
  `/check-flight/${encodeURIComponent(sub.flight_number)}/${encodeURIComponent(sub.dep_date)}${
    sub.origin ? `?origin=${encodeURIComponent(sub.origin)}` : ""
  }`;

/**
 * The message for how the page's answer moved from what the browser was last
 * told, or null when nothing a traveller cares about did. Every word comes
 * from `legs`, the page's answer now.
 */
export function noticeFor(
  sub: Pick<SubscriptionRow, "flight_number" | "dep_date" | "origin">,
  told: Told,
  legs: NoticeLeg[]
): NoticePayload | null {
  const lines: string[] = [];
  const kinds = new Set<"assigned" | "swap" | "answer">();
  for (const leg of legs) {
    const before = told[leg.dep];
    const plane = `${leg.tail}${leg.aircraft ? ` (${leg.aircraft})` : ""}`;
    const where = legs.length > 1 && leg.arr ? `${leg.dep} → ${leg.arr}: ` : "";
    if (!before) {
      kinds.add("assigned");
      lines.push(`${where}${plane} is assigned. ${starlinkWords(leg.starlink)}`);
    } else if (before.tail !== leg.tail) {
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
  return {
    title: `${sub.flight_number} on ${sub.dep_date}: ${what}`,
    body: lines.join(" "),
    url: pageUrl(sub),
    tag: `${sub.flight_number}-${sub.dep_date}`,
  };
}

/** The one message a new subscription gets: proof the browser can be
 * reached. A made-up endpoint fails it and its row is removed. */
export function confirmationFor(
  sub: Pick<SubscriptionRow, "flight_number" | "dep_date" | "origin">
): NoticePayload {
  return {
    title: `${sub.flight_number} on ${sub.dep_date}: notices on`,
    body: "We'll tell you here if its plane or Starlink answer changes before it leaves.",
    url: pageUrl(sub),
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
 * Store one browser for one flight and date. `shown` is what the page answers
 * at the tap, so it counts as told: the first notice is for a change after
 * it. The row waits unconfirmed until its first push goes through; until
 * then it counts against UNCONFIRMED_TOTAL, not the table's cap.
 */
export function subscribeNotice(
  db: Database,
  sub: NoticeSubscription,
  shown: NoticeLeg[],
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
  const expires = expiresAt(sub.depDate, shown);
  if (expires <= nowSec) return "invalid";
  return db.transaction((): SubscribeResult => {
    const held = db
      .query(
        "SELECT confirmed FROM flight_notice_subscriptions WHERE endpoint = ? AND airline = ? AND flight_number = ? AND dep_date = ?"
      )
      .get(sub.endpoint, sub.airline, sub.flightNumber, sub.depDate) as {
      confirmed: number;
    } | null;
    if (!held) {
      const count = (sql: string, ...p: Array<string | number>) =>
        (db.query(sql).get(...p) as { n: number }).n;
      if (
        count(
          "SELECT COUNT(*) AS n FROM flight_notice_subscriptions WHERE endpoint = ?",
          sub.endpoint
        ) >= MAX_PER_ENDPOINT ||
        count(
          "SELECT COUNT(*) AS n FROM flight_notice_subscriptions WHERE airline = ? AND flight_number = ? AND dep_date = ?",
          sub.airline,
          sub.flightNumber,
          sub.depDate
        ) >= MAX_PER_FLIGHT_DATE ||
        count("SELECT COUNT(*) AS n FROM flight_notice_subscriptions WHERE confirmed = 0") >=
          UNCONFIRMED_TOTAL ||
        count("SELECT COUNT(*) AS n FROM flight_notice_subscriptions WHERE confirmed = 1") >=
          MAX_TOTAL
      ) {
        return "full";
      }
    }
    db.query(
      `INSERT INTO flight_notice_subscriptions
         (endpoint, p256dh, auth, airline, flight_number, dep_date, origin, told, pending,
          created_at, expires_at, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      JSON.stringify(toldOf(shown)),
      JSON.stringify(
        confirmationFor({ flight_number: sub.flightNumber, dep_date: sub.depDate, origin })
      ),
      nowSec,
      Math.min(expires, nowSec + UNCONFIRMED_LIFE_SEC),
      nowSec
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
 * Called by the log's writer after it stored sightings: each subscription on
 * a written flight and date is marked to be decided again on the sender's
 * next tick, from the page's answer then. A write alone decides nothing,
 * since a sighting the page doesn't show is no news. Never throws into the
 * writer.
 */
export function noteAssignmentWrites(db: Database, writes: readonly AssignmentWrite[]): void {
  if (writes.length === 0) return;
  try {
    if (!noticesEnabled(db)) return;
    const dates = [...new Set(writes.map((w) => w.dep_date))];
    const subs = db
      .query(
        `SELECT id, airline, flight_number, dep_date FROM flight_notice_subscriptions
         WHERE dep_date IN (${placeholders(dates)}) AND recheck = 0`
      )
      .all(...dates) as Array<
      Pick<SubscriptionRow, "id" | "airline" | "flight_number" | "dep_date">
    >;
    if (subs.length === 0) return;
    const written = new Set(writes.map((w) => `${w.flight_number}|${w.dep_date}`));
    const mark = db.query("UPDATE flight_notice_subscriptions SET recheck = 1 WHERE id = ?");
    for (const sub of subs) {
      const cfg = AIRLINES[sub.airline];
      if (!cfg) continue;
      const touched = buildFlightLookupVariants(cfg, sub.flight_number).some((v) =>
        written.has(`${v}|${sub.dep_date}`)
      );
      if (touched) mark.run(sub.id);
    }
  } catch (err) {
    logError("flight notice: change check failed", err);
  }
}

/**
 * Marks every subscription whose told aircraft our Starlink check read since
 * it was last decided: a verdict that flips changes the page at once, with
 * no write to the aircraft log.
 */
function markReverified(db: Database): number {
  return db
    .query(
      `UPDATE flight_notice_subscriptions AS s SET recheck = 1
       WHERE s.recheck = 0 AND s.confirmed = 1 AND EXISTS (
         SELECT 1 FROM json_each(s.told) t
         JOIN starlink_verification_log v
           ON v.tail_number = json_extract(t.value, '$.tail') AND v.checked_at > s.checked_at)`
    )
    .run().changes;
}

/** Subscriptions whose flight has left, and unconfirmed ones past their life. */
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
  /** The page's answer. Without one nothing is decided, only confirmations go. */
  decide?: NoticeDecider;
  nowSec?: number;
  fetch?: typeof fetch;
  /** One tick handles at most this many rows; the rest wait for the next. */
  limit?: number;
  onResult?: (airline: string, result: PushResult | "expired") => void;
}

/**
 * The sender job's tick. Drops departed subscriptions; then, for each
 * subscription that is new, marked, holding an unsent message or not decided
 * for SWEEP_SEC: a new one is sent its confirmation, and every other one is
 * decided from the page's answer now and sent a message only where that
 * answer differs from what it was last told. A 404 or 410 from the push
 * service removes every subscription of that browser; any failure of a
 * confirmation removes that row. With the switch off it sends nothing and
 * makes no key.
 */
export async function sendFlightNotices(db: Database, opts: SendOptions = {}): Promise<SendTally> {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const tally: SendTally = { sent: 0, gone: 0, failed: 0, expired: 0 };
  tally.expired = expireNotices(db, nowSec);
  if (!noticesEnabled(db)) return tally;
  const keys = await ensureKeys(db, nowSec);
  markReverified(db);
  const due = db
    .query(
      `SELECT id, endpoint, p256dh, auth, airline, flight_number, dep_date, origin, told, pending,
              attempts, confirmed, expires_at
       FROM flight_notice_subscriptions
       WHERE confirmed = 0 OR recheck = 1 OR pending IS NOT NULL OR checked_at <= ?
       ORDER BY confirmed, recheck DESC, checked_at, id LIMIT ?`
    )
    .all(nowSec - SWEEP_SEC, opts.limit ?? 200) as SubscriptionRow[];
  const decided = db.query(
    "UPDATE flight_notice_subscriptions SET recheck = 0, checked_at = ?, pending = ?, expires_at = ? WHERE id = ?"
  );
  for (const row of due) {
    // Read again at send time: the switch can go off mid-tick.
    if (!noticesEnabled(db)) break;
    let payload: NoticePayload;
    let toldAfter: Told | null = null;
    if (row.confirmed === 0) {
      if (!row.pending) continue;
      payload = JSON.parse(row.pending) as NoticePayload;
    } else {
      if (!opts.decide) continue;
      const legs = await opts.decide(queryOf(row));
      if (!legs) {
        decided.run(nowSec, null, row.expires_at, row.id);
        continue;
      }
      const told = JSON.parse(row.told) as Told;
      const notice = noticeFor(row, told, legs);
      decided.run(
        nowSec,
        notice ? JSON.stringify(notice) : null,
        expiresAt(row.dep_date, legs),
        row.id
      );
      if (!notice) continue;
      payload = notice;
      toldAfter = { ...told, ...toldOf(legs) };
    }
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
    if (result === "gone") {
      db.query("DELETE FROM flight_notice_subscriptions WHERE endpoint = ?").run(row.endpoint);
    } else if (row.confirmed === 0) {
      if (result === "sent") {
        // Its real life: an hour past the departure the page names, else the
        // date's end. What it was told stays what the page said at the tap.
        const legs = opts.decide ? await opts.decide(queryOf(row)) : null;
        db.query(
          "UPDATE flight_notice_subscriptions SET confirmed = 1, pending = NULL, attempts = 0, expires_at = ? WHERE id = ?"
        ).run(expiresAt(row.dep_date, legs ?? []), row.id);
      } else {
        db.query("DELETE FROM flight_notice_subscriptions WHERE id = ?").run(row.id);
      }
    } else if (result === "sent") {
      db.query(
        "UPDATE flight_notice_subscriptions SET told = ?, pending = NULL, attempts = 0 WHERE id = ?"
      ).run(JSON.stringify(toldAfter), row.id);
    } else if (row.attempts + 1 >= MAX_ATTEMPTS) {
      // Given up: count it told, so the next decision doesn't retry it forever.
      db.query(
        "UPDATE flight_notice_subscriptions SET told = ?, pending = NULL, attempts = 0 WHERE id = ?"
      ).run(JSON.stringify(toldAfter), row.id);
    } else {
      db.query(
        "UPDATE flight_notice_subscriptions SET attempts = attempts + 1, recheck = 1 WHERE id = ?"
      ).run(row.id);
    }
  }
  return tally;
}

/** The notice's database steps, bound to one handle, for the HTTP layer
 * (which takes no raw Database). */
export interface NoticeStore {
  enabled(): boolean;
  offerKey(): string | null;
  subscribe(sub: NoticeSubscription, nowSec: number): Promise<SubscribeResult>;
  unsubscribe(endpoint: string, airline: string, flightNumber: string, depDate: string): boolean;
}

export function noticeStore(db: Database, decide: NoticeDecider): NoticeStore {
  return {
    enabled: () => noticesEnabled(db),
    offerKey: () => noticeOfferKey(db),
    subscribe: async (sub, nowSec) => {
      if (!noticesEnabled(db)) return "off";
      const origin = sub.origin ? toIata(sub.origin) : null;
      const shown = await decide({
        airline: sub.airline,
        flightNumber: sub.flightNumber,
        depDate: sub.depDate,
        origin,
      });
      return subscribeNotice(db, sub, shown ?? [], nowSec);
    },
    unsubscribe: (endpoint, airline, fn, date) =>
      unsubscribeNotice(db, endpoint, airline, fn, date),
  };
}
