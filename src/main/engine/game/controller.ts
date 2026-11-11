/**
 * The game mode state machine.
 *
 * Lifecycle of one session:
 *
 *   idle ──foreground match──► launching ──applied──► active
 *                                                      │
 *                                    game process gone │  (2 ticks, to ride out a restart)
 *                                                      ▼
 *                                                   restoring ──► idle
 *
 * Two invariants, both learned from the failure modes of this feature:
 *
 *  1. **Durable before mutate.** The session file — which pids are suspended and what
 *     their previous priorities/GPU preference were — is written before anything is
 *     changed. A crash therefore leaves a recovery record, not a frozen browser.
 *  2. **Restore is best-effort and total.** Every step is attempted even if an earlier
 *     one failed, because a partial restore (resumed Chrome but a game-stuck GPU
 *     preference) is worse than a noisy one.
 */
import { computeAffinityMask, isUsableMask, maskToHex } from '../../../shared/game/affinity';
import { selectProfile, type RunningProcess } from '../../../shared/game/matcher';
import { evaluateGameProfile, isBlocked, watchList, type GameFinding } from '../../../shared/game/policy';
import { evaluateGuards, GUARD_DEFAULTS } from '../../../shared/game/telemetry';
import { adaptGameProfile, describeMachine } from '../../../shared/game/adapt';
import type { HardwareSpec } from '../../../shared/types';
import type { AppliedAdjustment,
  GamePackageInfo,
  GameProfileActions,
  GameNetworkApplyResult,
  GameNetworkSnapshot,
  GameNetworkTarget,
  GuardOutcome,
  TelemetrySample,
  CpuTopology,
  GamePriority,
  GameProfile,
  GameSessionView,
  GameStatus,
} from '../../../shared/game/types';
import type { TimerHoldHandle } from '../../platform/game/timer';
import { describeError } from '../../../shared/errors';
import type { PriorityClass } from '../../../shared/types';
import { clampPollMs, GameWatcher, type GameSnapshot, type WatcherOptions } from '../../platform/game/watcher';
import type { LoadedProfiles, StoredGameSession, TrackedProcess } from './store';

export interface ProcessOutcome {
  pid: number;
  ok: boolean;
}

/** Everything the controller needs from the OS. Implemented for tests as a fake. */
export interface GameAdapter {
  topology(): Promise<CpuTopology>;
  applyAffinityAndPriority(
    pid: number,
    maskHex: string,
    priority: GamePriority | null,
    groups?: readonly { index: number; mask: string }[],
  ): Promise<void>;
  readProcessPriority(pid: number): Promise<PriorityClass | null>;
  setProcessPriority(pid: number, priority: PriorityClass): Promise<void>;
  suspendProcesses(pids: readonly number[]): Promise<ProcessOutcome[]>;
  resumeProcesses(pids: readonly number[]): Promise<ProcessOutcome[]>;
  /** EcoQoS is optional so adapters that cannot reach it stay usable. */
  setEcoMode?(pids: readonly number[], enabled: boolean): Promise<ProcessOutcome[]>;
  /** Timer holder is optional for the same reason; absence records a failed adjustment, never a crash. */
  startTimerHold?(): Promise<TimerHoldHandle>;
  purgeStandbyList(): Promise<boolean>;
  readGpuPreference(exePath: string): Promise<string | null>;
  writeGpuPreference(exePath: string, preference: 'high-performance' | 'power-saving'): Promise<void>;
  restoreGpuPreference(exePath: string, previous: string | null): Promise<void>;
  /** Optional so adapters without Store support keep working; absence only skips resolution. */
  resolvePackage?(familyName: string): Promise<GamePackageInfo | null>;
  /** Optional hardware telemetry. When absent, guards are reported as unenforced. */
  readTelemetry?(): Promise<TelemetrySample>;
  /** Optional network controls; absence records a skip, never a crash. */
  inspectNetwork?(pid: number): Promise<GameNetworkTarget[]>;
  captureNetwork?(targets: readonly GameNetworkTarget[]): Promise<GameNetworkSnapshot>;
  applyNetwork?(snapshot: GameNetworkSnapshot, settings: NonNullable<GameProfileActions['network']>): Promise<GameNetworkApplyResult>;
  restoreNetwork?(snapshot: GameNetworkSnapshot): Promise<string[]>;
}

/** The controller only starts, stops and replaces a watcher; tests provide a stub. */
export interface WatcherHandle {
  start(): void;
  stop(): void;
}

/** Narrow seams so the controller can be tested without the filesystem or a child process. */
export interface ProfilesSource {
  load(): Promise<LoadedProfiles>;
}

export interface SessionStore {
  newSessionId(): string;
  save(session: StoredGameSession): Promise<void>;
  pending(): Promise<StoredGameSession[]>;
}

