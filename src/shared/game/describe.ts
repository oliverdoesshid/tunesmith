/** Human-readable labels for a game profile's actions, used by the UI and logs. */
import type { GameProfile } from './types';

const AFFINITY_LABELS: Record<string, string> = {
  'all-cores': 'All cores',
  'physical-cores': 'One thread per physical core',
  'performance-cores': 'Performance cores only',
  'efficiency-cores': 'Efficiency cores only',
  custom: 'Selected cores',
};

export function describeActions(profile: GameProfile): string[] {
  const actions = profile.actions;
  const labels: string[] = [];

  if (actions.affinity !== undefined) {
    labels.push(`Affinity: ${AFFINITY_LABELS[actions.affinity.strategy] ?? actions.affinity.strategy}`);
  }
  if (actions.priority !== undefined) labels.push(`Priority: ${actions.priority}`);
  if (actions.gpuPreference !== undefined) {
    labels.push(actions.gpuPreference === 'high-performance' ? 'GPU: High performance' : 'GPU: Power saving');
  }
  if (actions.flushStandbyMemory === true) labels.push('Memory: purge standby list');
  if (actions.timerHold === true) labels.push('Timer: hold 0.5 ms resolution while playing');

  const rules = actions.backgroundRules ?? [];
  if (rules.length > 0) {
    const suspend = rules.filter((rule) => rule.action === 'suspend').length;
    const eco = rules.filter((rule) => rule.action === 'eco-mode').length;
    const lower = rules.length - suspend - eco;
    const parts: string[] = [];
    if (suspend > 0) parts.push(`${suspend} suspended`);
    if (eco > 0) parts.push(`${eco} efficiency mode`);
    if (lower > 0) parts.push(`${lower} lowered`);
    labels.push(`Background: ${parts.join(', ')}`);
  }

  return labels;
}
