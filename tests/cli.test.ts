import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli/args';
import { EXIT, runCli, type CliDeps, type CliStreams } from '../src/cli/run';
import type { LoadResult } from '../src/shared/preset/loader';
import type { ApplyOutcome, RollbackReport, SessionSummary } from '../src/shared/session';
import { makePreset, makeSpec, TEST_SIGNATURE } from './factories';

const SPEC = makeSpec();

function loadedLibrary(preset = makePreset()): LoadResult {
  return {
    presets: [{ preset, file: `${preset.id}.json`, sha256: 'a'.repeat(64), trust: 'bundled-verified', findings: [] }],
    failures: [],
  };
}

const OUTCOME: ApplyOutcome = {
  sessionId: 'session-1234',
  presetId: 'test-preset',
  status: 'applied',
  appliedSteps: 1,
  skippedSteps: 0,
  failedStep: null,
  autoRolledBack: false,
  restorePoint: { attempted: true, ok: true, detail: 'test checkpoint' },
  message: '1 change(s) applied.',
};

const REPORT: RollbackReport = {
  sessionId: 'session-1234',
  restored: 1,
  failed: 0,
  errors: [],
  ok: true,
  message: 'Restored 1 change(s) to their original values.',
};

const SESSION: SessionSummary = {
  id: 'session-1234',
  createdAt: '2026-01-01T00:00:00.000Z',
  finishedAt: null,
  presetId: 'test-preset',
  presetName: 'Test Preset',
  presetVersion: '1.0.0',
  presetRisk: 'moderate',
  signature: TEST_SIGNATURE,
  status: 'applied',
  restorePoint: { attempted: true, ok: true, detail: 'test' },
  stepCount: 1,
  pendingRollback: 1,
  interrupted: false,
};

interface Harness {
  deps: CliDeps;
  io: CliStreams;
  out: string[];
  err: string[];
  calls: { applied: number; rollbacks: string[]; restored: number };
}

function harness(options: { presetOverrides?: Record<string, unknown>; deps?: Partial<CliDeps> } = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const calls = { applied: 0, rollbacks: [] as string[], restored: 0 };

  const deps: CliDeps = {
    version: '0.1.0',
    loadPresets: async () => loadedLibrary(makePreset(options.presetOverrides ?? {})),
    detect: async () => SPEC,
    isElevated: async () => true,
    applyPlan: async () => {
      calls.applied += 1;
      return OUTCOME;
    },
    rollback: async (sessionId) => {
      calls.rollbacks.push(sessionId);
      return REPORT;
    },
    restoreDefaults: async () => {
      calls.restored += 1;
      return [REPORT];
    },
    sessions: async () => [SESSION],
    ...options.deps,
  };

  return { deps, io: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err, calls };
}

describe('argument parsing', () => {
  it('parses a dry-run apply', () => {
    const parsed = parseArgs(['apply', '--preset', 'competitive-fps-low-latency', '--dry-run']);
    expect(parsed.errors).toEqual([]);
    expect(parsed.command).toBe('apply');
    expect(parsed.presetId).toBe('competitive-fps-low-latency');
    expect(parsed.dryRun).toBe(true);
  });

  it('accepts --option=value', () => {
    const parsed = parseArgs(['apply', '--preset=test-preset']);
    expect(parsed.presetId).toBe('test-preset');
    expect(parsed.errors).toEqual([]);
  });

  it('defaults to help with no arguments', () => {
    expect(parseArgs([]).command).toBe('help');
  });

  it('reports unknown options and commands', () => {
    expect(parseArgs(['apply', '--frobnicate']).errors).toContain('Unknown option "--frobnicate".');
    expect(parseArgs(['explode']).errors[0]).toMatch(/Unknown command/);
  });

  it('rejects a missing value', () => {
    expect(parseArgs(['apply', '--preset']).errors[0]).toMatch(/needs a value/);
  });

  it('rejects a preset id that is not kebab-case', () => {
    // Would otherwise be a path traversal attempt.
    expect(parseArgs(['apply', '--preset', '../../etc/passwd']).errors[0]).toMatch(/not a valid preset id/);
  });

  it('requires an absolute --user-data path', () => {
    expect(parseArgs(['sessions', '--user-data', 'relative/dir']).errors[0]).toMatch(/absolute path/);
    expect(parseArgs(['sessions', '--user-data', 'C:\\data']).userData).toBe('C:\\data');
  });
});

describe('help and version', () => {
  it('prints usage and exits cleanly', async () => {
    const { deps, io, out } = harness();
    expect(await runCli(['help'], deps, io)).toBe(EXIT.ok);
    expect(out.join('\n')).toContain('tunesmith-cli apply --preset');
    expect(out.join('\n')).toContain('Exit codes');
  });

  it('prints the version', async () => {
    const { deps, io, out } = harness();
    expect(await runCli(['--version'], deps, io)).toBe(EXIT.ok);
    expect(out).toEqual(['0.1.0']);
  });

  it('turns usage errors into exit code 2', async () => {
    const { deps, io, err } = harness();
    expect(await runCli(['apply'], deps, io)).toBe(EXIT.usage);
    expect(err.join('\n')).toMatch(/needs --preset/);
  });
});

