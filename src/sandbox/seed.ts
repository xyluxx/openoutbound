/**
 * Turns the sandbox world (src/sandbox/world/**) into rows for one workspace. Inserts are done
 * directly with Drizzle (the sandbox cannot call other modules' operations: they are built in
 * parallel). Idempotent: each collection is only inserted when it is currently empty for the
 * workspace, so re-running without `reset` fills gaps without duplicating; `reset` deletes the
 * workspace first (cascades through every workspace-scoped table) and rebuilds it.
 *
 * Seeding only ever creates, fills in or deletes workspaces marked `is_sandbox`: a real
 * workspace that holds a world's slug is refused with `conflict` before anything changes.
 */
import { and, count, eq } from "drizzle-orm";
import { actorRef, type OpContext } from "../core/context.js";
import { OpenOutboundError } from "../core/errors.js";
import type { WorkspaceSettingsInput } from "../core/settings.js";
import { parseStepConfig } from "../core/settings.js";
import {
  type Company,
  campaign_steps,
  campaigns,
  companies,
  icps,
  knowledge_items,
  linkedin_accounts,
  list_members,
  lists,
  mailboxes,
  messages,
  offers,
  type Person,
  people,
  signals,
  suppressions,
  threads,
  workspaces,
} from "../db/schema/index.js";
import { icpCriteriaSchema, icpScoringSchema } from "../modules/leads/icp/criteria.js";
import { seedPrivacyRequest } from "./privacy-seed.js";
import { countPendingSimulations, type PendingSimulationCounts } from "./simulator/fast-forward.js";
import type { BlueprintCampaign, WorkspaceBlueprint } from "./world/blueprints.js";
import type { WorldCompany, WorldPerson } from "./world/index.js";
import { WORLD, type WorkspaceWorld, worldOfWorkspace } from "./world/index.js";
import { slugify } from "./world/names.js";
import { SIGNAL_WEIGHTS } from "./world/signals.js";

export interface SeedCounts {
  companies: number;
  people: number;
  lists: number;
  list_members: number;
  icps: number;
  knowledge_items: number;
  offers: number;
  signals: number;
  campaigns: number;
  campaign_steps: number;
  mailboxes: number;
  linkedin_accounts: number;
  threads: number;
  messages: number;
  suppressions: number;
}

export interface SeedWorkspaceResult {
  workspace_id: string;
  slug: string;
  name: string;
  /** True when the workspace row itself was created by this call. */
  created: boolean;
  reset: boolean;
  counts: SeedCounts;
  quick_start_prompts: string[];
}

async function rowCount(rows: Promise<Array<{ n: number }>>): Promise<number> {
  const result = await rows;
  return Number(result[0]?.n ?? 0);
}

function toNewCompany(world: WorldCompany, workspaceId: string) {
  return {
    workspace_id: workspaceId,
    name: world.name,
    domain: world.domain,
    website: world.website,
    linkedin_url: world.linkedin_url,
    industry: world.industry,
    description: world.description,
    employee_count: world.employee_count,
    employee_range: world.employee_range,
    founded_year: world.founded_year,
    country: world.country,
    region: world.region,
    city: world.city,
    address: world.address,
    postal_code: world.postal_code,
    phone: world.phone,
    timezone: world.timezone,
    technologies: world.technologies,
    tags: world.tags,
    custom: world.custom,
    source: world.source,
    source_refs: world.source_refs,
    fit_score: world.fit_score,
    fit_reasons: world.fit_reasons,
    intent_score: world.intent_score,
    status: world.status,
  };
}

function toNewPerson(world: WorldPerson, workspaceId: string, companyId: string | null, now: Date) {
  return {
    workspace_id: workspaceId,
    company_id: companyId,
    first_name: world.first_name,
    last_name: world.last_name,
    full_name: world.full_name,
    title: world.title,
    seniority: world.seniority,
    department: world.department,
    email: world.email,
    email_status: world.email_status,
    email_checked_at: world.email ? now : null,
    email_source: world.email_source,
    linkedin_url: world.linkedin_url,
    country: world.country,
    region: world.region,
    city: world.city,
    timezone: world.timezone,
    language: world.language,
    tags: world.tags,
    custom: world.custom,
    source: world.source,
    source_refs: world.source_refs,
    fit_score: world.fit_score,
    fit_reasons: world.fit_reasons,
  };
}

