/**
 * Artwork cache primitives with no Electron import, so the URL/path/magic-byte rules
 * are unit-testable in a plain Node environment.
 *
 * The custom scheme is deliberately narrow: one host, one flat file name made of a
 * SHA-256 digest and a known image extension. No path from a SteamGridDB response is
 * ever used as a filename.
 */
import path from 'node:path';

export const ARTWORK_SCHEME = 'ts-art';
export const ARTWORK_HOST = 'artwork';
export const ARTWORK_IMAGES_DIR = 'images';

const CACHED_FILE_RE = /^[a-f0-9]{64}\.(png|jpg|webp)$/;
const ALLOWED_ARTWORK_HOSTS = ['steamgriddb.com'] as const;

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
};

export type CachedImageExtension = 'png' | 'jpg' | 'webp';

export function artworkUrl(fileName: string): string {
  if (!CACHED_FILE_RE.test(fileName)) throw new Error('Invalid cached artwork file name');
  return `${ARTWORK_SCHEME}://${ARTWORK_HOST}/${fileName}`;
}

/** Resolve a `ts-art://artwork/<name>` request to a file inside the cache, or null. */
export function resolveArtworkRequestPath(cacheDir: string, requestUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }

  if (url.protocol !== `${ARTWORK_SCHEME}:` || url.hostname !== ARTWORK_HOST) return null;
  if (url.username.length > 0 || url.password.length > 0 || url.port.length > 0) return null;

  let fileName: string;
  try {
    fileName = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  } catch {
    return null;
  }
  if (!CACHED_FILE_RE.test(fileName)) return null;

  const root = path.resolve(cacheDir, ARTWORK_IMAGES_DIR);
  const resolved = path.resolve(root, fileName);
  if (path.dirname(resolved) !== root) return null;
  return resolved;
}

export function contentTypeForCachedFile(fileName: string): string {
  const extension = fileName.slice(fileName.lastIndexOf('.') + 1);
  return CONTENT_TYPES[extension] ?? 'application/octet-stream';
}

/**
 * Only https image URLs on SteamGridDB's own domains may be fetched. The API response
 * is untrusted input; without this a compromised or mistaken response could point the
 * main process at an internal address.
 */
export function isAllowedArtworkUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username.length > 0 || url.password.length > 0) return false;
  if (url.port.length > 0 && url.port !== '443') return false;

  const host = url.hostname.toLowerCase();
  return ALLOWED_ARTWORK_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

/**
 * Sniff the actual image format instead of trusting `Content-Type`, so a cache file is
 * always something an `<img>` can safely render.
 */
export function detectImageType(bytes: Uint8Array): CachedImageExtension | null {
  if (bytes.length >= 8) {
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (png.every((byte, index) => bytes[index] === byte)) return 'png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'webp';
  }
  return null;
}
