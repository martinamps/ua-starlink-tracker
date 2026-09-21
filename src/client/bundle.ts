/**
 * Browser scripts, bundled from src/client/entries at boot and served under
 * content-hashed /static URLs — the stylesheet's contract (see
 * registerStylesheet in app.ts): markup and script are versioned together, so
 * an immutable max-age can never serve a previous deploy's code to new markup.
 *
 * Bundling from source at boot rather than committing output means the shared
 * modules (flight-input.ts, flight-answer.ts) cannot drift from what the
 * server renders with. A build failure is fatal in production for the same
 * reason a missing stylesheet is: pages would silently lose their behavior.
 */
import path from "node:path";
import { BASE_RESPONSE_HEADERS } from "../utils/constants";

const ENTRIES = ["flight-search", "check-flight", "hub", "home"] as const;
export type ClientScript = (typeof ENTRIES)[number];

const srcByName = new Map<ClientScript, string>();
const responses = new Map<string, Response>();

async function buildAll(): Promise<void> {
  for (const name of ENTRIES) {
    const result = await Bun.build({
      entrypoints: [path.join(import.meta.dir, "entries", `${name}.ts`)],
      target: "browser",
      format: "iife",
      minify: true,
    });
    const out = result.success ? result.outputs[0] : undefined;
    if (!out) {
      const msg = `Client bundle ${name} failed: ${result.logs.map(String).join("; ")}`;
      if (process.env.NODE_ENV === "production") throw new Error(msg);
      console.error(msg);
      continue;
    }
    const code = await out.text();
    const href = `/static/${name}.${Bun.hash(code).toString(36)}.js`;
    srcByName.set(name, href);
    responses.set(
      href,
      new Response(code, {
        headers: {
          ...BASE_RESPONSE_HEADERS,
          "Content-Type": "text/javascript; charset=utf-8",
          "Cache-Control": "public, max-age=31536000, immutable",
        },
      })
    );
  }
}

await buildAll();

/** Fingerprinted URL for a bundle; null when its build failed (dev only). */
export function clientScriptSrc(name: ClientScript): string | null {
  return srcByName.get(name) ?? null;
}

/** The bundle served at `pathname`, or null. Tenant-agnostic like other static assets. */
export function clientScriptResponse(pathname: string): Response | null {
  return responses.get(pathname)?.clone() ?? null;
}