/** Loads seeded companies for a workspace as a domain -> id map (used across "fill missing" runs). */
async function loadCompanyIdsByDomain(
  ctx: OpContext,
  workspaceId: string,
): Promise<Map<string, string>> {
  const rows = await ctx.db.select().from(companies).where(eq(companies.workspace_id, workspaceId));
  const map = new Map<string, string>();
  for (const row of rows) if (row.domain) map.set(row.domain, row.id);
  return map;
}

async function seedCompanies(
  ctx: OpContext,
  workspaceId: string,
  world: WorkspaceWorld,
): Promise<Map<string, string>> {
  const existing = await rowCount(
    ctx.db.select({ n: count() }).from(companies).where(eq(companies.workspace_id, workspaceId)),
  );
  if (existing > 0) return loadCompanyIdsByDomain(ctx, workspaceId);

  const seeded = world.companies.filter((c) => c.seeded);
  const inserted = await ctx.db
    .insert(companies)
    .values(seeded.map((c) => toNewCompany(c, workspaceId)))
    .returning();
  const map = new Map<string, string>();
  inserted.forEach((row, i) => {
    const key = seeded[i]?.key;
    if (key) map.set(key, row.id);
  });
  return map;
}

async function loadPeopleByKey(
  ctx: OpContext,
  workspaceId: string,
  world: WorkspaceWorld,
  companyIds: Map<string, string>,
): Promise<Map<string, Person>> {
  const rows = await ctx.db.select().from(people).where(eq(people.workspace_id, workspaceId));
  const map = new Map<string, Person>();
  // Match rows back to world keys by email when present, else by (company, name).
  const byEmail = new Map(rows.filter((r) => r.email).map((r) => [r.email as string, r]));
  const byNameCompany = new Map(rows.map((r) => [`${r.company_id ?? ""}#${r.full_name ?? ""}`, r]));
  for (const person of world.people.filter((p) => p.seeded)) {
    const row =
      (person.email ? byEmail.get(person.email) : undefined) ??
      byNameCompany.get(`${companyIds.get(person.companyKey) ?? ""}#${person.full_name}`);
    if (row) map.set(person.key, row);
  }
  return map;
}

async function seedPeople(
  ctx: OpContext,
  workspaceId: string,
  world: WorkspaceWorld,
  companyIds: Map<string, string>,
): Promise<Map<string, Person>> {
  const existing = await rowCount(
    ctx.db.select({ n: count() }).from(people).where(eq(people.workspace_id, workspaceId)),
  );
  if (existing > 0) return loadPeopleByKey(ctx, workspaceId, world, companyIds);

  const now = ctx.clock.now();
  const seeded = world.people.filter((p) => p.seeded);
  const inserted = await ctx.db
    .insert(people)
    .values(
      seeded.map((p) => toNewPerson(p, workspaceId, companyIds.get(p.companyKey) ?? null, now)),
    )
    .returning();
  const map = new Map<string, Person>();
  inserted.forEach((row, i) => {
    const key = seeded[i]?.key;
    if (key) map.set(key, row);
  });
  return map;
}

async function seedLists(
  ctx: OpContext,
  workspaceId: string,
  blueprint: WorkspaceBlueprint,
  peopleByKey: Map<string, Person>,
  world: WorkspaceWorld,
): Promise<void> {
  const existing = await rowCount(
    ctx.db.select({ n: count() }).from(lists).where(eq(lists.workspace_id, workspaceId)),
  );
  if (existing > 0) return;

  const seededPeople = world.people.filter((p) => p.seeded);
  for (const list of blueprint.lists) {
    const [row] = await ctx.db
      .insert(lists)
      .values({
        workspace_id: workspaceId,
        name: list.name,
        description: list.description,
        kind: list.kind,
        filter: list.kind === "smart" ? (list.filter ?? {}) : null,
      })
      .returning();
    if (!row) continue;
    if (list.kind === "static" && list.static_member_count) {
      const members = seededPeople.slice(0, list.static_member_count);
      const memberRows = members
        .map((m) => peopleByKey.get(m.key))
        .filter((p): p is Person => Boolean(p))
        .map((person) => ({
          list_id: row.id,
          person_id: person.id,
          added_by: actorRef(ctx.principal),
        }));
      if (memberRows.length > 0) await ctx.db.insert(list_members).values(memberRows);
    }
  }
}

