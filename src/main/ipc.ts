/**
 * Privileged IPC surface.
 *
 * Every handler:
 *   - rejects messages that did not come from our own renderer
 *   - re-validates its payload with the shared zod schema (never trusts the renderer)
 *   - converts exceptions into `{ ok: false, error }` so a stack trace never crosses
 *     the bridge
 */
import { app, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { describeError, isTuneSmithError, TuneSmithError } from '../shared/errors';
import {
  applyRequestSchema,
  EVENT_CHANNELS,
  gameWatchingRequest,
  IPC_CHANNELS,
  marketInstallRequest,
  marketStatusRequest,
  presetIdRequest,
  sessionIdRequest,
  telemetryConsentRequest,
  type ElevationResult,
  type IpcEnvelope,
  type PresetSummary,
} from '../shared/ipc';
import type { InstallResult, MarketStatus } from '../shared/market/types';
import { describeActions } from '../shared/game/describe';
import type { GameProfileSummary, GameStatus } from '../shared/game/types';
import { compilePlan } from '../shared/preset/compiler';
import type { AppInfo } from '../shared/session';
import type { AppState } from './app-state-types';
import { runPreflight } from './engine/preflight';
import { probeSystemRestore } from './platform/restore-point';
import { isElevated, relaunchElevated } from './runtime';

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? '';
  if (url.startsWith('file://')) return true;
  const devUrl = process.env.TS_DEV_SERVER_URL;
  return devUrl !== undefined && devUrl.length > 0 && url.startsWith(devUrl);
}

function parsePayload<T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: unknown } }, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new TuneSmithError('invalid-request', 'Invalid request payload.');
  return parsed.data as T;
}

