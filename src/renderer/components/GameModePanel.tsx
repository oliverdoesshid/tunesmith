import type { ReactNode } from 'react';
import type { OsdStatus } from '../../shared/game/osd';
import type { GameLibraryScanResult, GameProfileSummary, GameStatus } from '../../shared/game/types';

interface GameModePanelProps {
  status: GameStatus | null;
  profiles: GameProfileSummary[];
  libraries: GameLibraryScanResult | null;
  osd: OsdStatus | null;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onStop: () => void;
  onToggleOsd: (enabled: boolean) => void;
  onRefreshLibraries: () => void;
}

const LIBRARY_SOURCE_LABEL: Record<string, string> = {
  steam: 'Steam',
  epic: 'Epic',
  xbox: 'Xbox',
  gog: 'GOG',
};

const CPU_SOURCE_LABEL: Record<string, string> = {
  'libre-hardware-monitor': 'LibreHardwareMonitor',
  'open-hardware-monitor': 'OpenHardwareMonitor',
  'acpi-thermal-zone': 'ACPI zone',
  'thermal-zone-counter': 'thermal zone',
};

const GPU_SOURCE_LABEL: Record<string, string> = {
  'libre-hardware-monitor': 'LibreHardwareMonitor',
  'open-hardware-monitor': 'OpenHardwareMonitor',
  'nvidia-smi': 'nvidia-smi',
};

function telemetryLine(status: GameStatus): string | null {
  const sample = status.telemetry;
  if (sample === null) return null;
  const parts: string[] = [];
  if (sample.cpuTempC !== null) {
    parts.push(`CPU ${sample.cpuTempC.toFixed(1)}°C (${CPU_SOURCE_LABEL[sample.cpuTempSource] ?? 'zone'})`);
  }
  if (sample.gpuTempC !== null) {
    parts.push(`GPU ${sample.gpuTempC.toFixed(1)}°C (${GPU_SOURCE_LABEL[sample.gpuTempSource] ?? 'vendor'})`);
  }
  if (sample.powerDrawW !== null) {
    parts.push(sample.powerSource === 'battery' ? `${sample.powerDrawW.toFixed(1)} W draw` : `${sample.powerDrawW.toFixed(1)} W package`);
  }
  if (sample.onAc !== null) parts.push(sample.onAc ? 'AC power' : 'on battery');
  if (sample.onAc === false && sample.batteryPercent !== null) parts.push(`${sample.batteryPercent}%`);
  return parts.length === 0 ? null : parts.join(' · ');
}