export interface GameControllerDeps {
  adapter: GameAdapter;
  profiles: ProfilesSource;
  sessions: SessionStore;
  pollMs?: number;
  now?: () => string;
  /** Detected hardware, used to adapt a profile to this exact machine. Optional. */
  hardware?: HardwareSpec;
  /** Millisecond clock for telemetry cadence and guard cooldowns; injectable for tests. */
  nowMs?: () => number;
  log?: (line: string) => void;
  onChange?: (status: GameStatus) => void;
  /** Called after each processed watcher tick, for the out-of-process OSD. */
  onSnapshot?: (snapshot: GameSnapshot, status: GameStatus) => void;
  createWatcher?: (options: WatcherOptions) => WatcherHandle;
}

/** Ticks a tracked pid must be missing before a session is torn down. */  const EXIT_TICKS = 2;
  const MAX_SUSPENDED_PER_SESSION = 12;

  /** The optimizer's own process: never a target, even if a profile names it. */
  const SELF_PID: number = typeof process === 'undefined' ? -1 : process.pid;

const PRIORITIES: readonly PriorityClass[] = ['Idle', 'BelowNormal', 'Normal', 'AboveNormal', 'High'];

function isoNow(): string {
  return new Date().toISOString();
}

export class GameController {
  private readonly adapter: GameAdapter;
  private readonly repo: ProfilesSource;
  private readonly sessions: SessionStore;
  private readonly pollMs: number;
  private readonly now: () => string;
  private readonly log: (line: string) => void;
  private onChange: (status: GameStatus) => void;
  private onSnapshot: ((snapshot: GameSnapshot, status: GameStatus) => void) | null;
  private readonly createWatcher: NonNullable<GameControllerDeps['createWatcher']>;

  private profiles: GameProfile[] = [];
  private hardware: HardwareSpec | null;
  private profilingError: string | null = null;
  private topology: CpuTopology | null = null;

  private watching = false;
  private watcherHealthy = false;
  private watcher: WatcherHandle | null = null;

  private phase: GameStatus['phase'] = 'idle';
  private active: StoredGameSession | null = null;
  private pendingRestore: StoredGameSession | null = null;
  /** Live timer holders by session id. Memory-only: a crash loses the handle, which is safe because the holder exits with its parent. */
  private readonly timerHolds = new Map<string, TimerHoldHandle>();
  /** Package family name -> resolved manifest facts, cached for the process lifetime. */
  private readonly packageInfo = new Map<string, GamePackageInfo>();
  private lastError: string | null = null;
  private lastFindings: GameFinding[] = [];

  private telemetry: TelemetrySample | null = null;
  private guardOutcome: GuardOutcome | null = null;
  private lastTelemetryAt = 0;
  private guardCooldownUntil = 0;
  private readonly guardNoted = new Set<string>();
  private readonly clock: () => number;

  private suppressedFor: string | null = null;
  /** When the current suppression ends; Infinity for a policy-blocked profile. */
  private suppressionExpiresAt = Number.POSITIVE_INFINITY;
  private missingTicks = 0;
  private queue: Promise<void> = Promise.resolve();
  private started = false;

  constructor(deps: GameControllerDeps) {
    this.adapter = deps.adapter;
    this.repo = deps.profiles;
    this.sessions = deps.sessions;
    this.pollMs = clampPollMs(deps.pollMs ?? 2_000);
    this.now = deps.now ?? isoNow;
    this.hardware = deps.hardware ?? null;
    this.clock = deps.nowMs ?? (() => Date.now());
    this.log = deps.log ?? (() => {});
    this.onChange = deps.onChange ?? (() => {});
    this.onSnapshot = deps.onSnapshot ?? null;
    this.createWatcher =
      deps.createWatcher ??
      ((options) => new GameWatcher(options));
  }

  /* ---------------------------------------------------------------- *
   * Lifecycle
   * ---------------------------------------------------------------- */

  /** Recover anything a crash left behind. Safe to call once at startup. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.reloadProfiles();

    const pending = await this.sessions.pending();
    for (const session of pending) {
      this.log(`recovering game session ${session.id} (${session.profileName})`);
      const problems = await this.restoreSession(session, { interrupted: true });
      if (problems.length > 0) {
        this.pendingRestore = { ...session, interrupted: true };
        this.lastError = `A previous game session could not be fully restored: ${problems[0]}`;
      }
    }
    this.emit();
  }

  /** Called after first hardware detection so later activations adapt to this machine. */
  setHardware(spec: HardwareSpec | null): void {
    this.hardware = spec;
  }

  async reloadProfiles(): Promise<void> {
    try {
      const loaded = await this.repo.load();
      this.profiles = loaded.profiles;
      this.profilingError = loaded.errors.length > 0 ? loaded.errors.map((e) => `${e.file}: ${e.message}`).join('; ') : null;
      if (this.profilingError !== null) this.log(`game profiles: ${this.profilingError}`);
    } catch (error) {
      this.profiles = [];
      this.profilingError = describeError(error);
    }
  }

