/**
 * Zero-key Steam artwork resolution.
 *
 * The security-relevant rules are tested directly: App IDs are validated before they
 * become URLs or file names, only four generated cache names are read, and every
 * failure degrades to a placeholder instead of throwing at the library grid.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ArtworkResolver,
  DEFAULT_STEAM_LIBRARY_CACHE,
  findLocalSteamArtwork,
  parseSteamAppId,
  STEAM_CDN_BASE,
  steamCacheDirFromEnv,
  steamCacheFileNames,
  steamCdnUrls,
  type FetchLike,
} from '../src/main/services/artworkResolver';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tunesmith-artwork-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('Steam artwork URL and cache rules', () => {
  it('accepts only positive integer App IDs inside the unsigned 32-bit range', () => {
    expect(parseSteamAppId(730)).toBe(730);
    expect(parseSteamAppId('730')).toBe(730);
    expect(parseSteamAppId(' 730 ')).toBe(730);
    expect(parseSteamAppId('001')).toBeNull();
    expect(parseSteamAppId('0')).toBeNull();
    expect(parseSteamAppId('-1')).toBeNull();
    expect(parseSteamAppId('73a')).toBeNull();
    expect(parseSteamAppId('../730')).toBeNull();
    expect(parseSteamAppId('1'.repeat(11))).toBeNull();
    expect(parseSteamAppId(1.5)).toBeNull();
    expect(parseSteamAppId(4_294_967_296)).toBeNull();
  });

  it('builds the four official CDN URLs', () => {
    expect(steamCdnUrls(1091500)).toEqual({
      cover: `${STEAM_CDN_BASE}/1091500/library_600x900.jpg`,
      hero: `${STEAM_CDN_BASE}/1091500/library_hero.jpg`,
      header: `${STEAM_CDN_BASE}/1091500/header.jpg`,
      logo: `${STEAM_CDN_BASE}/1091500/logo.png`,
    });
    expect(steamCdnUrls('../1091500')).toBeNull();
  });

  it('builds the local cache names Steam writes for a title', () => {
    expect(steamCacheFileNames(730)).toEqual({
      cover: '730_library_600x900.jpg',
      hero: '730_hero.jpg',
      header: '730_header.jpg',
      logo: '730_logo.png',
    });
    expect(steamCacheFileNames('nope')).toBeNull();
  });

  it('uses the default Steam cache path unless an explicit path is configured', () => {
    expect(steamCacheDirFromEnv({})).toBe(path.resolve(DEFAULT_STEAM_LIBRARY_CACHE));
    expect(steamCacheDirFromEnv({ TUNESMITH_STEAM_CACHE_DIR: '  D:\\SteamCache  ' })).toBe(
      path.resolve('D:\\SteamCache'),
    );
  });

  it('returns only file URLs for cache entries that exist', async () => {
    const cacheDir = await tempDir();
    await writeFile(path.join(cacheDir, '730_library_600x900.jpg'), Buffer.from('cover'));
    await writeFile(path.join(cacheDir, '730_logo.png'), Buffer.from('logo'));

    const assets = await findLocalSteamArtwork(cacheDir, '730');
    expect(assets.cover).toBe(pathToFileURL(path.join(cacheDir, '730_library_600x900.jpg')).href);
    expect(assets.logo).toBe(pathToFileURL(path.join(cacheDir, '730_logo.png')).href);
    expect(assets.hero).toBeUndefined();
    expect(assets.header).toBeUndefined();
  });

  it('never derives a cache path from an invalid App ID', async () => {
    const cacheDir = await tempDir();
    expect(await findLocalSteamArtwork(cacheDir, '../730')).toEqual({});
  });
});

describe('ArtworkResolver fallback chain', () => {
  it('prefers the local cache and makes no network request when all assets exist', async () => {
    const cacheDir = await tempDir();
    for (const file of ['library_600x900.jpg', 'hero.jpg', 'header.jpg', 'logo.png']) {
      await writeFile(path.join(cacheDir, `730_${file}`), Buffer.from('image'));
    }

    const fetchImpl = vi.fn<FetchLike>();
    const resolver = new ArtworkResolver({ cacheDir, fetchImpl });
    const art = await resolver.resolve(730);

    expect(art.source).toBe('local-cache');
    expect(art.placeholder).toBe(false);
    expect(art.cover?.origin).toBe('local-cache');
    expect(art.cover?.url).toBe(pathToFileURL(path.join(cacheDir, '730_library_600x900.jpg')).href);
    expect(art.logo?.url).toBe(pathToFileURL(path.join(cacheDir, '730_logo.png')).href);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('falls back to the public CDN when the local cache is empty', async () => {
    const cacheDir = await tempDir();
    const fetchImpl = vi.fn<FetchLike>(async () => new Response(null, { status: 200 }));
    const resolver = new ArtworkResolver({ cacheDir, fetchImpl });
    const art = await resolver.resolve('730');

    expect(art.source).toBe('steam-cdn');
    expect(art.cover).toEqual({
      url: `${STEAM_CDN_BASE}/730/library_600x900.jpg`,
      origin: 'steam-cdn',
    });
    expect(art.hero?.url).toBe(`${STEAM_CDN_BASE}/730/library_hero.jpg`);
    expect(art.header?.url).toBe(`${STEAM_CDN_BASE}/730/header.jpg`);
    expect(art.logo?.url).toBe(`${STEAM_CDN_BASE}/730/logo.png`);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('mixes local and CDN assets per kind instead of discarding a partial cache', async () => {
    const cacheDir = await tempDir();
    await writeFile(path.join(cacheDir, '730_library_600x900.jpg'), Buffer.from('cover'));

    const fetchImpl = vi.fn<FetchLike>(async (input) => {
      const url = String(input);
      if (url.endsWith('/header.jpg')) return new Response(null, { status: 200 });
      return new Response(null, { status: 404 });
    });
    const resolver = new ArtworkResolver({ cacheDir, fetchImpl });
    const art = await resolver.resolve(730);

    expect(art.source).toBe('steam-cdn');
    expect(art.cover?.origin).toBe('local-cache');
    expect(art.header?.origin).toBe('steam-cdn');
    expect(art.hero).toBeNull();
    expect(art.logo).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('returns a placeholder when the CDN reports no artwork for the app ID', async () => {
    const cacheDir = await tempDir();
    const fetchImpl = vi.fn<FetchLike>(async () => new Response(null, { status: 404 }));
    const resolver = new ArtworkResolver({ cacheDir, fetchImpl });
    const art = await resolver.resolve(999_999_999);

    expect(art.appId).toBe(999_999_999);
    expect(art.source).toBe('placeholder');
    expect(art.placeholder).toBe(true);
    expect(art.cover).toBeNull();
    expect(art.hero).toBeNull();
    expect(art.header).toBeNull();
    expect(art.logo).toBeNull();
    expect(art.message).toBeNull();
  });

  it('returns a placeholder for an invalid App ID without touching the filesystem or network', async () => {
    const cacheDir = await tempDir();
    const fetchImpl = vi.fn<FetchLike>();
    const resolver = new ArtworkResolver({ cacheDir, fetchImpl });
    const art = await resolver.resolve('../730');

    expect(art.appId).toBeNull();
    expect(art.placeholder).toBe(true);
    expect(art.message).toMatch(/Steam App ID/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports an outage and retries after the short negative cache expires', async () => {
    const cacheDir = await tempDir();
    let now = 1_000_000;
    const fetchImpl = vi.fn<FetchLike>(async () => {
      throw new Error('offline');
    });
    const resolver = new ArtworkResolver({ cacheDir, fetchImpl, now: () => now });

    const first = await resolver.resolve(730);
    expect(first.placeholder).toBe(true);
    expect(first.message).toMatch(/unreachable/i);
    expect(fetchImpl).toHaveBeenCalledTimes(4);

    now += 30_000;
    await resolver.resolve(730);
    expect(fetchImpl).toHaveBeenCalledTimes(4);

    now += 31_000;
    await resolver.resolve(730);
    expect(fetchImpl).toHaveBeenCalledTimes(8);
  });

  it('deduplicates concurrent requests for the same title', async () => {
    const cacheDir = await tempDir();
    const fetchImpl = vi.fn<FetchLike>(async () => new Response(null, { status: 200 }));
    const resolver = new ArtworkResolver({ cacheDir, fetchImpl });

    const [first, second] = await Promise.all([resolver.resolve(730), resolver.resolve('730')]);
    expect(first).toEqual(second);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('can skip CDN probes for callers that want URLs immediately', async () => {
    const cacheDir = await tempDir();
    const fetchImpl = vi.fn<FetchLike>();
    const resolver = new ArtworkResolver({ cacheDir, fetchImpl, verifyCdn: false });
    const art = await resolver.resolve(730);

    expect(art.source).toBe('steam-cdn');
    expect(art.cover?.url).toBe(`${STEAM_CDN_BASE}/730/library_600x900.jpg`);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
