/**
 * Onboard call rules, stated only where the airline's own published policy
 * says so. An airline missing here gets no claim either way: agents relayed
 * "works for video calls" to United flyers, whom United bars from calling.
 *
 * Each sentence stands alone (llms.txt joins them on the hub), so a sentence
 * that quotes a page names the page and carries the date it was read.
 */
export const CALL_POLICY: Record<string, string> = {
  UA: "United does not allow voice or video calls on board, Starlink or not.",
  // Read on 2026-11-24 as a search engine's copy of the page: the page renders
  // by script and was never opened whole. Re-read before changing the date.
  // AS and QR stay out: their sites refused us, so their wording is unread.
  HA: 'Hawaiian Airlines\' Wi-Fi page says it "prohibits video or voice calls while onboard our aircraft" (as of 24 November 2026).',
};

export function callPolicy(code: string): string | null {
  return CALL_POLICY[code] ?? null;
}
