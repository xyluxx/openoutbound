/**
 * Deterministic pseudo-random helpers for building the sandbox world. Never use `Math.random`
 * here: every generator takes a seed (or a stable string) so the world is byte-for-byte the
 * same on every process start.
 */

/** 32-bit FNV-1a hash of a string, for turning stable keys into numeric seeds. */
export function hashSeed(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Deterministic ratio in [0, 1) for a string, independent of any Rng instance's state. */
export function hashRatio(input: string): number {
  return hashSeed(input) / 0x100000000;
}

/** True for a `hashRatio(input) < probability` split, e.g. `hashBool("person:pe_1", 0.35)`. */
export function hashBool(input: string, probability: number): boolean {
  return hashRatio(input) < probability;
}

export interface Rng {
  /** Next float in [0, 1). */
  next(): number;
  /** Integer in [min, max], inclusive. */
  int(min: number, max: number): number;
  /** Float in [min, max). */
  float(min: number, max: number): number;
  /** True with the given probability (default 0.5). */
  bool(probability?: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** `n` distinct items (n capped to items.length), order preserved from a shuffle. */
  pickN<T>(items: readonly T[], n: number): T[];
  shuffle<T>(items: readonly T[]): T[];
}

/** mulberry32: tiny, fast, good enough distribution for fake-data generation. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Creates a deterministic Rng from a numeric seed or a stable string (hashed to a seed). */
export function createRng(seed: number | string): Rng {
  const next = mulberry32(typeof seed === "string" ? hashSeed(seed) : seed >>> 0);
  const rng: Rng = {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    float: (min, max) => min + next() * (max - min),
    bool: (probability = 0.5) => next() < probability,
    pick: (items) => {
      if (items.length === 0) throw new RangeError("Rng.pick: empty list");
      return items[Math.floor(next() * items.length)] as (typeof items)[number];
    },
    pickN: (items, n) => rng.shuffle(items).slice(0, Math.max(0, Math.min(n, items.length))),
    shuffle: (items) => {
      const out = items.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const a = out[i] as (typeof out)[number];
        out[i] = out[j] as (typeof out)[number];
        out[j] = a;
      }
      return out;
    },
  };
  return rng;
}
