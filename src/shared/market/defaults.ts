/**
 * Default marketplace endpoint.
 *
 * A build without an explicit `TUNESMITH_MARKET_URL` (or `market/config.json`) still
 * tries the project's public GitHub Pages catalog. The endpoint is only a transport:
 * the catalog must carry a signature from a pinned key before any entry is shown, so a
 * compromised host cannot substitute content.
 */
export const DEFAULT_MARKET_CATALOG_URL =
  'https://oliverdoesshid.github.io/tunesmith/market/catalog.json';
