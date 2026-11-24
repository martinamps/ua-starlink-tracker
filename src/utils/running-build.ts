/**
 * Which build this process runs and since when, stamped on every response so
 * one request to the live site shows whether a merge has actually deployed.
 *
 * The commit comes from the image, never from git at request time: Coolify
 * hands SOURCE_COMMIT to the build (the Dockerfile's ARG, baked into
 * DD_GIT_COMMIT_SHA) and, on some setups, to the container's environment too.
 * The ARG defaults to "unknown", so that literal is treated as absent.
 */

const COMMIT_RE = /^[0-9a-f]{7,40}$/i;

export function resolveCommit(env: Record<string, string | undefined> = process.env): string {
  for (const v of [env.SOURCE_COMMIT, env.DD_GIT_COMMIT_SHA]) {
    const c = v?.trim();
    if (c && COMMIT_RE.test(c)) return c.toLowerCase();
  }
  return "unknown";
}

export const BUILD_COMMIT = resolveCommit();

// timeOrigin is the process start, not this module's first import.
export const PROCESS_STARTED = new Date(performance.timeOrigin).toISOString();

export const BUILD_HEADERS: Record<string, string> = {
  "X-App-Commit": BUILD_COMMIT,
  "X-App-Started": PROCESS_STARTED,
};
