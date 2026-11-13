import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { PresetSummary } from '../shared/ipc';
import type { CompiledPlan } from '../shared/preset/compiler';
import type { AppInfo, EngineProgress, PreflightReport, SessionSummary } from '../shared/session';
import type { HardwareSpec } from '../shared/types';
import type {
  DiscoveredGame,
  GameLibraryScanResult,
  GamePathPickKind,
  GameProfileSummary,
  GameStatus,
  ManualGameAddRequest,
  PickedGamePath,
} from '../shared/game/types';
import type { OsdStatus } from '../shared/game/osd';
import type { HealthStatus } from '../shared/health/types';
import type { ShaderCacheStatus } from '../shared/shader-cache';
import type { PostApplyStatus } from '../shared/post-apply';
import type { UpdaterStatus } from '../shared/updater';
import type { ServiceDependencyGraph } from '../shared/service-graph';
import { Header } from './components/Chrome';
import { DashboardHUD } from './components/DashboardHUD';
import { GameLauncherGrid } from './components/GameLauncherGrid';
import { GameModePanel } from './components/GameModePanel';
import { HardwarePanel, SafetyBanner } from './components/HardwarePanel';
import { PlanDialog } from './components/PlanDialog';
import { InstalledPresets } from './components/InstalledPresets';
import { PresetBrowser } from './components/PresetBrowser';
import { SessionPanel, summarizeReports } from './components/SessionPanel';
import { SettingsDialog } from './components/SettingsDialog';
import { DiagnosticsDialog } from './components/DiagnosticsDialog';
import { ShaderCachePanel } from './components/ShaderCachePanel';
import { SystemHealthPanel } from './components/SystemHealthPanel';
import { errorMessage, getBridge, isMockBridge } from './lib/bridge';
import { PostApplyBanner } from './components/PostApplyBanner';
import {
  DEFAULT_FEATURES,
  FEATURE_DEFINITIONS,
  loadFeatureVisibility,
  saveFeatureVisibility,
  type FeatureKey,
} from './lib/features';

type Toast = { kind: 'ok' | 'error' | 'info'; text: string };

function updateLabel(status: UpdaterStatus): string {
  switch (status.phase) {
    case 'checking':
      return 'Checking for updates…';
    case 'available':
      return status.availableVersion === null ? 'Update available' : `Update ${status.availableVersion} available`;
    case 'downloading':
      return status.percent === null
        ? 'Downloading update…'
        : `Downloading update ${status.percent.toFixed(0)}%`;
    case 'downloaded':
      return status.availableVersion === null ? 'Update ready to install' : `Update ${status.availableVersion} ready`;
    case 'error':
      return 'Update check failed';
    default:
      return '';
  }
}

