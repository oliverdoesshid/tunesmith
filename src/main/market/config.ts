/**
 * Marketplace configuration.
 *
 * Read from `TUNESMITH_MARKET_URL` / `TUNESMITH_TELEMETRY_URL` / `TUNESMITH_MARKET_KEYS`
 * first, then from `<appPath>/market/config.json` for packaged installs. A URL must be
 * HTTPS, except loopback HTTP for local development; anything else is ignored with a log
 * line rather than half-enabled.
 *
 * With no URL configured at all the public GitHub Pages catalog is used. The catalog is
 * still signature-checked against the pinned key ring, so the default endpoint is a
 * convenience, not a trust decision.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_MARKET_CATALOG_URL } from '../../shared/market/defaults';
import { PRESET_SIGNING_KEY_ID, PRESET_SIGNING_PUBLIC_KEY } from '../security/keys';
import { loadTrustedKeys } from './verify';

export interface MarketplaceSettings {
  catalogUrl: string | null;
  telemetryUrl: string | null;
  keyRing: Map<string, string>;
  installDir: string;
  stateDir: string;
  appVersion: string;
}

interface ConfigFile {
  catalogUrl?: unknown;
  telemetryUrl?: unknown;
  keys?: unknown;
}

function readConfigFile(appPath: string): ConfigFile {
  const file = path.join(appPath, 'market', 'config.json');
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as ConfigFile;
  } catch {
    // No config file is the normal case.
  }
  return {};
}

function safeUrl(raw: unknown, label: string): string | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  try {
    const url = new URL(raw);
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) return url.toString();
    console.warn(`[market] ${label} must use HTTPS (loopback HTTP is allowed in development).`);
  } catch {
    console.warn(`[market] ${label} is not a valid URL; ignored.`);
  }
  return null;
}

export function loadMarketplaceSettings(
  appVersion: string,
  userData: string,
  appPath: string,
): MarketplaceSettings {
  const file = readConfigFile(appPath);
  const env = process.env;

  const configuredCatalog = env.TUNESMITH_MARKET_URL ?? file.catalogUrl;
  const catalogUrl =
    configuredCatalog === undefined || configuredCatalog === null
      ? DEFAULT_MARKET_CATALOG_URL
      : safeUrl(configuredCatalog, 'marketplace URL');
  const telemetryUrl = safeUrl(
    env.TUNESMITH_TELEMETRY_URL ?? file.telemetryUrl,
    'telemetry URL',
  );

  let keyRing = loadTrustedKeys(env.TUNESMITH_MARKET_KEYS);
  if (keyRing.size === 0 && file.keys !== undefined) {
    keyRing = loadTrustedKeys(JSON.stringify(file.keys));
  }
  // The public Pages catalog is signed by the same offline publisher key that signs the
  // bundled presets. That key is already compiled in, so trusting it here adds no new
  // trust root; an explicit environment/config key ring still replaces it wholesale.
  if (keyRing.size === 0) {
    keyRing = loadTrustedKeys(
      JSON.stringify({ [PRESET_SIGNING_KEY_ID]: PRESET_SIGNING_PUBLIC_KEY }),
    );
  }

  const stateDir = path.join(userData, 'market');

  return {
    catalogUrl,
    telemetryUrl,
    keyRing,
    stateDir,
    // A writable community directory beside the user's data. The bundled
    // `presets/community` directory is installed read-only next to the app and its files
    // are signed individually; marketplace installs are verified at download time.
    installDir: path.join(userData, 'presets', 'community'),
    appVersion,
  };
}
