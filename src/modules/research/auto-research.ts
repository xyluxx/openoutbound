/**
 * Tiered auto research: when a lead is created with a fit score at or above
 * `settings.data.auto_research_min_fit`, queue research for it. Jobs are per company
 * (singleton key) and delayed a minute, so an import's people at one company share one job.
 */

import type { PersonStatus } from "../../core/enums.js";
import { isOpenOutboundError } from "../../core/errors.js";
import { onEvent } from "../../core/operation.js";
import { parseWorkspaceSettings } from "../../core/settings.js";
import { planResearch } from "./service.js";
import { loadCompany, loadPerson } from "./targets.js";

/** People we never research automatically (they asked not to be contacted). */
const SKIP_STATUSES: PersonStatus[] = ["do_not_contact", "unsubscribed", "bounced", "customer"];

export const autoResearchHandler = onEvent(
  "lead.created",
  "research.auto_research",
  async (ctx, event) => {
    const workspace = ctx.workspace;
    if (!workspace || workspace.status === "archived") return;
    const threshold = parseWorkspaceSettings(workspace.settings).data.auto_research_min_fit;
    const { kind, id } = event.data;

    let fit: number | null;
    if (kind === "person") {
      const loaded = await loadPerson(ctx, id);
      if (!loaded || SKIP_STATUSES.includes(loaded.person.status)) return;
      fit = loaded.person.fit_score;
    } else {
      const company = await loadCompany(ctx, id);
      if (company?.status !== "active") return;
      fit = company.fit_score;
    }
    if (fit === null || fit < threshold) return;

    try {
      await ctx.usage.assertBudget(workspace.id, "ai");
    } catch (error) {
      if (isOpenOutboundError(error) && error.code === "budget_exceeded") {
        ctx.log.info({ lead_id: id }, "auto research skipped: AI budget used up");
        return;
      }
      throw error;
    }
    await planResearch(
      ctx,
      kind === "person" ? { personIds: [id], auto: true } : { companyIds: [id], auto: true },
    );
  },
);
