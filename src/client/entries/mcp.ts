/** /mcp: buttons with data-copy put that text on the clipboard. */
import { onReady } from "../ready";

onReady(() => {
  for (const btn of Array.from(document.querySelectorAll<HTMLElement>("[data-copy]"))) {
    btn.addEventListener("click", () => {
      navigator.clipboard.writeText(btn.dataset.copy ?? "").then(() => {
        const label = btn.textContent;
        btn.textContent = "Copied!";
        setTimeout(() => {
          btn.textContent = label;
        }, 2000);
      });
    });
  }
});
