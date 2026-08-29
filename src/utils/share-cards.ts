/**
 * Share-card path derivation, shared by the nightly generator
 * (scripts/generate-og-images.ts) and the pages that offer the download —
 * one derivation so the writer and the reader can never drift.
 *
 * PNG, not the og cards' webp: the card is handed to users to post, and PNG
 * pastes cleanly everywhere.
 */

import type { AirlineCode } from "../airlines/registry";

export function shareCardFile(scope: AirlineCode | "ALL"): string {
  return `share-card-${scope === "ALL" ? "hub" : scope.toLowerCase()}.png`;
}

export function shareCardPath(scope: AirlineCode | "ALL"): string {
  return `/static/${shareCardFile(scope)}`;
}
