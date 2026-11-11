/**
 * Serves cached SteamGridDB artwork to the renderer through a private scheme.
 *
 * `ts-art://` is registered as standard and secure before app-ready, then handled by a
 * one-route handler after ready. Only files the artwork service itself wrote (a SHA-256
 * name plus a known extension) are reachable, and the handler never performs network
 * access.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { protocol } from 'electron';
import {
  ARTWORK_SCHEME,
  contentTypeForCachedFile,
  resolveArtworkRequestPath,
} from './artwork-files';

export function registerArtworkScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ARTWORK_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
      },
    },
  ]);
}

export async function handleArtworkRequest(cacheDir: string, request: Request): Promise<Response> {
  const file = resolveArtworkRequestPath(cacheDir, request.url);
  if (file === null) {
    return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }

  try {
    const bytes = await readFile(file);
    const fileName = path.basename(file);
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'Content-Type': contentTypeForCachedFile(fileName),
        'Content-Length': String(bytes.byteLength),
        // Cache files are content-addressed, so the bytes for a URL never change.
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }
}

export function installArtworkProtocol(cacheDir: string): void {
  void protocol.handle(ARTWORK_SCHEME, (request) => handleArtworkRequest(cacheDir, request));
}