async function seedIcps(
  ctx: OpContext,
  workspaceId: string,
  blueprint: WorkspaceBlueprint,
): Promise<string[]> {
  const existingRows = await ctx.db.select().from(icps).where(eq(icps.workspace_id, workspaceId));
  if (existingRows.length > 0) return existingRows.map((r) => r.id);
  const inserted = await ctx.db
    .insert(icps)
    .values(
      blueprint.icps.map((icp) => ({
        workspace_id: workspaceId,
        name: icp.name,
        description: icp.description,
        // The shape manage_icp action create stores: parsed, defaults filled.
        criteria: icpCriteriaSchema.parse(icp.criteria) as Record<string, unknown>,
        scoring: icpScoringSchema.parse(icp.scoring) as Record<string, unknown>,
        signal_keys: icp.signal_keys,
        is_default: icp.is_default,
      })),
    )
    .returning();
  return inserted.map((r) => r.id);
}

async function seedKnowledge(
  ctx: OpContext,
  workspaceId: string,
  blueprint: WorkspaceBlueprint,
): Promise<number> {
  const existing = await rowCount(
    ctx.db
      .select({ n: count() })
      .from(knowledge_items)
      .where(eq(knowledge_items.workspace_id, workspaceId)),
  );
  if (existing > 0) return existing;
  const inserted = await ctx.db
    .insert(knowledge_items)
    .values(
      blueprint.knowledge.map((item) => ({
        workspace_id: workspaceId,
        kind: item.kind,
        title: item.title,
        body: item.body,
        status: "active" as const,
        source_type: "manual" as const,
      })),
    )
    .returning();
  return inserted.length;
}

async function seedOffers(
  ctx: OpContext,
  workspaceId: string,
  blueprint: WorkspaceBlueprint,
): Promise<string[]> {
  const existingRows = await ctx.db
    .select()
    .from(offers)
    .where(eq(offers.workspace_id, workspaceId));
  if (existingRows.length > 0) return existingRows.map((r) => r.id);
  const inserted = await ctx.db
    .insert(offers)
    .values(
      blueprint.offers.map((offer) => ({
        workspace_id: workspaceId,
        name: offer.name,
        summary: offer.summary,
        details: offer.details,
        value_props: offer.value_props,
        cta: offer.cta,
        booking_url: offer.booking_url,
        is_default: offer.is_default,
      })),
    )
    .returning();
  return inserted.map((r) => r.id);
}

async function seedSignals(
  ctx: OpContext,
  workspaceId: string,
  world: WorkspaceWorld,
  companyIds: Map<string, string>,
): Promise<number> {
  const existing = await rowCount(
    ctx.db.select({ n: count() }).from(signals).where(eq(signals.workspace_id, workspaceId)),
  );
  if (existing > 0) return existing;
  const now = ctx.clock.now();
  const rows = world.signals
    .filter((s) => companyIds.has(s.companyKey))
    .map(({ companyKey, raw }) => {
      const weight = SIGNAL_WEIGHTS[raw.definition_key] ?? 30;
      const strength = raw.strength ?? 1;
      const occurredAt = raw.occurred_at ? new Date(raw.occurred_at) : now;
      return {
        workspace_id: workspaceId,
        definition_key: raw.definition_key,
        company_id: companyIds.get(companyKey) ?? null,
        person_id: null,
        title: raw.title,
        summary: raw.summary ?? null,
        evidence_url: raw.evidence_url,
        evidence_excerpt: raw.evidence_excerpt ?? null,
        source: raw.source,
        occurred_at: occurredAt,
        detected_at: now,
        strength,
        score: Math.round(weight * strength),
        status: "new" as const,
        dedupe_key: `${raw.definition_key}:${raw.evidence_url}`,
        raw: { weight },
      };
    });
  if (rows.length === 0) return 0;
  const inserted = await ctx.db.insert(signals).values(rows).onConflictDoNothing().returning();
  return inserted.length;
}

interface SenderIds {
  mailboxIds: string[];
  linkedinAccountId: string | null;
}

interface SeededMailbox {
  id: string;
  email: string;
}

