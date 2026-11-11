/**
 * Community preset marketplace browser.
 *
 * Catalog metadata comes from the main process, which fetches the configurable static
 * endpoint (`TUNESMITH_MARKET_URL`, `market/config.json`, or the GitHub Pages default)
 * and removes every entry whose digest or Ed25519 signature does not verify. The
 * renderer therefore never decides that a preset is trustworthy: the "Download &
 * Install" button calls the preload bridge, whose main-process handler re-downloads the
 * payload, recomputes SHA-256 and verifies the signature before writing it into the
 * local community preset directory and rebuilding the index.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DEFAULT_MARKET_CATALOG_URL } from '../../shared/market/defaults';
import type { HardwareSpec } from '../../shared/types';
import type {
  InstallResult,
  MarketCompatibility,
  MarketEntryView,
  MarketStatus,
} from '../../shared/market/types';
import { errorMessage, getBridge } from '../lib/bridge';
import { Chip, RiskBadge } from './Chrome';

export type CatalogLoader = (refresh?: boolean) => Promise<MarketStatus>;
export type PresetInstaller = (presetId: string) => Promise<InstallResult>;
export type ConsentWriter = (consent: boolean) => Promise<MarketStatus>;

export interface PresetBrowserProps {
  /** Detected machine; only displayed here. Compatibility is computed in main. */
  hardware: HardwareSpec | null;
  /**
   * Catalog source. Defaults to the preload bridge (main process). Must be stable across
   * renders, like any loader passed to an effect.
   */
  loadCatalog?: CatalogLoader;
  /** Installs through the preload bridge by default; the main process verifies. */
  installPreset?: PresetInstaller;
  /** Telemetry opt-in through the preload bridge by default. */
  setTelemetryConsent?: ConsentWriter;
  /** Called after a verified install so the app can refresh its local preset list. */
  onInstalled?: (result: InstallResult) => void;
  /** Shown when the build is unconfigured; defaults to the hosted catalog URL. */
  catalogUrl?: string;
}

const defaultLoadCatalog: CatalogLoader = (refresh = false) => getBridge().market.status(refresh);
const defaultInstallPreset: PresetInstaller = (presetId) => getBridge().market.install(presetId);
const defaultSetConsent: ConsentWriter = (consent) => getBridge().market.setConsent(consent);

type Notice = { kind: 'ok' | 'error'; text: string; integrity: boolean };

function compatibilityBadge(compatibility: MarketCompatibility): {
  label: string;
  tone: string;
  title: string;
} {
  const title = compatibility.reasons.join(' · ');
  if (compatibility.blocked) {
    return { label: 'Blocked by policy', tone: 'pill-danger', title };
  }
  if (!compatibility.applicable) {
    return { label: 'Not for this PC', tone: 'pill-danger', title };
  }
  const percent = Math.round(compatibility.score * 100);
  return percent >= 75
    ? { label: `Great match · ${percent}%`, tone: 'pill-ok', title }
    : { label: `Compatible · ${percent}%`, tone: 'pill-warn', title };
}

function looksIntegrityRelated(message: string): boolean {
  return /digest|sha-?256|signature|integrity|verif/i.test(message);
}