  async setWatching(enabled: boolean): Promise<GameStatus> {
    if (enabled === this.watching) return this.status();

    if (!enabled) {
      this.watching = false;
      this.watcher?.stop();
      this.watcher = null;
      this.watcherHealthy = false;
      // Turning game mode off must not leave anything suspended.
      if (this.active !== null) await this.restoreActive('game mode disabled');
      this.emit();
      return this.status();
    }

    if (this.profiles.length === 0) await this.reloadProfiles();
    this.watching = true;

    const resolvedPackages = await this.resolvePackages();
    const watched = new Set(watchList(this.profiles));
    // A Store title may launch an executable whose name is not derivable from the PFN;
    // the manifest gives us the image names, which the watcher can then report.
    for (const pkg of resolvedPackages) {
      for (const executable of pkg.executables) watched.add(executable.toLowerCase());
    }
    const names = [...watched].sort();
    this.watcher = this.createWatcher({
      watchNames: names,
      pollMs: this.pollMs,
      onSnapshot: (snapshot) => this.handleSnapshot(snapshot),
      onStatus: (healthy, error) => {
        this.watcherHealthy = healthy;
        if (error !== null) this.lastError = error;
        this.emit();
      },
      log: this.log,
    });
    this.watcher.start();
    this.log(`watching ${names.length} image name(s) every ${this.pollMs} ms`);
    this.emit();
    return this.status();
  }

  dispose(): void {
    this.watcher?.stop();
    this.watcher = null;
    this.watching = false;
  }

  /* exposed for the profile list in the UI */
  evaluate(profile: GameProfile): GameFinding[] {
    return evaluateGameProfile(profile, this.topology);
  }

  /* ---------------------------------------------------------------- *
   * Driving
   * ---------------------------------------------------------------- */

  /** Serialised so a slow activation can never interleave with the next tick. */
  handleSnapshot(snapshot: GameSnapshot): void {
    this.queue = this.queue
      .then(async () => {
        await this.process(snapshot);
        try {
          this.onSnapshot?.(snapshot, this.status());
        } catch (error) {
          // The OSD is a visual aid; a failure there must not stop the game engine.
          this.log(`snapshot listener failed: ${describeError(error)}`);
        }
      })
      .catch((error) => {
        this.lastError = describeError(error);
        this.log(`tick failed: ${this.lastError}`);
        this.emit();
      });
  }

  /** Await the in-flight tick. Used by tests and by clean shutdown. */
  async settle(): Promise<void> {
    await this.queue;
  }

  private async process(snapshot: GameSnapshot): Promise<void> {
    if (!this.watching) return;

    if (this.active !== null) {
      await this.checkActive(snapshot);
      return;
    }

    const foreground = snapshot.foreground;
    if (foreground === null) return;

    const profile = selectProfile(this.profiles, foreground);
    if (profile === null) {
      this.suppressedFor = null;
      this.suppressionExpiresAt = Number.POSITIVE_INFINITY;
      return;
    }
    if (this.guardCooldownUntil > this.clock()) return;
    if (this.suppressedFor === foreground.exe.toLowerCase()) {
      if (this.clock() < this.suppressionExpiresAt) return;
      // A thermal cool-down has elapsed: the profile may be tried again.
      this.suppressedFor = null;
      this.suppressionExpiresAt = Number.POSITIVE_INFINITY;
    }

    await this.activate(profile, foreground, snapshot);
  }

  private async checkActive(snapshot: GameSnapshot): Promise<void> {
    const session = this.active;
    if (session === null) return;

    await this.checkThermalGuards(session);
    if (this.active === null) return;

    if (session.pid === null) {
      await this.restoreActive('no tracked process');
      return;
    }

    const alive =
      snapshot.running.some((process) => process.pid === session.pid) || snapshot.foreground?.pid === session.pid;

    if (alive) {
      this.missingTicks = 0;
      return;
    }

    this.missingTicks += 1;
    if (this.missingTicks < EXIT_TICKS) return;
    await this.restoreActive('game exited');
  }

  /* ---------------------------------------------------------------- *
   * Activation
   * ---------------------------------------------------------------- */

