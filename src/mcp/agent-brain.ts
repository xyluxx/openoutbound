import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { provider_settings } from "../db/schema/index.js";

/**
 * True when any workspace (or the instance) has the agent brain enabled, so the MCP door adds
 * the `agent_brain` toolset (get_agent_tasks, submit_agent_task) automatically. Never throws:
 * a missing table or closed database simply means "no".
 */
export async function agentBrainInUse(db: Db | null | undefined): Promise<boolean> {
  if (!db) return false;
  try {
    const rows = await db
      .select({ id: provider_settings.id })
      .from(provider_settings)
      .where(
        and(
          eq(provider_settings.slot, "brain"),
          eq(provider_settings.provider, "agent"),
          eq(provider_settings.enabled, true),
        ),
      )
      .limit(1);
    return rows.length > 0;
  } catch {
    return false;
  }
}
