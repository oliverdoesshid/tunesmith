/**
 * SteamGridDB v2 artwork service.
 *
 * The API key, the network request and every downloaded byte stay in the main process.
 * The renderer receives only `ts-art://` URLs that point at files this service wrote,
 * so a malicious API/CDN response cannot inject a remote image, a file URL, or a path
 * that escapes the cache directory.
 *
 * Failure policy:
 *   - no key          -> one `not-configured` batch, no requests, no cache writes
 *   - no match        -> `not-found`, negatively cached for a day
 *   - network/API     -> `error` with a short message, never cached, never thrown at the UI
 *   - partial images  -> `ok` with whichever categories downloaded, cached for a week
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { access, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { TuneSmithError, describeError } from '../../shared/errors';
import type {
  ArtworkAsset,
  ArtworkRequestItem,
  GameArtwork,
  GameArtworkBatch,
} from '../../shared/game/artwork';
import {
  type CachedImageExtension,
  detectImageType,
  isAllowedArtworkUrl,
  artworkUrl,
} from './artwork-files';

export const STEAMGRIDDB_API_BASE = 'https://www.steamgriddb.com/api/v2';
export const STEAMGRIDDB_API_KEY_ENV = 'STEAMGRIDDB_API_KEY';
export const STEAMGRIDDB_KEY_FILE = 'steamgriddb.key';

const INDEX_FILE = 'index.json';
const INDEX_VERSION = 1;
const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const MAX_INDEX_ENTRIES = 400;
const MAX_SEARCH_RESULTS = 20;
const MAX_LIST_IMAGES = 100;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const IMAGE_TIMEOUT_MS = 20_000;
const BATCH_CONCURRENCY = 3;
const POSITIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000;

const ARTWORK_KINDS = ['grid', 'hero', 'logo'] as const;
type ArtworkKind = (typeof ARTWORK_KINDS)[number];

export const ARTWORK_CONFIG_HINT =
  'SteamGridDB artwork is not configured. Set the STEAMGRIDDB_API_KEY environment variable, or save your key in steamgriddb.key inside TuneSmith’s user-data folder, then restart.';

/* ------------------------------------------------------------------ *
 * Response parsing
 * ------------------------------------------------------------------ */

const envelopeSchema = z.object({
  success: z.boolean(),
  data: z.unknown().optional(),
  errors: z.array(z.unknown()).optional(),
});

const searchEntrySchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1).max(200),
});

const imageSchema = z.object({
  url: z.string().min(1).max(2048),
  width: z.number().int().min(0).max(16_384).default(0),
  height: z.number().int().min(0).max(16_384).default(0),
  mime: z.string().max(80).optional(),
  style: z.string().max(40).optional(),
  nsfw: z.boolean().optional(),
  humor: z.boolean().optional(),
});

export type SgdbSearchEntry = z.infer<typeof searchEntrySchema>;
export type SgdbImage = z.infer<typeof imageSchema>;

function envelopeFailure(envelope: z.infer<typeof envelopeSchema>, fallback: string): TuneSmithError {
  const detail = envelope.errors === undefined ? '' : ` (${envelope.errors.length} error(s))`;
  return new TuneSmithError('parse-failed', `${fallback}${detail}`);
}

/** Validate an autocomplete response. Exported for fixtures and tests. */
export function parseSteamGridDbSearch(payload: unknown): SgdbSearchEntry[] {
  const parsed = envelopeSchema.safeParse(payload);
  if (!parsed.success) {
    throw new TuneSmithError('parse-failed', 'SteamGridDB returned an unreadable search response.');
  }
  if (!parsed.data.success) {
    throw envelopeFailure(parsed.data, 'SteamGridDB could not complete the title search.');
  }

  const list = z.array(searchEntrySchema).max(MAX_SEARCH_RESULTS).safeParse(parsed.data.data ?? []);
  if (!list.success) {
    throw new TuneSmithError('parse-failed', 'SteamGridDB returned malformed search results.');
  }
  return list.data;
}