export function GameModePanel({
  status,
  profiles,
  libraries,
  osd,
  busy,
  onToggle,
  onStop,
  onToggleOsd,
  onRefreshLibraries,
}: GameModePanelProps): ReactNode {
  const watching = status?.watching ?? false;
  const active = status?.active ?? null;
  const guard = status?.guard ?? null;
  const topology = status?.topology ?? null;
  const pendingRestore = status?.pendingRestore ?? null;
  const osdMessage = osd?.message ?? null;
  const telemetry = status === null ? null : telemetryLine(status);
  const blocked = profiles.filter((profile) => profile.blocked).length;
  const profileNames = new Map(profiles.map((profile) => [profile.id, profile.name]));
  const detectedProfiles = profiles.filter((profile) => profile.installed).length;

  return (
    <section className="panel game-mode">
      <div className="panel-head game-mode-head">
        <div>
          <h2>GAME MODE</h2>
          <p className="muted small">Focus-driven profiles. Every change is journaled before it is applied.</p>
        </div>
        <div className="mode-actions">
          <button
            type="button"
            className={`button small ${watching ? 'button-ghost' : 'button-primary'}`}
            disabled={busy}
            onClick={() => onToggle(!watching)}
          >
            {watching ? 'Stop watching' : 'Start watching'}
          </button>
          {active !== null && (
            <button type="button" className="button button-ghost small" disabled={busy} onClick={onStop}>
              Restore now
            </button>
          )}
          <button
            type="button"
            className="button button-ghost small"
            disabled={busy || osd === null}
            onClick={() => onToggleOsd(!(osd?.enabled ?? false))}
          >
            {osd?.enabled === true ? 'OSD off' : 'OSD on'}
          </button>
        </div>
      </div>

      <div className="mode-meta">
        <span>
          <small>Watcher</small>
          <strong className={watching ? 'mode-value-ok' : undefined}>{status === null ? 'Loading' : watching ? 'Armed' : 'Off'}</strong>
        </span>
        <span>
          <small>Profiles</small>
          <strong>{status === null ? '—' : `${status.profiles} loaded`}</strong>
        </span>
        <span>
          <small>CPU</small>
          <strong>{topology === null ? '—' : `${topology.physicalCores}C / ${topology.logicalProcessors}T`}</strong>
        </span>
        <span>
          <small>OSD</small>
          <strong className={osd?.visible === true ? 'mode-value-ok' : undefined}>
            {osd === null ? '—' : osd.visible ? 'Visible' : osd.enabled ? 'Armed' : 'Off'}
          </strong>
        </span>
      </div>

      {osdMessage !== null && <p className="mode-note">{osdMessage}</p>}
      {status?.lastError != null && <p className="mode-alert">{status.lastError}</p>}
      {pendingRestore !== null && (
        <p className="mode-alert">
          {pendingRestore.profileName} was not fully restored after a crash. Restart TuneSmith as administrator and toggle game
          mode to retry.
        </p>
      )}

      {guard?.status === 'trip' && <p className="mode-alert">Thermal guard: {guard.message}</p>}
      {guard?.status === 'unavailable' && <p className="mode-note">{guard.message}</p>}
      {guard?.status === 'ok' && guard.missing.length > 0 && (
        <p className="mode-note">Guard inputs unavailable: {guard.missing.join(', ')}.</p>
      )}
      {telemetry !== null && <p className="mode-note">Telemetry: {telemetry}</p>}

      {active !== null && (
        <details className="panel-details">
          <summary>
            Session adjustments <span className="details-count">{active.adjustments.length}</span>
          </summary>
          <div className="details-body">
            <ul className="adjustments">
              {active.adjustments.length === 0 && <li className="muted">No adjustments recorded.</li>}
              {active.adjustments.map((adjustment, index) => (
                <li key={`${adjustment.kind}-${adjustment.target}-${index}`}>
                  <span className={`pill ${adjustment.ok ? 'pill-ok' : 'pill-danger'}`}>
                    {adjustment.ok ? 'applied' : 'skipped'}
                  </span>{' '}
                  {adjustment.kind} · {adjustment.target} — {adjustment.detail}
                  {adjustment.error !== undefined && <span className="muted"> ({adjustment.error})</span>}
                </li>
              ))}
            </ul>
            {active.suspended.length > 0 && (
              <p className="muted small">
                Suspended: {active.suspended.map((process) => `${process.process} (${process.pid})`).join(', ')}
              </p>
            )}
          </div>
        </details>
      )}

      <details className="panel-details">
        <summary>
          Game library <span className="details-count">{libraries === null ? 'scanning' : `${libraries.games.length} title(s)`}</span>
        </summary>
        <div className="details-body">
          <div className="details-actions">
            <span className="muted small">
              {libraries === null
                ? 'Read-only scan in progress.'
                : `${detectedProfiles} profile(s) matched · scanned ${new Date(libraries.scannedAt).toLocaleTimeString()}`}
            </span>
            <button type="button" className="button button-ghost small" disabled={busy || libraries === null} onClick={onRefreshLibraries}>
              Rescan
            </button>
          </div>

          {libraries !== null && libraries.errors.length > 0 && (
            <ul className="mode-list muted small">
              {libraries.errors.map((error) => (
                <li key={`${error.source}-${error.message}`}>
                  {LIBRARY_SOURCE_LABEL[error.source] ?? 'Library'} scan incomplete: {error.message}
                </li>
              ))}
            </ul>
          )}

          <ul className="library-games">
            {(libraries?.games ?? []).map((game) => (
              <li key={game.id}>
                <div className="row">
                  <strong>{game.name}</strong>
                  <span className="chip">{LIBRARY_SOURCE_LABEL[game.source] ?? game.source}</span>
                  {game.profileIds.length > 0 ? (
                    <span className="pill pill-ok">Profile detected</span>
                  ) : (
                    <span className="chip">No installed profile</span>
                  )}
                </div>
                <p className="muted small library-path">
                  <code className="signature">{game.executablePath ?? game.installDir}</code>
                </p>
                {game.profileIds.length > 0 && (
                  <p className="muted small">Suggested: {game.profileIds.map((id) => profileNames.get(id) ?? id).join(', ')}</p>
                )}
              </li>
            ))}
            {libraries !== null && libraries.games.length === 0 && <li className="muted">No installed titles were detected.</li>}
          </ul>
        </div>
      </details>

      <details className="panel-details">
        <summary>
          Installed profiles <span className="details-count">{profiles.length}</span>
        </summary>
        <div className="details-body">
          <ul className="game-profiles">
            {profiles.map((profile) => (
              <li key={profile.id}>
                <div className="row">
                  <strong>{profile.name}</strong>
                  <code className="signature">{profile.exe || profile.packageFamilyName}</code>
                  {profile.installed && <span className="pill pill-ok">Detected</span>}
                  {profile.blocked && <span className="pill pill-danger">Blocked</span>}
                </div>
                {profile.installed && profile.detectedPath !== null && (
                  <p className="muted small library-path">
                    Found at <code className="signature">{profile.detectedPath}</code>
                  </p>
                )}
                <p className="muted small">{profile.actions.join(' · ')}</p>
                {profile.findings.length > 0 && (
                  <ul className="mode-list muted small">
                    {profile.findings.slice(0, 3).map((finding) => (
                      <li key={finding}>{finding}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
            {profiles.length === 0 && <li className="muted">No game profiles installed.</li>}
            {blocked > 0 && <li className="muted small">{blocked} profile(s) would be refused on this machine.</li>}
          </ul>
        </div>
      </details>
    </section>
  );
}
