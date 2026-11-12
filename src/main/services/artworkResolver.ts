/**
 * Zero-key Steam artwork resolution.
 *
 * The chain is deliberately simple and fully offline-capable:
 *   1. the local Steam library cache (`{appId}_library_600x900.jpg`, ...) as `file://`
 *   2. Valve's public CDN, after a cheap HEAD probe so a missing app ID becomes a
 *      placeholder instead of four broken `<img>` elements
 *   3. a placeholder signal, rendered as the launcher's built-in plate
 *
 * No API key, no third-party service and no remote URL supplied by the renderer: every
 * URL is built here from a validated numeric App ID. Local paths are likewise built
 * from the validated ID and never from user input, so a request cannot escape the
 * configured cache directory.
 *
 * This module intentionally has no Electron import, which keeps it unit-testable in a
 * plain Node environment.
 */
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  ArtworkOrigin,
  ResolvedArtworkAsset,
  ResolvedGameArtwork,
} from '../../shared/game/artwork';

export const STEAM_CDN_BASE = 'https://cdn.akamai.steamstatic.com/steam/apps';
export const STEAM_LIBRARY_CACHE_ENV = 'TUNESMITH_STEAM_CACHE_DIR';
export const DEFAULT_STEAM_LIBRARY_CACHE = 'C:\\Program Files (x86)\\Steam\\appcache\\librarycache';

export const STEAM_ARTWORK_KINDS = ['cover', 'hero', 'header', 'logo'] as const;
export type SteamArtworkKind = (typeof STEAM_ARTWORK_KINDS)[number];

/** Steam App IDs are unsigned 32-bit integers. */
const MAX_STEAM_APP_ID = 4_294_967_295;
const PROBE_TIMEOUT_MS = 4_000;
const POSITIVE_TTL_MS = 6 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 60 * 1000;

/** File names on Valve's public CDN. */
const CDN_FILE_NAMES: Record<SteamArtworkKind, string> = {
  cover: 'library_600x900.jpg',
  hero: 'library_hero.jpg',
  header: 'header.jpg',
  logo: 'logo.png',
};

/** File names Steam writes into `appcache/librarycache/`. */
const CACHE_FILE_NAMES: Record<SteamArtworkKind, string> = {
  cover: 'library_600x900.jpg',
  hero: 'hero.jpg',
  header: 'header.jpg',
  logo: 'logo.png',
};

export interface SteamCdnUrls {
  cover: string;
  hero: string;
  header: string;
  logo: string;
}

export interface SteamCacheFiles {
  cover: string;
  hero: string;
  header: string;
  logo: string;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ArtworkResolverOptions {
  /** Steam's library cache directory, or any user-configured equivalent. */
  cacheDir: string;
  fetchImpl?: FetchLike;
  now?: () => number;
  log?: (line: string) => void;
  /** Set false to skip network probes and always offer the CDN URLs. Defaults to true. */
  verifyCdn?: boolean;
}

/** Validate an untrusted App ID before it is used to build a URL or a file name. */
export function parseSteamAppId(value: string | number): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 && value <= MAX_STEAM_APP_ID ? value : null;
  }

  const trimmed = value.trim();
  if (!/^[1-9][0-9]{0,9}$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= MAX_STEAM_APP_ID ? parsed : null;
}

/** Official CDN URLs for one App ID, or null when the ID is not a valid Steam ID. */
export function steamCdnUrls(appId: string | number): SteamCdnUrls | null {
  const id = parseSteamAppId(appId);
  if (id === null) return null;

  const prefix = `${STEAM_CDN_BASE}/${String(id)}`;
  return {
    cover: `${prefix}/${CDN_FILE_NAMES.cover}`,
    hero: `${prefix}/${CDN_FILE_NAMES.hero}`,
    header: `${prefix}/${CDN_FILE_NAMES.header}`,
    logo: `${prefix}/${CDN_FILE_NAMES.logo}`,
  };
}

/** Local cache file names for one App ID, or null when the ID is invalid. */
export function steamCacheFileNames(appId: string | number): SteamCacheFiles | null {
  const id = parseSteamAppId(appId);
  if (id === null) return null;

  return {
    cover: `${String(id)}_${CACHE_FILE_NAMES.cover}`,
    hero: `${String(id)}_${CACHE_FILE_NAMES.hero}`,
    header: `${String(id)}_${CACHE_FILE_NAMES.header}`,
    logo: `${String(id)}_${CACHE_FILE_NAMES.logo}`,
  };
}

/**
 * Resolve the cache directory: an explicit `TUNESMITH_STEAM_CACHE_DIR` wins, otherwise
 * Steam's default Windows install path.
 */
export function steamCacheDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[STEAM_LIBRARY_CACHE_ENV]?.trim();
  const target = configured !== undefined && configured.length > 0 ? configured : DEFAULT_STEAM_LIBRARY_CACHE;
  return path.resolve(target);
}

/**
 * Scan the cache for one App ID. Only four known names are ever read, all derived from
 * the validated numeric ID, so a configured directory cannot be used for traversal.
 */
