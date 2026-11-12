/**
 * Local game library.
 *
 * Steam covers use the zero-key resolver: the local Steam cache is tried first, then
 * Valve's public CDN, then the built-in plate below. Requests are made per Steam App ID
 * for the rows on screen, in small batches, and results are memoised for the session.
 * Every failure leaves the plate in place; it never blocks the ledger.
 *
 * The library is also the per-game settings surface. Selecting a row opens its settings
 * in place, and the add flow keeps the launcher usable when none of the supported
 * launchers exposed a title.
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
  type FormEvent,
  type ReactNode,
} from 'react';
import type { ResolvedGameArtwork } from '../../shared/game/artwork';
import type {
  DiscoveredGame,
  GameLibraryScanResult,
  GamePathPickKind,
  GameProfileSummary,
  ManualGameAddRequest,
  PickedGamePath,
} from '../../shared/game/types';
import { errorMessage, getBridge } from '../lib/bridge';

const PAGE_SIZE = 30;
const MAX_ARTWORK_BATCH = 8;

const SOURCE_LABEL: Record<DiscoveredGame['source'], string> = {
  steam: 'Steam',
  epic: 'Epic',
  xbox: 'Xbox',
  gog: 'GOG',
  manual: 'Manual',
};

interface GameLauncherGridProps {
  games: readonly DiscoveredGame[];
  /** True while the first library scan is still running. */
  loading?: boolean;
  busy?: boolean;
  profiles?: readonly GameProfileSummary[];
  scanErrors?: GameLibraryScanResult['errors'];
  onBrowseFiles(game: DiscoveredGame): void;
  onLaunch(game: DiscoveredGame): void;
  onAddGame(input: ManualGameAddRequest): Promise<DiscoveredGame>;
  onRemoveGame(game: DiscoveredGame): Promise<void>;
  onPickPath(kind: GamePathPickKind): Promise<PickedGamePath | null>;
  onRefreshLibraries(): void;
  /** Injectable for tests; defaults to the typed preload bridge. */
  resolveArtwork?(appId: string): Promise<ResolvedGameArtwork>;
}

function defaultResolveArtwork(appId: string): Promise<ResolvedGameArtwork> {
  return getBridge().getArtwork(appId);
}

/** Only Steam titles with a numeric App ID can use the Steam resolver. */
function steamAppId(game: DiscoveredGame): string | null {
  if (game.source !== 'steam' || game.appId === null) return null;
  return /^[1-9][0-9]{0,9}$/.test(game.appId) ? game.appId : null;
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
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading');

  useEffect(() => {
    setStatus('loading');
  }, [src]);

  if (src === null || src === undefined || src.length === 0 || status === 'error') return null;
  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      loading="lazy"
      draggable={false}
      onLoad={() => setStatus('loaded')}
      onError={() => setStatus('error')}
      className={`${className}${status === 'loaded' ? ' is-loaded' : ''}`}
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

function SettingsIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="icon">
      <path
        d="M2 4.25h7.1a2.2 2.2 0 0 0 4.2 0H14v1.5h-.7a2.2 2.2 0 0 0-4.2 0H2v-1.5Zm0 6h.7a2.2 2.2 0 0 0 4.2 0H14v1.5H6.9a2.2 2.2 0 0 0-4.2 0H2v-1.5Z"
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
  onOpenSettings,
}: {
  game: DiscoveredGame;
  busy: boolean;
  onBrowseFiles(game: DiscoveredGame): void;
  onLaunch(game: DiscoveredGame): void;
  onOpenSettings(game: DiscoveredGame): void;
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
      <button
        type="button"
        onClick={() => onOpenSettings(game)}
        aria-label={`Open settings for ${game.name}`}
        title={`Open settings for ${game.name}`}
        className="button button-ghost button-compact"
      >
        <SettingsIcon />
        SETTINGS
      </button>
    </div>
  );
}

function LauncherRow({
  game,
  art,
  artworkLoading,
  busy,
  onBrowseFiles,
  onLaunch,
  onOpenSettings,
}: {
  game: DiscoveredGame;
  art: ResolvedGameArtwork | undefined;
  artworkLoading: boolean;
  busy: boolean;
  onBrowseFiles(game: DiscoveredGame): void;
  onLaunch(game: DiscoveredGame): void;
  onOpenSettings(game: DiscoveredGame): void;
}): ReactNode {
  const exe = executableName(game);
  const hasProfile = game.profileIds.length > 0;

  return (
    <article
      className="library-row is-selectable"
      onClick={(event) => {
        const target = event.target;
        if (target instanceof Element && target.closest('button,a') !== null) return;
        onOpenSettings(game);
      }}
    >
      <div className={`library-cover${artworkLoading ? ' is-loading' : ''}`}>
        <span className="library-cover-fallback" aria-hidden="true">
          {initials(game.name)}
        </span>
        <ArtworkImage src={art?.cover?.url} className="library-cover-art" />
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

      <LauncherActions
        game={game}
        busy={busy}
        onBrowseFiles={onBrowseFiles}
        onLaunch={onLaunch}
        onOpenSettings={onOpenSettings}
      />
    </article>
  );
}

