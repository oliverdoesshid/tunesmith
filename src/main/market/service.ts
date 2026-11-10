/**
 * Marketplace orchestration: catalog cache, verified views, installs and telemetry.
 *
 * This class never trusts the renderer: `install` re-checks the id against the verified
 * catalog it fetched itself, and installs only the canonical bytes whose Ed25519
 * signature already verified. It is also the only writer of telemetry, gated on consent.
 */
import { describeError, TuneSmithError } from '../../shared/errors';
import { canonicalJson } from '../../shared/market/canonical';
import { scoreEntry } from '../../shared/market/score';
import type { TelemetryKind } from '../../shared/market/telemetry';
import type {
  InstallResult,
  MarketEntryView,
  MarketStatus,
  TelemetryStats,
} from '../../shared/market/types';
import { fetchVerifiedCatalog, type CatalogResult, type FetchLike } from './client';
import { installVerifiedPreset } from './install';
import { TelemetryStore } from './telemetry-store';

const CACHE_TTL_MS = 5 * 60 * 1000;

export interface MarketplaceSettings {
  catalogUrl: string | null;
  telemetryUrl: string | null;
  keyRing: Map<string, string>;
  installDir: string;
  stateDir: string;
  appVersion: string;
}

export interface MarketplaceDeps extends MarketplaceSettings {
  listInstalled(): Promise<Map<string, string>>;
  onInstalled(): void;
  fetchImpl?: FetchLike;
}

function displaySource(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

export class MarketplaceService {
  private readonly telemetry: TelemetryStore;
  private cache: { result: CatalogResult; at: number } | null = null;
  private uploading = false;

  constructor(private readonly deps: MarketplaceDeps) {
    this.telemetry = new TelemetryStore(deps.stateDir);
  }

  async status(force = false): Promise<MarketStatus> {
    const telemetry = await this.telemetryView();
    const installed = await this.deps.listInstalled();

    if (this.deps.catalogUrl === null) {
      return {
        configured: false,
        source: null,
        fetchedAt: null,
        error: null,
        rejected: [],
        entries: [],
        telemetry,
      };
    }

    try {
      const result = await this.loadCatalog(force);
      const stats = await this.telemetry.stats();

      const entries: MarketEntryView[] = result.entries.map(({ entry }) => {
        const id = entry.preset.id;
        const installedVersion = installed.get(id) ?? null;
        return {
          id,
          version: entry.preset.version,
          name: entry.preset.name,
          description: entry.preset.description,
          risk: entry.preset.risk,
          tags: entry.preset.tags,
          authors: entry.preset.authors.map((author) => author.handle),
          license: entry.preset.license,
          sha256: entry.sha256,
          publishedAt: entry.publishedAt,
          ratings: entry.ratings,
          safety: scoreEntry(entry, stats.get(id) ?? null),
          stats:
            stats.get(id) ?? {
              applies: 0,
              failed: 0,
              interrupted: 0,
              recovered: 0,
              crashRate: 0,
              recoveryRate: 0,
            },
          installedVersion,
          updateAvailable: installedVersion !== null && installedVersion !== entry.preset.version,
        };
      });

      entries.sort(
        (a, b) => b.safety.score - a.safety.score || a.name.localeCompare(b.name),
      );

      return {
        configured: true,
        source: displaySource(this.deps.catalogUrl),
        fetchedAt: result.fetchedAt,
        error: null,
        rejected: result.rejected,
        entries,
        telemetry,
      };
    } catch (error) {
      return {
        configured: true,
        source: displaySource(this.deps.catalogUrl),
        fetchedAt: null,
        error: describeError(error),
        rejected: [],
        entries: [],
        telemetry,
      };
    }
  }

  async install(presetId: string): Promise<InstallResult> {
    const result = await this.loadCatalog(false);
    const found = result.entries.find((candidate) => candidate.entry.preset.id === presetId);
    if (found === undefined) {
      throw new TuneSmithError('unavailable', 'That preset is not in the verified catalog.');
    }

    // Re-verify the canonical form at the last moment; `installVerifiedPreset` checks it again.
    if (canonicalJson(found.entry.preset) !== found.canonical) {
      throw new TuneSmithError('integrity-failed', 'The preset changed after verification.');
    }

    const written = await installVerifiedPreset(
      found.entry,
      found.canonical,
      this.deps.installDir,
    );
    this.deps.onInstalled();

    return {
      presetId: found.entry.preset.id,
      version: found.entry.preset.version,
      file: written.file,
      sha256: written.sha256,
    };
  }

  async setConsent(consent: boolean): Promise<MarketStatus> {
    await this.telemetry.setConsent(consent);
    if (consent) void this.maybeUpload();
    return this.status(false);
  }

  /** Record an apply outcome locally and, with consent, try one upload. */
  async recordEvent(presetId: string, presetVersion: string, kind: TelemetryKind): Promise<void> {
    await this.telemetry.record({
      at: new Date().toISOString(),
      presetId,
      presetVersion,
      appVersion: this.deps.appVersion,
      kind,
    });
    await this.maybeUpload();
  }

  /** Startup hook: sessions the crash left unfinished, one event each. */
  async recordInterrupted(sessions: { presetId: string; presetVersion: string }[]): Promise<void> {
    for (const session of sessions) {
      await this.recordEvent(session.presetId, session.presetVersion, 'session-interrupted');
    }
  }

  /** Local stats for the current store, used by tests and the panel. */
  async localStats(): Promise<Map<string, TelemetryStats>> {
    return this.telemetry.stats();
  }

  private async loadCatalog(force: boolean): Promise<CatalogResult> {
    const now = Date.now();
    if (!force && this.cache !== null && now - this.cache.at < CACHE_TTL_MS) return this.cache.result;

    if (this.deps.catalogUrl === null) {
      throw new TuneSmithError('unavailable', 'No marketplace is configured for this build.');
    }

    const result = await fetchVerifiedCatalog({
      url: this.deps.catalogUrl,
      keyRing: this.deps.keyRing,
      ...(this.deps.fetchImpl !== undefined ? { fetchImpl: this.deps.fetchImpl } : {}),
    });
    this.cache = { result, at: now };
    return result;
  }

  private async telemetryView(): Promise<MarketStatus['telemetry']> {
    const snapshot = await this.telemetry.snapshot();
    return {
      consent: snapshot.consent,
      pending: snapshot.events.length,
      uploadConfigured: this.deps.telemetryUrl !== null,
      lastUploadAt: snapshot.lastUploadAt,
      lastUploadError: snapshot.lastUploadError,
    };
  }

  private async maybeUpload(): Promise<void> {
    if (this.deps.telemetryUrl === null || this.uploading) return;
    const snapshot = await this.telemetry.snapshot();
    if (!snapshot.consent || snapshot.events.length === 0) return;

    this.uploading = true;
    try {
      await this.telemetry.upload(this.deps.telemetryUrl, this.deps.fetchImpl);
    } catch (error) {
      console.warn(`[market] telemetry upload failed: ${describeError(error)}`);
    } finally {
      this.uploading = false;
    }
  }
}
