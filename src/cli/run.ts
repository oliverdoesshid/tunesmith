/**
 * Command runner for the headless CLI.
 *
 * This module owns *policy and presentation*, never system access: every privileged
 * operation arrives through `CliDeps`. That is what lets the CLI be tested against fakes
 * in plain Node while the real entry point wires in the very same `SystemAdapter`,
 * `Executor` and `PresetRepository` the Electron app uses.
 *
 * The CLI adds no capability of its own. If an option is not expressible as a compiled
 * step, the CLI cannot perform it either.
 */
import type { CompiledPlan } from '../shared/preset/compiler';
import { compilePlan } from '../shared/preset/compiler';
import type { LoadResult } from '../shared/preset/loader';
import type {
  ApplyOutcome,
  EngineProgress,
  RollbackReport,
  SessionSummary,
} from '../shared/session';
import type { HardwareSpec } from '../shared/types';
import { parseArgs, usage, type ParsedArgs } from './args';

export const EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  elevation: 3,
  refused: 4,
} as const;

export interface CliStreams {
  out(line: string): void;
  err(line: string): void;
}

export interface ApplyOptions {
  acknowledgeConsent: boolean;
  acknowledgeRisk: boolean;
}

export interface CliDeps {
  version: string;
  loadPresets(): Promise<LoadResult>;
  detect(): Promise<HardwareSpec>;
  isElevated(): Promise<boolean>;
  applyPlan(plan: CompiledPlan, options: ApplyOptions, onProgress: (progress: EngineProgress) => void): Promise<ApplyOutcome>;
  rollback(sessionId: string): Promise<RollbackReport>;
  restoreDefaults(): Promise<RollbackReport[]>;
  sessions(): Promise<SessionSummary[]>;
}

function findingLines(plan: CompiledPlan, severity: 'block' | 'consent' | 'warn'): string[] {
  return plan.findings.filter((finding) => finding.severity === severity).map((finding) => finding.message);
}

function formatStep(step: CompiledPlan['steps'][number]): string[] {
  return [`  [${step.group}] ${step.label}`, `      ${step.target}${step.detail.length > 0 ? ` — ${step.detail}` : ''}`];
}

/** Human-readable plan, used by `--dry-run` and printed before an apply. */
export function formatPlan(plan: CompiledPlan): string[] {
  const lines: string[] = [];
  const counts = Object.entries(plan.summary)
    .filter(([, value]) => value > 0)
    .map(([group, value]) => `${group} ${value}`)
    .join(' · ');

  lines.push(`${plan.presetName} v${plan.presetVersion}  (${plan.presetId})`);
  lines.push(`  risk ${plan.risk} · ${plan.steps.length} step(s)${counts.length > 0 ? `: ${counts}` : ''}`);
  lines.push(`  signature ${plan.signature}`);
  lines.push(`  restore point: ${plan.restorePoint}`);
  if (plan.activeProfiles.length > 0) {
    lines.push(`  profiles: ${plan.activeProfiles.map((profile) => `${profile.name}${profile.conditional ? ' (conditional)' : ''}`).join(', ')}`);
  }
  if (plan.compatibility.reasons.length > 0) {
    lines.push(`  match: ${plan.compatibility.reasons.join('; ')}`);
  }
  if (plan.overrides > 0) {
    lines.push(`  ${plan.overrides} step(s) overridden by a later profile`);
  }

  const warnings = findingLines(plan, 'warn');
  const consents = findingLines(plan, 'consent');
  if (consents.length > 0) {
    lines.push('  needs acknowledgement (--yes):');
    for (const message of consents) lines.push(`    ! ${message}`);
  }
  if (warnings.length > 0) {
    lines.push('  warnings:');
    for (const message of warnings) lines.push(`    - ${message}`);
  }

  if (plan.steps.length > 0) {
    lines.push('  steps:');
    for (const step of plan.steps) lines.push(...formatStep(step));
  }

  return lines;
}

function summariseOutcome(outcome: ApplyOutcome): string[] {
  const lines = [
    `  status: ${outcome.status}`,
    `  applied: ${outcome.appliedSteps}/${outcome.appliedSteps + outcome.skippedSteps} step(s)`,
  ];
  if (outcome.failedStep !== null) lines.push(`  failed at: ${outcome.failedStep.label} — ${outcome.failedStep.error}`);
  if (outcome.restorePoint.attempted) {
    lines.push(`  restore point: ${outcome.restorePoint.ok ? 'created' : `not created (${outcome.restorePoint.detail})`}`);
  }
  lines.push(`  message: ${outcome.message}`);
  return lines;
}