  private async activate(profile: GameProfile, process: RunningProcess, snapshot: GameSnapshot): Promise<void> {
    const topology = await this.getTopology();
    const findings = evaluateGameProfile(profile, topology);
    this.lastFindings = findings;

    if (isBlocked(findings)) {
      this.suppressedFor = process.exe.toLowerCase();
      this.suppressionExpiresAt = Number.POSITIVE_INFINITY;
      this.phase = 'error';
      this.lastError = findings
        .filter((finding) => finding.severity === 'block')
        .map((finding) => finding.message)
        .join(' ');
      this.log(`refused profile ${profile.id}: ${this.lastError}`);
      this.emit();
      return;
    }

    // Refuse to start aggressive tuning onto a machine that is already over its limit.
    if (profile.guards !== undefined) {
      const outcome = await this.sampleGuards(profile);
      this.lastTelemetryAt = this.clock();
      if (outcome !== null && outcome.status === 'trip') {
        this.guardCooldownUntil = this.clock() + (profile.guards.cooldownSeconds ?? GUARD_DEFAULTS.cooldownSeconds) * 1000;
        this.suppressedFor = process.exe.toLowerCase();
        this.suppressionExpiresAt = this.guardCooldownUntil;
        this.phase = 'error';
        this.lastError = `Refused to tune while a thermal guard is tripped — ${outcome.message}`;
        this.log(this.lastError);
        this.emit();
        return;
      }
    }

    const session: StoredGameSession = {
      schemaVersion: 1,
      id: this.sessions.newSessionId(),
      profileId: profile.id,
      profileName: profile.name,
      exe: process.exe,
      pid: process.pid,
      startedAt: this.now(),
      phase: 'launching',
      processes: [],
      game: { affinityApplied: false, priorityApplied: false },
      adjustments: [],
    };

    this.active = session;
    this.phase = 'launching';
    this.missingTicks = 0;
    await this.sessions.save(session);
    this.emit();

    // Narrow the profile to this machine before touching anything. Every change is
    // recorded in the session so the UI can explain why a rule did not run.
    const machine = describeMachine(this.hardware, topology);
    const adapted = adaptGameProfile(profile, machine);
    for (const change of adapted.changes) {
      this.record(session, {
        kind: 'adaptation',
        target: change.target,
        detail: change.message,
        ok: true,
      });
    }
    if (adapted.changes.length > 0) await this.sessions.save(session);

    await this.applyGpuPreference(session, adapted.actions, process);
    await this.applyNetwork(session, adapted.actions, process);
    await this.applyMemoryFlush(session, adapted.actions);
    await this.applyTimerHold(session, adapted.actions);
    await this.applyProcessChanges(session, adapted.actions, process, snapshot, topology);

    session.phase = 'active';
    await this.sessions.save(session);
    this.phase = 'active';
    this.log(`activated ${profile.id} for ${process.exe} (pid ${process.pid})`);
    this.emit();
  }

  private emit(): void {
    this.onChange(this.status());
  }

  /**
   * Read telemetry and evaluate the active profile's guards.
   *
   * Runs on its own cadence (`sampleSeconds`), not on the watcher tick: a WMI query every
   * two seconds is wasteful, and a guard does not need sub-second reaction time.
   */
  private async checkThermalGuards(session: StoredGameSession): Promise<void> {
    const profile = this.profiles.find((candidate) => candidate.id === session.profileId);
    if (profile?.guards === undefined) return;

    const intervalMs = (profile.guards.sampleSeconds ?? GUARD_DEFAULTS.sampleSeconds) * 1000;
    if (this.clock() - this.lastTelemetryAt < intervalMs) return;
    this.lastTelemetryAt = this.clock();

    const outcome = await this.sampleGuards(profile);
    if (outcome === null) return;

    if (outcome.status === 'trip') {
      this.record(session, {
        kind: 'thermal-guard',
        target: outcome.reason.kind,
        detail: outcome.message,
        ok: false,
        error: outcome.message,
      });
      this.guardCooldownUntil =
        this.clock() + (profile.guards.cooldownSeconds ?? GUARD_DEFAULTS.cooldownSeconds) * 1000;
      this.suppressedFor = session.exe.toLowerCase();
      this.suppressionExpiresAt = this.guardCooldownUntil;
      await this.restoreActive(`thermal guard: ${outcome.message}`);
      this.lastError = `Tuning released by a thermal guard — ${outcome.message}`;
      this.emit();
      return;
    }

    // Unenforced inputs are reported once, not on every sample.
    const note =
      outcome.status === 'unavailable'
        ? { detail: 'Guard not enforced', error: outcome.message }
        : outcome.missing.length > 0
          ? { detail: 'Partly enforced', error: `Unavailable: ${outcome.missing.join(', ')}.` }
          : null;
    if (note === null) return;

    const key = `${session.id}:unavailable`;
    if (this.guardNoted.has(key)) return;
    this.guardNoted.add(key);
    session.adjustments.push({
      kind: 'thermal-guard',
      target: 'telemetry',
      detail: note.detail,
      ok: false,
      error: note.error,
    });
    await this.sessions.save(session);
    this.emit();
  }

