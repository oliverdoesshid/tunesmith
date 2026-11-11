/**
 * Artwork DTOs shared by the main process and the renderer.
 *
 * Remote SteamGridDB URLs never cross the bridge. The main process downloads and
 * validates every image, keeps it in its own cache, and returns a `ts-art://` URL that
 * the registered protocol handler serves from disk. That keeps the renderer's
 * `img-src` closed (no remote origins, no renderer-side fetches) and means a dropped
 * connection can only affect a cache miss, never the UI thread.
 */

export type ArtworkStatus = 'ok' | 'not-found' | 'not-configured' | 'error';

/** One cached, locally servable image. `url` is a `ts-art://artwork/<sha>.<ext>` URL. */
export interface ArtworkAsset {
  url: string;
  width: number;
  height: number;
}

export interface GameArtwork {
  /** The library key the renderer asked for (e.g. `steam:1091500`). */
  key: string;
  title: string;
  status: ArtworkStatus;
  /** SteamGridDB game id, when a title matched. */
  steamGridDbId: number | null;
  /** The SteamGridDB name that matched, which can differ from the library title. */
  matchedTitle: string | null;
  grid: ArtworkAsset | null;
  hero: ArtworkAsset | null;
  logo: ArtworkAsset | null;
  /** Short, user-safe explanation for `not-found` and `error`. Never a URL or key. */
  message: string | null;
}

export interface GameArtworkBatch {
  /** False when no API key is configured; the UI shows one setup hint instead of per-card errors. */
  configured: boolean;
  message: string | null;
  items: GameArtwork[];
}

export interface ArtworkRequestItem {
  key: string;
  title: string;
}