export function registerIpcHandlers(state: AppState, getWindow: () => BrowserWindow | null): void {
  // Push game mode transitions to the window as they happen.
  state.game.setOnChange((status: GameStatus) => {
    getWindow()?.webContents.send(EVENT_CHANNELS.gameStatus, status);
  });


  const handle = <T>(channel: string, fn: (...args: unknown[]) => Promise<T>): void => {
    ipcMain.handle(channel, async (event, ...args): Promise<IpcEnvelope<T>> => {
      if (!isTrustedSender(event)) {
        return { ok: false, error: { code: 'invalid-request', message: 'Untrusted IPC sender.' } };
      }
      try {
        return { ok: true, value: await fn(...args) };
      } catch (err) {
        const code = isTuneSmithError(err) ? err.code : 'unexpected-exit';
        const message = describeError(err);
        console.error(`[ipc] ${channel} failed: ${message}`);
        return { ok: false, error: { code, message } };
      }
    });
  };

  handle<AppInfo>(IPC_CHANNELS.appInfo, async () => {
    const loaded = await state.repo.load();
    return {
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? 'unknown',
      platform: process.platform,
      isElevated: await isElevated(),
      devMode: !app.isPackaged,
      sessionsDir: state.sessionsDir,
      presetCount: loaded.presets.length,
    };
  });

  handle<ElevationResult>(IPC_CHANNELS.appElevation, async () => {
    const args = app.isPackaged ? [] : process.argv.slice(1);
    await relaunchElevated(process.execPath, args);
    setTimeout(() => app.quit(), 250);
    return { relaunching: true, detail: 'An elevated instance is starting.' };
  });

  handle(IPC_CHANNELS.hardwareGet, async (force) => state.getSpec(force === true));

  handle<PresetSummary[]>(IPC_CHANNELS.presetsList, async () => {
    const [{ presets }, spec] = await Promise.all([state.repo.load(), state.getSpec()]);

    return presets.map(({ preset, trust, sha256 }) => {
      const plan = compilePlan(preset, spec);
      return {
        id: preset.id,
        name: preset.name,
        version: preset.version,
        description: preset.description,
        risk: preset.risk,
        tags: preset.tags,
        authors: preset.authors.map((a) => a.handle),
        license: preset.license,
        applicable: plan.compatibility.applicable && plan.steps.length > 0,
        matchScore: plan.compatibility.score,
        matchReasons: plan.compatibility.reasons,
        stepCount: plan.steps.length,
        summary: plan.summary,
        blocked: plan.blocked,
        needsConsent: plan.needsConsent,
        blockers: plan.findings.filter((f) => f.severity === 'block').map((f) => f.message),
        consents: plan.findings.filter((f) => f.severity === 'consent').map((f) => f.message),
        warnings: plan.warnings,
        trust,
        sha256,
      };
    });
  });

  handle(IPC_CHANNELS.presetsPlan, async (raw) => {
    const { presetId } = parsePayload<{ presetId: string }>(presetIdRequest, raw);
    const loaded = await state.repo.get(presetId);
    if (loaded === null) throw new TuneSmithError('unavailable', `Preset "${presetId}" was not found.`);
    const spec = await state.getSpec();
    return compilePlan(loaded.preset, spec);
  });

  handle<void>(IPC_CHANNELS.presetsOpenFolder, async () => {
    const error = await shell.openPath(state.presetsDir);
    if (error.length > 0) throw new TuneSmithError('unavailable', `Could not open the preset folder: ${error}`);
  });

  handle<MarketStatus>(IPC_CHANNELS.marketStatus, async (raw) => {
    const parsed =
      raw === undefined
        ? { refresh: false }
        : parsePayload<{ refresh?: boolean }>(marketStatusRequest, raw);
    return state.market.status(parsed.refresh === true);
  });

  handle<InstallResult>(IPC_CHANNELS.marketInstall, async (raw) => {
    const { presetId } = parsePayload<{ presetId: string }>(marketInstallRequest, raw);
    return state.market.install(presetId);
  });

  handle<MarketStatus>(IPC_CHANNELS.marketTelemetryConsent, async (raw) => {
    const { consent } = parsePayload<{ consent: boolean }>(telemetryConsentRequest, raw);
    return state.market.setConsent(consent);
  });

  handle(IPC_CHANNELS.safetyPreflight, async () =>
    runPreflight({
      journal: state.journal,
      getSpec: state.getSpec,
      isElevated: () => isElevated(),
      probeRestore: () => probeSystemRestore(),
      lockHolder: () => state.lock.currentHolder(),
    }),
  );

  handle(IPC_CHANNELS.engineApply, async (raw) => {
    // A game profile and a tuning preset must not touch the machine at the same time.
    if (state.game.hasActiveSession()) {
      throw new TuneSmithError('invalid-request', 'Stop the active game session before applying a preset.');
    }

    const request = parsePayload<{ presetId: string; expectedSignature: string; acknowledgeConsent: boolean; acknowledgeRisk: boolean }>(
      applyRequestSchema,
      raw,
    );

    const spec = await state.getSpec();
    if (spec.signature !== request.expectedSignature) {
      throw new TuneSmithError(
        'invalid-request',
        'Hardware changed since this preset was previewed. Re-open the preset and try again.',
      );
    }

    const loaded = await state.repo.get(request.presetId);
    if (loaded === null) throw new TuneSmithError('unavailable', `Preset "${request.presetId}" was not found.`);

    const plan = compilePlan(loaded.preset, spec);
    state.executor.onProgress = (progress) => {
      getWindow()?.webContents.send(EVENT_CHANNELS.progress, progress);
    };

    const outcome = await state.executor.apply(plan, {
      acknowledgeConsent: request.acknowledgeConsent,
      acknowledgeRisk: request.acknowledgeRisk,
    });

    // Local-only by default; an upload happens only when the user has opted in.
    void state.market.recordEvent(
      plan.presetId,
      plan.presetVersion,
      outcome.status === 'applied' ? 'apply-ok' : 'apply-failed',
    );

    return outcome;
  });

  handle(IPC_CHANNELS.engineSessions, async () => state.journal.summaries());

  handle(IPC_CHANNELS.engineRollback, async (raw) => {
    const { sessionId } = parsePayload<{ sessionId: string }>(sessionIdRequest, raw);
    const before = (await state.journal.summaries()).find((summary) => summary.id === sessionId);
    const report = await state.executor.rollback(sessionId);
    if (report.ok && before?.interrupted === true) {
      void state.market.recordEvent(before.presetId, before.presetVersion, 'session-recovered');
    }
    return report;
  });

  handle(IPC_CHANNELS.engineRestoreDefaults, async () => state.executor.restoreDefaults());

  handle<GameStatus>(IPC_CHANNELS.gameStatus, async () => state.game.status());

  handle<GameStatus>(IPC_CHANNELS.gameSetWatching, async (raw) => {
    const { enabled } = parsePayload<{ enabled: boolean }>(gameWatchingRequest, raw);
    return state.game.setWatching(enabled);
  });

  handle<GameStatus>(IPC_CHANNELS.gameStop, async () => state.game.stopActive());

  handle<GameProfileSummary[]>(IPC_CHANNELS.gameProfiles, async () => {
    state.game.status();
    return state.game.profileList().map((profile) => {
      const findings = state.game.evaluate(profile);
      return {
        id: profile.id,
        name: profile.name,
        version: profile.version,
        description: profile.description,
        risk: profile.risk,
        exe: profile.trigger.exe ?? '',
        packageFamilyName: profile.trigger.packageFamilyName ?? null,
        blocked: findings.some((finding) => finding.severity === 'block'),
        findings: findings.map((finding) => finding.message),
        actions: describeActions(profile),
        notes: profile.notes ?? [],
      };
    });
  });
}
