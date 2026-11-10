import type { ReactNode } from 'react';
import type { GameProfileSummary, GameStatus } from '../../shared/game/types';

interface GameModePanelProps {
  status: GameStatus | null;
  profiles: GameProfileSummary[];
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onStop: () => void;
}

function topologyLine(status: GameStatus): string | null {
  const topology = status.topology;
  if (topology === null) return null;
  if (!topology.hybrid) return `${topology.logicalProcessors} logical processors (no hybrid split reported)`;
  const fastest = Math.max(...topology.efficiencyClasses);
  const performance = topology.efficiencyClasses.filter((value) => value === fastest).length;
  return `${topology.logicalProcessors} logical processors · ${performance} performance · ${topology.logicalProcessors - performance} efficiency`;
}

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

export function GameModePanel({ status, profiles, busy, onToggle, onStop }: GameModePanelProps): ReactNode {
  const watching = status?.watching ?? false;
  const active = status?.active ?? null;
  const guard = status?.guard ?? null;
  const telemetry = status === null ? null : telemetryLine(status);
  const blocked = profiles.filter((profile) => profile.blocked).length;

  return (
    <section className="panel">
      <div className="section-head">
        <h2>GAME MODE</h2>
        <span className={`pill ${watching ? 'pill-ok' : 'pill-muted'}`}>{watching ? 'Watching' : 'Off'}</span>
      </div>

      <p className="muted small">
        Watches for a game taking focus, applies its profile, and restores everything when the game closes. Changes are
        written to disk before they are applied, so a crash cannot leave a browser suspended.
      </p>

      <div className="row">
        <button
          type="button"
          className={watching ? 'button button-ghost' : 'button'}
          disabled={busy}
          onClick={() => onToggle(!watching)}
        >
          {watching ? 'Stop watching' : 'Start watching'}
        </button>
        {active !== null && (
          <button type="button" className="button button-ghost" disabled={busy} onClick={onStop}>
            Restore now
          </button>
        )}
        <span className="muted small">
          {status === null
            ? 'Loading…'
            : `${status.profiles} profile(s) · polls every ${(status.pollMs / 1000).toFixed(1)}s`}
        </span>
      </div>

      {status?.lastError != null && <p className="small badge-aggressive">Last error: {status.lastError}</p>}

      {status?.pendingRestore != null && (
        <p className="small badge-aggressive">
          {status.pendingRestore.profileName} was not fully restored after a crash. Restart TuneSmith as administrator and
          toggle game mode to retry.
        </p>
      )}

      {active !== null && (
        <div className="game-active">
          <p>
            <strong>{active.profileName}</strong> <span className="muted">· {active.exe}</span>
            {active.pid !== null && <span className="muted"> · pid {active.pid}</span>}
          </p>
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
      )}

      {status !== null && topologyLine(status) !== null && <p className="muted small">CPU: {topologyLine(status)}</p>}

      {telemetry !== null && <p className="muted small">Telemetry: {telemetry}</p>}

      {guard?.status === 'unavailable' && <p className="muted small">{guard.message}</p>}

      {guard?.status === 'ok' && guard.missing.length > 0 && (
        <p className="muted small">Guard inputs unavailable: {guard.missing.join(', ')}.</p>
      )}

      {guard?.status === 'trip' && <p className="small badge-aggressive">Thermal guard: {guard.message}</p>}

      {status !== null && status.packages.length > 0 && (
        <p className="muted small">
          Store packages:{' '}
          {status.packages
            .map((pkg) => `${pkg.familyName} (${pkg.executables.join(', ') || 'no executable in manifest'})`)
            .join(' · ')}
        </p>
      )}

      <ul className="game-profiles">
        {profiles.map((profile) => (
          <li key={profile.id}>
            <div className="row">
              <strong>{profile.name}</strong>
              <code className="signature">{profile.exe || profile.packageFamilyName}</code>
              {profile.blocked && <span className="pill pill-danger">Blocked</span>}
            </div>
            <p className="muted small">{profile.actions.join(' · ')}</p>
            {profile.findings.length > 0 && (
              <ul className="muted small">
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
    </section>
  );
}
