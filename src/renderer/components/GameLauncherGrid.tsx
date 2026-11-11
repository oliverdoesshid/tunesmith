/**
 * Local game library.
 *
 * Artwork is requested lazily for the rows on screen, in bounded batches, and every image
 * the main process returns is already cached locally (`ts-art://`). A missing API key or
 * an unreadable image therefore leaves the generated mono plate in place; it never blocks
 * the ledger and never touches the UI thread.
 *
 * The component is wrapped in its own error boundary so a malformed scan can only take
 * down this panel, never the workbench.
 */
import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import type { ArtworkRequestItem, GameArtwork, GameArtworkBatch } from '../../shared/game/artwork';
import type { DiscoveredGame } from '../../shared/game/types';
import { errorMessage, getBridge } from '../lib/bridge';

const PAGE_SIZE = 30;
const MAX_ARTWORK_BATCH = 24;

const SOURCE_LABEL: Record<DiscoveredGame['source'], string> = {
  steam: 'Steam',
  epic: 'Epic',
  xbox: 'Xbox',
  gog: 'GOG',
};

interface GameLauncherGridProps {
  games: readonly DiscoveredGame[];
  /** True while the first library scan is still running. */
  loading?: boolean;
  busy?: boolean;
  onBrowseFiles(game: DiscoveredGame): void;
  onLaunch(game: DiscoveredGame): void;
  /** Injectable for tests; defaults to the typed preload bridge. */
  loadArtwork?(items: ArtworkRequestItem[]): Promise<GameArtworkBatch>;
}

function defaultLoadArtwork(items: ArtworkRequestItem[]): Promise<GameArtworkBatch> {
  return getBridge().game.artwork(items);
}

function initials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean).slice(0, 2);
  const value = parts.map((part) => part[0]?.toUpperCase() ?? '').join('');
  return value.length > 0 ? value : '?';
}

function executableName(game: DiscoveredGame): string | null {
  if (game.executablePath === null) return null;
  const parts = game.executablePath.split(/[\\/]/);
  return parts[parts.length - 1] ?? game.executablePath;
}

/* ------------------------------------------------------------------ *
 * Error containment
 * ------------------------------------------------------------------ */

interface BoundaryProps {
  children: ReactNode;
}

interface BoundaryState {
  message: string | null;
}

class LauncherErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  constructor(props: BoundaryProps) {
    super(props);
    this.state = { message: null };
  }

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { message: error instanceof Error ? error.message : 'Unknown launcher error' };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[launcher] unhandled UI error', error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.message !== null) {
      return (
        <section className="panel launcher launcher-fault" role="alert">
          <div className="panel-head">
            <div>
              <span className="panel-kicker">FAULT / LIBRARY</span>
              <h2>Launcher unavailable</h2>
              <p className="muted small">The rest of TuneSmith is unaffected.</p>
            </div>
          </div>
          <p className="finding finding-block">The game launcher hit an unexpected error. Rescan the libraries or retry this panel.</p>
          <code className="launcher-fault-message">{this.state.message}</code>
          <button
            type="button"
            onClick={() => this.setState({ message: null })}
            className="button button-ghost"
          >
            Retry launcher
          </button>
        </section>
      );
    }
    return this.props.children;
  }
}

/* ------------------------------------------------------------------ *
 * Small building blocks
 * ------------------------------------------------------------------ */

function ArtworkImage({ src, className }: { src: string | null | undefined; className: string }): ReactNode {
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    setBroken(false);
  }, [src]);

  if (src === null || src === undefined || src.length === 0 || broken) return null;
  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      loading="lazy"
      draggable={false}
      onError={() => setBroken(true)}
      className={className}
    />
  );
}

function PlayIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="icon">
      <path d="M4 2.5v11l9-5.5-9-5.5Z" fill="currentColor" />
    </svg>
  );
}

function FolderIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="icon">
      <path
        d="M1.5 3.5A1.5 1.5 0 0 1 3 2h3l1.4 1.5H13A1.5 1.5 0 0 1 14.5 5v7A1.5 1.5 0 0 1 13 13.5H3A1.5 1.5 0 0 1 1.5 12V3.5Z"
        fill="currentColor"
      />
    </svg>
  );
}

