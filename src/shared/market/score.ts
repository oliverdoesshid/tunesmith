/**
 * Safety score: a transparent, conservative summary — not a security guarantee.
 *
 * The score only ever *lowers* confidence from a neutral base. A brand-new preset with no
 * votes and no telemetry lands in "caution", because "nobody has run this yet" is not
 * evidence of safety. Verification adds the largest single bonus, and crash data can
 * remove it again.
 */
import type { MarketEntry, SafetyScore, TelemetryStats } from './types';

const WEIGHTS = {
  base: 45,
  verified: 25,
  lowRisk: 6,
  aggressiveRisk: -14,
  telemetryCrash: 35,
  telemetryRecovery: 8,
  votes: 12,
} as const;

/** Votes below this are treated as noise rather than a rating. */
const MIN_VOTES = 3;
/** Applies below this are treated as noise rather than a crash rate. */
const MIN_APPLIES = 5;

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function scoreEntry(
  entry: Pick<MarketEntry, 'preset' | 'ratings' | 'sha256'>,
  stats: TelemetryStats | null,
): SafetyScore {
  const reasons: string[] = [];
  let score: number = WEIGHTS.base;

  reasons.push(`Base ${WEIGHTS.base}`);
  reasons.push(`Signature verified +${WEIGHTS.verified}`);
  score += WEIGHTS.verified;

  if (entry.preset.risk === 'conservative') {
    score += WEIGHTS.lowRisk;
    reasons.push(`Conservative preset +${WEIGHTS.lowRisk}`);
  } else if (entry.preset.risk === 'aggressive') {
    score += WEIGHTS.aggressiveRisk;
    reasons.push(`Aggressive preset ${WEIGHTS.aggressiveRisk}`);
  }

  const votes = entry.ratings.up + entry.ratings.down;
  if (votes >= MIN_VOTES) {
    const ratio = entry.ratings.up / votes;
    const delta = Math.round((ratio - 0.5) * 2 * WEIGHTS.votes);
    score += delta;
    reasons.push(`${entry.ratings.up}/${votes} positive votes ${delta >= 0 ? '+' : ''}${delta}`);
  } else {
    reasons.push('No community votes yet');
  }

  if (stats !== null && stats.applies >= MIN_APPLIES) {
    // A 10% crash rate costs 10 points; the cap keeps one bad preset from hitting zero alone.
    score -= Math.min(Math.round(stats.crashRate * 100), WEIGHTS.telemetryCrash);
    reasons.push(`Crash rate ${(stats.crashRate * 100).toFixed(1)}% (${stats.interrupted}/${stats.applies})`);
    if (stats.recovered > 0) {
      score += WEIGHTS.telemetryRecovery;
      reasons.push(`Crash recovery succeeded ${stats.recovered} time(s) +${WEIGHTS.telemetryRecovery}`);
    }
  } else if (stats !== null) {
    reasons.push('Not enough local telemetry yet');
  } else {
    reasons.push('No local telemetry');
  }

  const finalScore = clamp(score);
  const label: SafetyScore['label'] =
    finalScore >= 80 ? 'safe' : finalScore >= 60 ? 'good' : finalScore >= 40 ? 'caution' : 'risky';

  return { score: finalScore, label, reasons };
}
