// Pins the slice of united's flight-status payload the checker relies on.
// If united renames fields the parser must degrade to null (DOM scrape is the fallback).

import { describe, expect, test } from "bun:test";
import { parseStatusApiResponse } from "../src/scripts/united-starlink-checker";

function segment(over: Record<string, unknown> = {}) {
  return {
    DepartureAirport: { IATACode: "LAX" },
    ArrivalAirport: { IATACode: "SFO" },
    Equipment: {
      TailNumber: "N73275",
      NoseNumber: "3275",
      ShipNumber: "3275",
      Model: { Description: "Boeing 737-800" },
      Amenities: { WifiPrvdr: "Starlink" },
    },
    ...over,
  };
}

function payload(...segments: Array<Record<string, unknown>>) {
  return { data: { flightLegs: [{ OperationalFlightSegments: segments }] } };
}

describe("parseStatusApiResponse", () => {
  test("extracts provider, tail, ship, and model from the equipment block", () => {
    const parsed = parseStatusApiResponse(payload(segment()), "LAX", "SFO");
    expect(parsed).toEqual({
      wifiProvider: "Starlink",
      tailNumber: "N73275",
      shipNumber: "3275",
      aircraftType: "Boeing 737-800",
    });
  });

  test("picks the segment matching the requested leg, not the first one", () => {
    const otherLeg = segment({
      DepartureAirport: { IATACode: "SFO" },
      ArrivalAirport: { IATACode: "DEN" },
      Equipment: { TailNumber: "N77590", Amenities: { WifiPrvdr: "Viasat" } },
    });
    const parsed = parseStatusApiResponse(payload(otherLeg, segment()), "LAX", "SFO");
    expect(parsed?.wifiProvider).toBe("Starlink");
    expect(parsed?.tailNumber).toBe("N73275");
  });

  test("falls back to the only segment when no leg matches", () => {
    const parsed = parseStatusApiResponse(payload(segment()), "EWR", "ORD");
    expect(parsed?.tailNumber).toBe("N73275");
  });

  test("returns null when several segments exist and none match the leg", () => {
    const otherLeg = segment({ ArrivalAirport: { IATACode: "DEN" } });
    expect(parseStatusApiResponse(payload(segment(), otherLeg), "EWR", "ORD")).toBeNull();
  });

  test.each([
    ["STARLINK Wi-Fi", "Starlink"],
    ["Panasonic Avionics", "Panasonic"],
    ["VIASAT", "Viasat"],
    ["Not offered", "None"],
    ["SomeFutureVendor", "SomeFutureVendor"],
  ])("canonicalizes provider %s to %s", (raw, expected) => {
    const variant = segment({
      Equipment: { TailNumber: "N73275", Amenities: { WifiPrvdr: raw } },
    });
    expect(parseStatusApiResponse(payload(variant), "LAX", "SFO")?.wifiProvider).toBe(expected);
  });

  test.each([
    ["null payload", null],
    ["missing flightLegs", { data: {} }],
    ["missing equipment", payload({ DepartureAirport: { IATACode: "LAX" } })],
  ])("returns null for %s", (_label, input) => {
    expect(parseStatusApiResponse(input, "LAX", "SFO")).toBeNull();
  });

  test("nulls fields that fail validation instead of passing junk through", () => {
    const parsed = parseStatusApiResponse(
      payload(
        segment({
          Equipment: {
            TailNumber: "Boeing 737-800W",
            NoseNumber: "not-a-ship",
            Model: {},
            Amenities: { WifiPrvdr: "  " },
          },
        })
      ),
      "LAX",
      "SFO"
    );
    expect(parsed).toEqual({
      wifiProvider: null,
      tailNumber: null,
      shipNumber: null,
      aircraftType: null,
    });
  });
});