function LauncherActions({
  game,
  busy,
  onBrowseFiles,
  onLaunch,
}: {
  game: DiscoveredGame;
  busy: boolean;
  onBrowseFiles(game: DiscoveredGame): void;
  onLaunch(game: DiscoveredGame): void;
}): ReactNode {
  const noExecutable = game.executablePath === null;

  return (
    <div className="library-actions">
      <button
        type="button"
        disabled={busy || noExecutable}
        onClick={() => onLaunch(game)}
        aria-label={`Launch ${game.name}`}
        title={noExecutable ? 'No executable was detected for this title' : `Launch ${game.name}`}
        className="button button-primary button-compact"
      >
        <PlayIcon />
        {busy ? 'WORKING' : 'PLAY'}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => onBrowseFiles(game)}
        aria-label={`Browse local files for ${game.name}`}
        className="button button-ghost button-compact"
      >
        <FolderIcon />
        FILES
      </button>
    </div>
  );
}

function LauncherRow({
  game,
  art,
  busy,
  onBrowseFiles,
  onLaunch,
}: {
  game: DiscoveredGame;
  art: GameArtwork | undefined;
  busy: boolean;
  onBrowseFiles(game: DiscoveredGame): void;
  onLaunch(game: DiscoveredGame): void;
}): ReactNode {
  const exe = executableName(game);
  const hasProfile = game.profileIds.length > 0;

  return (
    <article className="library-row">
      <div className="library-cover">
        <span className="library-cover-fallback" aria-hidden="true">
          {initials(game.name)}
        </span>
        <ArtworkImage src={art?.grid?.url} className="library-cover-art" />
      </div>

      <div className="library-title">
        <div className="library-kicker">
          <span>{SOURCE_LABEL[game.source] ?? game.source}</span>
          {hasProfile && <span className="tag tag-accent">PROFILE MATCH</span>}
        </div>
        <h3 title={game.name}>{game.name}</h3>
        <code className={exe === null ? 'library-exe is-warn' : 'library-exe'} title={game.executablePath ?? undefined}>
          {exe ?? 'NO EXECUTABLE DETECTED'}
        </code>
      </div>

      <div className="library-install">
        <span className="data-label">INSTALL ROOT</span>
        <span className="library-install-path" title={game.installDir}>
          {game.installDir}
        </span>
      </div>

      <div className="library-profile">
        <span className="data-label">PROFILE</span>
        <strong className={hasProfile ? 'is-accent' : ''}>{hasProfile ? 'MATCHED' : 'NOT SET'}</strong>
      </div>

      <LauncherActions game={game} busy={busy} onBrowseFiles={onBrowseFiles} onLaunch={onLaunch} />
    </article>
  );
}

/* ------------------------------------------------------------------ *
 * Library ledger
 * ------------------------------------------------------------------ */