  private async sampleGuards(profile: GameProfile): Promise<GuardOutcome | null> {
    const guards = profile.guards;
    if (guards === undefined) return null;

    if (this.adapter.readTelemetry === undefined) {
      this.guardOutcome = {
        status: 'unavailable',
        missing: ['telemetry provider'],
        message: 'This build has no hardware telemetry provider, so guards cannot be enforced.',
      };
      return this.guardOutcome;
    }

    try {
      const sample = await this.adapter.readTelemetry();
      this.telemetry = sample;
      this.guardOutcome = evaluateGuards(guards, sample);
      return this.guardOutcome;
    } catch (error) {
      this.guardOutcome = {
        status: 'unavailable',
        missing: ['telemetry'],
        message: `Hardware telemetry could not be read: ${describeError(error)}`,
      };
      return this.guardOutcome;
    }
  }

  private record(session: StoredGameSession, adjustment: AppliedAdjustment): void {
    session.adjustments.push(adjustment);
    if (!adjustment.ok) this.lastError = `${adjustment.target}: ${adjustment.error ?? 'failed'}`;
  }

  private async applyGpuPreference(
    session: StoredGameSession,
    actions: GameProfileActions,
    process: RunningProcess,
  ): Promise<void> {
    const preference = actions.gpuPreference;
    if (preference === undefined) return;

    // Windows' per-app GPU preference is keyed by executable path and has no equivalent
    // for AppContainer packages. Skipping it is honest; guessing a path is not.
    if (process.packageFamilyName !== undefined && process.packageFamilyName !== null) {
      this.record(session, {
        kind: 'gpu-preference',
        target: process.packageFamilyName,
        detail: 'Skipped',
        ok: false,
        error: 'Windows has no per-app GPU preference for Microsoft Store packages.',
      });
      await this.sessions.save(session);
      return;
    }

    const exePath = process.path ?? null;
    if (exePath === null || !/^[A-Za-z]:\\/.test(exePath)) {
      this.record(session, {
        kind: 'gpu-preference',
        target: process.exe,
        detail: 'Skipped',
        ok: false,
        error: 'The executable path is unavailable, so a per-app GPU preference cannot be written.',
      });
      await this.sessions.save(session);
      return;
    }

    try {
      const previous = await this.adapter.readGpuPreference(exePath);
      session.gpu = { exePath, previous };
      // Persist the previous value before overwriting it.
      await this.sessions.save(session);
      await this.adapter.writeGpuPreference(exePath, preference);
      this.record(session, {
        kind: 'gpu-preference',
        target: exePath,
        detail: preference === 'high-performance' ? 'Windows set to High performance' : 'Windows set to Power saving',
        ok: true,
      });
    } catch (error) {
      this.record(session, {
        kind: 'gpu-preference',
        target: exePath,
        detail: 'Failed',
        ok: false,
        error: describeError(error),
      });
    }
    await this.sessions.save(session);
  }

  private async applyMemoryFlush(session: StoredGameSession, actions: GameProfileActions): Promise<void> {
    if (actions.flushStandbyMemory !== true) return;

    const ok = await this.adapter.purgeStandbyList();
    this.record(session, {
      kind: 'memory-flush',
      target: 'standby list',
      detail: ok ? 'Purged' : 'Not purged',
      ok,
      ...(ok ? {} : { error: 'The purge was refused; it needs administrator rights.' }),
    });
    await this.sessions.save(session);
  }

  private async applyNetwork(
    session: StoredGameSession,
    actions: GameProfileActions,
    process: RunningProcess,
  ): Promise<void> {
    const settings = actions.network;
    if (settings === undefined) return;

    if (
      this.adapter.inspectNetwork === undefined ||
      this.adapter.captureNetwork === undefined ||
      this.adapter.applyNetwork === undefined
    ) {
      this.record(session, {
        kind: 'network',
        target: 'game network route',
        detail: 'Not applied',
        ok: false,
        error: 'Game network control is unavailable in this build.',
      });
      await this.sessions.save(session);
      return;
    }

    try {
      const targets = await this.adapter.inspectNetwork(process.pid);
      if (targets.length === 0) {
        this.record(session, {
          kind: 'network',
          target: 'game network route',
          detail: 'No server interface found',
          ok: false,
          error:
            'No established game server route was found. Connect to a match/server first; TCP tuning is not applied to idle interfaces.',
        });
        await this.sessions.save(session);
        return;
      }

      // Capture first, persist, and only then mutate. A crash after the write therefore
      // always leaves enough information to restore the exact prior values.
      const snapshot = await this.adapter.captureNetwork(targets);
      session.network = snapshot;
      await this.sessions.save(session);

      const result = await this.adapter.applyNetwork(snapshot, settings);
      this.record(session, {
        kind: 'network',
        target: targets.map((target) => target.adapterName).join(', '),
        detail: result.message,
        ok: result.ok,
        ...(result.ok ? {} : { error: result.message }),
      });
    } catch (error) {
      this.record(session, {
        kind: 'network',
        target: 'game network route',
        detail: 'Failed',
        ok: false,
        error: describeError(error),
      });
    }
    await this.sessions.save(session);
  }

