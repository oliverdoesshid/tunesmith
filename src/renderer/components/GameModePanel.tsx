import type { ReactNode } from 'react';
import type { OsdStatus } from '../../shared/game/osd';
import type { GameProfileSummary, GameStatus } from '../../shared/game/types';

interface GameModePanelProps {
  status: GameStatus | null;
  profiles: GameProfileSummary[];
  osd: OsdStatus | null;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onStop: () => void;
  onToggleCryoFreeze: (enabled: boolean) => void;
  onToggleInterruptAffinity: (enabled: boolean) => void;
  onToggleOsd: (enabled: boolean) => void;
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

export function GameModePanel({
  status,
  profiles,
  osd,
  busy,
  onToggle,
  onStop,
  onToggleCryoFreeze,
  onToggleInterruptAffinity,
  onToggleOsd,
}: GameModePanelProps): ReactNode {
  const watching = status?.watching ?? false;
  const cryoFreeze = status?.cryoFreeze ?? false;
  const interruptAffinity = status?.interruptAffinity ?? false;
  const active = status?.active ?? null;
  const guard = status?.guard ?? null;
  const topology = status?.topology ?? null;
  const pendingRestore = status?.pendingRestore ?? null;
  const osdMessage = osd?.message ?? null;
  const telemetry = status === null ? null : telemetryLine(status);
  const blocked = profiles.filter((profile) => profile.blocked).length;

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
            disabled={busy || active !== null}
            aria-pressed={cryoFreeze}
            title={
              active !== null
                ? 'Restore the active session before changing Cryo-Freeze.'
                : 'Pause non-essential cloud sync, updater and telemetry processes while a game session runs.'
            }
            onClick={() => onToggleCryoFreeze(!cryoFreeze)}
          >
            {cryoFreeze ? 'Cryo-Freeze off' : 'Cryo-Freeze on'}
          </button>
          <button
            type="button"
            className="button button-ghost small"
            disabled={busy || active !== null}
            aria-pressed={interruptAffinity}
            title={
              active !== null
                ? 'Restore the active session before changing IRQ pinning.'
                : 'Stage GPU, NVMe and NIC interrupt affinity on physical performance cores. Requires administrator rights. Windows applies the policy when each device next starts; devices are never restarted mid-game.'
            }
            onClick={() => onToggleInterruptAffinity(!interruptAffinity)}
          >
            {interruptAffinity ? 'IRQ pin off' : 'IRQ pin on'}
          </button>
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
          <small>Cryo-Freeze</small>
          <strong className={cryoFreeze ? 'mode-value-ok' : undefined}>
            {status === null ? '—' : cryoFreeze ? 'Enabled' : 'Off'}
          </strong>
        </span>
        <span>
          <small>IRQ pin</small>
          <strong className={interruptAffinity ? 'mode-value-ok' : undefined}>
            {status === null ? '—' : interruptAffinity ? 'Staged' : 'Off'}
          </strong>
        </span>
        <span>
          <small>OSD</small>
          <strong className={osd?.visible === true ? 'mode-value-ok' : undefined}>
            {osd === null ? '—' : osd.visible ? 'Visible' : osd.enabled ? 'Armed' : 'Off'}
          </strong>
        </span>
      </div>

      {cryoFreeze && (
        <p className="mode-note">
          Cryo-Freeze is enabled: a fixed allowlist of cloud-sync, updater and telemetry processes is
          suspended when a game session starts, and resumed when it ends or is recovered after a crash.
        </p>
      )}
      {interruptAffinity && (
        <p className="mode-note">
          IRQ pinning is armed for the next session. The GPU, NVMe and NIC affinity policies are
          journaled and restored on exit; Windows applies a device's policy when that device next
          starts, and the restored policy is read at that same next start. TuneSmith never restarts
          those devices during play. Administrator rights are required for the stage/restore write.
        </p>
      )}
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
                Suspended:{' '}
                {active.suspended
                  .map(
                    (process) =>
                      `${process.process} (${process.pid})${process.cryoFreeze === true ? ' · Cryo-Freeze' : ''}`,
                  )
                  .join(', ')}
              </p>
            )}
          </div>
        </details>
      )}

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
