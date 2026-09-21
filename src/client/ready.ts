/** Run once the document is parsed; deferred bundles usually already are. */
export function onReady(fn: () => void): void {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
  else fn();
}
