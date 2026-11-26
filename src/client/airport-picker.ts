/**
 * The route planner's boxes take a city or an airport name: this offers the
 * airports that match and puts the chosen code in the box. It is the ARIA
 * combobox with a listbox popup: arrow keys move, Enter chooses, Escape
 * closes, and a tap or click chooses too.
 *
 * Loaded only once a visitor touches a box (entries/airport-picker.ts), so the
 * names table costs the page nothing until then. Typed text is only ever set
 * as text, never as markup, and never leaves the browser: the search runs
 * here and the form sends the chosen code.
 */
import {
  AIRPORT_QUERY_MAX,
  type AirportMatch,
  resolveAirport,
  searchAirports,
} from "../utils/airport-search";
import { HINT_ERROR, HINT_PLAIN } from "./hint-classes";

/** What the planner asks of a box when the form is sent. */
export interface AirportBox {
  /** The code to search by, or null when the visitor has more to do. */
  resolve(): string | null;
}

export interface AirportBoxParts {
  input: HTMLInputElement;
  /** The empty, hidden listbox beside the input. */
  list: HTMLElement;
  /** The line under the box: the chosen airport's name, or what went wrong. */
  hint: HTMLElement;
  /** Says a result to a screen reader without moving focus. */
  announce: (text: string) => void;
  /** Airports this airline flies most, first: they lead within a rank. */
  prefer: readonly string[];
  /** False when the box's text was already searched: no list opens over the results. */
  openNow: boolean;
}

const OPTIONS_SHOWN = 8;

const OPTION =
  "flex items-baseline justify-between gap-3 px-3 py-3 text-sm text-primary cursor-pointer border-l-2 border-transparent";
const OPTION_ACTIVE = `${OPTION} bg-accent/20 border-accent`;
const OPTION_NAME = "min-w-0 break-words";
const OPTION_CODE = "shrink-0 font-mono text-xs text-secondary";
// On the highlight the quieter grey falls under 4.5:1.
const OPTION_CODE_ACTIVE = "shrink-0 font-mono text-xs text-primary";

export function attachAirportBox({
  input,
  list,
  hint,
  announce,
  prefer,
  openNow,
}: AirportBoxParts): AirportBox {
  let matches: AirportMatch[] = [];
  let active = -1;

  const say = (text: string, error = false) => {
    hint.textContent = text;
    hint.className = error ? HINT_ERROR : HINT_PLAIN;
    if (error) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
  };

  const draw = () => {
    const open = matches.length > 0;
    list.replaceChildren(
      ...matches.map((m, i) => {
        const row = document.createElement("div");
        row.id = `${list.id}-${i}`;
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", String(i === active));
        row.dataset.index = String(i);
        row.className = i === active ? OPTION_ACTIVE : OPTION;
        const name = document.createElement("span");
        name.className = OPTION_NAME;
        name.textContent = m.name;
        const code = document.createElement("span");
        code.className = i === active ? OPTION_CODE_ACTIVE : OPTION_CODE;
        code.textContent = m.code;
        row.append(name, code);
        return row;
      })
    );
    list.hidden = !open;
    input.setAttribute("aria-expanded", String(open));
    if (open && active >= 0) {
      input.setAttribute("aria-activedescendant", `${list.id}-${active}`);
      list.children[active]?.scrollIntoView({ block: "nearest" });
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  };

  const close = () => {
    matches = [];
    active = -1;
    draw();
  };

  const show = (found: AirportMatch[], total: number) => {
    matches = found;
    active = -1;
    draw();
    if (total === 0) return;
    const more = total > found.length ? ` Showing ${found.length}; keep typing to narrow.` : "";
    announce(`${total} airport${total === 1 ? "" : "s"} match.${more}`);
  };

  const choose = (m: AirportMatch) => {
    input.value = m.code;
    say(m.name);
    close();
    announce(`${m.name}, ${m.code}, chosen.`);
  };

  const search = () => {
    const text = input.value.trim();
    if (!text) {
      // An emptied box leaves no count behind for a screen reader to find.
      announce("");
      return close();
    }
    const { matches: found, total } = searchAirports(text, OPTIONS_SHOWN, prefer);
    show(found, total);
    if (total === 0 && text.length > 4) announce("No airport matches.");
  };

  input.addEventListener("input", () => {
    say("");
    search();
  });
  // This script arrives a moment after the first touch: a visitor who has
  // already typed gets the list for what is in the box, not at the next key.
  if (openNow && document.activeElement === input) search();

  input.addEventListener("keydown", (e) => {
    // An input method's own Enter and arrows pick its candidate, not ours.
    if (e.isComposing) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (matches.length === 0) {
        const { matches: found, total } = searchAirports(input.value, OPTIONS_SHOWN, prefer);
        if (total === 0) return;
        show(found, total);
      }
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      // From the box, Down lands on the first and Up on the last; both wrap.
      active =
        active < 0 && step < 0
          ? matches.length - 1
          : (active + step + matches.length) % matches.length;
      draw();
    } else if (e.key === "Enter" && active >= 0) {
      // Enter with nothing highlighted is the form's: a typed code goes
      // straight to the search, with no extra step.
      e.preventDefault();
      choose(matches[active]);
    } else if (e.key === "Escape" && matches.length > 0) {
      e.preventDefault();
      close();
    }
  });

  input.addEventListener("blur", close);
  // Keeps the focus in the box, so the tap that chooses is not also a blur
  // that closes the list first. Touch scrolling of the list is not a mousedown.
  list.addEventListener("mousedown", (e) => e.preventDefault());
  list.addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-index]");
    const m = row ? matches[Number(row.dataset.index)] : undefined;
    if (m) choose(m);
  });

  return {
    resolve() {
      const typed = input.value.trim().slice(0, AIRPORT_QUERY_MAX);
      const r = resolveAirport(typed, prefer);
      if (r.kind === "code") {
        input.value = r.code;
        say(r.name ?? "");
        close();
        return r.code;
      }
      // The list closes on blur, and the form may have been sent by its button.
      input.focus();
      if (r.kind === "choose") {
        show(r.matches, r.total);
        say(`${r.total} airports match “${typed}”. Choose one.`, true);
        announce(`${r.total} airports match ${typed}. Choose one.`);
      } else {
        close();
        say(`No airport matches “${typed}”. Try a city or a 3-letter code.`, true);
        announce(`No airport matches ${typed}. Try a city or a 3-letter airport code.`);
      }
      return null;
    },
  };
}