async function seedMailboxes(
  ctx: OpContext,
  workspaceId: string,
  blueprint: WorkspaceBlueprint,
): Promise<SeededMailbox[]> {
  const existingRows = await ctx.db
    .select()
    .from(mailboxes)
    .where(eq(mailboxes.workspace_id, workspaceId));
  if (existingRows.length > 0) return existingRows.map((r) => ({ id: r.id, email: r.email }));
  const inserted = await ctx.db
    .insert(mailboxes)
    .values(
      blueprint.senders.map((sender) => ({
        workspace_id: workspaceId,
        email: `${slugify(sender.first_name)}@${blueprint.company_domain}`,
        from_name: `${sender.first_name} ${sender.last_name}`,
        provider_label: "sandbox" as const,
        auth_type: "sandbox" as const,
        daily_limit: 40,
        signature: `${sender.first_name} ${sender.last_name}\n${sender.title}, ${blueprint.name.replace(" (sandbox)", "")}`,
        status: "active" as const,
      })),
    )
    .returning();
  return inserted.map((r) => ({ id: r.id, email: r.email }));
}

async function seedLinkedInAccount(
  ctx: OpContext,
  workspaceId: string,
  blueprint: WorkspaceBlueprint,
): Promise<string | null> {
  const existingRows = await ctx.db
    .select()
    .from(linkedin_accounts)
    .where(eq(linkedin_accounts.workspace_id, workspaceId));
  if (existingRows.length > 0) return existingRows[0]?.id ?? null;
  const sender = blueprint.senders[0];
  if (!sender) return null;
  const [row] = await ctx.db
    .insert(linkedin_accounts)
    .values({
      workspace_id: workspaceId,
      provider: "sandbox",
      external_account_id: `sbx_acct_${blueprint.slug}`,
      name: `${sender.first_name} ${sender.last_name}`,
      profile_url: `https://www.linkedin.com/in/${slugify(`${sender.first_name}-${sender.last_name}`)}`,
      status: "active",
      limits: {
        invites_per_day: 15,
        invites_per_week: 80,
        messages_per_day: 40,
        visits_per_day: 60,
        likes_per_day: 30,
        comments_per_day: 10,
      },
      working_hours: { days: [1, 2, 3, 4, 5], start_hour: 9, end_hour: 17 },
      timezone: blueprint.timezone,
      connected_at: ctx.clock.now(),
    })
    .returning();
  return row?.id ?? null;
}

async function seedCampaigns(
  ctx: OpContext,
  workspaceId: string,
  blueprint: WorkspaceBlueprint,
  offerIds: string[],
  icpIds: string[],
  senders: SenderIds,
): Promise<{ campaigns: number; steps: number }> {
  const existing = await rowCount(
    ctx.db.select({ n: count() }).from(campaigns).where(eq(campaigns.workspace_id, workspaceId)),
  );
  if (existing > 0) {
    const stepCount = await rowCount(
      ctx.db
        .select({ n: count() })
        .from(campaign_steps)
        .where(eq(campaign_steps.workspace_id, workspaceId)),
    );
    return { campaigns: existing, steps: stepCount };
  }

  let stepTotal = 0;
  for (const template of blueprint.campaigns) {
    const settings: Record<string, unknown> = {
      senders: {
        mailbox_ids: senders.mailboxIds,
        linkedin_account_ids: senders.linkedinAccountId ? [senders.linkedinAccountId] : [],
      },
      schedule: { timezone: blueprint.timezone },
    };
    const [campaign] = await ctx.db
      .insert(campaigns)
      .values({
        workspace_id: workspaceId,
        name: template.name,
        description: template.description,
        status: "draft",
        goal: template.goal,
        offer_id: offerIds[template.offer_index] ?? null,
        icp_id: icpIds[template.icp_index] ?? null,
        settings,
        is_template: false,
        template_key: slugify(template.name),
        created_by: actorRef(ctx.principal),
      })
      .returning();
    if (!campaign) continue;
    stepTotal += await seedCampaignSteps(ctx, workspaceId, campaign.id, template);
  }
  return { campaigns: blueprint.campaigns.length, steps: stepTotal };
}

