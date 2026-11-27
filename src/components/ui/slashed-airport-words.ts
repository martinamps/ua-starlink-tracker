/**
 * The words of airport names that join two places with a slash:
 * "Seattle/Tacoma", and "Dallas/Fort" of "Dallas/Fort Worth". A heading
 * offers a line break inside these and in no other slash (layout.tsx,
 * headingWords).
 *
 * Written out, not read from the airport tables: a component may not import
 * the hand table (the browser's airport picker bundles it, and server code
 * reaches names through their own functions), and the list is two dozen
 * words. tests/heading-wrap.test.ts reads the tables and fails when a slashed
 * name in one of them is missing here, or a word here is in none.
 */
// biome-ignore format: one word per line keeps the list diffable
export const SLASHED_AIRPORT_WORDS: readonly string[] = [
  "Akron/Canton",
  "Arcata/Eureka",
  "Basel/Mulhouse",
  "Bend/Coos",
  "Carbondale/Murphysboro",
  "Dallas/Fort",
  "Greenville/Spartanburg",
  "Gulfport/Biloxi",
  "Hattiesburg/Laurel",
  "Houghton/Hancock",
  "Ixtapa/Zihuatanejo",
  "León/Guanajuato",
  "Midland/Odessa",
  "Minneapolis/St.",
  "Pasco/Tri-Cities",
  "Raleigh/Durham",
  "Redmond/Bend",
  "Sarasota/Bradenton",
  "Seattle/Tacoma",
  "Springs/Hayden",
  "Tarbes/Lourdes",
  "Vail/Eagle",
  "Valley/Hailey",
  "Wilkes-Barre/Scranton",
];