  private async applyTimerHold(session: StoredGameSession, actions: GameProfileActions): Promise<void> {
    if (actions.timerHold !== true) return;

    if (this.adapter.startTimerHold === undefined) {
      this.record(session, {
        kind: 'timer-resolution',
        target: 'global timer',
        detail: 'Not held',
        ok: false,
        error: 'The timer holder is not available on this machine.',
      });
      await this.sessions.save(session);
      return;
    }

    try {
      const holder = await this.adapter.startTimerHold();
      this.timerHolds.set(session.id, holder);
      session.timerHeld = true;
      this.record(session, {
        kind: 'timer-resolution',
        target: 'global timer',
        detail: '0.5 ms held while the session is active',
        ok: true,
      });
    } catch (error) {
      this.record(session, {
        kind: 'timer-resolution',
        target: 'global timer',
        detail: 'Not held',
        ok: false,
        error: describeError(error),
      });
    }
    await this.sessions.save(session);
  }

  private async applyProcessChanges(
    session: StoredGameSession,
    actions: GameProfileActions,
    process: RunningProcess,
    snapshot: GameSnapshot,
    topology: CpuTopology,
  ): Promise<void> {
    const wantsAffinity = actions.affinity !== undefined || actions.priority !== undefined;
    if (wantsAffinity) {
      const plan = actions.affinity ?? { strategy: 'all-cores' as const };
      const selection = computeAffinityMask(topology, plan);

      if (!isUsableMask(selection, topology)) {
        this.record(session, { kind: 'affinity', target: process.exe, detail: 'Not applied', ok: false, error: selection.reason });
      } else {
        try {
          await this.adapter.applyAffinityAndPriority(
            process.pid,
            maskToHex(selection.mask),
            actions.priority ?? null,
            selection.groups,
          );
          session.game.affinityApplied = true;
          session.game.priorityApplied = actions.priority !== undefined;
          this.record(session, { kind: 'affinity', target: process.exe, detail: selection.reason, ok: true });
          if (actions.priority !== undefined) {
            this.record(session, {
              kind: 'priority',
              target: process.exe,
              detail: `Priority ${actions.priority}`,
              ok: true,
            });
          }
        } catch (error) {
          this.record(session, { kind: 'affinity', target: process.exe, detail: 'Failed', ok: false, error: describeError(error) });
        }
      }
      await this.sessions.save(session);
    }

    const rules = actions.backgroundRules ?? [];
    if (rules.length === 0) return;

    const planned: { tracked: TrackedProcess; rulePriority: PriorityClass | null }[] = [];
    let suspendBudget = MAX_SUSPENDED_PER_SESSION;

    for (const rule of rules) {
      const targets = snapshot.running.filter(
        (candidate) =>
          candidate.exe.toLowerCase() === rule.process.toLowerCase() &&
          candidate.pid !== process.pid &&
          candidate.pid !== SELF_PID,
      );

      for (const target of targets) {
        if (rule.action === 'suspend' && suspendBudget <= 0) continue;
        const previousPriority = await this.adapter.readProcessPriority(target.pid);
        const suspended = rule.action === 'suspend';
        const ecoMode = rule.action === 'eco-mode';
        if (suspended) suspendBudget -= 1;

        planned.push({
          tracked: {
            pid: target.pid,
            exe: target.exe,
            previousPriority,
            suspended,
            ...(ecoMode ? { ecoMode: true } : {}),
          },
          rulePriority: suspended || ecoMode ? null : (rule.priority ?? 'BelowNormal'),
        });
      }
    }

    if (planned.length === 0) return;

    // Durable before mutate: every pid and its prior state is on disk before the first
    // process is touched, so a crash is recoverable.
    session.processes = planned.map((entry) => entry.tracked);
    await this.sessions.save(session);

    const suspendPids = planned.filter((entry) => entry.tracked.suspended).map((entry) => entry.tracked.pid);
    if (suspendPids.length > 0) {
      const outcomes = await this.adapter.suspendProcesses(suspendPids);
      for (const outcome of outcomes) {
        const entry = planned.find((candidate) => candidate.tracked.pid === outcome.pid);
        if (entry === undefined) continue;
        entry.tracked.suspended = outcome.ok;
        this.record(session, {
          kind: 'background-suspend',
          target: entry.tracked.exe,
          detail: `pid ${entry.tracked.pid}`,
          ok: outcome.ok,
          ...(outcome.ok ? {} : { error: 'The process refused suspension.' }),
        });
      }
      await this.sessions.save(session);
    }

    const ecoPids = planned.filter((entry) => entry.tracked.ecoMode === true).map((entry) => entry.tracked.pid);
    if (ecoPids.length > 0) {
      if (this.adapter.setEcoMode === undefined) {
        for (const entry of planned) {
          if (entry.tracked.ecoMode !== true) continue;
          entry.tracked.ecoMode = false;
          this.record(session, {
            kind: 'background-eco',
            target: entry.tracked.exe,
            detail: `pid ${entry.tracked.pid}`,
            ok: false,
            error: 'Efficiency Mode is not available on this machine.',
          });
        }
      } else {
        const outcomes = await this.adapter.setEcoMode(ecoPids, true);
        for (const outcome of outcomes) {
          const entry = planned.find((candidate) => candidate.tracked.pid === outcome.pid);
          if (entry === undefined) continue;
          entry.tracked.ecoMode = outcome.ok;
          this.record(session, {
            kind: 'background-eco',
            target: entry.tracked.exe,
            detail: `pid ${entry.tracked.pid} · Efficiency Mode on`,
            ok: outcome.ok,
            ...(outcome.ok ? {} : { error: 'Efficiency Mode was refused for this process.' }),
          });
        }
      }
      await this.sessions.save(session);
    }

    for (const entry of planned) {
      if (entry.tracked.suspended || entry.rulePriority === null) continue;
      try {
        await this.adapter.setProcessPriority(entry.tracked.pid, entry.rulePriority);
        this.record(session, {
          kind: 'background-priority',
          target: entry.tracked.exe,
          detail: `pid ${entry.tracked.pid} -> ${entry.rulePriority}`,
          ok: true,
        });
      } catch (error) {
        this.record(session, {
          kind: 'background-priority',
          target: entry.tracked.exe,
          detail: `pid ${entry.tracked.pid}`,
          ok: false,
          error: describeError(error),
        });
      }
    }
    await this.sessions.save(session);
  }

