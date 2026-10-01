/**
 * Signal scoring (spec 11.7, playbook-signals section 5). Pure functions, no I/O.
 *
 * score  = round(weight x strength x 0.5 ^ (age_days / half_life_days)), clamped 0-100
 * intent = round(100 x (1 - product(1 - s / 100))) over active signals, keeping the strongest
 *          signal per definition key (repeated news about one thing counts once).
 */

const DAY_MS = 86_400_000;

/** Parameters of a signal definition that affect scoring. */
export interface ScoringDefinition {
  weight: number;
  half_life_days: number;
  /** Signals weaker than this (0-1) are stored but score 0. */
  min_strength: number;
}

/** Whole and fractional days between `from` and `now` (never negative). */
export function ageDays(from: Date, now: Date): number {
  return Math.max(0, (now.getTime() - from.getTime()) / DAY_MS);
}

/** Clamps a strength to 0-1 with two decimals (the column is numeric(3,2)); NaN becomes 0. */
export function normalizeStrength(value: number | null | undefined, fallback = 1): number {
  const raw = value ?? fallback;
  if (!Number.isFinite(raw)) return 0;
  return Math.round(Math.min(1, Math.max(0, raw)) * 100) / 100;
}

/** Decayed score 0-100 of one signal (no min_strength check). */
export function decayedScore(input: {
  weight: number;
  strength: number;
  ageDays: number;
  halfLifeDays: number;
}): number {
  const halfLife = input.halfLifeDays > 0 ? input.halfLifeDays : 1;
  const age = Math.max(0, input.ageDays);
  const raw = input.weight * normalizeStrength(input.strength) * 0.5 ** (age / halfLife);
  if (!Number.isFinite(raw)) return 0;
  return Math.min(100, Math.max(0, Math.round(raw)));
}

/** Score of a signal under a definition: 0 below min_strength, else the decayed score. */
export function signalScore(
  definition: ScoringDefinition,
  strength: number,
  signalAgeDays: number,
): number {
  // numeric columns round-trip through floats: compare with a small tolerance.
  if (normalizeStrength(strength) + 1e-9 < definition.min_strength) return 0;
  return decayedScore({
    weight: definition.weight,
    strength,
    ageDays: signalAgeDays,
    halfLifeDays: definition.half_life_days,
  });
}

/** A signal as seen by the intent formula. */
export interface IntentInput {
  definition_key: string;
  score: number;
}

/**
 * Company intent 0-100 (noisy-OR). Only active signals count (score >= 1; callers drop
 * dismissed ones), and only the strongest signal per definition key.
 */
export function intentScore(items: readonly IntentInput[]): number {
  const bestByKey = new Map<string, number>();
  for (const item of items) {
    const score = Math.min(100, Math.max(0, item.score));
    if (score < 1) continue;
    const current = bestByKey.get(item.definition_key) ?? 0;
    if (score > current) bestByKey.set(item.definition_key, score);
  }
  if (bestByKey.size === 0) return 0;
  let remaining = 1;
  for (const score of bestByKey.values()) remaining *= 1 - score / 100;
  return Math.min(100, Math.max(0, Math.round(100 * (1 - remaining))));
}