/* ------------------------------------------------------------------ *
 * Game settings view
 * ------------------------------------------------------------------ */

function GameSettings({
  game,
  profiles,
  busy,
  onBack,
  onBrowseFiles,
  onLaunch,
  onRemove,
}: {
  game: DiscoveredGame;
  profiles: readonly GameProfileSummary[];
  busy: boolean;
  onBack(): void;
  onBrowseFiles(game: DiscoveredGame): void;
  onLaunch(game: DiscoveredGame): void;
  onRemove(game: DiscoveredGame): Promise<void>;
}): ReactNode {
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matched = game.profileIds
    .map((id) => profiles.find((profile) => profile.id === id))
    .filter((profile): profile is GameProfileSummary => profile !== undefined);

  const remove = async (): Promise<void> => {
    setRemoving(true);
    setError(null);
    try {
      await onRemove(game);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div className="launcher-settings">
      <div className="launcher-settings-head">
        <div>
          <span className="panel-kicker">GAME SETTINGS</span>
          <h3>{game.name}</h3>
          <p className="muted small">
            {game.source === 'manual'
              ? 'Added manually. TuneSmith validates the install folder and executable before saving.'
              : 'Discovered from a local launcher. Paths are read-only here.'}
          </p>
        </div>
        <span className={`chip${game.source === 'manual' ? ' chip-tag' : ''}`}>
          {SOURCE_LABEL[game.source] ?? game.source}
        </span>
      </div>

      <div className="settings-grid">
        <div className="settings-cell">
          <span className="data-label">INSTALL ROOT</span>
          <code title={game.installDir}>{game.installDir}</code>
        </div>
        <div className="settings-cell">
          <span className="data-label">EXECUTABLE</span>
          <code title={game.executablePath ?? undefined}>{game.executablePath ?? 'Not detected'}</code>
        </div>
        <div className="settings-cell">
          <span className="data-label">PROFILE MATCH</span>
          <strong>{matched.length > 0 ? `${matched.length} matched` : 'No installed profile'}</strong>
        </div>
        <div className="settings-cell">
          <span className="data-label">LIBRARY ENTRY</span>
          <strong>{game.source === 'manual' ? 'Manual' : 'Auto-detected'}</strong>
        </div>
      </div>

      <div className="settings-profiles">
        <span className="data-label">MATCHED PROFILES</span>
        {matched.length > 0 ? (
          <ul className="settings-list">
            {matched.map((profile) => (
              <li key={profile.id}>
                <strong>{profile.name}</strong>
                <span className="muted small"> · {profile.actions.join(' · ')}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">No installed game profile matches this title. The watcher will ignore it.</p>
        )}
      </div>

      {error !== null && <p className="form-error" role="alert">{error}</p>}

      <div className="settings-actions">
        <button
          type="button"
          className="button button-primary compact-action"
          disabled={busy || game.executablePath === null}
          onClick={() => onLaunch(game)}
        >
          <PlayIcon />
          Launch game
        </button>
        <button type="button" className="button button-ghost compact-action" disabled={busy} onClick={() => onBrowseFiles(game)}>
          <FolderIcon />
          Open folder
        </button>
        {game.source === 'manual' && (
          <button
            type="button"
            className="button button-ghost compact-action"
            disabled={busy || removing}
            onClick={() => void remove()}
          >
            {removing ? 'Removing…' : 'Remove from launcher'}
          </button>
        )}
        <button type="button" className="button button-ghost compact-action" onClick={onBack}>
          Back to library
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Manual add form
 * ------------------------------------------------------------------ */

function ManualGameForm({
  busy,
  onCancel,
  onAdd,
  onPickPath,
}: {
  busy: boolean;
  onCancel(): void;
  onAdd(input: ManualGameAddRequest): Promise<DiscoveredGame>;
  onPickPath(kind: GamePathPickKind): Promise<PickedGamePath | null>;
}): ReactNode {
  const [name, setName] = useState('');
  const [installDir, setInstallDir] = useState<PickedGamePath | null>(null);
  const [executablePath, setExecutablePath] = useState<PickedGamePath | null>(null);
  const [picking, setPicking] = useState<GamePathPickKind | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = async (kind: GamePathPickKind): Promise<void> => {
    setPicking(kind);
    setError(null);
    try {
      const chosen = await onPickPath(kind);
      if (chosen !== null) {
        if (kind === 'folder') setInstallDir(chosen);
        else setExecutablePath(chosen);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPicking(null);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (installDir === null || executablePath === null) return;
    setSubmitting(true);
    setError(null);
    try {
      await onAdd({
        name: name.trim(),
        installDirToken: installDir.token,
        executableToken: executablePath.token,
      });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const disabled = busy || submitting || name.trim().length === 0 || installDir === null || executablePath === null;

  return (
    <form className="manual-game-form" onSubmit={(event) => void submit(event)}>
      <p className="muted small">
        Use this when a title is installed outside a supported launcher. TuneSmith stores only the paths
        and never executes anything until you press Play.
      </p>

      <label className="manual-field">
        <span className="data-label">GAME NAME</span>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="My game"
          maxLength={160}
          required
          autoFocus
        />
      </label>

      <label className="manual-field">
        <span className="data-label">INSTALL FOLDER</span>
        <div className="manual-path-row">
          <input
            value={installDir?.path ?? ''}
            placeholder="Choose with Browse…"
            readOnly
          />
          <button
            type="button"
            className="button button-ghost small"
            disabled={picking !== null || submitting}
            onClick={() => void pick('folder')}
          >
            {picking === 'folder' ? 'Choosing…' : 'Browse…'}
          </button>
        </div>
      </label>

      <label className="manual-field">
        <span className="data-label">EXECUTABLE</span>
        <div className="manual-path-row">
          <input
            value={executablePath?.path ?? ''}
            placeholder="Choose with Browse…"
            readOnly
          />
          <button
            type="button"
            className="button button-ghost small"
            disabled={picking !== null || submitting}
            onClick={() => void pick('executable')}
          >
            {picking === 'executable' ? 'Choosing…' : 'Browse…'}
          </button>
        </div>
      </label>

      <p className="muted small">
        Use Browse so TuneSmith can prove both paths came from your selection. The executable must be a
        local <code>.exe</code> inside the install folder.
      </p>

      {error !== null && <p className="form-error" role="alert">{error}</p>}

      <div className="settings-actions">
        <button type="submit" className="button button-primary compact-action" disabled={disabled}>
          {submitting ? 'Adding…' : 'Add to library'}
        </button>
        <button type="button" className="button button-ghost compact-action" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ *
 * Library ledger
 * ------------------------------------------------------------------ */

type LauncherView = { kind: 'library' } | { kind: 'add' } | { kind: 'game'; id: string };

function LauncherContent({
  games,
  loading = false,
  busy = false,
  profiles = [],
  scanErrors = [],
  onBrowseFiles,
  onLaunch,
  onAddGame,
  onRemoveGame,
  onPickPath,
  onRefreshLibraries,
  resolveArtwork = defaultResolveArtwork,
}: GameLauncherGridProps): ReactNode {
  const [artwork, setArtwork] = useState<Record<string, ResolvedGameArtwork>>({});
  const [artworkNotice, setArtworkNotice] = useState<string | null>(null);
  const [pendingArtwork, setPendingArtwork] = useState<ReadonlySet<string>>(() => new Set());
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [retryToken, setRetryToken] = useState(0);
  const [view, setView] = useState<LauncherView>({ kind: 'library' });
  const requested = useRef(new Set<string>());

  const visibleGames = useMemo(() => games.slice(0, visibleCount), [games, visibleCount]);
  const localCount = useMemo(
    () => Object.values(artwork).filter((item) => item.source === 'local-cache').length,
    [artwork],
  );
  const selectedGame = view.kind === 'game' ? (games.find((game) => game.id === view.id) ?? null) : null;

  useEffect(() => {
    if (view.kind === 'game' && selectedGame === null) setView({ kind: 'library' });
  }, [selectedGame, view.kind]);

  useEffect(() => {
    const missing = visibleGames
      .filter((game) => {
        const appId = steamAppId(game);
        return appId !== null && artwork[game.id] === undefined && !requested.current.has(game.id);
      })
      .slice(0, MAX_ARTWORK_BATCH);
    if (missing.length === 0) return;

    for (const game of missing) requested.current.add(game.id);
    setPendingArtwork((previous) => {
      const next = new Set(previous);
      for (const game of missing) next.add(game.id);
      return next;
    });

    for (const game of missing) {
      const appId = steamAppId(game);
      if (appId === null) continue;

      void resolveArtwork(appId)
        .then((resolved) => {
          setArtwork((previous) => ({ ...previous, [game.id]: resolved }));
          if (resolved.placeholder && resolved.message !== null) setArtworkNotice(resolved.message);
        })
        .catch((error: unknown) => {
          // Allow a manual retry: this title never produced a result.
          requested.current.delete(game.id);
          setArtworkNotice(`Artwork lookup failed: ${errorMessage(error)}`);
        })
        .finally(() => {
          setPendingArtwork((previous) => {
            if (!previous.has(game.id)) return previous;
            const next = new Set(previous);
            next.delete(game.id);
            return next;
          });
        });
    }
  }, [visibleGames, artwork, resolveArtwork, retryToken]);

  const retryArtwork = useCallback(() => {
    setArtworkNotice(null);
    setRetryToken((token) => token + 1);
  }, []);

  const addGame = async (input: ManualGameAddRequest): Promise<DiscoveredGame> => {
    const added = await onAddGame(input);
    setView({ kind: 'library' });
    return added;
  };

  const removeGame = async (game: DiscoveredGame): Promise<void> => {
    await onRemoveGame(game);
    setView({ kind: 'library' });
  };

  const title =
    view.kind === 'add' ? 'Add a game' : selectedGame === null ? 'Game library' : selectedGame.name;
  const kicker =
    view.kind === 'add'
      ? 'LAUNCHER / MANUAL ENTRY'
      : selectedGame === null
        ? 'LOCAL LIBRARIES'
        : 'LAUNCHER / GAME SETTINGS';
  const description =
    view.kind === 'add'
      ? 'Register a local title that no supported launcher exposed.'
      : selectedGame === null
        ? 'Titles discovered from Steam, Epic, Xbox and GOG, plus games you add manually. Launching arms the profile watcher before the game starts.'
        : 'Review this title’s paths and matched profiles, then launch it with the watcher armed.';

  return (
    <section className="panel launcher">
      <div className="panel-head launcher-head">
        <div>
          <span className="panel-kicker">{kicker}</span>
          <h2>{title}</h2>
          <p className="muted small">{description}</p>
        </div>
        <div className="panel-tools launcher-tools">
          <span className="data-tag">
            {games.length} TITLE{games.length === 1 ? '' : 'S'}
          </span>
          {view.kind === 'library' && (
            <span
              className="data-tag is-accent"
              title="Covers come from the local Steam cache first, then Valve's public CDN. No API key is used."
            >
              {localCount > 0 ? `LOCAL ${String(localCount)}` : 'STEAM CDN'}
            </span>
          )}
          {view.kind === 'library' ? (
            <>
              <button
                type="button"
                className="button button-primary small"
                disabled={busy}
                onClick={() => setView({ kind: 'add' })}
              >
                Add game
              </button>
              <button
                type="button"
                className="button button-ghost small"
                disabled={busy || loading}
                onClick={onRefreshLibraries}
              >
                Rescan
              </button>
            </>
          ) : (
            <button type="button" className="button button-ghost small" onClick={() => setView({ kind: 'library' })}>
              Back to library
            </button>
          )}
        </div>
      </div>

      {artworkNotice !== null && (
        <div className="inline-notice inline-notice-warn">
          <span>{artworkNotice}</span>
          <button type="button" onClick={retryArtwork} className="button button-ghost small">
            Retry artwork
          </button>
        </div>
      )}

      {view.kind === 'add' ? (
        <ManualGameForm busy={busy} onCancel={() => setView({ kind: 'library' })} onAdd={addGame} onPickPath={onPickPath} />
      ) : selectedGame !== null ? (
        <GameSettings
          game={selectedGame}
          profiles={profiles}
          busy={busy}
          onBack={() => setView({ kind: 'library' })}
          onBrowseFiles={onBrowseFiles}
          onLaunch={onLaunch}
          onRemove={removeGame}
        />
      ) : (
        <>
          {scanErrors.length > 0 && (
            <div className="inline-notice inline-notice-warn">
              <span>
                {scanErrors.length} library source{scanErrors.length === 1 ? '' : 's'} could not be read.
                {scanErrors[0] !== undefined ? ` ${scanErrors[0].message}` : ''}
              </span>
              <button type="button" className="button button-ghost small" disabled={busy || loading} onClick={onRefreshLibraries}>
                Retry scan
              </button>
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
                  Add a game manually if a launcher did not expose it. TuneSmith only reads launcher
                  manifests automatically; discovery never executes anything.
                </p>
                <button type="button" className="button button-primary small" onClick={() => setView({ kind: 'add' })}>
                  Add a game
                </button>
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
                    artworkLoading={pendingArtwork.has(game.id)}
                    busy={busy}
                    onBrowseFiles={onBrowseFiles}
                    onLaunch={onLaunch}
                    onOpenSettings={(selected) => setView({ kind: 'game', id: selected.id })}
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
