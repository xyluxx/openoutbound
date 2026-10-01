import { sql } from "drizzle-orm";
import { askToChangeSetting } from "../../../core/setting-hints.js";
import { parseWorkspaceSettings } from "../../../core/settings.js";
import type { Db } from "../../../db/client.js";
import type { Workspace } from "../../../db/schema/index.js";
import { rows } from "../sql.js";
import type { SetupItem } from "./schema.js";

interface SetupCounts {
  knowledge: number;
  offers: number;
  icps: number;
  senders: number;
  leads: number;
  campaigns: number;
}

/**
 * Setup checklist with the same items, order and counts as the workspace status (get_status):
 * company profile, brain, knowledge, offer, ICP, a sender, leads, a campaign and the postal
 * address for email footers. One query.
 */
export async function setupChecklist(
  db: Db,
  workspace: Pick<Workspace, "id" | "settings">,
  brainConfigured: boolean,
): Promise<{ complete: boolean; done: number; total: number; items: SetupItem[] }> {
  const workspaceId = workspace.id;
  const settings = parseWorkspaceSettings(workspace.settings ?? {});
  const [counts] = await rows<SetupCounts>(
    db,
    sql`select
        (select count(*)::int from knowledge_items k
          where k.workspace_id = ${workspaceId} and k.status = 'active') as knowledge,
        (select count(*)::int from offers o
          where o.workspace_id = ${workspaceId} and o.status = 'active') as offers,
        (select count(*)::int from icps i where i.workspace_id = ${workspaceId}) as icps,
        (select count(*)::int from mailboxes m
          where m.workspace_id = ${workspaceId} and m.status in ('active', 'warming'))
        + (select count(*)::int from linkedin_accounts l
          where l.workspace_id = ${workspaceId} and l.status = 'active') as senders,
        (select count(*)::int from people p where p.workspace_id = ${workspaceId}) as leads,
        (select count(*)::int from campaigns c
          where c.workspace_id = ${workspaceId} and not c.is_template) as campaigns`,
  );
  const c: SetupCounts = counts ?? {
    knowledge: 0,
    offers: 0,
    icps: 0,
    senders: 0,
    leads: 0,
    campaigns: 0,
  };
  const company = settings.company;
  const items: SetupItem[] = [
    {
      key: "company",
      label: "Company profile",
      done: Boolean(company.name && company.website),
      count: company.name && company.website ? 1 : 0,
      hint: askToChangeSetting({
        "company.name": "<company name>",
        "company.website": "https://www.example.com",
        "company.postal_address": "<postal address>",
      }),
    },
    {
      key: "brain",
      label: "AI brain",
      done: brainConfigured,
      count: brainConfigured ? 1 : 0,
      hint: "Configure one with manage_providers (action set, slot brain), or set ANTHROPIC_API_KEY or OPENAI_API_KEY.",
    },
    {
      key: "knowledge",
      label: "Knowledge base",
      done: c.knowledge > 0,
      count: c.knowledge,
      hint: "Draft it from your website with manage_knowledge (action bootstrap_from_website), then review the suggestions.",
    },
    {
      key: "offer",
      label: "Offer",
      done: c.offers > 0,
      count: c.offers,
      hint: "Add what you sell and the call to action with manage_knowledge (action add_offer).",
    },
    {
      key: "icp",
      label: "Ideal customer profile",
      done: c.icps > 0,
      count: c.icps,
      hint: "Describe who you sell to with manage_icp (action create).",
    },
    {
      key: "senders",
      label: "Sender connected",
      done: c.senders > 0,
      count: c.senders,
      hint: "Add a mailbox with manage_mailboxes (action add) or connect LinkedIn with manage_linkedin.",
    },
    {
      key: "leads",
      label: "Leads",
      done: c.leads > 0,
      count: c.leads,
      hint: "Find leads with find_leads or bring your own list with import_leads.",
    },
    {
      key: "campaign",
      label: "Campaign",
      done: c.campaigns > 0,
      count: c.campaigns,
      hint: "Create one with create_campaign, preview it with preview_campaign, then launch_campaign.",
    },
  ];
  const address = company.postal_address.trim();
  items.push({
    key: "postal_address",
    label: "Postal address for email footers",
    done: address !== "",
    count: address !== "" ? 1 : 0,
    hint: `Cold email footers need it. ${askToChangeSetting({ "company.postal_address": "<postal address>" })}`,
  });
  const done = items.filter((item) => item.done).length;
  return { complete: done === items.length, done, total: items.length, items };
}
