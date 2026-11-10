import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { PresetSummary } from '../shared/ipc';
import type { CompiledPlan } from '../shared/preset/compiler';
import type { AppInfo, EngineProgress, PreflightReport, SessionSummary } from '../shared/session';
import type { HardwareSpec } from '../shared/types';
import type { GameProfileSummary, GameStatus } from '../shared/game/types';
import { Header } from './components/Chrome';
import { GameModePanel } from './components/GameModePanel';
import { HardwarePanel, SafetyBanner } from './components/HardwarePanel';
import { PlanDialog } from './components/PlanDialog';
import { PresetBrowser } from './components/PresetBrowser';
import { SessionPanel, summarizeReports } from './components/SessionPanel';
import { errorMessage, getBridge, isMockBridge } from './lib/bridge';

type Toast = { kind: 'ok' | 'error' | 'info'; text: string };

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

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [dialog, setDialog] = useState<{ preset: PresetSummary; plan: CompiledPlan } | null>(null);
  const [progress, setProgress] = useState<EngineProgress | null>(null);

  const reload = useCallback(async () => {
    const [presetList, sessionList, report, gameStatus, profiles] = await Promise.all([
      bridge.presets.list(),
      bridge.engine.sessions(),
      bridge.safety.preflight(),
      bridge.game.status(),
      bridge.game.profiles(),
    ]);
    setPresets(presetList);
    setSessions(sessionList);
    setPreflight(report);
    setGame(gameStatus);
    setGameProfiles(profiles);
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

  const openPreview = useCallback(
    async (presetId: string) => {
      try {
        const plan = await bridge.presets.plan(presetId);
        const preset = presets.find((p) => p.id === presetId);
        if (preset === undefined) throw new Error('Preset vanished from the list; refresh and retry.');
        setDialog({ preset, plan });
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
    try {
      const result = await bridge.app.requestElevation();
      setToast({ kind: 'info', text: result.detail });
    } catch (err) {
      setToast({ kind: 'error', text: errorMessage(err) });
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

  return (
    <div className="app">
      <Header
        signature={spec?.signature ?? null}
        isElevated={preflight?.isElevated ?? false}
        isMock={mock}
        busy={busy}
        onRefresh={() => void refreshAll()}
      />

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

      <main className="layout">
        <HardwarePanel spec={spec} />

        <div className="content">
          {loading ? (
            <section className="panel">
              <p className="muted">Scanning hardware and loading presets…</p>
            </section>
          ) : (
            <>
              <PresetBrowser
                presets={presets}
                onPreview={(id) => void openPreview(id)}
                onApply={(id) => void openPreview(id)}
                onOpenFolder={() => void bridge.presets.openFolder()}
              />
              <GameModePanel
                status={game}
                profiles={gameProfiles}
                busy={busy}
                onToggle={(enabled) => void toggleGameMode(enabled)}
                onStop={() => void stopGameSession()}
              />
              <SessionPanel
                sessions={sessions}
                busy={busy}
                onRollback={(id) => void rollback(id)}
                onRestoreDefaults={() => void restoreDefaults()}
              />
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
        <span className="muted small">{info?.sessionsDir ?? ''}</span>
      </footer>

      {dialog !== null && (
        <PlanDialog
          preset={dialog.preset}
          plan={dialog.plan}
          busy={busy}
          progress={progress}
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
