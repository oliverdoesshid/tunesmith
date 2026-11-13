import { useEffect, useState, type ReactNode } from 'react';
import type { GameStatus } from '../../shared/game/types';
import type { HealthStatus } from '../../shared/health/types';
import type { PostApplyStatus } from '../../shared/post-apply';
import type { MemorySnapshot, PreflightReport, SessionSummary } from '../../shared/session';
import type { HardwareSpec } from '../../shared/types';
import { getBridge } from '../lib/bridge';

type Tone = 'ok' | 'warn' | 'danger' | 'muted';

interface DashboardHUDProps {
  spec: HardwareSpec | null;
  preflight: PreflightReport | null;
  game: GameStatus | null;
  postApply: PostApplyStatus | null;
  health: HealthStatus | null;
  sessions: SessionSummary[];
  busy: boolean;
  onToggleWatching: (enabled: boolean) => void;
  onStopGame: () => void;
}

interface WatchdogView {
  tone: Tone;
  value: string;
  hint: string;
  badge: string;
}

function clock(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function gigabytes(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}

function pressureLabel(pressure: MemorySnapshot['pressure']): string {
  if (pressure === 'critical') return 'CRITICAL';
  if (pressure === 'elevated') return 'ELEVATED';
  return 'OPTIMAL';
}

function pressureTone(pressure: MemorySnapshot['pressure']): Tone {
  if (pressure === 'critical') return 'danger';
  if (pressure === 'elevated') return 'warn';
  return 'ok';
}

function watchdogView(postApply: PostApplyStatus | null, health: HealthStatus | null): WatchdogView {
  if (postApply !== null && postApply.phase !== 'idle' && postApply.phase !== 'cancelled') {
    if (postApply.phase === 'monitoring') {
      return {
        tone: postApply.trip === null ? 'warn' : 'danger',
        value: clock(postApply.remainingMs),
        hint: `${postApply.sampleCount} sample(s) · ${postApply.presetName ?? 'post-apply'} window`,
        badge: 'MONITORING',
      };
    }
    if (postApply.phase === 'stable') {
      return { tone: 'ok', value: 'STABLE', hint: postApply.message, badge: 'PASSED' };
    }
    if (postApply.phase === 'rolling-back') {
      return { tone: 'danger', value: 'ROLLBACK', hint: postApply.message, badge: 'ACTIVE' };
    }
    if (postApply.phase === 'rolled-back') {
      return { tone: 'danger', value: 'ROLLED BACK', hint: postApply.message, badge: 'COMPLETE' };
    }
    return { tone: 'danger', value: 'FAILED', hint: postApply.message, badge: 'ACTION' };
  }

  if (health?.watchdog === 'error') {
    return {
      tone: 'danger',
      value: 'DEGRADED',
      hint: health.error ?? 'The health watchdog could not complete its read-only checks.',
      badge: 'ERROR',
    };
  }
  if (health !== null && health.signals.length > 0) {
    return {
      tone: 'warn',
      value: 'DRIFT',
      hint: `${health.signals.length} change(s) since the accepted baseline.`,
      badge: 'REVIEW',
    };
  }
  if (health?.watchdog === 'healthy') {
    return {
      tone: 'ok',
      value: 'HEALTHY',
      hint: health.signals.length === 0 ? 'No drift detected. Read-only checks are current.' : 'Watching for system drift.',
      badge: 'WATCHING',
    };
  }
  return {
    tone: 'muted',
    value: 'STARTING',
    hint: 'Starting the passive health watchdog…',
    badge: 'BOOT',
  };
}

/** Isolated so the memory sample only re-renders this HUD. */
function useMemoryPressure(active: boolean): MemorySnapshot | null {
  const [memory, setMemory] = useState<MemorySnapshot | null>(null);

  useEffect(() => {
    const bridge = getBridge();
    let alive = true;

    const read = async (): Promise<void> => {
      try {
        const next = await bridge.app.memory();
        if (alive) setMemory(next);
      } catch {
        // The HUD is informational. The shell already reports bridge failures elsewhere.
      }
    };

    void read();
    // An active game is worth a fresh reading; an idle HUD is not. The visibility handler
    // still refreshes immediately when the window returns.
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void read();
    }, active ? 5_000 : 15_000);
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') void read();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [active]);

  return memory;
}

export function DashboardHUD({
  spec,
  preflight,
  game,
  postApply,
  health,
  sessions,
  busy,
  onToggleWatching,
  onStopGame,
}: DashboardHUDProps): ReactNode {
  const active = game?.active ?? null;
  const memory = useMemoryPressure(active !== null);
  const watchdog = watchdogView(postApply, health);
  const affinity = active?.adjustments.find((adjustment) => adjustment.kind === 'affinity');
  const memoryTone = memory === null ? 'muted' : pressureTone(memory.pressure);
  const pending = sessions.reduce((sum, session) => sum + session.pendingRollback, 0);
  const applied = active?.adjustments.filter((adjustment) => adjustment.ok).length ?? 0;

  const critical =
    watchdog.tone === 'danger' ||
    (game?.pendingRestore ?? null) !== null ||
    preflight?.ready === false ||
    memoryTone === 'danger';
  const warning =
    !critical &&
    (watchdog.tone === 'warn' ||
      memoryTone === 'warn' ||
      health?.watchdog === 'starting' ||
      (health?.signals.length ?? 0) > 0 ||
      (game?.watching === true && !game.watcherHealthy));
  const overall: Tone = critical ? 'danger' : warning ? 'warn' : game === null ? 'muted' : 'ok';
  const overallLabel = critical ? 'ATTENTION' : warning ? 'MONITORING' : active !== null ? 'TUNING LIVE' : 'OPTIMAL';

  const title = active?.profileName ?? (game === null ? 'Reading system state' : game.watching ? 'Game mode armed' : 'System ready');
  const subtitle =
    active !== null
      ? `${active.exe}${active.pid === null ? '' : ` · pid ${active.pid}`} · ${active.phase}`
      : game === null
        ? 'Connecting to the local engine…'
        : game.watching
          ? `Watching ${game.profiles} profile(s) · ${game.watcherHealthy ? 'observer healthy' : 'observer starting'}`
          : 'No game profile is active. Arm game mode to tune on focus.';

  const affinityValue =
    spec === null ? '—' : `${spec.cpu.cores}C / ${spec.cpu.threads}T`;
  const affinityBadge = affinity?.ok === true ? 'APPLIED' : affinity !== undefined ? 'SKIPPED' : active !== null ? 'DEFAULT' : 'IDLE';
  const affinityTone: Tone = affinity?.ok === true ? 'ok' : affinity !== undefined ? 'warn' : 'muted';
  const affinityHint =
    affinity !== undefined
      ? affinity.ok
        ? affinity.detail
        : (affinity.error ?? affinity.detail)
      : active !== null
        ? 'No affinity adjustment was recorded for this session.'
        : 'All logical processors are available to the foreground game.';

  const profileTone: Tone = active !== null ? 'ok' : game?.watching === true ? 'warn' : 'muted';
  const profileValue = active?.profileName ?? (game?.watching === true ? 'WATCHING' : 'STANDBY');
  const profileHint =
    active !== null
      ? `${applied}/${active.adjustments.length} change(s) applied${active.suspended.length > 0 ? ` · ${active.suspended.length} process(es) suspended` : ''}`
      : game?.watching === true
        ? `${game.profiles} profile(s) armed · no active game yet`
        : 'Waiting for a detected title to take focus.';

  return (
    <section className={`dash-hud dash-hud-${overall}`} aria-label="Live system dashboard">
      <div className="hud-topline">
        <span className="hud-topline-title">TUNESMITH / LIVE STATE</span>
        <span className={`hud-topline-signal hud-topline-${overall}`}>{overallLabel}</span>
        <span className="hud-topline-meta">
          {preflight === null ? 'PREFLIGHT PENDING' : preflight.isElevated ? 'ADMIN' : 'USER'} / LOCAL
        </span>
      </div>

      <div className="hud-hero">
        <div className="hud-identity">
          <span className={`hud-orb hud-orb-${overall}`} aria-hidden="true" />
          <div className="hud-identity-copy">
            <span className="hud-eyebrow">LIVE SYSTEM · {overallLabel}</span>
            <h2>{title}</h2>
            <p className="hud-sub">{subtitle}</p>
            <code className="hud-signature">{spec?.signature ?? 'Detecting hardware signature…'}</code>
          </div>
        </div>

        <div className="hud-hero-actions">
          <span className={`hud-status hud-status-${overall}`}>
            <span className="hud-status-dot" aria-hidden="true" />
            {overallLabel}
          </span>
          {active !== null ? (
            <button type="button" className="hud-action hud-action-danger" disabled={busy} onClick={onStopGame}>
              Restore session
            </button>
          ) : (
            <button
              type="button"
              className="hud-action hud-action-primary"
              disabled={busy || game === null}
              onClick={() => onToggleWatching(!(game?.watching ?? false))}
            >
              {game?.watching === true ? 'Disarm game mode' : 'Arm game mode'}
            </button>
          )}
          {game?.watching === true && <span className="hud-quiet">Game mode on</span>}
        </div>
      </div>

      <div className="hud-metrics">
        <article className={`hud-metric hud-tone-${affinityTone}`}>
          <div className="hud-metric-top">
            <span className="hud-label">
              <span className="hud-metric-index">01</span>
              CPU affinity
            </span>
            <span className={`hud-badge hud-badge-${affinityTone}`}>{affinityBadge}</span>
          </div>
          <span className="hud-value">{affinityValue}</span>
          <p className="hud-hint" title={affinityHint}>
            {affinityHint}
          </p>
        </article>

        <article className={`hud-metric hud-tone-${profileTone}`}>
          <div className="hud-metric-top">
            <span className="hud-label">
              <span className="hud-metric-index">02</span>
              Active profile
            </span>
            <span className={`hud-badge hud-badge-${profileTone}`}>{active === null ? 'STANDBY' : 'LIVE'}</span>
          </div>
          <span className="hud-value hud-value-profile" title={profileValue}>
            {profileValue}
          </span>
          <p className="hud-hint" title={profileHint}>
            {profileHint}
          </p>
        </article>

        <article className={`hud-metric hud-tone-${memoryTone}`}>
          <div className="hud-metric-top">
            <span className="hud-label">
              <span className="hud-metric-index">03</span>
              Memory pressure
            </span>
            <span className={`hud-badge hud-badge-${memoryTone}`}>{memory === null ? 'READING' : pressureLabel(memory.pressure)}</span>
          </div>
          <span className="hud-value">{memory === null ? '—' : `${memory.usedPercent.toFixed(0)}%`}</span>
          <p className="hud-hint">
            {memory === null
              ? 'Reading physical memory from the local engine…'
              : `${gigabytes(memory.availableBytes)} GB free of ${gigabytes(memory.totalBytes)} GB`}
          </p>
          <div
            className="hud-memory-bar"
            role="progressbar"
            aria-label="Memory used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={memory === null ? 0 : Math.round(memory.usedPercent)}
          >
            <span className={`hud-fill-${memoryTone}`} style={{ width: `${memory === null ? 0 : Math.min(100, memory.usedPercent)}%` }} />
          </div>
        </article>

        <article className={`hud-metric hud-tone-${watchdog.tone}`}>
          <div className="hud-metric-top">
            <span className="hud-label">
              <span className="hud-metric-index">04</span>
              Stability watchdog
            </span>
            <span className={`hud-badge hud-badge-${watchdog.tone}`}>{watchdog.badge}</span>
          </div>
          <span className="hud-value hud-value-watchdog">{watchdog.value}</span>
          <p className="hud-hint" title={watchdog.hint}>
            {watchdog.hint}
          </p>
        </article>
      </div>

      <div className="hud-strip">
        <span>
          <span className={`hud-mini-dot hud-mini-${overall}`} aria-hidden="true" />
          {overallLabel} · read-only telemetry
        </span>
        <span>{preflight === null ? 'Preflight pending' : preflight.isElevated ? 'Elevated' : 'Standard user'}</span>
        <span>{pending > 0 ? `${pending} reversible change(s)` : 'Journal clear'}</span>
        <span className="hud-stamp">{memory === null ? 'Sampling…' : `Memory sampled ${new Date(memory.sampledAt).toLocaleTimeString()}`}</span>
      </div>
    </section>
  );
}