async function seedCampaignSteps(
  ctx: OpContext,
  workspaceId: string,
  campaignId: string,
  template: BlueprintCampaign,
): Promise<number> {
  const rows = template.steps.map((step, position) => ({
    campaign_id: campaignId,
    workspace_id: workspaceId,
    position,
    type: step.type,
    delay_days: step.delay_days ?? 0,
    delay_hours: step.delay_hours ?? 0,
    // parseStepConfig both validates against StepConfig and fills defaults for storage.
    config: parseStepConfig(step.type, step.config),
  }));
  if (rows.length === 0) return 0;
  await ctx.db.insert(campaign_steps).values(rows);
  return rows.length;
}

/** Two of the seeded people (with an email) get a matching suppression, for realism. */
async function seedSuppressionsAndThreads(
  ctx: OpContext,
  workspaceId: string,
  blueprint: WorkspaceBlueprint,
  peopleByKey: Map<string, Person>,
  companyIds: Map<string, string>,
  world: WorkspaceWorld,
  mailboxRows: SeededMailbox[],
): Promise<{ suppressions: number; threads: number; messages: number }> {
  const suppressionExisting = await rowCount(
    ctx.db
      .select({ n: count() })
      .from(suppressions)
      .where(eq(suppressions.workspace_id, workspaceId)),
  );
  const threadExisting = await rowCount(
    ctx.db.select({ n: count() }).from(threads).where(eq(threads.workspace_id, workspaceId)),
  );
  if (suppressionExisting > 0 && threadExisting > 0) {
    const messageExisting = await rowCount(
      ctx.db.select({ n: count() }).from(messages).where(eq(messages.workspace_id, workspaceId)),
    );
    return {
      suppressions: suppressionExisting,
      threads: threadExisting,
      messages: messageExisting,
    };
  }

  const withEmail = world.people.filter((p) => p.seeded && p.email && peopleByKey.has(p.key));
  const a = withEmail[Math.min(5, withEmail.length - 1)];
  const b = withEmail[Math.min(12, withEmail.length - 1)];
  let suppressionCount = 0;
  if (suppressionExisting === 0 && withEmail.length >= 2 && a && b) {
    const rowA = peopleByKey.get(a.key);
    const rowB = peopleByKey.get(b.key);
    if (rowA && rowB && rowA.id !== rowB.id) {
      await ctx.db.insert(suppressions).values([
        {
          workspace_id: workspaceId,
          type: "email",
          value: rowA.email as string,
          reason: "unsubscribed",
          source: "sandbox_seed",
          note: "Sandbox fixture: pre-existing unsubscribe.",
        },
        {
          workspace_id: workspaceId,
          type: "person",
          value: rowB.id,
          reason: "do_not_contact",
          source: "sandbox_seed",
          note: "Sandbox fixture: marked do-not-contact.",
        },
      ]);
      await ctx.db.update(people).set({ status: "unsubscribed" }).where(eq(people.id, rowA.id));
      await ctx.db.update(people).set({ status: "do_not_contact" }).where(eq(people.id, rowB.id));
      suppressionCount = 2;
    }
  } else {
    suppressionCount = suppressionExisting;
  }

  let threadCount = 0;
  let messageCount = 0;
  if (threadExisting === 0) {
    // Replies go to these people, so their address must take one: never an address known to be
    // invalid (or a catch-all), and never the people suppressed above.
    const demoPeople = withEmail
      .filter((p) => p.email_status === "valid" || p.email_status === "unknown")
      .filter((p) => p.key !== a?.key && p.key !== b?.key)
      .slice(0, 3);
    const mailbox = mailboxRows[0] ?? null;
    const mailboxId = mailbox?.id ?? null;
    const now = ctx.clock.now();
    const offerLine =
      blueprint.segment === "ecommerce"
        ? "your reorder points for the next few weeks"
        : "keeping the practice stocked without the weekly ordering hassle";
    const scenarios: Array<{
      category: "interested" | "question" | null;
      needsAttention: boolean;
      replyText: string | null;
    }> = [
      {
        category: "interested",
        needsAttention: true,
        replyText:
          blueprint.segment === "ecommerce"
            ? "Thanks for reaching out, this has been a headache this quarter. Can we set up a call this week?"
            : "We've actually been meaning to look at this. Can you send over pricing for a 4-chair practice?",
      },
      {
        category: "question",
        needsAttention: true,
        replyText:
          blueprint.segment === "ecommerce"
            ? "Does this integrate with NetSuite, or only Shopify?"
            : "Do you deliver to our area, and is there a minimum order?",
      },
      { category: null, needsAttention: false, replyText: null },
    ];

    for (let i = 0; i < demoPeople.length; i++) {
      const person = demoPeople[i] as WorldPerson;
      const row = peopleByKey.get(person.key);
      if (!row) continue;
      const company = companyIds.has(person.companyKey) ? row.company_id : null;
      const scenario = scenarios[i] ?? scenarios[scenarios.length - 1];
      const sentAt = new Date(now.getTime() - (3 - i) * 86_400_000);
      const subject =
        blueprint.segment === "ecommerce"
          ? `Quick question about ${person.first_name}'s reorder process`
          : `Quick question for ${person.first_name}`;
      const body = `Hi ${person.first_name}, wanted to ask about ${offerLine}. Worth a quick look?`;

      const [thread] = await ctx.db
        .insert(threads)
        .values({
          workspace_id: workspaceId,
          person_id: row.id,
          company_id: company,
          channel: "email",
          subject,
          mailbox_id: mailboxId,
          status: "open",
          needs_attention: scenario?.needsAttention ?? false,
          category: scenario?.category ?? null,
          sentiment: scenario?.category === "interested" ? "positive" : null,
          last_message_at: sentAt,
          last_inbound_at: scenario?.replyText ? sentAt : null,
        })
        .returning();
      if (!thread) continue;
      threadCount++;

      await ctx.db.insert(messages).values({
        workspace_id: workspaceId,
        thread_id: thread.id,
        person_id: row.id,
        company_id: company,
        channel: "email",
        action: "email",
        direction: "outbound",
        status: "sent",
        subject,
        body_text: body,
        from_address: mailbox?.email ?? null,
        to_address: row.email,
        mailbox_id: mailboxId,
        sent_at: sentAt,
      });
      messageCount++;

      if (scenario?.replyText) {
        const receivedAt = new Date(sentAt.getTime() + 12 * 3_600_000);
        await ctx.db.insert(messages).values({
          workspace_id: workspaceId,
          thread_id: thread.id,
          person_id: row.id,
          company_id: company,
          channel: "email",
          action: "reply",
          direction: "inbound",
          status: "received",
          subject: `Re: ${subject}`,
          body_text: scenario.replyText,
          from_address: row.email,
          to_address: mailbox?.email ?? null,
          mailbox_id: mailboxId,
          received_at: receivedAt,
          classification: {
            category: scenario.category ?? "other",
            confidence: 0.88,
            sentiment: scenario.category === "interested" ? "positive" : "neutral",
          },
        });
        messageCount++;
        await ctx.db
          .update(threads)
          .set({ last_message_at: receivedAt, last_inbound_at: receivedAt })
          .where(eq(threads.id, thread.id));
      }
    }
  } else {
    threadCount = threadExisting;
    messageCount = await rowCount(
      ctx.db.select({ n: count() }).from(messages).where(eq(messages.workspace_id, workspaceId)),
    );
  }

  return { suppressions: suppressionCount, threads: threadCount, messages: messageCount };
}