function CatalogCard({
  entry,
  hardwareSignature,
  installedVersion,
  installing,
  busy,
  onInstall,
}: {
  entry: MarketEntryView;
  hardwareSignature: string | null;
  installedVersion: string | null;
  installing: boolean;
  busy: boolean;
  onInstall: (entry: MarketEntryView) => void;
}): ReactNode {
  const badge = compatibilityBadge(entry.compatibility);
  const upToDate = installedVersion !== null && installedVersion === entry.version;
  const update = installedVersion !== null && !upToDate;
  const label = installing
    ? 'Verifying…'
    : upToDate
      ? 'Installed'
      : update
        ? 'Update'
        : 'Download & Install';

  return (
    <article className="card preset-card" data-preset-id={entry.id}>
      <div className="card-top">
        <div>
          <h3>{entry.name}</h3>
          <p className="muted small">
            v{entry.version} · {entry.authors.join(', ') || 'unknown author'} · {entry.license}
          </p>
        </div>
        <RiskBadge risk={entry.risk} />
      </div>

      <p className="preset-description">{entry.description}</p>

      <div className="chip-row">
        <span className={`pill ${badge.tone}`} title={badge.title || undefined}>
          {badge.label}
        </span>
        <Chip tone="accent">SHA-256 + Ed25519</Chip>
        {entry.tags.slice(0, 4).map((tag) => (
          <Chip key={tag}>{tag}</Chip>
        ))}
      </div>

      {!entry.compatibility.applicable && entry.compatibility.reasons.length > 0 && (
        <ul className="finding finding-muted">
          {entry.compatibility.reasons.slice(0, 2).map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}

      <p className="muted small" title={entry.safety.reasons.join(' · ')}>
        Safety {entry.safety.score}/100 · {entry.safety.label}
        {entry.ratings.up + entry.ratings.down > 0 &&
          ` · 👍 ${entry.ratings.up} / 👎 ${entry.ratings.down}`}
      </p>
      <p className="muted small market-meta">
        <code>{entry.sha256.slice(0, 16)}…</code>
        {hardwareSignature !== null && ` · matched to ${hardwareSignature}`}
      </p>

      <div className="card-actions">
        {installedVersion !== null && (
          <span className="muted small" title="Installed version">
            v{installedVersion} installed
          </span>
        )}
        <button
          type="button"
          className="button button-primary"
          disabled={busy || installing || upToDate}
          onClick={() => onInstall(entry)}
        >
          {label}
        </button>
      </div>
    </article>
  );
}

export function PresetBrowser({
  hardware,
  loadCatalog = defaultLoadCatalog,
  installPreset = defaultInstallPreset,
  setTelemetryConsent = defaultSetConsent,
  onInstalled,
  catalogUrl = DEFAULT_MARKET_CATALOG_URL,
}: PresetBrowserProps): ReactNode {
  const [status, setStatus] = useState<MarketStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [installedNow, setInstalledNow] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<Notice | null>(null);
  const [consentBusy, setConsentBusy] = useState(false);

  // Keep the latest loader in a ref so an inline prop cannot re-trigger the mount fetch.
  const loaderRef = useRef(loadCatalog);
  useEffect(() => {
    loaderRef.current = loadCatalog;
  }, [loadCatalog]);

  const load = useCallback(async (refresh: boolean) => {
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const next = await loaderRef.current(refresh);
      setStatus(next);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const categories = useMemo(() => {
    const all = new Set<string>();
    for (const entry of status?.entries ?? []) {
      for (const tag of entry.tags) all.add(tag);
    }
    return [...all].sort((a, b) => a.localeCompare(b)).slice(0, 8);
  }, [status]);

  useEffect(() => {
    if (category !== 'all' && !categories.includes(category)) setCategory('all');
  }, [categories, category]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (status?.entries ?? []).filter((entry) => {
      if (category !== 'all' && !entry.tags.includes(category)) return false;
      if (q.length === 0) return true;
      return `${entry.name} ${entry.description} ${entry.authors.join(' ')} ${entry.tags.join(' ')}`
        .toLowerCase()
        .includes(q);
    });
  }, [status, query, category]);

  const handleInstall = useCallback(
    async (entry: MarketEntryView) => {
      setInstallingId(entry.id);
      setNotice(null);
      try {
        const result = await installPreset(entry.id);
        setInstalledNow((current) => ({ ...current, [result.presetId]: result.version }));
        setNotice({
          kind: 'ok',
          integrity: false,
          text: `Installed ${result.presetId} v${result.version}; SHA-256 ${result.sha256.slice(0, 12)}… verified before writing.`,
        });
        try {
          onInstalled?.(result);
        } catch {
          // A refresh callback cannot undo a completed install.
        }
      } catch (err) {
        const message = errorMessage(err);
        const integrity = looksIntegrityRelated(message);
        setNotice({
          kind: 'error',
          integrity,
          text: integrity ? `Integrity check failed: ${message}` : message,
        });
      } finally {
        setInstallingId(null);
      }
    },
    [installPreset, onInstalled],
  );

  const handleConsent = useCallback(
    async (consent: boolean) => {
      setConsentBusy(true);
      setNotice(null);
      try {
        setStatus(await setTelemetryConsent(consent));
      } catch (err) {
        const message = errorMessage(err);
        setNotice({ kind: 'error', integrity: false, text: message });
      } finally {
        setConsentBusy(false);
      }
    },
    [setTelemetryConsent],
  );

  const catalogError = error ?? status?.error ?? null;

  return (
    <section className="panel presets" aria-busy={loading}>
      <div className="panel-head">
        <div>
          <h2>Community marketplace</h2>
          <p className="muted small">
            {status?.source ?? catalogUrl}
            {hardware !== null && ` · matched to ${hardware.signature}`}
          </p>
        </div>
        <div className="preset-tools">
          <input
            type="search"
            placeholder="Search community presets…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search community presets"
            disabled={status === null}
          />
          <button
            type="button"
            className="button button-ghost small"
            onClick={() => void load(true)}
            disabled={loading}
          >
            {loading ? 'Refreshing…' : 'Refresh catalog'}
          </button>
        </div>
      </div>

      <p className="muted small">
        Every entry is schema-checked, SHA-256 matched and Ed25519-verified against a pinned key before it
        appears. Installing re-downloads the payload, verifies it again in the main process, then writes it
        into the local community preset directory and re-indexes immediately.
      </p>

      {catalogError !== null && (
        <div className="finding finding-block market-notice" role="alert">
          <strong>Could not load the community catalog</strong>
          <p>{catalogError}</p>
          <button type="button" className="button button-ghost small" onClick={() => void load(true)}>
            Retry
          </button>
        </div>
      )}

      {status !== null && !status.configured && (
        <p className="finding finding-muted market-notice">
          No catalog endpoint is configured. Set <code>TUNESMITH_MARKET_URL</code> or ship{' '}
          <code>market/config.json</code>. The default is <code>{catalogUrl}</code>.
        </p>
      )}

      {notice !== null && (
        <p
          className={`finding market-notice ${notice.kind === 'ok' ? 'finding-warn' : 'finding-block'}`}
          role={notice.kind === 'error' ? 'alert' : 'status'}
          data-integrity={notice.integrity ? 'failed' : undefined}
        >
          {notice.text}
        </p>
      )}

      {status !== null && status.rejected.length > 0 && (
        <div className="finding finding-warn market-notice market-warnings" role="alert">
          <strong>
            {status.rejected.length} catalog entr{status.rejected.length === 1 ? 'y' : 'ies'} failed
            integrity verification and cannot be installed
          </strong>
          <ul>
            {status.rejected.map((rejected, index) => (
              <li key={`${rejected.id ?? 'unknown'}-${index}`}>
                <code>{rejected.id ?? 'unknown'}</code>
                {looksIntegrityRelated(rejected.reason) && ' — SHA-256/Ed25519 mismatch'}
                {`: ${rejected.reason}`}
              </li>
            ))}
          </ul>
        </div>
      )}

      {loading && status === null && (
        <p className="muted empty" role="status">
          Loading the community catalog…
        </p>
      )}

      {status !== null && categories.length > 0 && (
        <div className="chip-row filters" aria-label="Preset categories">
          {['all', ...categories].map((value) => (
            <button
              key={value}
              type="button"
              className={`filter ${category === value ? 'is-active' : ''}`}
              aria-pressed={category === value}
              onClick={() => setCategory(value)}
            >
              {value === 'all' ? 'All' : value}
            </button>
          ))}
        </div>
      )}

      {status !== null &&
        (status.entries.length === 0 ? (
          <p className="muted empty">
            {catalogError === null ? 'The catalog contains no verified entries.' : 'No catalog entries available.'}
          </p>
        ) : visible.length === 0 ? (
          <p className="muted empty">No community presets match this view.</p>
        ) : (
          <div className="preset-grid">
            {visible.map((entry) => (
              <CatalogCard
                key={entry.id}
                entry={entry}
                hardwareSignature={hardware?.signature ?? null}
                installedVersion={installedNow[entry.id] ?? entry.installedVersion}
                installing={installingId === entry.id}
                busy={installingId !== null}
                onInstall={(selected) => void handleInstall(selected)}
              />
            ))}
          </div>
        ))}

      {status?.telemetry !== undefined && (
        <label className="small market-telemetry">
          <input
            type="checkbox"
            checked={status.telemetry.consent}
            disabled={consentBusy || loading}
            onChange={(event) => void handleConsent(event.target.checked)}
          />{' '}
          Share anonymous crash statistics
          <span className="muted">
            {' '}
            · only preset id/version, app version and outcome are sent. {status.telemetry.pending} event(s) queued.
          </span>
        </label>
      )}
    </section>
  );
}
