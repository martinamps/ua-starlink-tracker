/**
 * Live filter for a registration table: rows carry data-tail-row and their
 * tail as the id. Registrations are [A-Z-] only, so "FHRBB" finds "F-HRBB" —
 * people type it without the dash.
 */
export function wireTailFilter(): void {
  const input = document.getElementById("tail-filter") as HTMLInputElement | null;
  if (!input) return;
  const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-tail-row]"));
  input.addEventListener("input", () => {
    const q = input.value.toUpperCase().replace(/[^A-Z]/g, "");
    for (const r of rows) r.hidden = q.length > 0 && !r.id.replace("-", "").includes(q);
  });
}
