/**
 * Slack incoming-webhook notifier. Reads SLACK_WEBHOOK_URL at call time so a
 * missing/rotated value degrades to a no-op log instead of a startup failure.
 */

import { info, error as logError } from "./logger";

const MENTION = process.env.SLACK_MENTION ?? "<@U07HKUAAD0B>";

export interface NewPlaneNotice {
  tail: string;
  aircraftType: string | null;
  fleet: string | null;
  prevStatus: string;
  firstFlight?: { flight_number: string; origin: string; dest: string } | null;
}

export async function notifySlack(text: string): Promise<boolean> {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) {
    info(`[slack disabled] ${text}`);
    return false;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`slack webhook ${res.status}`);
    return true;
  } catch (err) {
    logError("slack notify failed", err);
    return false;
  }
}

export function formatNewPlaneNotice(n: NewPlaneNotice): string {
  const route = n.firstFlight
    ? ` — next: ${n.firstFlight.flight_number} ${n.firstFlight.origin}→${n.firstFlight.dest}`
    : "";
  const type = n.aircraftType ? ` (${n.aircraftType}${n.fleet ? `, ${n.fleet}` : ""})` : "";
  return (
    `🛰️ *New Starlink plane:* \`${n.tail}\`${type}${route} ` +
    `· was \`${n.prevStatus}\` · <https://unitedstarlinktracker.com/fleet|fleet> ${MENTION}`
  );
}

export async function notifyNewStarlinkPlane(n: NewPlaneNotice): Promise<void> {
  await notifySlack(formatNewPlaneNotice(n));
}
