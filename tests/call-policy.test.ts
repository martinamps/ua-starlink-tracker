/**
 * Onboard call rules: a site states one only where CALL_POLICY holds the
 * airline's own published wording. An airline whose wording we could not read
 * must say nothing either way, on its pages and to agents.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { CALL_POLICY, callPolicy } from "../src/airlines/call-policy";
import { SITES, siteForAirline } from "../src/airlines/registry";
import { createApp } from "../src/server/app";
import { openSnapshot, req } from "./helpers";

let app: ReturnType<typeof createApp>;

beforeAll(() => {
  app = createApp(openSnapshot());
});

const hostOf = (code: "UA" | "HA" | "AS" | "QR") => {
  const site = siteForAirline(code);
  if (!site) throw new Error(`no site for ${code}`);
  return site.canonicalHost;
};

const llms = async (host: string) => (await app.dispatch(req("/llms.txt", host))).text();

// Crawlers read text, so undo React's comment splits and HTML entities.
const home = async (host: string) => {
  const res = await app.dispatch(req("/", host, { headers: { Accept: "text/html" } }));
  return (await res.text())
    .replace(/<!--.*?-->/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'");
};

const HAWAIIAN_WORDS = '"prohibits video or voice calls while onboard our aircraft"';
// Any wording of a call rule. The llms.txt sample question ("work / stream /
// video call on flight AS123") is a question, not a rule, and must not match.
const CALL_RULE_RE =
  /voice|calls? (are|is|aren't|isn't)|(allow|prohibit|ban|bar)\w* [^.\n]*\bcalls?\b/i;

describe("call rules per airline", () => {
  test("only airlines whose own wording we read have an entry", () => {
    expect(Object.keys(CALL_POLICY).sort()).toEqual(["HA", "UA"]);
    expect(callPolicy("AS")).toBeNull();
    expect(callPolicy("QR")).toBeNull();
  });

  test("Hawaiian's sentence quotes its Wi-Fi page, names it and is dated", () => {
    const sentence = callPolicy("HA") ?? "";
    expect(sentence).toContain(HAWAIIAN_WORDS);
    expect(sentence).toContain("Hawaiian Airlines' Wi-Fi page says");
    expect(sentence).toMatch(/\(as of \d{1,2} \w+ \d{4}\)\.$/);
  });

  test("the Hawaiian site states it in llms.txt and in its home page FAQ", async () => {
    const host = hostOf("HA");
    const txt = await llms(host);
    expect(txt).toContain(callPolicy("HA") as string);
    expect(txt).toContain("Call rules are the airline's, not Starlink's");
    expect(txt, "another airline's rule on Hawaiian's llms.txt").not.toContain(CALL_POLICY.UA);

    const html = await home(host);
    expect(html).toContain("Can I make voice or video calls on Hawaiian Airlines flights?");
    expect(html).toContain(`No. ${callPolicy("HA")}`);
    // Visible answer plus the FAQPage JSON-LD built from it.
    expect(html.split("prohibits video or voice calls").length - 1).toBeGreaterThanOrEqual(2);
  });

  test("the hub's llms.txt carries each airline's own sentence", async () => {
    const txt = await llms(SITES.airline.canonicalHost);
    for (const sentence of Object.values(CALL_POLICY)) expect(txt).toContain(sentence);
  });

  test("the Alaska and Qatar sites state no call rule", async () => {
    // The pattern must catch the rules we do publish, or its silence proves nothing.
    for (const sentence of Object.values(CALL_POLICY)) expect(sentence).toMatch(CALL_RULE_RE);
    for (const code of ["AS", "QR"] as const) {
      const host = hostOf(code);
      const txt = await llms(host);
      expect(txt, `${code} llms.txt`).not.toMatch(CALL_RULE_RE);
      expect(txt, `${code} llms.txt`).not.toContain("Call rules are");
      for (const sentence of Object.values(CALL_POLICY)) {
        expect(txt, `${code} llms.txt`).not.toContain(sentence);
      }
      const html = await home(host);
      expect(html, `${code} home page`).not.toMatch(/voice (or|and) video|video (or|and) voice/i);
      expect(html, `${code} home page`).not.toContain("calls on board");
    }
  });
});