async function currentCounts(ctx: OpContext, workspaceId: string): Promise<SeedCounts> {
  const c = (rows: Promise<Array<{ n: number }>>) => rowCount(rows);
  return {
    companies: await c(
      ctx.db.select({ n: count() }).from(companies).where(eq(companies.workspace_id, workspaceId)),
    ),
    people: await c(
      ctx.db.select({ n: count() }).from(people).where(eq(people.workspace_id, workspaceId)),
    ),
    lists: await c(
      ctx.db.select({ n: count() }).from(lists).where(eq(lists.workspace_id, workspaceId)),
    ),
    list_members: await c(
      ctx.db
        .select({ n: count() })
        .from(list_members)
        .innerJoin(lists, eq(list_members.list_id, lists.id))
        .where(eq(lists.workspace_id, workspaceId)),
    ),
    icps: await c(
      ctx.db.select({ n: count() }).from(icps).where(eq(icps.workspace_id, workspaceId)),
    ),
    knowledge_items: await c(
      ctx.db
        .select({ n: count() })
        .from(knowledge_items)
        .where(eq(knowledge_items.workspace_id, workspaceId)),
    ),
    offers: await c(
      ctx.db.select({ n: count() }).from(offers).where(eq(offers.workspace_id, workspaceId)),
    ),
    signals: await c(
      ctx.db.select({ n: count() }).from(signals).where(eq(signals.workspace_id, workspaceId)),
    ),
    campaigns: await c(
      ctx.db.select({ n: count() }).from(campaigns).where(eq(campaigns.workspace_id, workspaceId)),
    ),
    campaign_steps: await c(
      ctx.db
        .select({ n: count() })
        .from(campaign_steps)
        .where(eq(campaign_steps.workspace_id, workspaceId)),
    ),
    mailboxes: await c(
      ctx.db.select({ n: count() }).from(mailboxes).where(eq(mailboxes.workspace_id, workspaceId)),
    ),
    linkedin_accounts: await c(
      ctx.db
        .select({ n: count() })
        .from(linkedin_accounts)
        .where(eq(linkedin_accounts.workspace_id, workspaceId)),
    ),
    threads: await c(
      ctx.db.select({ n: count() }).from(threads).where(eq(threads.workspace_id, workspaceId)),
    ),
    messages: await c(
      ctx.db.select({ n: count() }).from(messages).where(eq(messages.workspace_id, workspaceId)),
    ),
    suppressions: await c(
      ctx.db
        .select({ n: count() })
        .from(suppressions)
        .where(eq(suppressions.workspace_id, workspaceId)),
    ),
  };
}

