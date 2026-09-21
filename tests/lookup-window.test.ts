/**
 * The FR24 lookup span every tail-lookup surface shares (flight-verdict, MCP
 * check_flight's assignment note, the dated alternatives): yesterday through
 * three days out, on an injected clock.
 */
import { describe, expect, test } from "bun:test";
import { DAY_SEC, inLookupWindow, lookupWindowPosition } from "../src/database/sql/windows";

const now = 1_800_000_000;
const day = (offset: number) => [now + offset * DAY_SEC, now + (offset + 1) * DAY_SEC] as const;

describe("lookupWindowPosition", () => {
  test("a day that ended more than a day ago is past", () => {
    expect(lookupWindowPosition(...day(-2), now)).toBe("past");
    expect(lookupWindowPosition(...day(-1.5), now)).toBe("inside");
  });

  test("today through the next few days are inside", () => {
    for (const offset of [0, 1, 2]) expect(inLookupWindow(...day(offset), now)).toBe(true);
  });

  test("a day starting three or more days out is future", () => {
    expect(lookupWindowPosition(...day(3), now)).toBe("future");
    expect(inLookupWindow(...day(3), now)).toBe(false);
  });
});