export default function App(): ReactNode {
  const bridge = useMemo(() => getBridge(), []);
  const mock = useMemo(() => isMockBridge(), []);

  const [info, setInfo] = useState<AppInfo | null>(null);
  const [spec, setSpec] = useState<HardwareSpec | null>(null);
  const [presets, setPresets] = useState<PresetSummary[]>([]);
  const [preflight, setPreflight] = useState<PreflightReport | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [game, setGame] = useState<GameStatus | null>(null);
  const [gameProfiles, setGameProfiles] = useState<GameProfileSummary[]>([]);
  const [libraries, setLibraries] = useState<GameLibraryScanResult | null>(null);
  const [osd, setOsd] = useState<OsdStatus | null>(null);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [shaderCache, setShaderCache] = useState<ShaderCacheStatus | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdaterStatus | null>(null);
  const [postApply, setPostApply] = useState<PostApplyStatus | null>(null);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [dialog, setDialog] = useState<{
    preset: PresetSummary;
    plan: CompiledPlan;
    serviceGraph: ServiceDependencyGraph | null;
    serviceGraphError: string | null;
  } | null>(null);
  const [progress, setProgress] = useState<EngineProgress | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [features, setFeatures] = useState(() => loadFeatureVisibility());

  const hasRail = features.hardware || features.health;
  const hasContent =
    features.marketplace ||
    features.installed ||
    features.launcher ||
    features.gameMode ||
    features.sessions ||
    features.shaderCache;

  const reload = useCallback(async () => {
    const [presetList, sessionList, report, gameStatus, profiles, libraryScan, osdStatus, healthStatus, stabilityStatus, shaderCacheStatus] = await Promise.all([
      bridge.presets.list(),
      bridge.engine.sessions(),
      bridge.safety.preflight(),
      bridge.game.status(),
      bridge.game.profiles(),
      bridge.game.libraries(),
      bridge.game.osd(),
      bridge.health.status(),
      bridge.engine.postApply(),
      bridge.shaderCache.scan(),
    ]);
    setPresets(presetList);
    setSessions(sessionList);
    setPreflight(report);
    setGame(gameStatus);
    setGameProfiles(profiles);
    setLibraries(libraryScan);
    setOsd(osdStatus);
    setHealth(healthStatus);
    setPostApply(stabilityStatus);
    setShaderCache(shaderCacheStatus);
  }, [bridge]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const [appInfo, hardware] = await Promise.all([bridge.app.info(), bridge.hardware.get()]);
        if (cancelled) return;
        setInfo(appInfo);
        setSpec(hardware);
        await reload();
      } catch (err) {
        if (!cancelled) setToast({ kind: 'error', text: errorMessage(err) });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [bridge, reload]);

  useEffect(() => bridge.events.onProgress((next) => setProgress(next)), [bridge]);

  useEffect(() => bridge.game.onStatus((next) => setGame(next)), [bridge]);

  useEffect(() => bridge.health.onStatus((next) => setHealth(next)), [bridge]);

  useEffect(() => {
    let cancelled = false;
    void bridge.updater
      .status()
      .then((status) => {
        if (!cancelled) setUpdateStatus(status);
      })
      .catch(() => {
        // Update status is optional UI; a failed status request must not block the workbench.
      });
    const unsubscribe = bridge.updater.onStatus((status) => setUpdateStatus(status));
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [bridge]);

  useEffect(() => bridge.engine.onPostApply((next) => setPostApply(next)), [bridge]);

  useEffect(() => {
    saveFeatureVisibility(features);
  }, [features]);

  const openPreview = useCallback(
    async (presetId: string) => {
      try {
        const plan = await bridge.presets.plan(presetId);
        const preset = presets.find((p) => p.id === presetId);
        if (preset === undefined) throw new Error('Preset vanished from the list; refresh and retry.');
        let serviceGraph: ServiceDependencyGraph | null = null;
        let serviceGraphError: string | null = null;
        if (plan.summary.Services > 0) {
          try {
            serviceGraph = await bridge.presets.serviceDependencies(presetId);
          } catch (err) {
            serviceGraphError = errorMessage(err);
          }
        }
        setDialog({ preset, plan, serviceGraph, serviceGraphError });
        setProgress(null);
      } catch (err) {
        setToast({ kind: 'error', text: errorMessage(err) });
      }
    },
    [bridge, presets],
  );

  const applyPlan = useCallback(
    async (options: { consent: boolean; risk: boolean }) => {
      if (dialog === null) return;
      setBusy(true);
      setProgress({ phase: 'preflight', message: 'Checking the machine…' });
      try {
        const outcome = await bridge.engine.apply({
          presetId: dialog.plan.presetId,
          expectedSignature: dialog.plan.signature,
          acknowledgeConsent: options.consent,
          acknowledgeRisk: options.risk,
        });
        setToast({ kind: outcome.status === 'applied' ? 'ok' : 'error', text: outcome.message });
        setDialog(null);
        await reload();
      } catch (err) {
        setToast({ kind: 'error', text: errorMessage(err) });
      } finally {
        setBusy(false);
        setProgress(null);
      }
    },
    [bridge, dialog, reload],
  );

  const rollback = useCallback(
    async (sessionId: string) => {
      setBusy(true);
      try {
        const report = await bridge.engine.rollback(sessionId);
        setToast({ kind: report.ok ? 'ok' : 'error', text: report.message });
        await reload();
      } catch (err) {
        setToast({ kind: 'error', text: errorMessage(err) });
      } finally {
        setBusy(false);
      }
    },
    [bridge, reload],
  );

  const restoreDefaults = useCallback(async () => {
    setBusy(true);
    try {
      const reports = await bridge.engine.restoreDefaults();
      setToast({ kind: 'ok', text: summarizeReports(reports) });
      await reload();
    } catch (err) {
      setToast({ kind: 'error', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }, [bridge, reload]);

  const toggleGameMode = useCallback(
    async (enabled: boolean) => {
      setBusy(true);
      try {
        setGame(await bridge.game.setWatching(enabled));
      } catch (err) {
        setToast({ kind: 'error', text: errorMessage(err) });
      } finally {
        setBusy(false);
      }
    },
    [bridge],
  );

  const toggleCryoFreeze = useCallback(
    async (enabled: boolean) => {
      setBusy(true);
      try {
        setGame(await bridge.game.setCryoFreeze(enabled));
        setToast({
          kind: 'info',
          text: enabled
            ? 'Cryo-Freeze enabled. Non-essential sync and update processes will pause while a game session runs.'
            : 'Cryo-Freeze disabled.',
        });
      } catch (err) {
        setToast({ kind: 'error', text: errorMessage(err) });
      } finally {
        setBusy(false);
      }
    },
    [bridge],
  );

  const toggleInterruptAffinity = useCallback(
    async (enabled: boolean) => {
      setBusy(true);
      try {
        setGame(await bridge.game.setInterruptAffinity(enabled));
        setToast({
          kind: 'info',
          text: enabled
            ? 'IRQ pinning armed. GPU, NVMe and NIC affinity policies will be staged for the next game session and restored on exit.'
            : 'IRQ pinning disabled.',
        });
      } catch (err) {
        setToast({ kind: 'error', text: errorMessage(err) });
      } finally {
        setBusy(false);
      }
    },
    [bridge],
  );

  const toggleOsd = useCallback(
    async (enabled: boolean) => {
      setBusy(true);
      try {
        setOsd(await bridge.game.setOsd(enabled));
        setToast({
          kind: 'info',
          text: enabled
            ? 'Performance OSD enabled. It appears when a game profile is active.'
            : 'Performance OSD disabled.',
        });
      } catch (err) {
        setToast({ kind: 'error', text: errorMessage(err) });
      } finally {
        setBusy(false);
      }
    },
    [bridge],
  );

  const browseGameFiles = useCallback(
    async (game: DiscoveredGame) => {
      try {
        await bridge.game.openFolder(game.installDir);
      } catch (err) {
        setToast({ kind: 'error', text: errorMessage(err) });
      }
    },
    [bridge],
  );

  const launchGame = useCallback(
    async (game: DiscoveredGame) => {
      setBusy(true);
      try {
        const result = await bridge.game.launch(game.id);
        setToast({ kind: result.launched ? 'ok' : 'error', text: result.message });
        setGame(await bridge.game.status());
      } catch (err) {
        setToast({ kind: 'error', text: errorMessage(err) });
      } finally {
        setBusy(false);
      }
    },
    [bridge],
  );

  const refreshLibraries = useCallback(async () => {
    setBusy(true);
    try {
      const scan = await bridge.game.libraries(true);
      const profiles = await bridge.game.profiles();
      setLibraries(scan);
      setGameProfiles(profiles);
    } catch (err) {
      setToast({ kind: 'error', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }, [bridge]);

  const addManualGame = useCallback(
    async (input: ManualGameAddRequest): Promise<DiscoveredGame> => {
      setBusy(true);
      try {
        const added = await bridge.game.addManual(input);
        setLibraries(await bridge.game.libraries(true));
        setToast({ kind: 'ok', text: `${added.name} was added to the launcher.` });
        return added;
      } catch (err) {
        setToast({ kind: 'error', text: errorMessage(err) });
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [bridge],
  );

  const removeManualGame = useCallback(
    async (game: DiscoveredGame): Promise<void> => {
      setBusy(true);
      try {
        const removed = await bridge.game.removeManual(game.id);
        if (!removed) throw new Error('That manual game entry was not found.');
        setLibraries(await bridge.game.libraries(true));
        setToast({ kind: 'ok', text: `${game.name} was removed from the launcher. Game files were not changed.` });
      } catch (err) {
        setToast({ kind: 'error', text: errorMessage(err) });
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [bridge],
  );

  const pickGamePath = useCallback(
    async (kind: GamePathPickKind): Promise<PickedGamePath | null> => {
      try {
        return await bridge.game.pickPath(kind);
      } catch (err) {
        setToast({ kind: 'error', text: errorMessage(err) });
        throw err;
      }
    },
    [bridge],
  );

  const checkHealth = useCallback(async () => {
    setBusy(true);
    try {
      setHealth(await bridge.health.check());
    } catch (err) {
      setToast({ kind: 'error', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }, [bridge]);

  const acknowledgeHealth = useCallback(async () => {
    setBusy(true);
    try {
      setHealth(await bridge.health.acknowledge());
      setToast({ kind: 'ok', text: 'Current system state accepted as the new health baseline.' });
    } catch (err) {
      setToast({ kind: 'error', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }, [bridge]);

  const flushJournals = useCallback(async () => {
    setBusy(true);
    try {
      const result = await bridge.health.flushJournals();
      setToast({ kind: 'ok', text: result.message });
      await reload();
    } catch (err) {
      setToast({ kind: 'error', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }, [bridge, reload]);

  const installUpdate = useCallback(async () => {
    try {
      await bridge.updater.install();
    } catch (err) {
      setToast({ kind: 'error', text: errorMessage(err) });
    }
  }, [bridge]);

  const scanShaderCache = useCallback(async () => {
    setBusy(true);
    try {
      setShaderCache(await bridge.shaderCache.scan(true));
    } catch (err) {
      setToast({ kind: 'error', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }, [bridge]);

  const pruneShaderCache = useCallback(async () => {
    setBusy(true);
    try {
      const result = await bridge.shaderCache.prune({ cacheIds: ['directx'], confirm: true });
      setShaderCache(result.status);
      setToast({ kind: result.ok ? 'ok' : 'error', text: result.message });
    } catch (err) {
      setToast({ kind: 'error', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }, [bridge]);

  const pinPreset = useCallback(
    async (presetId: string | null) => {
      setBusy(true);
      try {
        setHealth(await bridge.health.pin(presetId));
        setToast({ kind: 'ok', text: presetId === null ? 'Recovery preset unpinned.' : 'Preset pinned for recovery.' });
      } catch (err) {
        setToast({ kind: 'error', text: errorMessage(err) });
      } finally {
        setBusy(false);
      }
    },
    [bridge],
  );

  const reapplyPinned = useCallback(() => {
    if (health?.pinnedPreset === null || health?.pinnedPreset === undefined) {
      setToast({ kind: 'info', text: 'Pin a preset first, then it can be re-applied after a system change.' });
      return;
    }
    if (health.pinnedPresetMissing) {
      setToast({ kind: 'error', text: 'The pinned preset is no longer installed.' });
      return;
    }
    void openPreview(health.pinnedPreset.id);
  }, [health, openPreview]);

  const stopGameSession = useCallback(async () => {
    setBusy(true);
    try {
      setGame(await bridge.game.stop());
      setToast({ kind: 'ok', text: 'Game session restored.' });
    } catch (err) {
      setToast({ kind: 'error', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }, [bridge]);

  const requestElevation = useCallback(async () => {
    setBusy(true);
    setToast({ kind: 'info', text: 'Requesting administrator rights…' });
    try {
      const result = await bridge.app.requestElevation();
      setToast({ kind: 'info', text: result.detail });
    } catch (err) {
      setToast({ kind: 'error', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }, [bridge]);

  const refreshAll = useCallback(async () => {
    setBusy(true);
    try {
      setSpec(await bridge.hardware.get(true));
      await reload();
    } catch (err) {
      setToast({ kind: 'error', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }, [bridge, reload]);

  const setFeatureEnabled = useCallback(
    (key: FeatureKey, enabled: boolean) => {
      setFeatures((current) => ({ ...current, [key]: enabled }));
      // Turning off game mode should also disarm the watcher; an active session is left
      // intact so its journaled changes can still be restored from the panel or HUD.
      if (key === 'gameMode' && !enabled) {
        void bridge.game
          .setWatching(false)
          .then(setGame)
          .catch((err: unknown) => setToast({ kind: 'error', text: errorMessage(err) }));
      }
    },
    [bridge],
  );

  const setAllFeatures = useCallback(
    (enabled: boolean) => {
      setFeatures(() => {
        const next = { ...DEFAULT_FEATURES };
        for (const feature of FEATURE_DEFINITIONS) next[feature.key] = enabled;
        return next;
      });
      if (!enabled) {
        void bridge.game
          .setWatching(false)
          .then(setGame)
          .catch((err: unknown) => setToast({ kind: 'error', text: errorMessage(err) }));
      }
    },
    [bridge],
  );

  return (
    <div className="app">
      <Header
        signature={spec?.signature ?? null}
        isElevated={preflight?.isElevated ?? false}
        isMock={mock}
        busy={busy}
        features={features}
        onOpenSettings={() => setSettingsOpen(true)}
        onRefresh={() => void refreshAll()}
      />

      {features.hud && (
        <DashboardHUD
          spec={spec}
          preflight={preflight}
          game={game}
          postApply={postApply}
          health={health}
          sessions={sessions}
          busy={busy}
          onToggleWatching={(enabled) => void toggleGameMode(enabled)}
          onStopGame={() => void stopGameSession()}
        />
      )}

      {mock && (
        <div className="banner banner-warn">
          <div className="banner-body">
            <strong>Browser preview</strong>
            <ul>
              <li>
                No preload bridge detected, so presets are compiled against a fixture machine ({spec?.signature ?? '…'}) and
                every change is simulated.
              </li>
            </ul>
          </div>
        </div>
      )}

      <SafetyBanner preflight={preflight} onRequestElevation={() => void requestElevation()} busy={busy} />

      <PostApplyBanner status={postApply} />

      <main className={`layout ${hasRail ? '' : 'layout-wide'}`}>
        {hasRail && (
          <aside className="rail">
            {features.hardware && <HardwarePanel spec={spec} />}
            {features.health && (
              <SystemHealthPanel
                health={health}
                busy={busy}
                onCheck={() => void checkHealth()}
                onAcknowledge={() => void acknowledgeHealth()}
                onReapply={reapplyPinned}
                onFlush={() => void flushJournals()}
              />
            )}
          </aside>
        )}

        <div className="content">
          {!hasContent ? (
            <EmptyWorkspace onShowAll={() => setAllFeatures(true)} />
          ) : loading ? (
            <section className="panel loading-panel">
              <span className="panel-kicker">SCANNING</span>
              <h2>Reading the machine</h2>
              <p className="muted">Hardware, presets and local libraries are being indexed…</p>
              <div className="loading-rule" aria-hidden="true" />
            </section>
          ) : (
            <>
              {features.marketplace && <PresetBrowser hardware={spec} onInstalled={() => void reload()} />}
              {features.installed && (
                <InstalledPresets
                  presets={presets}
                  pinnedPresetId={health?.pinnedPresetId ?? null}
                  onPreview={(id) => void openPreview(id)}
                  onApply={(id) => void openPreview(id)}
                  onPin={(id) => void pinPreset(id)}
                  onOpenFolder={() => void bridge.presets.openFolder()}
                />
              )}
              {features.launcher && (
                <GameLauncherGrid
                  games={libraries?.games ?? []}
                  loading={libraries === null}
                  busy={busy}
                  profiles={gameProfiles}
                  scanErrors={libraries?.errors ?? []}
                  onBrowseFiles={(game) => void browseGameFiles(game)}
                  onLaunch={(game) => void launchGame(game)}
                  onAddGame={addManualGame}
                  onRemoveGame={removeManualGame}
                  onPickPath={pickGamePath}
                  onRefreshLibraries={() => void refreshLibraries()}
                />
              )}
              {features.shaderCache && (
                <ShaderCachePanel
                  status={shaderCache}
                  busy={busy}
                  onScan={() => void scanShaderCache()}
                  onPrune={() => void pruneShaderCache()}
                />
              )}
              {features.gameMode && (
                <GameModePanel
                  status={game}
                  profiles={gameProfiles}
                  osd={osd}
                  busy={busy}
                  onToggle={(enabled) => void toggleGameMode(enabled)}
                  onStop={() => void stopGameSession()}
                  onToggleCryoFreeze={(enabled) => void toggleCryoFreeze(enabled)}
                  onToggleInterruptAffinity={(enabled) => void toggleInterruptAffinity(enabled)}
                  onToggleOsd={(enabled) => void toggleOsd(enabled)}
                />
              )}
              {features.sessions && (
                <SessionPanel
                  sessions={sessions}
                  busy={busy}
                  onRollback={(id) => void rollback(id)}
                  onRestoreDefaults={() => void restoreDefaults()}
                />
              )}
            </>
          )}
        </div>
      </main>

      <footer className="footer">
        <span>
          {info === null
            ? 'TuneSmith'
            : `TuneSmith ${info.appVersion} · Electron ${info.electronVersion} · ${info.presetCount} preset(s)`}
        </span>
        {updateStatus !== null &&
          updateStatus.phase !== 'disabled' &&
          updateStatus.phase !== 'idle' &&
          updateStatus.phase !== 'up-to-date' && (
            <div
              className={`footer-update footer-update-${updateStatus.phase}`}
              aria-live="polite"
              title={updateStatus.message ?? undefined}
            >
              <span>{updateLabel(updateStatus)}</span>
              {updateStatus.phase === 'downloaded' && (
                <button type="button" className="button button-primary small" onClick={() => void installUpdate()}>
                  Install update
                </button>
              )}
            </div>
          )}
        <span className="muted small">{info?.sessionsDir ?? ''}</span>
      </footer>

      {settingsOpen && (
        <SettingsDialog
          features={features}
          game={game}
          osd={osd}
          busy={busy}
          onClose={() => setSettingsOpen(false)}
          onSetFeature={setFeatureEnabled}
          onSetAllFeatures={setAllFeatures}
          onToggleGameMode={(enabled) => void toggleGameMode(enabled)}
          onToggleCryoFreeze={(enabled) => void toggleCryoFreeze(enabled)}
          onToggleInterruptAffinity={(enabled) => void toggleInterruptAffinity(enabled)}
          onToggleOsd={(enabled) => void toggleOsd(enabled)}
          onOpenDiagnostics={() => {
            setSettingsOpen(false);
            setDiagnosticsOpen(true);
          }}
        />
      )}

      {diagnosticsOpen && <DiagnosticsDialog onClose={() => setDiagnosticsOpen(false)} />}

      {dialog !== null && (
        <PlanDialog
          preset={dialog.preset}
          plan={dialog.plan}
          busy={busy}
          progress={progress}
          serviceGraph={dialog.serviceGraph}
          serviceGraphError={dialog.serviceGraphError}
          onClose={() => setDialog(null)}
          onApply={(options) => void applyPlan(options)}
        />
      )}

      {toast !== null && (
        <div className={`toast toast-${toast.kind}`} role="status">
          <span>{toast.text}</span>
          <button type="button" className="toast-close" onClick={() => setToast(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
    </div>
  );
}

function EmptyWorkspace({ onShowAll }: { onShowAll: () => void }): ReactNode {
  return (
    <section className="panel empty-workspace">
      <span className="panel-kicker">WORKSPACE / EMPTY</span>
      <h2>All modules are hidden</h2>
      <p className="muted">
        The engine is still running. Choose which instruments you want on the bench, or restore the full layout.
      </p>
      <button type="button" className="button button-primary" onClick={onShowAll}>
        Restore all modules
      </button>
    </section>
  );
}