export interface SeedOptions {
  /** Slug of the sandbox workspace. Default: the world's own slug ("northwind", "brightsmile"). */
  slug?: string;
}

function realWorkspaceTaken(slug: string, worldKey: string, name: string): OpenOutboundError {
  return new OpenOutboundError(
    "conflict",
    `A real workspace already uses the slug "${slug}", so the ${name} sandbox cannot use it. The sandbox never changes or deletes a real workspace.`,
    {
      hint: `Seed this practice world under another slug: openoutbound sandbox --world ${worldKey} --slug ${worldKey}-sandbox (MCP: manage_sandbox action seed with world and slug).`,
      details: { field: "slug", slug, world: worldKey },
    },
  );
}

/** The sandbox workspace with `slug`, or null; refuses a real workspace with that slug. */
async function sandboxRowFor(ctx: OpContext, worldKey: string, slug: string) {
  const world = WORLD[worldKey];
  if (!world) throw new Error(`seedWorkspace: unknown sandbox world "${worldKey}"`);
  const [row] = await ctx.db.select().from(workspaces).where(eq(workspaces.slug, slug));
  if (row && !row.is_sandbox) throw realWorkspaceTaken(slug, worldKey, world.blueprint.name);
  return row ?? null;
}

/**
 * Seeds (or fills in) the sandbox workspace of one world (`worldKey`, e.g. "northwind"), under
 * `options.slug` when given. `reset` deletes that sandbox workspace first and rebuilds it from
 * scratch. A real workspace with the slug is refused (`conflict`) and never touched.
 */