describe('apply', () => {
  it('compiles the real plan for a dry run and mutates nothing', async () => {
    const { deps, io, out, err, calls } = harness();
    const code = await runCli(['apply', '--preset', 'test-preset', '--dry-run'], deps, io);

    expect(code).toBe(EXIT.ok);
    expect(calls.applied).toBe(0);
    expect(err).toEqual([]);
    const text = out.join('\n');
    expect(text).toContain('Test Preset v1.0.0');
    expect(text).toContain('GameDVR_Enabled');
    expect(text).toContain('Dry run: nothing was changed');
  });

  it('does not need elevation for a dry run', async () => {
    const { deps, io, out } = harness({ deps: { isElevated: async () => false } });
    expect(await runCli(['apply', '--preset', 'test-preset', '--dry-run'], deps, io)).toBe(EXIT.ok);
    expect(out.join('\n')).toContain('Dry run');
  });

  it('refuses to mutate without administrator rights', async () => {
    const { deps, io, err, calls } = harness({ deps: { isElevated: async () => false } });
    const code = await runCli(['apply', '--preset', 'test-preset'], deps, io);

    expect(code).toBe(EXIT.elevation);
    expect(calls.applied).toBe(0);
    expect(err.join('\n')).toMatch(/Administrator rights/);
  });

  it('applies and points at the rollback command', async () => {
    const { deps, io, out, calls } = harness();
    const code = await runCli(['apply', '--preset', 'test-preset'], deps, io);

    expect(code).toBe(EXIT.ok);
    expect(calls.applied).toBe(1);
    expect(out.join('\n')).toContain('rollback --session session-1234');
  });

  it('requires --risk before running an aggressive preset', async () => {
    const { deps, io, err, calls } = harness({ presetOverrides: { risk: 'aggressive' } });

    expect(await runCli(['apply', '--preset', 'test-preset'], deps, io)).toBe(EXIT.refused);
    expect(calls.applied).toBe(0);
    expect(err.join('\n')).toMatch(/aggressive/i);

    expect(await runCli(['apply', '--preset', 'test-preset', '--risk'], deps, io)).toBe(EXIT.ok);
    expect(calls.applied).toBe(1);
  });

  it('refuses a policy-blocked preset instead of compiling it', async () => {
    const blocked = makePreset({
      profiles: [
        {
          id: 'base',
          name: 'Base',
          actions: { services: [{ name: 'WinDefend', startup: 'Disabled' }] },
        },
      ],
    });
    const { deps, io, err, calls } = harness({ deps: { loadPresets: async () => loadedLibrary(blocked) } });

    expect(await runCli(['apply', '--preset', 'test-preset'], deps, io)).toBe(EXIT.refused);
    expect(calls.applied).toBe(0);
    expect(err.join('\n')).toMatch(/blocked by policy/i);
  });

  it('reports an unknown preset with the available ids', async () => {
    const { deps, io, err } = harness();
    expect(await runCli(['apply', '--preset', 'nope-nope'], deps, io)).toBe(EXIT.usage);
    expect(err.join('\n')).toContain('test-preset');
  });

  it('exits 1 when the transaction failed', async () => {
    const failed: ApplyOutcome = {
      ...OUTCOME,
      status: 'failed',
      failedStep: { label: 'Set GameDVR_Enabled', error: 'access denied' },
      autoRolledBack: true,
      message: 'Preset failed and every change was rolled back.',
    };
    const { deps, io, out } = harness({ deps: { applyPlan: async () => failed } });

    expect(await runCli(['apply', '--preset', 'test-preset'], deps, io)).toBe(EXIT.failed);
    expect(out.join('\n')).toContain('access denied');
  });

  it('emits one JSON object for scripting', async () => {
    const { deps, io, out } = harness();
    expect(await runCli(['apply', '--preset', 'test-preset', '--dry-run', '--json'], deps, io)).toBe(EXIT.ok);

    const parsed = JSON.parse(out.join('\n')) as {
      command: string;
      dryRun: boolean;
      stepCount: number;
      blockers?: unknown;
      steps: { target: string }[];
    };
    expect(parsed.command).toBe('apply');
    expect(parsed.dryRun).toBe(true);
    expect(parsed.stepCount).toBeGreaterThan(0);
    expect(parsed.steps.length).toBe(parsed.stepCount);
  });

  it('passes acknowledgements through to the executor', async () => {
    let seen: { acknowledgeConsent: boolean; acknowledgeRisk: boolean } | null = null;
    const { deps, io } = harness({
      presetOverrides: { risk: 'aggressive' },
      deps: {
        applyPlan: async (_plan, options) => {
          seen = options;
          return OUTCOME;
        },
      },
    });

    await runCli(['apply', '--preset', 'test-preset', '--risk', '--yes'], deps, io);
    expect(seen).toEqual({ acknowledgeConsent: true, acknowledgeRisk: true });
  });
});

describe('sessions, rollback and restore', () => {
  it('lists sessions as JSON', async () => {
    const { deps, io, out } = harness();
    expect(await runCli(['sessions', '--json'], deps, io)).toBe(EXIT.ok);
    const parsed = JSON.parse(out.join('\n')) as { sessions: { id: string }[] };
    expect(parsed.sessions[0]?.id).toBe('session-1234');
  });

  it('rolls a session back and requires elevation', async () => {
    const forbidden = harness({ deps: { isElevated: async () => false } });
    expect(await runCli(['rollback', '--session', 'session-1234'], forbidden.deps, forbidden.io)).toBe(EXIT.elevation);
    expect(forbidden.calls.rollbacks).toEqual([]);

    const allowed = harness();
    expect(await runCli(['rollback', '--session', 'session-1234'], allowed.deps, allowed.io)).toBe(EXIT.ok);
    expect(allowed.calls.rollbacks).toEqual(['session-1234']);
  });

  it('requires a session id for rollback', async () => {
    const { deps, io, err } = harness();
    expect(await runCli(['rollback'], deps, io)).toBe(EXIT.usage);
    expect(err.join('\n')).toMatch(/--session/);
  });

  it('restores every pending session', async () => {
    const { deps, io, out, calls } = harness();
    expect(await runCli(['restore'], deps, io)).toBe(EXIT.ok);
    expect(calls.restored).toBe(1);
    expect(out.join('\n')).toContain('Restored 1 change(s)');
  });
});
