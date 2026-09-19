/** Indefinite article for a word as spoken: "an Alaska", "a United", "a Flight". */
export function article(word: string): "a" | "an" {
  if (/^(uni|use|usu|eu|one)/i.test(word)) return "a";
  return /^[aeiou]/i.test(word) ? "an" : "a";
}