export async function seedWorkspace(
  ctx: OpContext,
  worldKey: string,
  reset: boolean,
  options: SeedOptions = {},
): Promise<SeedWorkspaceResult> {
  const world = WORLD[worldKey];
  if (!world) throw new Error(`seedWorkspace: unknown sandbox world "${worldKey}"`);
  const blueprint = world.blueprint;
  const slug = options.slug ?? blueprint.slug;

  const existingRow = await sandboxRowFor(ctx, worldKey, slug);
  let workspaceId = existingRow?.id;
  let created = false;
  const didReset = reset && Boolean(existingRow);

  if (existingRow && reset) {
    // Only ever a sandbox row: the condition holds even if the row changed meanwhile.
    await ctx.db
      .delete(workspaces)
      .where(and(eq(workspaces.id, existingRow.id), eq(workspaces.is_sandbox, true)));
    workspaceId = undefined;
  }

  if (!workspaceId) {
    const settings: WorkspaceSettingsInput = {
      company: {
        name: blueprint.name,
        website: blueprint.company_website,
        sender_company_line: blueprint.company_line,
        postal_address: "123 Placeholder Ave, Austin, TX 78701, US",
      },
    };
    const [row] = await ctx.db
      .insert(workspaces)
      .values({
        slug,
        name: blueprint.name,
        is_sandbox: true,
        timezone: blueprint.timezone,
        settings,
      })
      .returning();
    if (!row) throw new Error(`seedWorkspace: failed to create workspace "${slug}"`);
    workspaceId = row.id;
    created = true;
  }

  const companyIds = await seedCompanies(ctx, workspaceId, world);
  const peopleByKey = await seedPeople(ctx, workspaceId, world, companyIds);
  await seedLists(ctx, workspaceId, blueprint, peopleByKey, world);
  const icpIds = await seedIcps(ctx, workspaceId, blueprint);
  await seedKnowledge(ctx, workspaceId, blueprint);
  const offerIds = await seedOffers(ctx, workspaceId, blueprint);
  await seedSignals(ctx, workspaceId, world, companyIds);
  const mailboxRows = await seedMailboxes(ctx, workspaceId, blueprint);
  const linkedinAccountId = await seedLinkedInAccount(ctx, workspaceId, blueprint);
  await seedCampaigns(ctx, workspaceId, blueprint, offerIds, icpIds, {
    mailboxIds: mailboxRows.map((m) => m.id),
    linkedinAccountId,
  });
  await seedSuppressionsAndThreads(
    ctx,
    workspaceId,
    blueprint,
    peopleByKey,
    companyIds,
    world,
    mailboxRows,
  );
  await seedPrivacyRequest(ctx, { workspaceId, mailbox: mailboxRows[0] ?? null });

  const counts = await currentCounts(ctx, workspaceId);
  return {
    workspace_id: workspaceId,
    slug,
    name: blueprint.name,
    created,
    reset: didReset,
    counts,
    quick_start_prompts: blueprint.quick_start_prompts,
  };
}

/**
 * Seeds every sandbox workspace (northwind, brightsmile), or only `options.world`, optionally
 * under `options.slug` (which needs `world`). Every target is checked before anything changes:
 * when one slug belongs to a real workspace, nothing is seeded.
 */
export async function seedAllSandboxWorkspaces(
  ctx: OpContext,
  reset: boolean,
  options: SeedOptions & { world?: string } = {},
): Promise<SeedWorkspaceResult[]> {
  if (options.slug && !options.world) {
    throw new OpenOutboundError(
      "validation_failed",
      "`slug` names one sandbox workspace, so it needs `world` too.",
      {
        hint: "Pass world (northwind or brightsmile) with slug, e.g. openoutbound sandbox --world northwind --slug northwind-sandbox.",
        details: { field: "world" },
      },
    );
  }
  const worldKeys = options.world ? [options.world] : Object.keys(WORLD);
  const slugOf = (worldKey: string) =>
    (worldKey === options.world ? options.slug : undefined) ?? WORLD[worldKey]?.blueprint.slug;
  for (const worldKey of worldKeys) {
    await sandboxRowFor(ctx, worldKey, slugOf(worldKey) ?? worldKey);
  }
  const results: SeedWorkspaceResult[] = [];
  for (const worldKey of worldKeys) {
    const slug = slugOf(worldKey);
    results.push(await seedWorkspace(ctx, worldKey, reset, slug ? { slug } : {}));
  }
  return results;
}

/** Counts per table for every existing sandbox workspace (sandbox.status). */
export async function sandboxStatus(ctx: OpContext): Promise<
  Array<{
    workspace_id: string;
    slug: string;
    name: string;
    counts: SeedCounts;
    quick_start_prompts: string[];
    pending_simulated_replies: PendingSimulationCounts;
  }>
> {
  const rows = await ctx.db.select().from(workspaces).where(eq(workspaces.is_sandbox, true));
  const out: Array<{
    workspace_id: string;
    slug: string;
    name: string;
    counts: SeedCounts;
    quick_start_prompts: string[];
    pending_simulated_replies: PendingSimulationCounts;
  }> = [];
  for (const row of rows) {
    const world = worldOfWorkspace(row);
    out.push({
      workspace_id: row.id,
      slug: row.slug,
      name: row.name,
      counts: await currentCounts(ctx, row.id),
      quick_start_prompts: world?.blueprint.quick_start_prompts ?? [],
      pending_simulated_replies: await countPendingSimulations(ctx, row.id),
    });
  }
  return out;
}

export type { Company, Person };