async function runApply(parsed: ParsedArgs, deps: CliDeps, io: CliStreams): Promise<number> {
  if (parsed.presetId === null) {
    io.err('apply needs --preset <id>. Run "presets" to list the installed library.');
    return EXIT.usage;
  }

  const loaded = await deps.loadPresets();
  const entry = loaded.presets.find((candidate) => candidate.preset.id === parsed.presetId);
  if (entry === undefined) {
    const available = loaded.presets.map((candidate) => candidate.preset.id).sort();
    io.err(
      available.length === 0
        ? `No presets could be loaded. Check the preset folder and its index.`
        : `Unknown preset "${parsed.presetId}". Available: ${available.join(', ')}`,
    );
    return EXIT.usage;
  }
  for (const failure of loaded.failures) {
    io.err(`warning: skipped ${failure.file}: ${failure.code} — ${failure.message}`);
  }

  const spec = await deps.detect();
  const plan = compilePlan(entry.preset, spec);

  if (plan.blocked) {
    io.err(`Refused: "${plan.presetName}" is blocked by policy.`);
    for (const message of findingLines(plan, 'block')) io.err(`  - ${message}`);
    return EXIT.refused;
  }
  if (!plan.compatibility.applicable) {
    io.err(`Refused: "${plan.presetName}" does not target this machine (${plan.signature}).`);
    for (const reason of plan.compatibility.reasons) io.err(`  - ${reason}`);
    return EXIT.refused;
  }
  if (plan.steps.length === 0) {
    io.err(`Refused: "${plan.presetName}" produced no actions for this machine.`);
    return EXIT.refused;
  }

  if (parsed.dryRun) {
    if (parsed.json) {
      io.out(
        JSON.stringify(
          {
            command: 'apply',
            dryRun: true,
            presetId: plan.presetId,
            presetName: plan.presetName,
            presetVersion: plan.presetVersion,
            risk: plan.risk,
            signature: plan.signature,
            applicable: plan.compatibility.applicable,
            blocked: plan.blocked,
            needsConsent: plan.needsConsent,
            restorePoint: plan.restorePoint,
            stepCount: plan.steps.length,
            summary: plan.summary,
            findings: plan.findings.map((finding) => ({ severity: finding.severity, message: finding.message })),
            warnings: plan.warnings,
            steps: plan.steps.map((step) => ({
              group: step.group,
              label: step.label,
              target: step.target,
              detail: step.detail,
            })),
          },
          null,
          2,
        ),
      );
      return EXIT.ok;
    }

    for (const line of formatPlan(plan)) io.out(line);
    io.out('');
    io.out('Dry run: nothing was changed. Remove --dry-run to apply.');
    return EXIT.ok;
  }

  // Elevation is checked *after* compilation so `--dry-run` works from any prompt.
  if (!(await deps.isElevated())) {
    io.err('Administrator rights are required to apply a preset.');
    io.err('Open an elevated terminal (or use the desktop app) and run the same command again.');
    return EXIT.elevation;
  }

  if (plan.needsConsent && !parsed.yes) {
    io.err('This preset needs an explicit acknowledgement before it may run. Re-run with --yes.');
    for (const message of findingLines(plan, 'consent')) io.err(`  - ${message}`);
    return EXIT.refused;
  }
  if (plan.risk === 'aggressive' && !parsed.risk) {
    io.err('This is an aggressive preset. Re-run with --risk to acknowledge its blast radius.');
    return EXIT.refused;
  }

  if (!parsed.json) {
    for (const line of formatPlan(plan)) io.out(line);
    io.out('');
  }

  const outcome = await deps.applyPlan(
    plan,
    { acknowledgeConsent: parsed.yes, acknowledgeRisk: parsed.risk },
    (progress) => {
      if (!parsed.json) io.err(`  … ${progress.message}`);
    },
  );

  if (parsed.json) {
    io.out(JSON.stringify({ command: 'apply', dryRun: false, ...outcome }, null, 2));
  } else {
    io.out(outcome.status === 'applied' ? `Applied "${plan.presetName}".` : `Failed: "${plan.presetName}".`);
    for (const line of summariseOutcome(outcome)) io.out(line);
    if (outcome.status === 'applied') {
      io.out('');
      io.out(`Undo with: tunesmith-cli rollback --session ${outcome.sessionId}`);
    }
  }

  return outcome.status === 'applied' ? EXIT.ok : EXIT.failed;
}

