/**
 * The two small parts of Web Push a server needs, on Bun's WebCrypto: a
 * VAPID signature (RFC 8292) that names us to the browser's push service,
 * and the message encryption (RFC 8291, "aes128gcm" of RFC 8188) that only
 * the subscribed browser can open. No library: the push service sees only
 * ciphertext, our public key and a signed claim of our origin.
 *
 * The key pair is made here and kept by the caller in the database
 * (database/flight-notice.ts); nothing in this file reads the environment,
 * logs a key or returns the private half anywhere but to its keeper.
 */

type Bytes = Uint8Array<ArrayBuffer>;

const subtle = crypto.subtle;
const enc = new TextEncoder();

export function b64url(bytes: Bytes): string {
  return Buffer.from(bytes).toString("base64url");
}

export function fromB64url(s: string): Bytes {
  return new Uint8Array(Buffer.from(s, "base64url"));
}

function concat(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export interface VapidKeys {
  /** Uncompressed P-256 point, base64url: the browser's applicationServerKey. */
  publicKey: string;
  /** The private half as a JWK string. Kept in the database only. */
  privateJwk: string;
}

export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = (await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  const jwk = await subtle.exportKey("jwk", pair.privateKey);
  return { publicKey: b64url(raw), privateJwk: JSON.stringify(jwk) };
}

/** `Authorization` header value for one push service origin (RFC 8292 §3). */
export async function vapidAuthorization(
  keys: VapidKeys,
  endpoint: string,
  subject: string,
  nowSec: number
): Promise<string> {
  const header = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(
    enc.encode(
      JSON.stringify({ aud: new URL(endpoint).origin, exp: nowSec + 12 * 3600, sub: subject })
    )
  );
  const key = await subtle.importKey(
    "jwk",
    JSON.parse(keys.privateJwk) as JsonWebKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  // WebCrypto's ECDSA signature is r||s already, the form JWS wants.
  const sig = new Uint8Array(
    await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${header}.${claims}`))
  );
  return `vapid t=${header}.${claims}.${b64url(sig)}, k=${keys.publicKey}`;
}

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, bytes: number): Promise<Bytes> {
  const key = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8)
  );
}

export interface BrowserKeys {
  /** The subscription's p256dh: the browser's P-256 public point, base64url. */
  p256dh: string;
  /** The subscription's 16-byte auth secret, base64url. */
  auth: string;
}

/** One record, so the record size only has to exceed the message. */
const RECORD_SIZE = 4096;
/** Room for the 86-byte header, the delimiter and the 16-byte tag. */
export const MAX_PLAINTEXT = RECORD_SIZE - 17 - 86;

/**
 * The aes128gcm body for one message (RFC 8291 §3.4). `ephemeral` and `salt`
 * are fresh per message; tests pass fixed ones to check against RFC 8291's
 * own example.
 */
export async function encryptPayload(
  browser: BrowserKeys,
  plaintext: Bytes,
  fixed?: { ephemeral: CryptoKeyPair; salt: Bytes }
): Promise<Bytes> {
  if (plaintext.length > MAX_PLAINTEXT) throw new Error("push payload too long");
  const uaPublic = fromB64url(browser.p256dh);
  const authSecret = fromB64url(browser.auth);
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error("bad browser keys");
  const ephemeral =
    fixed?.ephemeral ??
    ((await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ])) as CryptoKeyPair);
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const asPublic = new Uint8Array(await subtle.exportKey("raw", ephemeral.publicKey));
  const uaKey = await subtle.importKey(
    "raw",
    uaPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
  const shared = new Uint8Array(
    await subtle.deriveBits({ name: "ECDH", public: uaKey }, ephemeral.privateKey, 256)
  );
  const ikm = await hkdf(
    authSecret,
    shared,
    concat(enc.encode("WebPush: info\0"), uaPublic, asPublic),
    32
  );
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const aes = await subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const sealed = new Uint8Array(
    await subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, concat(plaintext, Uint8Array.of(2)))
  );
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, RECORD_SIZE);
  return concat(salt, rs, Uint8Array.of(asPublic.length), asPublic, sealed);
}

/**
 * Push services we send to. The endpoint is the browser's to name, so an
 * address anywhere else would make the server post wherever a stranger said.
 */
const PUSH_HOSTS = [
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "push.services.mozilla.com",
  ".push.apple.com",
  ".notify.windows.com",
];

export function isPushEndpoint(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length > 1024 || !URL.canParse(raw)) return false;
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.port || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOSTS.some((h) => (h.startsWith(".") ? host.endsWith(h) : host === h));
}

export type PushResult = "sent" | "gone" | "failed";

export interface PushRequest {
  endpoint: string;
  keys: BrowserKeys;
  payload: unknown;
  /** Seconds the push service may hold it for an offline browser. */
  ttlSec: number;
  /** Same-topic messages replace each other while undelivered (RFC 8030 §5.4). */
  topic?: string;
}

/** POST one message; 404 and 410 mean the browser dropped the subscription. */
export async function sendPush(
  keys: VapidKeys,
  subject: string,
  push: PushRequest,
  opts: { fetch?: typeof fetch; nowSec?: number; timeoutMs?: number } = {}
): Promise<PushResult> {
  return (await sendPushStatus(keys, subject, push, opts)).result;
}

/**
 * sendPush, with the push service's status beside the result: null when no
 * answer came (a timeout, a refused connection). A caller that must tell a
 * passing failure from a refusal reads it (isTransientPush).
 */
export async function sendPushStatus(
  keys: VapidKeys,
  subject: string,
  push: PushRequest,
  opts: { fetch?: typeof fetch; nowSec?: number; timeoutMs?: number } = {}
): Promise<{ result: PushResult; status: number | null }> {
  const doFetch = opts.fetch ?? fetch;
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (!isPushEndpoint(push.endpoint)) return { result: "gone", status: null };
  try {
    const body = await encryptPayload(push.keys, enc.encode(JSON.stringify(push.payload)));
    const res = await doFetch(push.endpoint, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
      headers: {
        Authorization: await vapidAuthorization(keys, push.endpoint, subject, nowSec),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(Math.max(0, Math.floor(push.ttlSec))),
        Urgency: "normal",
        ...(push.topic ? { Topic: push.topic } : {}),
      },
      body,
    });
    const result: PushResult =
      res.status === 404 || res.status === 410
        ? "gone"
        : res.status >= 200 && res.status < 300
          ? "sent"
          : "failed";
    return { result, status: res.status };
  } catch {
    return { result: "failed", status: null };
  }
}

/** A failure worth one more try: no answer, the service's own trouble, or
 * its "slow down". Any other 4xx is a refusal of this message or endpoint. */
export const isTransientPush = (status: number | null): boolean =>
  status === null || status === 429 || status >= 500;