/** Validate a grids/heroes/logos response. Exported for fixtures and tests. */
export function parseSteamGridDbImages(payload: unknown): SgdbImage[] {
  const parsed = envelopeSchema.safeParse(payload);
  if (!parsed.success) {
    throw new TuneSmithError('parse-failed', 'SteamGridDB returned an unreadable artwork response.');
  }
  if (!parsed.data.success) {
    throw envelopeFailure(parsed.data, 'SteamGridDB could not fetch artwork for this title.');
  }

  const list = z.array(imageSchema).max(MAX_LIST_IMAGES).safeParse(parsed.data.data ?? []);
  if (!list.success) {
    throw new TuneSmithError('parse-failed', 'SteamGridDB returned malformed artwork metadata.');
  }
  return list.data;
}

function normalisePercent(value: string): string {
  return value.replace(/[®™©]/g, '');
}

/** Lowercase, punctuation-free title used for matching and as the cache key. */
export function normaliseArtworkTitle(value: string): string {
  return normalisePercent(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .slice(0, 200);
}

/**
 * Pick the closest autocomplete result. An exact normalised match wins; otherwise a
 * containment match is accepted, because SteamGridDB often appends edition subtitles.
 * A result set with no relation to the title is treated as no match, so a search for an
 * obscure title cannot silently receive another game's art.
 */
export function pickSearchEntry(entries: readonly SgdbSearchEntry[], title: string): SgdbSearchEntry | null {
  const target = normaliseArtworkTitle(title);
  if (target.length === 0) return null;

  const exact = entries.find((entry) => normaliseArtworkTitle(entry.name) === target);
  if (exact !== undefined) return exact;

  return (
    entries.find((entry) => {
      const candidate = normaliseArtworkTitle(entry.name);
      if (candidate.length === 0) return false;
      return candidate.includes(target) || target.includes(candidate);
    }) ?? null
  );
}

function usableImage(image: SgdbImage): boolean {
  if (image.nsfw === true || image.humor === true) return false;
  if (image.style === 'animated') return false;
  if (image.mime !== undefined) {
    const mime = image.mime.toLowerCase();
    if (mime !== 'image/png' && mime !== 'image/jpeg' && mime !== 'image/webp') return false;
  }
  return isAllowedArtworkUrl(image.url);
}

/** Choose one image per category. Vertical covers are preferred for grids. */
export function pickArtworkImage(images: readonly SgdbImage[], kind: ArtworkKind): SgdbImage | null {
  const usable = images.filter(usableImage);
  if (usable.length === 0) return null;
  if (kind === 'grid') return usable.find((image) => image.height >= image.width * 1.2) ?? usable[0] ?? null;
  if (kind === 'hero') return usable.find((image) => image.width >= 1200) ?? usable[0] ?? null;
  return usable[0] ?? null;
}

/* ------------------------------------------------------------------ *
 * API key
 * ------------------------------------------------------------------ */

function validKeyShape(value: string): boolean {
  return /^[A-Za-z0-9._-]{8,256}$/.test(value);
}

/**
 * API key precedence: environment, then a single-line file in the user-data folder.
 * No key is ever logged or included in an IPC error.
 */
export function loadSteamGridDbApiKey(
  userDataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const fromEnv = env[STEAMGRIDDB_API_KEY_ENV]?.trim();
  // A malformed environment value must not hide a valid key file.
  if (fromEnv !== undefined && validKeyShape(fromEnv)) return fromEnv;

  try {
    const fromFile = readFileSync(path.join(userDataDir, STEAMGRIDDB_KEY_FILE), 'utf8').trim();
    return fromFile.length > 0 && validKeyShape(fromFile) ? fromFile : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Cache
 * ------------------------------------------------------------------ */

const cachedImageSchema = z.object({
  file: z.string().regex(/^[a-f0-9]{64}\.(png|jpg|webp)$/),
  width: z.number().int().min(0).max(16_384),
  height: z.number().int().min(0).max(16_384),
});

const cacheEntrySchema = z.object({
  fetchedAt: z.number().int().min(0),
  status: z.enum(['ok', 'not-found']),
  sgdbId: z.number().int().positive().nullable(),
  matchedTitle: z.string().max(200).nullable(),
  message: z.string().max(500).nullable(),
  images: z.object({
    grid: cachedImageSchema.optional(),
    hero: cachedImageSchema.optional(),
    logo: cachedImageSchema.optional(),
  }),
});

const cacheIndexSchema = z.object({
  version: z.literal(INDEX_VERSION),
  entries: z.record(z.string().min(1).max(200), cacheEntrySchema),
});

type CachedImage = z.infer<typeof cachedImageSchema>;
type CacheEntry = z.infer<typeof cacheEntrySchema>;
type CacheIndex = z.infer<typeof cacheIndexSchema>;

type ArtworkBody = Pick<
  GameArtwork,
  'status' | 'steamGridDbId' | 'matchedTitle' | 'grid' | 'hero' | 'logo' | 'message'
>;

interface FetchedArtwork {
  body: ArtworkBody;
  files: Partial<Record<ArtworkKind, CachedImage>>;
}

/* ------------------------------------------------------------------ *
 * Service
 * ------------------------------------------------------------------ */

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface SteamGridDbServiceOptions {
  cacheDir: string;
  apiKey: string | null;
  fetchImpl?: FetchLike;
  now?: () => number;
  log?: (line: string) => void;
}

class SteamGridDbNotFoundError extends Error {
  constructor() {
    super('SteamGridDB has no record for this title.');
    this.name = 'SteamGridDbNotFoundError';
  }
}

function shortError(error: unknown): string {
  return describeError(error).replace(/\s+/g, ' ').slice(0, 240);
}

function noArtwork(status: 'not-found' | 'not-configured' | 'error', message: string): ArtworkBody {
  return {
    status,
    steamGridDbId: null,
    matchedTitle: null,
    grid: null,
    hero: null,
    logo: null,
    message,
  };
}

function emptyImages(): CacheEntry['images'] {
  return {};
}

async function fileExists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

const ENDPOINT_SEGMENT: Record<ArtworkKind, string> = {
  grid: 'grids',
  hero: 'heroes',
  logo: 'logos',
};

function endpointFor(kind: ArtworkKind, gameId: number): string {
  const query = '?nsfw=false&humor=false&types=static';
  return `/${ENDPOINT_SEGMENT[kind]}/game/${String(gameId)}${query}`;
}

export class SteamGridDbService {
  private readonly cacheDir: string;
  private readonly imagesDir: string;
  private readonly indexPath: string;
  private readonly apiKey: string | null;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  private index: CacheIndex | null = null;
  private loadPromise: Promise<CacheIndex> | null = null;
  private saveChain: Promise<void> = Promise.resolve();
  private readonly inFlight = new Map<string, Promise<ArtworkBody>>();

  constructor(options: SteamGridDbServiceOptions) {
    this.cacheDir = path.resolve(options.cacheDir);
    this.imagesDir = path.join(this.cacheDir, 'images');
    this.indexPath = path.join(this.cacheDir, INDEX_FILE);
    this.apiKey = options.apiKey !== null && validKeyShape(options.apiKey) ? options.apiKey : null;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? (() => {});
  }

  get configured(): boolean {
    return this.apiKey !== null;
  }

  async artworkForGames(items: readonly ArtworkRequestItem[]): Promise<GameArtworkBatch> {
    if (this.apiKey === null) {
      return {
        configured: false,
        message: ARTWORK_CONFIG_HINT,
        items: items.map((item) => ({
          key: item.key,
          title: item.title,
          ...noArtwork('not-configured', ARTWORK_CONFIG_HINT),
        })),
      };
    }

    const results = await mapLimit(items, BATCH_CONCURRENCY, (item) => this.artworkFor(item));
    return { configured: true, message: null, items: results };
  }

  async artworkFor(item: ArtworkRequestItem): Promise<GameArtwork> {
    const title = item.title.replace(/\s+/g, ' ').trim().slice(0, 160);
    const key = item.key;

    if (this.apiKey === null) {
      return { key, title, ...noArtwork('not-configured', ARTWORK_CONFIG_HINT) };
    }
    if (title.length === 0) {
      return { key, title, ...noArtwork('not-found', 'This title has no usable name to search for.') };
    }

    const cacheKey = normaliseArtworkTitle(title);
    const pending = this.inFlight.get(cacheKey);
    if (pending !== undefined) {
      return { key, title, ...(await pending) };
    }

    const work = this.resolve(cacheKey, title).finally(() => {
      if (this.inFlight.get(cacheKey) === work) this.inFlight.delete(cacheKey);
    });
    this.inFlight.set(cacheKey, work);
    return { key, title, ...(await work) };
  }

  private async resolve(cacheKey: string, title: string): Promise<ArtworkBody> {
    try {
      const cached = await this.readCached(cacheKey);
      if (cached !== null) return cached;

      const fetched = await this.fetchArtwork(title);
      if (fetched.body.status === 'ok' || fetched.body.status === 'not-found') {
        const index = await this.getIndex();
        index.entries[cacheKey] = {
          fetchedAt: this.now(),
          status: fetched.body.status,
          sgdbId: fetched.body.steamGridDbId,
          matchedTitle: fetched.body.matchedTitle,
          message: fetched.body.message,
          images: fetched.files,
        };
        await this.evict(index);
        await this.persist(index);
      }
      return fetched.body;
    } catch (error) {
      const message = shortError(error);
      this.log(`artwork lookup failed for "${title}": ${message}`);
      return noArtwork('error', message);
    }
  }

  private async readCached(cacheKey: string): Promise<ArtworkBody | null> {
    const index = await this.getIndex();
    const entry = index.entries[cacheKey];
    if (entry === undefined) return null;

    const ttl = entry.status === 'ok' ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
    if (this.now() - entry.fetchedAt >= ttl) return null;

    if (entry.status === 'not-found') {
      return {
        status: 'not-found',
        steamGridDbId: entry.sgdbId,
        matchedTitle: entry.matchedTitle,
        grid: null,
        hero: null,
        logo: null,
        message: entry.message ?? 'SteamGridDB has no artwork for this title.',
      };
    }

    const assets: Partial<Record<ArtworkKind, ArtworkAsset>> = {};
    for (const kind of ARTWORK_KINDS) {
      const image = entry.images[kind];
      if (image === undefined) continue;
      if (!(await fileExists(path.join(this.imagesDir, image.file)))) continue;
      assets[kind] = {
        url: artworkUrl(image.file),
        width: image.width,
        height: image.height,
      };
    }

    if (Object.keys(assets).length === 0) return null;
    return {
      status: 'ok',
      steamGridDbId: entry.sgdbId,
      matchedTitle: entry.matchedTitle,
      grid: assets.grid ?? null,
      hero: assets.hero ?? null,
      logo: assets.logo ?? null,
      message: null,
    };
  }

  private async fetchArtwork(title: string): Promise<FetchedArtwork> {
    let entries: SgdbSearchEntry[];
    try {
      const searchPayload = await this.requestJson(
        `/search/autocomplete/${encodeURIComponent(title)}`,
      );
      entries = parseSteamGridDbSearch(searchPayload);
    } catch (error) {
      if (error instanceof SteamGridDbNotFoundError) {
        return {
          body: noArtwork('not-found', 'SteamGridDB has no entry for this title.'),
          files: emptyImages(),
        };
      }
      throw error;
    }

    const match = pickSearchEntry(entries, title);
    if (match === null) {
      return {
        body: noArtwork('not-found', 'No close SteamGridDB match was found for this title.'),
        files: emptyImages(),
      };
    }

    const settled = await Promise.allSettled(
      ARTWORK_KINDS.map(async (kind) => {
        const payload = await this.requestJson(endpointFor(kind, match.id));
        return { kind, images: parseSteamGridDbImages(payload) };
      }),
    );

    const candidates = new Map<ArtworkKind, SgdbImage>();
    let endpointError: string | null = null;
    for (const outcome of settled) {
      if (outcome.status === 'rejected') {
        endpointError ??= shortError(outcome.reason);
        continue;
      }
      const picked = pickArtworkImage(outcome.value.images, outcome.value.kind);
      if (picked !== null) candidates.set(outcome.value.kind, picked);
    }

    if (candidates.size === 0) {
      if (endpointError !== null) {
        throw new TuneSmithError('unavailable', `SteamGridDB artwork lookup failed: ${endpointError}`);
      }
      return {
        body: noArtwork('not-found', 'SteamGridDB has no suitable static artwork for this title.'),
        files: emptyImages(),
      };
    }

    const downloads = await Promise.all(
      ARTWORK_KINDS.map(async (kind) => {
        const image = candidates.get(kind);
        if (image === undefined) return null;
        const cached = await this.downloadImage(image);
        return cached === null ? null : { kind, cached };
      }),
    );

    const files: Partial<Record<ArtworkKind, CachedImage>> = {};
    const assets: Partial<Record<ArtworkKind, ArtworkAsset>> = {};
    for (const download of downloads) {
      if (download === null) continue;
      files[download.kind] = download.cached;
      assets[download.kind] = {
        url: artworkUrl(download.cached.file),
        width: download.cached.width,
        height: download.cached.height,
      };
    }

    if (Object.keys(files).length === 0) {
      throw new TuneSmithError('unavailable', 'SteamGridDB returned artwork, but no image could be downloaded.');
    }

    return {
      body: {
        status: 'ok',
        steamGridDbId: match.id,
        matchedTitle: match.name,
        grid: assets.grid ?? null,
        hero: assets.hero ?? null,
        logo: assets.logo ?? null,
        message: null,
      },
      files,
    };
  }

  private async requestJson(endpoint: string): Promise<unknown> {
    if (this.apiKey === null) throw new TuneSmithError('unavailable', ARTWORK_CONFIG_HINT);

    let response: Response;
    try {
      response = await this.fetchImpl(`${STEAMGRIDDB_API_BASE}${endpoint}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: 'application/json',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new TuneSmithError('unavailable', `SteamGridDB could not be reached: ${shortError(error)}`);
    }

    if (response.status === 401 || response.status === 403) {
      throw new TuneSmithError(
        'unavailable',
        'SteamGridDB rejected the API key. Check the key and restart TuneSmith.',
      );
    }
    if (response.status === 404) throw new SteamGridDbNotFoundError();
    if (response.status === 429) {
      throw new TuneSmithError('unavailable', 'SteamGridDB rate limit reached. Artwork will retry later.');
    }
    if (!response.ok) {
      throw new TuneSmithError('unavailable', `SteamGridDB request failed (HTTP ${String(response.status)}).`);
    }

    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw new TuneSmithError('unavailable', `SteamGridDB response could not be read: ${shortError(error)}`);
    }
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new TuneSmithError('parse-failed', 'SteamGridDB returned an oversized response.');
    }

    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new TuneSmithError('parse-failed', 'SteamGridDB returned malformed JSON.');
    }
  }

  private async downloadImage(image: SgdbImage): Promise<CachedImage | null> {
    if (!isAllowedArtworkUrl(image.url)) return null;

    const digest = createHash('sha256').update(image.url).digest('hex');
    const existing = await this.findExistingImage(digest);
    if (existing !== null) {
      return { file: existing, width: image.width, height: image.height };
    }

    let response: Response;
    try {
      response = await this.fetchImpl(image.url, {
        method: 'GET',
        headers: { Accept: 'image/png,image/jpeg,image/webp' },
        redirect: 'follow',
        signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
      });
    } catch (error) {
      this.log(`artwork download failed: ${shortError(error)}`);
      return null;
    }

    if (!response.ok) return null;
    if (response.url.length > 0 && !isAllowedArtworkUrl(response.url)) return null;

    const declaredLength = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) return null;

    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch {
      return null;
    }
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) return null;

    const extension: CachedImageExtension | null = detectImageType(bytes);
    if (extension === null) return null;

    const file = `${digest}.${extension}`;
    const target = path.join(this.imagesDir, file);
    // Two titles can share an artwork URL and download it concurrently; a unique temp
    // name keeps their renames from racing on the same file.
    const temp = path.join(this.imagesDir, `.${digest}.${randomUUID()}.tmp`);

    try {
      await mkdir(this.imagesDir, { recursive: true });
      await writeFile(temp, bytes, { mode: 0o600 });
      await rename(temp, target);
    } catch (error) {
      this.log(`artwork cache write failed: ${shortError(error)}`);
      try {
        await unlink(temp);
      } catch {
        // The temporary file may never have been created.
      }
      return null;
    }

    return { file, width: image.width, height: image.height };
  }

  private async findExistingImage(digest: string): Promise<string | null> {
    for (const extension of ['png', 'jpg', 'webp'] as const) {
      const file = `${digest}.${extension}`;
      if (await fileExists(path.join(this.imagesDir, file))) return file;
    }
    return null;
  }

  private async getIndex(): Promise<CacheIndex> {
    if (this.index !== null) return this.index;
    if (this.loadPromise !== null) return this.loadPromise;

    this.loadPromise = this.loadIndex();
    this.index = await this.loadPromise;
    return this.index;
  }

  private async loadIndex(): Promise<CacheIndex> {
    const empty: CacheIndex = { version: INDEX_VERSION, entries: {} };
    try {
      const bytes = await readFile(this.indexPath);
      if (bytes.byteLength > MAX_INDEX_BYTES) return empty;
      const parsed: unknown = JSON.parse(bytes.toString('utf8'));
      const valid = cacheIndexSchema.safeParse(parsed);
      return valid.success ? valid.data : empty;
    } catch {
      return empty;
    }
  }

  private async evict(index: CacheIndex): Promise<void> {
    const keys = Object.keys(index.entries);
    if (keys.length <= MAX_INDEX_ENTRIES) return;

    const ordered = keys.sort(
      (a, b) => (index.entries[a]?.fetchedAt ?? 0) - (index.entries[b]?.fetchedAt ?? 0),
    );
    const removed = ordered.slice(0, keys.length - MAX_INDEX_ENTRIES);
    const removedEntries = removed.map((key) => index.entries[key]).filter((entry) => entry !== undefined);
    for (const key of removed) delete index.entries[key];

    const referenced = new Set<string>();
    for (const entry of Object.values(index.entries)) {
      for (const image of [entry.images.grid, entry.images.hero, entry.images.logo]) {
        if (image !== undefined) referenced.add(image.file);
      }
    }

    for (const entry of removedEntries) {
      for (const image of [entry.images.grid, entry.images.hero, entry.images.logo]) {
        if (image === undefined || referenced.has(image.file)) continue;
        try {
          await unlink(path.join(this.imagesDir, image.file));
        } catch {
          // Best effort: an orphaned cache file is harmless and gets ignored.
        }
      }
    }
  }

  private persist(index: CacheIndex): Promise<void> {
    const snapshot = JSON.stringify(index);
    this.saveChain = this.saveChain
      .catch(() => undefined)
      .then(async () => {
        await mkdir(this.cacheDir, { recursive: true });
        const temp = `${this.indexPath}.tmp`;
        await writeFile(temp, snapshot, 'utf8');
        await rename(temp, this.indexPath);
      })
      .catch((error: unknown) => {
        this.log(`artwork cache index write failed: ${shortError(error)}`);
      });
    return this.saveChain;
  }
}
