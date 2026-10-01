/**
 * Sandbox signals provider: returns the world's pre-generated signals for a company (the exact
 * same evidence used to seed the workspace, so re-collecting agrees with what is already there).
 */
import type { RawSignal, SignalProvider, SignalTarget } from "../../providers/types.js";
import { findCompanyByDomain, WORLD } from "../world/index.js";
import { SIGNAL_WEIGHTS } from "../world/signals.js";

export function createSandboxSignals(): SignalProvider {
  return {
    id: "sandbox",
    supportedSignals: Object.keys(SIGNAL_WEIGHTS),
    creditsPerCall: 1,
    async collect(
      target: SignalTarget,
      options: { since?: Date; signalKeys?: string[] } = {},
    ): Promise<RawSignal[]> {
      const domain = target.company.domain;
      const company = domain ? findCompanyByDomain(domain) : null;
      if (!company) return [];
      const world = Object.values(WORLD).find((w) =>
        w.companies.some((c) => c.key === company.key),
      );
      const raws =
        world?.signals.filter((s) => s.companyKey === company.key).map((s) => s.raw) ?? [];
      return raws.filter((raw) => {
        if (options.signalKeys?.length && !options.signalKeys.includes(raw.definition_key))
          return false;
        if (options.since && raw.occurred_at && new Date(raw.occurred_at) < options.since)
          return false;
        return true;
      });
    },
  };
}
