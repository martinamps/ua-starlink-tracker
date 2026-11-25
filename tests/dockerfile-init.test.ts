import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { countZombieChildren } from "../src/observability/zombies";

// Without an init as PID 1, the server is PID 1 and every orphaned Chromium
// helper from a United check stays a zombie until the container restarts
// (reports: ~1,700 a day, linear kernel-memory growth toward the task limit).
describe("Dockerfile runs the server under an init", () => {
  const lines = readFileSync(join(import.meta.dir, "..", "Dockerfile"), "utf8")
    .replace(/\\\n/g, " ")
    .split("\n")
    .map((l) => l.trim());

  test("ENTRYPOINT is tini, after the RUN that installs it", () => {
    const entry = lines.findLastIndex((l) => l.startsWith("ENTRYPOINT"));
    expect(entry).toBeGreaterThan(-1);
    expect(lines[entry]).toMatch(/^ENTRYPOINT \["\/usr\/bin\/tini", "--"\]$/);
    const install = lines.findIndex((l) => /^RUN .*apt-get install[^&]*\btini\b/.test(l));
    expect(install).toBeGreaterThan(-1);
    expect(install).toBeLessThan(entry);
  });

  test("CMD still starts the server with bun, not through a shell", () => {
    const cmd = lines.findLast((l) => l.startsWith("CMD"));
    expect(cmd).toBe('CMD ["bun", "--smol", "server.ts"]');
  });
});

describe("countZombieChildren", () => {
  const fake = (stats: Record<string, string>) => ({
    pids: () => Object.keys(stats),
    stat: (pid: string) => stats[pid] ?? null,
  });

  test("counts only zombies whose parent is the given pid", () => {
    const proc = fake({
      "10": "10 (chrome-headless) Z 1 10 1 0 -1",
      "11": "11 (chrome-headless) S 1 11 1 0 -1",
      "12": "12 (chrome-headless) Z 7 12 7 0 -1",
      "13": "13 (weird ) Z (name) Z 1 13 1 0 -1",
    });
    expect(countZombieChildren(1, proc)).toBe(2);
    expect(countZombieChildren(7, proc)).toBe(1);
    expect(countZombieChildren(99, proc)).toBe(0);
  });

  test("skips vanished and malformed entries", () => {
    const proc = {
      pids: () => ["1", "2"],
      stat: (pid: string) => (pid === "1" ? "garbage" : null),
    };
    expect(countZombieChildren(1, proc)).toBe(0);
  });

  test("reads the real /proc without throwing", () => {
    expect(countZombieChildren()).toBeGreaterThanOrEqual(0);
  });
});
