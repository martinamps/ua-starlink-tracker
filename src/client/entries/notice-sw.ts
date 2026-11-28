/**
 * The flight-change notice's service worker, served at /static/notice/sw.js
 * (server/flight-notice.ts). It shows what the server sent and opens the
 * flight's page on a tap; it caches nothing and handles no fetch.
 */

interface NoticeMessage {
  title?: string;
  body?: string;
  url?: string;
  tag?: string;
}

interface PushLikeEvent extends Event {
  data?: { json(): unknown } | null;
  waitUntil(p: Promise<unknown>): void;
}

interface NotificationClickLikeEvent extends Event {
  notification: Notification & { data?: { url?: string } };
  waitUntil(p: Promise<unknown>): void;
}

interface WorkerScope {
  registration: ServiceWorkerRegistration;
  location: Location;
  clients: { openWindow(url: string): Promise<unknown> };
  skipWaiting(): Promise<void>;
  addEventListener(type: string, fn: (e: Event) => void): void;
}

const scope = self as unknown as WorkerScope;

/** Only our own pages open from a notice, whatever a message says. */
function ownPage(raw: unknown): string {
  return typeof raw === "string" && raw.startsWith("/check-flight/") ? raw : "/check-flight";
}

scope.addEventListener("install", () => {
  void scope.skipWaiting();
});

scope.addEventListener("push", (event) => {
  const e = event as PushLikeEvent;
  let msg: NoticeMessage = {};
  try {
    msg = (e.data?.json() as NoticeMessage) ?? {};
  } catch {}
  e.waitUntil(
    scope.registration.showNotification(msg.title || "Your flight changed", {
      body: msg.body ?? "",
      tag: msg.tag,
      icon: "/apple-touch-icon.png",
      data: { url: ownPage(msg.url) },
    })
  );
});

scope.addEventListener("notificationclick", (event) => {
  const e = event as NotificationClickLikeEvent;
  e.notification.close();
  e.waitUntil(scope.clients.openWindow(ownPage(e.notification.data?.url)));
});
