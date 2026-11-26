import { MAP_HEIGHT, MAP_WIDTH } from "../../utils/map-projection";
import { BORDER_PATH, LAND_PATH, STATE_PATH } from "./basemap";

/**
 * The /routes map's coastlines as one standalone SVG, served from /static with
 * a content hash so browsers keep it for a year and each page only carries
 * its routes. Colours are spelled out because an <img> sees none of the
 * page's variables; they match index.html's surface-elevated and border.
 */
export const BASEMAP_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MAP_WIDTH} ${MAP_HEIGHT}"><path d="${LAND_PATH}" fill="#1a2332" stroke="#2b3a52" stroke-width="0.8" stroke-linejoin="round"/><path d="${BORDER_PATH}" fill="none" stroke="#33445f" stroke-width="0.9" stroke-linejoin="round"/><path d="${STATE_PATH}" fill="none" stroke="#243044" stroke-width="0.6" stroke-linejoin="round"/></svg>`;