export async function findLocalSteamArtwork(
  cacheDir: string,
  appId: string | number,
): Promise<Partial<Record<SteamArtworkKind, string>>> {
  const files = steamCacheFileNames(appId);
  if (files === null) return {};

  const root = path.resolve(cacheDir);
  const found: Partial<Record<SteamArtworkKind, string>> = {};

  await Promise.all(
    STEAM_ARTWORK_KINDS.map(async (kind) => {
      const file = path.join(root, files[kind]);
      try {
        const info = await stat(file);
        if (info.isFile() && info.size > 0) found[kind] = pathToFileURL(file).href;
      } catch {
        // Missing or unreadable cache entries simply fall through to the CDN.
      }
    }),
  );

  return found;
}

type ProbeResult = 'available' | 'missing' | 'unreachable';

async function probeCdn(fetchImpl: FetchLike, url: string): Promise<ProbeResult> {
  try {
    const response = await fetchImpl(url, {
      method: 'HEAD',
      redirect: 'error',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (response.ok) return 'available';
    if (response.status === 404 || response.status === 403) return 'missing';
    return 'unreachable';
  } catch {
    return 'unreachable';
  }
}

function placeholder(appId: number | null, message: string | null): ResolvedGameArtwork {
  return {
    appId,
    cover: null,
    hero: null,
    header: null,
    logo: null,
    source: 'placeholder',
    placeholder: true,
    message,
  };
}

function asset(url: string, origin: Exclude<ArtworkOrigin, 'placeholder'>): ResolvedArtworkAsset {
  return { url, origin };
}

interface CacheEntry {
  value: ResolvedGameArtwork;
  expiresAt: number;
}

export class ArtworkResolver {
  private readonly cacheDir: string;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly verifyCdn: boolean;

  private readonly cache = new Map<number, CacheEntry>();
  private readonly inFlight = new Map<number, Promise<ResolvedGameArtwork>>();

  constructor(options: ArtworkResolverOptions) {
    this.cacheDir = path.resolve(options.cacheDir);
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? (() => {});
    this.verifyCdn = options.verifyCdn ?? true;
  }

  get cacheDirectory(): string {
    return this.cacheDir;
  }

  /**
   * Resolve one Steam title. Never throws: an invalid ID, a cache miss with no network
   * and an unavailable CDN all come back as a placeholder with a user-safe message.
   */
  async resolve(appId: string | number): Promise<ResolvedGameArtwork> {
    const id = parseSteamAppId(appId);
    if (id === null) {
      return placeholder(null, 'This title has no valid Steam App ID.');
    }

    const cached = this.cache.get(id);
    if (cached !== undefined && cached.expiresAt > this.now()) return cached.value;

    const pending = this.inFlight.get(id);
    if (pending !== undefined) return pending;

    const work = this.resolveOne(id).finally(() => {
      if (this.inFlight.get(id) === work) this.inFlight.delete(id);
    });
    this.inFlight.set(id, work);
    return work;
  }

  /** Drop every memoised result; the next request rescans the cache and probes again. */
  clearCache(): void {
    this.cache.clear();
  }

  private async resolveOne(id: number): Promise<ResolvedGameArtwork> {
    const cdn = steamCdnUrls(id);
    if (cdn === null) return placeholder(null, 'This title has no valid Steam App ID.');

    const local = await findLocalSteamArtwork(this.cacheDir, id).catch((error: unknown) => {
      this.log(`local cache scan failed for ${String(id)}: ${String(error)}`);
      return {} as Partial<Record<SteamArtworkKind, string>>;
    });

    const missing = STEAM_ARTWORK_KINDS.filter((kind) => local[kind] === undefined);
    const probeResults = new Map<SteamArtworkKind, ProbeResult>();

    if (this.verifyCdn) {
      await Promise.all(
        missing.map(async (kind) => {
          probeResults.set(kind, await probeCdn(this.fetchImpl, cdn[kind]));
        }),
      );
    }

    const assets: Partial<Record<SteamArtworkKind, ResolvedArtworkAsset>> = {};
    let hasCdn = false;
    for (const kind of STEAM_ARTWORK_KINDS) {
      const localUrl = local[kind];
      if (localUrl !== undefined) {
        assets[kind] = asset(localUrl, 'local-cache');
        continue;
      }
      if (!this.verifyCdn || probeResults.get(kind) === 'available') {
        assets[kind] = asset(cdn[kind], 'steam-cdn');
        hasCdn = true;
      }
    }

    if (assets.cover === undefined && assets.hero === undefined && assets.header === undefined && assets.logo === undefined) {
      const unreachable = [...probeResults.values()].some((result) => result === 'unreachable');
      // A title without Steam artwork is normal; only a connectivity problem deserves
      // a visible notice. Both outcomes are negatively cached, briefly for an outage.
      const value = placeholder(
        id,
        unreachable ? 'Steam artwork is unreachable right now. A placeholder is shown.' : null,
      );
      this.cache.set(id, { value, expiresAt: this.now() + NEGATIVE_TTL_MS });
      return value;
    }

    const source: ArtworkOrigin = hasCdn ? 'steam-cdn' : 'local-cache';
    const value: ResolvedGameArtwork = {
      appId: id,
      cover: assets.cover ?? null,
      hero: assets.hero ?? null,
      header: assets.header ?? null,
      logo: assets.logo ?? null,
      source,
      placeholder: false,
      message: null,
    };
    this.cache.set(id, { value, expiresAt: this.now() + POSITIVE_TTL_MS });
    return value;
  }
}
