import { useEffect, type ReactNode } from 'react';
import type { OsdStatus } from '../../shared/game/osd';
import type { GameStatus } from '../../shared/game/types';
import { FEATURE_DEFINITIONS, type FeatureKey, type FeatureVisibility } from '../lib/features';

interface SettingsDialogProps {
  features: FeatureVisibility;
  game: GameStatus | null;
  osd: OsdStatus | null;
  busy: boolean;
  onClose: () => void;
  onSetFeature: (key: FeatureKey, enabled: boolean) => void;
  onSetAllFeatures: (enabled: boolean) => void;
  onToggleGameMode: (enabled: boolean) => void;
  onToggleCryoFreeze: (enabled: boolean) => void;
  onToggleInterruptAffinity: (enabled: boolean) => void;
  onToggleOsd: (enabled: boolean) => void;
  onOpenDiagnostics?: () => void;
}

interface ToggleRowProps {
  code: string;
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (enabled: boolean) => void;
}

function ToggleRow({ code, label, description, checked, disabled = false, onChange }: ToggleRowProps): ReactNode {
  return (
    <label className={`workspace-option settings-option ${checked ? 'is-on' : ''} ${disabled ? 'is-disabled' : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="workspace-check" aria-hidden="true" />
      <span className="workspace-code">{code}</span>
      <span className="workspace-option-copy">
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
    </label>
  );
}

export function SettingsDialog({
  features,
  game,
  osd,
  busy,
  onClose,
  onSetFeature,
  onSetAllFeatures,
  onToggleGameMode,
  onToggleCryoFreeze,
  onToggleInterruptAffinity,
  onToggleOsd,
  onOpenDiagnostics,
}: SettingsDialogProps): ReactNode {
  const enabledCount = FEATURE_DEFINITIONS.filter((feature) => features[feature.key]).length;
  const allEnabled = enabledCount === FEATURE_DEFINITIONS.length;
  const allDisabled = enabledCount === 0;
  const gameModeEnabled = features.gameMode;
  const activeGame = game?.active != null;
  const runtimeBusy = busy || game === null;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      className="overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="dialog settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="dialog-head">
          <div>
            <span className="panel-kicker">SYSTEM / PREFERENCES</span>
            <h2 id="settings-title">Settings</h2>
            <p className="muted small">
              {enabledCount}/{FEATURE_DEFINITIONS.length} workspace features enabled · saved on this machine
            </p>
          </div>
          <button type="button" className="button button-ghost small" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="dialog-body settings-body">
          <section>
            <div className="settings-section-head">
              <div>
                <h3 className="section-title">Workspace features</h3>
                <p className="muted small">
                  Turn any panel off when you do not want it on the bench. Engine safety, journals and rollback stay
                  active.
                </p>
              </div>
              <div className="settings-all-actions">
                <button
                  type="button"
                  className="button button-ghost small"
                  disabled={allEnabled}
                  onClick={() => onSetAllFeatures(true)}
                >
                  Enable all
                </button>
                <button
                  type="button"
                  className="button button-ghost small"
                  disabled={allDisabled}
                  onClick={() => onSetAllFeatures(false)}
                >
                  Disable all
                </button>
              </div>
            </div>

            <div className="workspace-options settings-options">
              {FEATURE_DEFINITIONS.map((feature) => (
                <ToggleRow
                  key={feature.key}
                  code={feature.code}
                  label={feature.label}
                  description={feature.description}
                  checked={features[feature.key]}
                  onChange={(enabled) => onSetFeature(feature.key, enabled)}
                />
              ))}
            </div>
          </section>

          <section>
            <h3 className="section-title">Game mode behaviour</h3>
            <p className="muted small">
              These switches control what TuneSmith does while a game is running. They are available only when the
              Game mode feature is enabled.
            </p>

            <div className="workspace-options settings-options settings-runtime">
              <ToggleRow
                code="W"
                label="Game mode watcher"
                description="Detect a configured game taking focus and apply its profile automatically."
                checked={game?.watching ?? false}
                disabled={runtimeBusy || !gameModeEnabled}
                onChange={onToggleGameMode}
              />
              <ToggleRow
                code="C"
                label="Cryo-Freeze"
                description="Pause a fixed allowlist of sync, updater and telemetry processes during a game session."
                checked={game?.cryoFreeze ?? false}
                disabled={runtimeBusy || !gameModeEnabled || activeGame}
                onChange={onToggleCryoFreeze}
              />
              <ToggleRow
                code="I"
                label="IRQ pinning"
                description="Stage GPU, NVMe and NIC interrupt affinity on physical performance cores for the next session."
                checked={game?.interruptAffinity ?? false}
                disabled={runtimeBusy || !gameModeEnabled || activeGame}
                onChange={onToggleInterruptAffinity}
              />
              <ToggleRow
                code="O"
                label="Performance OSD"
                description="Show the click-through in-game overlay with the active profile and available telemetry."
                checked={osd?.enabled ?? false}
                disabled={runtimeBusy || !gameModeEnabled || osd === null}
                onChange={onToggleOsd}
              />
            </div>

            <p className="settings-note">
              Changing a workspace feature never silently applies or restores system values. A change that needs a
              running game session is disabled until that session is restored.
            </p>
          </section>
        </div>

        <footer className="dialog-foot settings-foot">
          <span className="muted small">Personal preferences are stored locally and do not leave this machine.</span>
          {onOpenDiagnostics !== undefined && (
            <button type="button" className="button button-ghost small" onClick={onOpenDiagnostics}>
              Crash diagnostics
            </button>
          )}
          <button type="button" className="button button-primary small" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