  /* ---------------------------------------------------------------- *
   * Restore
   * ---------------------------------------------------------------- */

  async stopActive(): Promise<GameStatus> {
    await this.restoreActive('requested by user');
    return this.status();
  }

  private async restoreActive(reason: string): Promise<void> {
    const session = this.active;
    if (session === null) return;

    this.phase = 'restoring';
    this.emit();

    const problems = await this.restoreSession(session, { interrupted: false });
    this.active = null;
    this.phase = 'idle';
    this.missingTicks = 0;
    this.lastError = problems.length > 0 ? `Restore was incomplete: ${problems[0]}` : null;
    if (problems.length > 0) this.pendingRestore = { ...session, interrupted: true };
    this.log(`restored ${session.profileId} (${reason})${problems.length > 0 ? ` with ${problems.length} problem(s)` : ''}`);
    this.emit();
  }

  /**
   * Best-effort restore. Never throws: a restore that stops at the first error leaves the
   * machine in the worst possible state.
   */
  private async restoreSession(session: StoredGameSession, options: { interrupted: boolean }): Promise<string[]> {
    const problems: string[] = [];

    const suspended = session.processes.filter((entry) => entry.suspended);
    if (suspended.length > 0) {
      try {
        const outcomes = await this.adapter.resumeProcesses(suspended.map((entry) => entry.pid));
        for (const outcome of outcomes) {
          if (!outcome.ok) problems.push(`could not resume pid ${outcome.pid}`);
        }
      } catch (error) {
        problems.push(`resume failed: ${describeError(error)}`);
      }
    }

    const eco = session.processes.filter((entry) => entry.ecoMode === true);
    if (eco.length > 0) {
      if (this.adapter.setEcoMode === undefined) {
        problems.push('Efficiency Mode could not be switched off: unsupported on this machine.');
      } else {
        try {
          const outcomes = await this.adapter.setEcoMode(
            eco.map((entry) => entry.pid),
            false,
          );
          for (const outcome of outcomes) {
            if (!outcome.ok) problems.push(`could not switch off Efficiency Mode for pid ${outcome.pid}`);
          }
        } catch (error) {
          problems.push(`efficiency-mode restore failed: ${describeError(error)}`);
        }
      }
    }

    for (const entry of session.processes) {
      if (entry.suspended || entry.ecoMode === true || entry.previousPriority === null) continue;
      try {
        await this.adapter.setProcessPriority(entry.pid, entry.previousPriority);
      } catch {
        // The process exited while the game was running. Nothing to restore.
      }
    }

    if (session.timerHeld === true) {
      const holder = this.timerHolds.get(session.id);
      this.timerHolds.delete(session.id);
      if (holder !== undefined) {
        try {
          await holder.stop();
        } catch (error) {
          problems.push(`timer hold: ${describeError(error)}`);
        }
      } else if (!options.interrupted) {
        // A live session always has its handle; only crash recovery may not, and
        // there the holder has already exited with its dead parent.
        problems.push('timer hold: holder handle was lost while the session was live');
      }
      session.timerHeld = false;
    }

    if (session.gpu !== undefined) {
      try {
        await this.adapter.restoreGpuPreference(session.gpu.exePath, session.gpu.previous);
      } catch (error) {
        problems.push(`GPU preference: ${describeError(error)}`);
      }
    }

    if (session.network !== undefined) {
      if (this.adapter.restoreNetwork === undefined) {
        problems.push('network: restore is unavailable in this build');
      } else {
        try {
          problems.push(...(await this.adapter.restoreNetwork(session.network)));
        } catch (error) {
          problems.push(`network restore failed: ${describeError(error)}`);
        }
      }
    }

    session.restoredAt = this.now();
    session.endedAt = session.endedAt ?? session.restoredAt;
    session.phase = 'restored';
    if (options.interrupted) session.interrupted = true;
    try {
      await this.sessions.save(session);
    } catch (error) {
      problems.push(`session file: ${describeError(error)}`);
    }

    return problems;
  }

