/**
 * A/B ranking of one step's variants on the campaign's `ab_test.metric`: each variant's rate
 * gets a Beta posterior (uniform prior, people as trials), and Monte Carlo draws with a fixed
 * seed estimate the probability that each variant is the best. The same counts always give the
 * same leader and confidence. Only variants that were sent are compared, and there is no leader
 * or confidence before every variant has AB_MIN_SENDS sends: with the uniform prior a variant
 * nobody got (or barely got) could otherwise lead with high confidence.
 */

export type AbMetric = "positive_reply_rate" | "reply_rate" | "meeting_rate";

/** Every variant needs this many sends before the comparison counts as enough data. */
export const AB_MIN_SENDS = 50;
/** Monte Carlo draws per comparison. */
export const AB_DRAWS = 10_000;
/** Fixed seed: reports never change between two runs over the same data. */
export const AB_SEED = 0x5eed_ab;

export interface VariantCounts {
  variant: string;
  sent: number;
  /** People who got the variant (the trials). */
  people: number;
  replies: number;
  positive_replies: number;
  meetings: number;
}

export interface AbRanking {
  /** Variant most likely to be the best, or null until `enough_data`. */
  leader: string | null;
  /** Probability (0-1, 2 decimals) that the leader is the best variant; null until `enough_data`. */
  confidence: number | null;
  /** Every variant has at least AB_MIN_SENDS sends. */
  enough_data: boolean;
}

export function successesFor(metric: AbMetric, row: VariantCounts): number {
  if (metric === "reply_rate") return row.replies;
  if (metric === "meeting_rate") return row.meetings;
  return row.positive_replies;
}

/** mulberry32: small, fast and deterministic. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Standard normal (Box-Muller). */
function normal(random: () => number): number {
  let u = 0;
  while (u === 0) u = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

/** Gamma(shape, 1) for shape >= 1 (Marsaglia and Tsang). */
function gamma(shape: number, random: () => number): number {
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normal(random);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = random();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function beta(a: number, b: number, random: () => number): number {
  const x = gamma(a, random);
  return x / (x + gamma(b, random));
}

/** Leader, confidence and enough_data for a step's variants (sorted by key for stability). */
export function rankVariants(
  rows: readonly VariantCounts[],
  metric: AbMetric,
  options: { draws?: number; seed?: number } = {},
): AbRanking {
  const sorted = [...rows].sort((a, b) => a.variant.localeCompare(b.variant));
  const enough = sorted.length >= 2 && sorted.every((row) => row.sent >= AB_MIN_SENDS);
  const variants = sorted.filter((row) => row.sent > 0 && row.people > 0);
  if (!enough || variants.length < 2) {
    return { leader: null, confidence: null, enough_data: enough };
  }
  const params = variants.map((row) => {
    const trials = Math.max(0, row.people);
    const successes = Math.min(Math.max(0, successesFor(metric, row)), trials);
    return { a: 1 + successes, b: 1 + trials - successes, rate: trials ? successes / trials : 0 };
  });
  const draws = Math.max(1, options.draws ?? AB_DRAWS);
  const random = seededRandom(options.seed ?? AB_SEED);
  const wins = variants.map(() => 0);
  for (let draw = 0; draw < draws; draw++) {
    let best = 0;
    let bestValue = -1;
    params.forEach((param, index) => {
      const value = beta(param.a, param.b, random);
      if (value > bestValue) {
        bestValue = value;
        best = index;
      }
    });
    wins[best] = (wins[best] ?? 0) + 1;
  }
  let leader = 0;
  for (let index = 1; index < variants.length; index++) {
    const more = (wins[index] ?? 0) - (wins[leader] ?? 0);
    const better = (params[index]?.rate ?? 0) - (params[leader]?.rate ?? 0);
    if (more > 0 || (more === 0 && better > 0)) leader = index;
  }
  return {
    leader: variants[leader]?.variant ?? null,
    confidence: Math.round(((wins[leader] ?? 0) / draws) * 100) / 100,
    enough_data: enough,
  };
}
