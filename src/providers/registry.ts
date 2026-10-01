/**
 * Static provider catalog: which provider definitions exist, per slot. Resolution against
 * workspace settings, secrets and env vars (ProviderResolver) lives in the runtime, not here.
 */
import type { ProviderDefinition, Slot } from "./types.js";

export interface ProviderCatalog {
  all(): readonly ProviderDefinition[];
  /** Definitions for a slot, in registration order. */
  bySlot<S extends Slot>(slot: S): ProviderDefinition<S>[];
  find<S extends Slot>(slot: S, id: string): ProviderDefinition<S> | undefined;
  /** Like find, but throws an actionable error listing the known ids. */
  require<S extends Slot>(slot: S, id: string): ProviderDefinition<S>;
}

/** Builds a catalog; throws on duplicate (slot, id) pairs. */
export function createProviderCatalog(definitions: readonly ProviderDefinition[]): ProviderCatalog {
  const byKey = new Map<string, ProviderDefinition>();
  for (const definition of definitions) {
    const key = `${definition.slot}:${definition.id}`;
    if (byKey.has(key))
      throw new Error(`Duplicate provider "${definition.id}" in slot "${definition.slot}"`);
    byKey.set(key, definition);
  }
  const list = [...byKey.values()];
  const catalog: ProviderCatalog = {
    all: () => list,
    bySlot: <S extends Slot>(slot: S) =>
      list.filter((d) => d.slot === slot) as ProviderDefinition<S>[],
    find: <S extends Slot>(slot: S, id: string) =>
      byKey.get(`${slot}:${id}`) as ProviderDefinition<S> | undefined,
    require: <S extends Slot>(slot: S, id: string) => {
      const found = catalog.find(slot, id);
      if (!found) {
        const known = catalog
          .bySlot(slot)
          .map((d) => d.id)
          .join(", ");
        throw new Error(`Unknown ${slot} provider "${id}". Known: ${known || "none"}.`);
      }
      return found;
    },
  };
  return catalog;
}

/** Definitions for one slot from a plain list. */
export function providersForSlot<S extends Slot>(
  definitions: readonly ProviderDefinition[],
  slot: S,
): ProviderDefinition<S>[] {
  return definitions.filter((d) => d.slot === slot) as ProviderDefinition<S>[];
}

/** One definition by slot + id from a plain list. */
export function findProvider<S extends Slot>(
  definitions: readonly ProviderDefinition[],
  slot: S,
  id: string,
): ProviderDefinition<S> | undefined {
  return definitions.find((d) => d.slot === slot && d.id === id) as
    | ProviderDefinition<S>
    | undefined;
}