function LauncherContent({
  games,
  loading = false,
  busy = false,
  onBrowseFiles,
  onLaunch,
  loadArtwork = defaultLoadArtwork,
}: GameLauncherGridProps): ReactNode {
  const [artwork, setArtwork] = useState<Record<string, GameArtwork>>({});
  const [artworkNotice, setArtworkNotice] = useState<string | null>(null);
  const [artworkConfigured, setArtworkConfigured] = useState<boolean | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [retryToken, setRetryToken] = useState(0);
  const requested = useRef(new Set<string>());

  const visibleGames = useMemo(() => games.slice(0, visibleCount), [games, visibleCount]);

  useEffect(() => {
    const missing = visibleGames
      .filter((game) => artwork[game.id] === undefined && !requested.current.has(game.id))
      .slice(0, MAX_ARTWORK_BATCH);
    if (missing.length === 0) return;

    for (const game of missing) requested.current.add(game.id);

    void loadArtwork(missing.map((game) => ({ key: game.id, title: game.name })))
      .then((batch) => {
        setArtworkConfigured(batch.configured);
        setArtwork((previous) => {
          const next = { ...previous };
          for (const item of batch.items) next[item.key] = item;
          return next;
        });

        if (!batch.configured) {
          setArtworkNotice(batch.message ?? 'SteamGridDB is not configured; generated mono plates are shown.');
          return;
        }
        const failed = batch.items.find((item) => item.status === 'error');
        setArtworkNotice(failed?.message ?? null);
      })
      .catch((error: unknown) => {
        // Allow a manual retry: drop the ids that never produced a result.
        for (const game of missing) requested.current.delete(game.id);
        setArtworkNotice(`Artwork lookup failed: ${errorMessage(error)}`);
      });
  }, [visibleGames, artwork, loadArtwork, retryToken]);

  const retryArtwork = useCallback(() => {
    setArtworkNotice(null);
    setArtwork((previous) => {
      const next = { ...previous };
      for (const [key, item] of Object.entries(next)) {
        if (item.status !== 'error') continue;
        delete next[key];
        requested.current.delete(key);
      }
      return next;
    });
    setRetryToken((token) => token + 1);
  }, []);

  return (
    <section className="panel launcher">
      <div className="panel-head launcher-head">
        <div>
          <span className="panel-kicker">LOCAL LIBRARIES</span>
          <h2>Game library</h2>
          <p className="muted small">
            Titles discovered from Steam, Epic, Xbox and GOG. Launching arms the profile watcher before the game starts.
          </p>
        </div>
        <div className="panel-tools">
          <span className="data-tag">
            {games.length} TITLE{games.length === 1 ? '' : 'S'}
          </span>
          <span
            className={`data-tag ${artworkConfigured === false ? 'is-warn' : 'is-accent'}`}
            title={
              artworkConfigured === false
                ? 'SteamGridDB key not configured; generated placeholders are shown.'
                : 'SteamGridDB artwork'
            }
          >
            {artworkConfigured === null ? 'ARTWORK' : artworkConfigured ? 'STEAMGRIDDB' : 'ARTWORK OFF'}
          </span>
        </div>
      </div>

      {artworkNotice !== null && (
        <div className="inline-notice inline-notice-warn">
          <span>{artworkNotice}</span>
          {artworkConfigured !== false && (
            <button type="button" onClick={retryArtwork} className="button button-ghost small">
              Retry artwork
            </button>
          )}
        </div>
      )}

      {loading && (
        <p role="status" className="muted small">
          Scanning installed game libraries…
        </p>
      )}

      {!loading && games.length === 0 && (
        <div className="empty-state">
          <span className="empty-state-mark" aria-hidden="true">
            Ø
          </span>
          <div>
            <h3>No installed titles detected</h3>
            <p className="muted small">
              Start Steam, Epic, the Xbox app or GOG once, then rescan the libraries in Game Mode. TuneSmith only reads
              launcher manifests; discovery never executes anything.
            </p>
          </div>
        </div>
      )}

      {!loading && games.length > 0 && (
        <>
          <div className="library-index-head" aria-hidden="true">
            <span>PLATE</span>
            <span>TITLE / EXECUTABLE</span>
            <span>INSTALL ROOT</span>
            <span>PROFILE</span>
            <span>OPERATIONS</span>
          </div>

          <div className="library-list">
            {visibleGames.map((game) => (
              <LauncherRow
                key={game.id}
                game={game}
                art={artwork[game.id]}
                busy={busy}
                onBrowseFiles={onBrowseFiles}
                onLaunch={onLaunch}
              />
            ))}
          </div>

          {visibleGames.length < games.length && (
            <div className="library-more">
              <button
                type="button"
                onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
                className="button button-ghost"
              >
                Load next {Math.min(PAGE_SIZE, games.length - visibleGames.length)} / {games.length - visibleGames.length} remaining
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

export function GameLauncherGrid(props: GameLauncherGridProps): ReactNode {
  return (
    <LauncherErrorBoundary>
      <LauncherContent {...props} />
    </LauncherErrorBoundary>
  );
}
