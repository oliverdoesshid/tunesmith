/**
 * Artwork DTOs shared by the main process and the renderer.
 *
 * Two pipelines live here:
 *   - the legacy SteamGridDB batch, where remote URLs never cross the bridge and the
 *     main process returns only `ts-art://` URLs from its own cache;
 *   - the zero-key Steam resolver, which returns either a `file://` URL from Steam's
 *     local library cache or an official Valve CDN URL, with a placeholder signal when
 *     neither exists.
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

/* ------------------------------------------------------------------ *
 * Zero-key Steam artwork resolver
 * ------------------------------------------------------------------ */

/** Where one resolved image came from. */
export type ArtworkOrigin = 'local-cache' | 'steam-cdn' | 'placeholder';

export interface ResolvedArtworkAsset {
  /** `file://` for a local Steam cache hit, otherwise an official Valve CDN URL. */
  url: string;
  origin: Exclude<ArtworkOrigin, 'placeholder'>;
}

/**
 * Artwork resolved without an API key: local Steam cache, then Valve's public CDN.
 *
 * When no image is available every asset is null, `placeholder` is true and the
 * launcher renders its built-in clean plate. The main process never throws for a
 * missing title, so an offline machine still renders the whole library.
 */
export interface ResolvedGameArtwork {
  appId: number | null;
  cover: ResolvedArtworkAsset | null;
  hero: ResolvedArtworkAsset | null;
  header: ResolvedArtworkAsset | null;
  logo: ResolvedArtworkAsset | null;
  /** Highest-fidelity origin used for this title. */
  source: ArtworkOrigin;
  placeholder: boolean;
  /** Short, user-safe explanation when only a placeholder is available. */
  message: string | null;
}
