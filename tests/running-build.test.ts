import { describe, expect, test } from "bun:test";
import { BUILD_HEADERS, resolveCommit } from "../src/utils/running-build";

describe("resolveCommit", () => {
  const SHA = "5bd2a62d4ebaf341a629b7f487048fc2d3f797be";

  test("no commit in the environment reads unknown", () => {
    expect(resolveCommit({})).toBe("unknown");
  });

  test("the Dockerfile's ARG default counts as absent", () => {
    expect(resolveCommit({ SOURCE_COMMIT: "unknown", DD_GIT_COMMIT_SHA: "unknown" })).toBe(
      "unknown"
    );
  });

  test("runtime SOURCE_COMMIT wins over the baked DD_GIT_COMMIT_SHA", () => {
    expect(resolveCommit({ SOURCE_COMMIT: SHA, DD_GIT_COMMIT_SHA: "abc1234" })).toBe(SHA);
  });

  test("falls back to the baked DD_GIT_COMMIT_SHA", () => {
    expect(resolveCommit({ DD_GIT_COMMIT_SHA: ` ${SHA.toUpperCase()}\n` })).toBe(SHA);
  });

  test("anything but a hex hash is refused, so a header never carries junk", () => {
    for (const v of ["", "main", "5bd2a6", "5bd2a62\r\nSet-Cookie: x=1", "g".repeat(40)]) {
      expect(resolveCommit({ SOURCE_COMMIT: v })).toBe("unknown");
    }
  });

  test("headers carry the commit and an ISO start time", () => {
    expect(BUILD_HEADERS["X-App-Commit"]).toMatch(/^([0-9a-f]{7,40}|unknown)$/);
    expect(new Date(BUILD_HEADERS["X-App-Started"]).toISOString()).toBe(
      BUILD_HEADERS["X-App-Started"]
    );
  });
});
