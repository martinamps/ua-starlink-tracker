import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { REDACTED_PATH, redactOutboundUrl } from "../src/observability/outbound-url";
import { FETCH_PLUGIN_OPTIONS } from "../src/observability/tracer";

// Made-up credentials: the test only needs strings it can look for.
const FAKE_WEBHOOK_SECRET = "zzFAKEwebhookSECRETzz";
const FAKE_SLACK_URL = `http://hooks.slack.com/services/TFAKE0000/BFAKE0000/${FAKE_WEBHOOK_SECRET}`;
const FAKE_SHEETS_KEY = "zzFAKEsheetsKEYzz";
const FAKE_SHEETS_URL = `http://sheets.googleapis.com/v4/spreadsheets/doc123?fields=sheets&key=${FAKE_SHEETS_KEY}`;

describe("redactOutboundUrl", () => {
  test("a Slack webhook keeps its host and loses its path", () => {
    const out = redactOutboundUrl(
      `https://hooks.slack.com/services/TFAKE0000/BFAKE0000/${FAKE_WEBHOOK_SECRET}`
    );
    expect(out).toBe(`https://hooks.slack.com${REDACTED_PATH}`);
    expect(out).not.toContain("/services/");
    expect(redactOutboundUrl("https://HOOKS.SLACK.COM/services/a/b/c")).not.toContain("/services");
  });

  test("query, fragment and userinfo never survive; ordinary paths do", () => {
    const out = redactOutboundUrl(
      `https://user:pw@sheets.googleapis.com/v4/spreadsheets/doc?key=${FAKE_SHEETS_KEY}#x`
    );
    expect(out).toBe("https://sheets.googleapis.com/v4/spreadsheets/doc");
    expect(redactOutboundUrl("https://api.indexnow.org:8443/indexnow")).toBe(
      "https://api.indexnow.org:8443/indexnow"
    );
  });

  test("an unparseable address says nothing", () => {
    expect(redactOutboundUrl("not a url /services/x")).toBe(REDACTED_PATH);
  });

  test("the fetch plugin is configured with the request hook", () => {
    let tag: unknown;
    FETCH_PLUGIN_OPTIONS.hooks.request(
      {
        setTag: (_name: string, value: unknown) => {
          tag = value;
        },
      },
      new Request(FAKE_SLACK_URL)
    );
    expect(String(tag)).not.toContain(FAKE_WEBHOOK_SECRET);
  });
});

describe("a real dd-trace span for the Slack notifier", () => {
  test("carries the Slack host but not the webhook path or a query key", () => {
    const child = Bun.spawnSync({
      cmd: [
        process.execPath,
        join(import.meta.dir, "fixtures/outbound-span-child.ts"),
        FAKE_SLACK_URL,
        FAKE_SHEETS_URL,
      ],
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      timeout: 30_000,
    });
    expect(child.exitCode).toBe(0);
    const out = JSON.parse(child.stdout.toString()) as { sent: boolean; text: string };
    expect(out.sent).toBe(true);
    expect(out.text).toContain("hooks.slack.com");
    expect(out.text).toContain("http.url");
    expect(out.text).not.toContain(FAKE_WEBHOOK_SECRET);
    expect(out.text).not.toContain("/services/");
    expect(out.text).toContain("sheets.googleapis.com");
    expect(out.text).not.toContain(FAKE_SHEETS_KEY);
  }, 40_000);
});
