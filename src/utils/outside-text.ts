/**
 * Shape checks for text an outside service hands us (the aircraft lookup's
 * tail, type name and airports) before any of it is printed in a sentence, a
 * message or a key. A value of the right shape passes through unchanged; one
 * that isn't is dropped, never repaired, so nothing reads as a tail that
 * wasn't one. Callers trim surrounding space first: that is the lookup's
 * formatting, not part of the value.
 */

// N782HA, F-GSQA, A7-BEA, JA873A, 9V-SMA: letters and digits, one hyphen at most.
const REGISTRATION = /^(?=.{2,10}$)[A-Za-z0-9]+(?:-[A-Za-z0-9]+)?$/;

export function isRegistration(tail: string | null | undefined): tail is string {
  return typeof tail === "string" && REGISTRATION.test(tail);
}

// "Boeing 737-990(ER)", "Airbus A220-300 (BD-500-1A11)", "ATR 72-600".
const TYPE_NAME = /^(?=.{1,60}$)[A-Za-z0-9][A-Za-z0-9 ()./-]*$/;

/** The type name as given, or null where it isn't a plain model name. */
export function plainTypeName(name: string | null | undefined): string | null {
  return typeof name === "string" && TYPE_NAME.test(name) ? name : null;
}

const AIRPORT = /^[A-Za-z0-9]{3,4}$/;

export function isAirportCode(code: string | null | undefined): code is string {
  return typeof code === "string" && AIRPORT.test(code);
}
