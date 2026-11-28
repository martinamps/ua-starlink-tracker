/**
 * "Tell me if this changes" on a dated flight page: asks the browser for a
 * notice permission and a push subscription, and hands the server the
 * subscription with this flight and date (server/flight-notice.ts). Which
 * flights this browser follows is kept here, in localStorage, only so the
 * button can say "Stop" on a page already followed.
 *
 * The control is drawn hidden (flight-answer.ts noticeRow) and exists only
 * while the server's switch is on; without it this file does nothing.
 */
import { NOTICE_CONTROL_ID } from "./flight-answer";

export const NOTICE_STORE_KEY = "flight-notice";
const WORKER = "/static/notice/sw.js";
const WORKER_SCOPE = "/static/notice/";
/** As many as the server keeps per browser. */
const STORE_MAX = 10;

export interface NoticeFlight {
  f: string;
  d: string;
  o?: string;
}

interface Store {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

const keyOf = (n: NoticeFlight) => `${n.f}|${n.d}`;

export function followed(store: Store | null): string[] {
  try {
    const raw = JSON.parse(store?.getItem(NOTICE_STORE_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

export function setFollowed(store: Store | null, n: NoticeFlight, on: boolean): void {
  const rest = followed(store).filter((k) => k !== keyOf(n));
  const next = on ? [...rest, keyOf(n)].slice(-STORE_MAX) : rest;
  try {
    store?.setItem(NOTICE_STORE_KEY, JSON.stringify(next));
  } catch {}
}

/** An iPhone or iPad page outside a home-screen site: Safari offers no push there. */
export function iosOutsideHomeScreen(ua: string, standalone: boolean, touchMac: boolean): boolean {
  return (/iPhone|iPad|iPod/.test(ua) || touchMac) && !standalone;
}

function urlKey(b64url: string): Uint8Array<ArrayBuffer> {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function activeWorker(reg: ServiceWorkerRegistration): Promise<void> {
  const w = reg.installing ?? reg.waiting;
  if (reg.active || !w) return Promise.resolve();
  return new Promise((resolve) => {
    w.addEventListener("statechange", () => {
      if (w.state === "activated") resolve();
    });
  });
}

function browserStore(): Store | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

async function post(path: string, body: unknown): Promise<boolean> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Draw the control's state and wire its button; safe to call again after
 * the answer card is redrawn. */
export function wireFlightNotice(flight: NoticeFlight): void {
  const root = document.getElementById(NOTICE_CONTROL_ID);
  if (!root || root.dataset.wired) return;
  const key = root.dataset.noticeKey;
  const button = root.querySelector<HTMLButtonElement>("[data-notice-toggle]");
  const status = root.querySelector<HTMLElement>("[data-notice-status]");
  const ios = root.querySelector<HTMLElement>("[data-notice-ios]");
  if (!key || !button || !status) return;
  root.dataset.wired = "1";
  const nav = navigator as Navigator & { standalone?: boolean };
  const supported =
    "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (!supported) {
    const touchMac = /Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1;
    if (ios && iosOutsideHomeScreen(navigator.userAgent, !!nav.standalone, touchMac)) {
      ios.hidden = false;
      root.hidden = false;
    }
    return;
  }
  const lead = status.textContent ?? "";
  const store = browserStore();
  const draw = (note?: string) => {
    const on = followed(store).includes(keyOf(flight));
    button.textContent = on ? "Stop these notices" : "Tell me if this changes";
    button.setAttribute("aria-pressed", String(on));
    status.textContent =
      note ??
      (on
        ? "On. You'll get a browser notice if this flight's aircraft or Starlink answer changes."
        : lead);
  };
  button.hidden = false;
  status.hidden = false;
  root.hidden = false;
  if (Notification.permission === "denied") {
    button.disabled = true;
    draw("Notices are blocked for this site in your browser's settings.");
    return;
  }
  draw();
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const on = followed(store).includes(keyOf(flight));
      const reg =
        (await navigator.serviceWorker.getRegistration(WORKER_SCOPE)) ??
        (on ? undefined : await navigator.serviceWorker.register(WORKER, { scope: WORKER_SCOPE }));
      if (on) {
        const sub = await reg?.pushManager.getSubscription();
        if (sub) await post("/static/notice/unsubscribe", { endpoint: sub.endpoint, ...flight });
        setFollowed(store, flight, false);
        draw();
        return;
      }
      if ((await Notification.requestPermission()) !== "granted" || !reg) {
        draw(
          "No notice without your browser's permission. The calendar above still follows the flight."
        );
        return;
      }
      await activeWorker(reg);
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlKey(key),
        }));
      const json = sub.toJSON();
      const ok = await post("/static/notice/subscribe", {
        endpoint: json.endpoint,
        keys: json.keys,
        ...flight,
      });
      if (ok) setFollowed(store, flight, true);
      draw(
        ok ? undefined : "That didn't work just now. Try again later, or use the calendar above."
      );
    } catch {
      draw("That didn't work in this browser. The calendar above still follows the flight.");
    } finally {
      button.disabled = false;
    }
  });
}
