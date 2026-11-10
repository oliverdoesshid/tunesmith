/**
 * Anonymous usage telemetry: local aggregation first, upload only with explicit consent.
 *
 * An event carries a preset identity, the TuneSmith version and an outcome. It carries no
 * hardware signature, no user name, no path, no session id and no free-text field — there
 * is nothing in the schema that could identify a person or a machine.
 */
import type { TelemetryStats } from './types';

export const TELEMETRY_LIMITS = {
  maxEvents: 1_000,
  maxBatch: 50,
} as const;

export type TelemetryKind = 'apply-ok' | 'apply-failed' | 'session-interrupted' | 'session-recovered';

export interface TelemetryEvent {
  /** ISO timestamp; second precision keeps the payload small. */
  at: string;
  presetId: string;
  presetVersion: string;
  appVersion: string;
  kind: TelemetryKind;
}

export const TELEMETRY_KINDS: readonly TelemetryKind[] = [
  'apply-ok',
  'apply-failed',
  'session-interrupted',
  'session-recovered',
];

export function aggregateEvents(events: readonly TelemetryEvent[]): Map<string, TelemetryStats> {
  const byPreset = new Map<string, TelemetryStats>();

  for (const event of events) {
    const stats = byPreset.get(event.presetId) ?? {
      applies: 0,
      failed: 0,
      interrupted: 0,
      recovered: 0,
      crashRate: 0,
      recoveryRate: 0,
    };

    if (event.kind === 'apply-ok' || event.kind === 'apply-failed') stats.applies += 1;
    if (event.kind === 'apply-failed') stats.failed += 1;
    if (event.kind === 'session-interrupted') stats.interrupted += 1;
    if (event.kind === 'session-recovered') stats.recovered += 1;

    byPreset.set(event.presetId, stats);
  }

  for (const stats of byPreset.values()) {
    stats.crashRate = stats.applies > 0 ? stats.interrupted / stats.applies : 0;
    stats.recoveryRate = stats.interrupted > 0 ? stats.recovered / stats.interrupted : 0;
  }

  return byPreset;
}

/** Drops the oldest events first and rejects anything outside the schema. */
export function trimEvents(events: readonly TelemetryEvent[]): TelemetryEvent[] {
  return events.slice(Math.max(0, events.length - TELEMETRY_LIMITS.maxEvents));
}

export function isTelemetryEvent(value: unknown): value is TelemetryEvent {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.at === 'string' &&
    typeof record.presetId === 'string' &&
    typeof record.presetVersion === 'string' &&
    typeof record.appVersion === 'string' &&
    typeof record.kind === 'string' &&
    (TELEMETRY_KINDS as readonly string[]).includes(record.kind)
  );
}
