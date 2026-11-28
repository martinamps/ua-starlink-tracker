/**
 * The Web Push parts we wrote instead of taking a library: the message
 * encryption is checked byte for byte against RFC 8291's own example
 * (Appendix A), the VAPID signature against its own public key, and the
 * endpoint gate against addresses that are not a push service.
 */
import { describe, expect, test } from "bun:test";
import {
  b64url,
  encryptPayload,
  fromB64url,
  generateVapidKeys,
  isPushEndpoint,
  sendPush,
  vapidAuthorization,
} from "../src/utils/web-push";

// RFC 8291 Appendix A.
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic:
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  uaPublic:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

async function rfcSenderKeys(): Promise<CryptoKeyPair> {
  const pub = fromB64url(RFC.asPublic);
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: b64url(pub.slice(1, 33)),
    y: b64url(pub.slice(33, 65)),
    d: RFC.asPrivate,
    ext: true,
  };
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );
  const { d: _, ...publicJwk } = jwk;
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    publicJwk,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    []
  );
  return { privateKey, publicKey };
}

describe("message encryption (RFC 8291)", () => {
  test("matches the RFC's example byte for byte", async () => {
    const body = await encryptPayload(
      { p256dh: RFC.uaPublic, auth: RFC.auth },
      new TextEncoder().encode(RFC.plaintext),
      { ephemeral: await rfcSenderKeys(), salt: fromB64url(RFC.salt) }
    );
    expect(b64url(body)).toBe(RFC.body);
  });

  test("refuses keys that are not a browser's", async () => {
    await expect(
      encryptPayload({ p256dh: "AAAA", auth: RFC.auth }, new Uint8Array(4))
    ).rejects.toThrow();
  });
});

describe("VAPID (RFC 8292)", () => {
  test("signs a claim for the push service's origin that our public key verifies", async () => {
    const keys = await generateVapidKeys();
    expect(fromB64url(keys.publicKey).length).toBe(65);
    const header = await vapidAuthorization(
      keys,
      "https://fcm.googleapis.com/fcm/send/abc",
      "https://example.test",
      1_800_000_000
    );
    const m = header.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/);
    expect(m).not.toBeNull();
    const [, h, c, sig, k] = m as RegExpMatchArray;
    expect(k).toBe(keys.publicKey);
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(c)));
    expect(claims).toEqual({
      aud: "https://fcm.googleapis.com",
      exp: 1_800_000_000 + 12 * 3600,
      sub: "https://example.test",
    });
    const verifier = await crypto.subtle.importKey(
      "raw",
      fromB64url(k),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      verifier,
      fromB64url(sig),
      new TextEncoder().encode(`${h}.${c}`)
    );
    expect(ok).toBe(true);
    expect(header).not.toContain(JSON.parse(keys.privateJwk).d);
  });
});

describe("push endpoints", () => {
  test("only the browsers' push services are posted to", () => {
    for (const ok of [
      "https://fcm.googleapis.com/fcm/send/x",
      "https://updates.push.services.mozilla.com/wpush/v2/x",
      "https://web.push.apple.com/QK",
      "https://wns2-par02p.notify.windows.com/w/?token=x",
    ]) {
      expect(isPushEndpoint(ok)).toBe(true);
    }
    for (const bad of [
      "http://fcm.googleapis.com/fcm/send/x",
      "https://fcm.googleapis.com.evil.test/x",
      "https://evilpush.apple.com.test/x",
      "https://localhost/x",
      "https://127.0.0.1/x",
      "https://fcm.googleapis.com:8443/x",
      "https://user:pw@fcm.googleapis.com/x",
      "not a url",
      `https://fcm.googleapis.com/${"x".repeat(1100)}`,
      42,
    ]) {
      expect(isPushEndpoint(bad)).toBe(false);
    }
  });

  test("404 and 410 read as a dropped subscription; nothing follows a redirect", async () => {
    const keys = await generateVapidKeys();
    const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ])) as CryptoKeyPair;
    const browser = {
      p256dh: b64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
      auth: b64url(crypto.getRandomValues(new Uint8Array(16))),
    };
    const seen: RequestInit[] = [];
    const answer = (status: number) =>
      (async (_url: string | URL | Request, init?: RequestInit) => {
        seen.push(init ?? {});
        return new Response(null, { status });
      }) as unknown as typeof fetch;
    const push = {
      endpoint: "https://fcm.googleapis.com/fcm/send/x",
      keys: browser,
      payload: { title: "t" },
      ttlSec: 600,
    };
    expect(await sendPush(keys, "https://example.test", push, { fetch: answer(201) })).toBe("sent");
    expect(await sendPush(keys, "https://example.test", push, { fetch: answer(410) })).toBe("gone");
    expect(await sendPush(keys, "https://example.test", push, { fetch: answer(404) })).toBe("gone");
    expect(await sendPush(keys, "https://example.test", push, { fetch: answer(500) })).toBe(
      "failed"
    );
    expect(await sendPush(keys, "https://example.test", push, { fetch: answer(302) })).toBe(
      "failed"
    );
    expect(seen.every((i) => i.redirect === "manual")).toBe(true);
    const headers = seen[0].headers as Record<string, string>;
    expect(headers["Content-Encoding"]).toBe("aes128gcm");
    expect(headers.TTL).toBe("600");
  });
});