  /* ---------------------------------------------------------------- *
   * Introspection
   * ---------------------------------------------------------------- */

  /** Resolve every PFN named by a loaded profile. Failures are logged, never fatal. */
  private async resolvePackages(): Promise<GamePackageInfo[]> {
    const wanted = new Set<string>();
    for (const profile of this.profiles) {
      const familyName = profile.trigger.packageFamilyName;
      if (familyName !== undefined) wanted.add(familyName);
    }

    const resolved: GamePackageInfo[] = [];
    for (const familyName of wanted) {
      const cached = this.packageInfo.get(familyName);
      if (cached !== undefined) {
        resolved.push(cached);
        continue;
      }
      if (this.adapter.resolvePackage === undefined) {
        this.log(`package ${familyName}: resolution is unavailable in this build`);
        continue;
      }
      try {
        const info = await this.adapter.resolvePackage(familyName);
        if (info === null) {
          this.log(`package ${familyName} is not installed for this user`);
          continue;
        }
        this.packageInfo.set(familyName, info);
        resolved.push(info);
        this.log(
          `package ${familyName}: ${info.executables.length} executable(s), ${info.capabilities.length} capabilit(ies)`,
        );
      } catch (error) {
        this.log(`package ${familyName}: ${describeError(error)}`);
      }
    }
    return resolved;
  }

  private async getTopology(): Promise<CpuTopology> {
    if (this.topology !== null) return this.topology;
    try {
      this.topology = await this.adapter.topology();
    } catch (error) {
      this.log(`topology unavailable: ${describeError(error)}`);
      this.topology = {
        logicalProcessors: 1,
        physicalCores: 1,
        hybrid: false,
        efficiencyClasses: [0],
        coreIndices: [0],
        source: 'synthetic',
        higherEfficiencyIsFaster: true,
      };
    }
    return this.topology;
  }

  status(): GameStatus {
    return {
      watching: this.watching,
      phase: this.phase,
      watcherHealthy: this.watcherHealthy,
      active: this.active === null ? null : toView(this.active),
      pendingRestore: this.pendingRestore === null ? null : toView(this.pendingRestore),
      lastError: this.lastError ?? this.profilingError,
      topology: this.topology,
      packages: [...this.packageInfo.values()],
      telemetry: this.telemetry,
      guard: this.guardOutcome,
      profiles: this.profiles.length,
      pollMs: this.pollMs,
    };
  }

  /** Replaces the status listener; the main process points this at the window. */
  setOnChange(listener: (status: GameStatus) => void): void {
    this.onChange = listener;
  }

  /** The overlay needs foreground-window geometry, which is not part of GameStatus. */
  setOnSnapshot(listener: ((snapshot: GameSnapshot, status: GameStatus) => void) | null): void {
    this.onSnapshot = listener;
  }

  hasActiveSession(): boolean {
    return this.active !== null;
  }

  /** Stop watching and restore before the app exits. */
  async shutdown(): Promise<void> {
    this.dispose();
    if (this.active !== null) await this.restoreActive('application quit');
  }

  findings(): GameFinding[] {
    return this.lastFindings;
  }

  profileList(): GameProfile[] {
    return this.profiles;
  }
}

function toView(session: StoredGameSession): GameSessionView {
  return {
    id: session.id,
    profileId: session.profileId,
    profileName: session.profileName,
    exe: session.exe,
    pid: session.pid,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    phase: session.phase === 'restored' ? 'idle' : session.phase,
    adjustments: session.adjustments,
    suspended: session.processes.filter((entry) => entry.suspended).map((entry) => ({ pid: entry.pid, process: entry.exe })),
    restoredAt: session.restoredAt,
    interrupted: session.interrupted,
  };
}

export { PRIORITIES };