async function runPresets(parsed: ParsedArgs, deps: CliDeps, io: CliStreams): Promise<number> {
  const loaded = await deps.loadPresets();
  const spec = await deps.detect();
  const rows = loaded.presets.map((entry) => {
    const plan = compilePlan(entry.preset, spec);
    return {
      id: entry.preset.id,
      name: entry.preset.name,
      version: entry.preset.version,
      risk: entry.preset.risk,
      trust: entry.trust,
      applicable: plan.compatibility.applicable && plan.steps.length > 0,
      blocked: plan.blocked,
      needsConsent: plan.needsConsent,
      stepCount: plan.steps.length,
    };
  });

  if (parsed.json) {
    io.out(JSON.stringify({ command: 'presets', signature: spec.signature, presets: rows, failures: loaded.failures }, null, 2));
    return EXIT.ok;
  }

  io.out(`Presets for ${spec.signature}`);
  for (const row of rows) {
    const state = row.blocked ? 'blocked' : row.applicable ? 'applicable' : 'not applicable';
    io.out(
      `  ${row.id.padEnd(34)} ${row.risk.padEnd(12)} ${state.padEnd(15)} ${String(row.stepCount).padStart(3)} step(s)`,
    );
  }
  if (loaded.failures.length > 0) {
    io.out('');
    io.out(`Skipped ${loaded.failures.length} file(s):`);
    for (const failure of loaded.failures) io.out(`  ${failure.file}: ${failure.code} — ${failure.message}`);
  }
  return EXIT.ok;
}

async function runSessions(parsed: ParsedArgs, deps: CliDeps, io: CliStreams): Promise<number> {
  const sessions = await deps.sessions();
  if (parsed.json) {
    io.out(JSON.stringify({ command: 'sessions', sessions }, null, 2));
    return EXIT.ok;
  }
  if (sessions.length === 0) {
    io.out('No tuning sessions yet.');
    return EXIT.ok;
  }
  for (const session of sessions) {
    io.out(
      `  ${session.id}  ${session.status.padEnd(16)} ${String(session.pendingRollback).padStart(2)} active  ${session.presetName}`,
    );
  }
  return EXIT.ok;
}

async function runRollback(parsed: ParsedArgs, deps: CliDeps, io: CliStreams): Promise<number> {
  if (parsed.sessionId === null) {
    io.err('rollback needs --session <id>. Run "sessions" to list them.');
    return EXIT.usage;
  }
  if (!(await deps.isElevated())) {
    io.err('Administrator rights are required to restore a session.');
    return EXIT.elevation;
  }

  const report = await deps.rollback(parsed.sessionId);
  if (parsed.json) {
    io.out(JSON.stringify({ command: 'rollback', ...report }, null, 2));
  } else {
    io.out(report.message);
    for (const error of report.errors) io.err(`  - ${error}`);
  }
  return report.ok ? EXIT.ok : EXIT.failed;
}

async function runRestore(parsed: ParsedArgs, deps: CliDeps, io: CliStreams): Promise<number> {
  if (!(await deps.isElevated())) {
    io.err('Administrator rights are required to restore changes.');
    return EXIT.elevation;
  }

  const reports = await deps.restoreDefaults();
  const failed = reports.filter((report) => !report.ok);
  const restored = reports.reduce((sum, report) => sum + report.restored, 0);

  if (parsed.json) {
    io.out(JSON.stringify({ command: 'restore', restored, reports }, null, 2));
  } else if (reports.length === 0) {
    io.out('Nothing to restore.');
  } else {
    io.out(`Restored ${restored} change(s) across ${reports.length} session(s).`);
    for (const report of failed) io.err(`  - ${report.sessionId}: ${report.message}`);
  }
  return failed.length === 0 ? EXIT.ok : EXIT.failed;
}

export async function runCli(argv: readonly string[], deps: CliDeps, io: CliStreams): Promise<number> {
  const parsed = parseArgs(argv);

  if (parsed.errors.length > 0) {
    for (const error of parsed.errors) io.err(`error: ${error}`);
    io.err('');
    io.err(usage(deps.version));
    return EXIT.usage;
  }

  switch (parsed.command) {
    case 'help':
      io.out(usage(deps.version));
      return EXIT.ok;
    case 'version':
      io.out(deps.version);
      return EXIT.ok;
    case 'presets':
      return runPresets(parsed, deps, io);
    case 'sessions':
      return runSessions(parsed, deps, io);
    case 'rollback':
      return runRollback(parsed, deps, io);
    case 'restore':
      return runRestore(parsed, deps, io);
    case 'apply':
      return runApply(parsed, deps, io);
  }
}
