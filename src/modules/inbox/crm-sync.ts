/**
 * CRM sync: pushes an opportunity (its person, company and deal) to every configured `crm`
 * provider while `crm.mode` is `built_in`. `crm_links` maps our ids to the CRM's ids per
 * provider, so re-syncs update the same records instead of creating duplicates. Before a deal
 * is created without a link, the provider is asked for the contact's deal with the same title
 * (it names the opportunity), so a retry after a lost answer never creates a second one; a deal
 * another opportunity links to is never reused. Before a contact is created, it is looked up
 * by email. Creating a person's contact and company, and an opportunity's deal, runs under a
 * lock per record (links read again once it is held), so parallel jobs never create two.
 * `opportunities.crm_refs` keeps provider -> deal id for display.
 *
 * Runs as the `inbox.crm_sync` job (one per opportunity at a time), queued by `crm-events.ts`
 * (live or daily) or on demand with `crm.sync`. A provider the engine gives up on opens one
 * `crm_sync_failed` problem; the next success with that provider resolves it.
 */
import { and, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { type JobContext, type OpContext, requireWorkspace } from "../../core/context.js";
import { isOpenOutboundError, OpenOutboundError } from "../../core/errors.js";
import { failureOf, isRetryable } from "../../core/failures.js";
import { idSchema } from "../../core/ids.js";
import { defineJob, defineOperation, dryRun, dryRunOutput } from "../../core/operation.js";
import { askToChangeSetting, askToChangeSettingAfter } from "../../core/setting-hints.js";
import { parseWorkspaceSettings, type WorkspaceSettings } from "../../core/settings.js";
import {
  type Company,
  crm_links,
  type Opportunity,
  opportunities,
  type Person,
} from "../../db/schema/index.js";
import { displayName } from "../../providers/crm/http.js";
import { crmDealTitle } from "../../providers/crm/labels.js";
import type { CrmProvider } from "../../providers/types.js";
import { withDeferredHealth } from "../../runtime/provider-health.js";
import { openProblem, resolveProblemsFor } from "../problems/service.js";
import { getOpportunity, OPEN_STAGES } from "./opportunities.js";
import { findCompany, findPerson } from "./reply-context.js";

export const CRM_SYNC_JOB = "inbox.crm_sync";
/** Syncs again when the opportunity changed during a sync, at most this many rounds. */
const MAX_ROUNDS = 3;

/** crm_links entity types: our records, plus `activity` (an event already written as a note). */
export type CrmLinkType = "person" | "company" | "opportunity" | "activity";

export type CrmPreferences = WorkspaceSettings["crm"];

/** The workspace's `crm.*` preferences, defaults filled in. */
export function crmPreferences(ctx: Pick<OpContext, "workspace">): CrmPreferences {
  return parseWorkspaceSettings(requireWorkspace(ctx).settings).crm;
}

const CRM_NAMES: Record<string, string> = {
  hubspot: "HubSpot",
  pipedrive: "Pipedrive",
  webhook: "the CRM webhook",
  sandbox: "the sandbox CRM",
};

/** "HubSpot" for `hubspot`; unknown ids stay as they are. */
export function crmDisplayName(provider: string): string {
  return CRM_NAMES[provider] ?? provider;
}

export interface CrmProviderResult {
  provider: string;
  ok: boolean;
  contact_id: string | null;
  company_id: string | null;
  deal_id: string | null;
  /** The deal had no link but was found in the CRM (same contact and title) and updated. */
  reused_deal: boolean;
  error: string | null;
}

export interface CrmSyncResult {
  opportunity_id: string;
  skipped: "not_found" | "no_crm_provider" | "mode_agent" | "mode_off" | null;
  providers: CrmProviderResult[];
  rounds: number;
}

/** The synced fields; a different fingerprint after a sync means it must run again. */
function fingerprint(opportunity: Opportunity): string {
  return JSON.stringify([
    opportunity.stage,
    opportunity.value,
    opportunity.currency,
    opportunity.meeting_at?.getTime() ?? null,
    opportunity.lost_reason,
    opportunity.notes,
    opportunity.closed_at?.getTime() ?? null,
    opportunity.person_id,
    opportunity.company_id,
    opportunity.source_signal_keys,
  ]);
}

/** Known external ids of these records in one CRM, keyed `type:id`. */
export async function readLinks(
  ctx: OpContext,
  provider: string,
  entities: Array<{ type: CrmLinkType; id: string }>,
): Promise<Map<string, string>> {
  const workspace = requireWorkspace(ctx);
  if (entities.length === 0) return new Map();
  const rows = await ctx.db
    .select()
    .from(crm_links)
    .where(
      and(
        eq(crm_links.workspace_id, workspace.id),
        eq(crm_links.provider, provider),
        or(
          ...entities.map((entity) =>
            and(eq(crm_links.entity_type, entity.type), eq(crm_links.entity_id, entity.id)),
          ),
        ),
      ),
    );
  return new Map(rows.map((row) => [`${row.entity_type}:${row.entity_id}`, row.external_id]));
}

/** Stores (or moves) the link of one record in one CRM. */
export async function writeLink(
  ctx: OpContext,
  provider: string,
  type: CrmLinkType,
  entityId: string,
  externalId: string,
): Promise<void> {
  const workspace = requireWorkspace(ctx);
  const now = ctx.clock.now();
  await ctx.db
    .insert(crm_links)
    .values({
      workspace_id: workspace.id,
      provider,
      entity_type: type,
      entity_id: entityId,
      external_id: externalId,
      synced_at: now,
    })
    .onConflictDoUpdate({
      target: [
        crm_links.workspace_id,
        crm_links.provider,
        crm_links.entity_type,
        crm_links.entity_id,
      ],
      set: { external_id: externalId, synced_at: now },
    });
}

/**
 * Retry later (rate limits, timeouts, server errors, unexpected failures) vs. needs a human:
 * the engine's one rule, `isRetryable` from core/failures.
 */
export { isRetryable };

/** True when no retry follows a failure: outside a job, or on the job's last attempt. */
export function isLastAttempt(ctx: OpContext): boolean {
  const job = (ctx as Partial<JobContext>).job;
  return !job || job.attempt >= job.maxAttempts;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const syncProblemKey = (provider: string) => `crm_sync_failed:${provider}`;

/**
 * Opens (or refreshes) the provider's `crm_sync_failed` problem once the engine stopped
 * retrying: a non-retryable error, or retries used up.
 */
export async function openCrmSyncProblem(
  ctx: OpContext,
  provider: string,
  error: unknown,
): Promise<void> {
  const name = crmDisplayName(provider);
  const message = errorMessage(error).trim();
  const failure = failureOf(error);
  await openProblem(ctx, {
    kind: "crm_sync_failed",
    severity: "high",
    owner: "person",
    title: `CRM sync to ${name} is failing`,
    reason: `${name} did not accept the latest sync and the engine stopped retrying it: ${message}`,
    remedy: `Test the connection with manage_providers action test (slot crm, provider ${provider}). Fix the credentials, pipeline or stage ids with manage_providers action set, then push again with manage_crm action sync. ${askToChangeSettingAfter("To stop the engine writing to a CRM (crm.mode agent or off)", { "crm.mode": "agent" })}`,
    data: {
      provider,
      error: message,
      reason: failure?.class ?? null,
      failure,
      status: failure?.upstream_status ?? null,
    },
    dedupeKey: syncProblemKey(provider),
  });
}

/** Resolves the provider's `crm_sync_failed` problem after something worked again. */
export async function resolveCrmSyncProblem(ctx: OpContext, provider: string): Promise<void> {
  await resolveProblemsFor(
    ctx,
    { dedupeKey: syncProblemKey(provider) },
    `A later sync with ${crmDisplayName(provider)} worked.`,
  );
}

/**
 * Runs `fn` alone for one record of one CRM, across every worker: a Postgres advisory lock held
 * for one transaction. `fn` gets a context on that transaction; only its database reads and
 * writes and the CRM calls for that one record belong inside (no events, jobs or problems).
 * Provider health records the outcome of those CRM calls after the transaction ends.
 */
export async function withCrmLock<T>(
  ctx: OpContext,
  key: string,
  fn: (locked: OpContext) => Promise<T>,
): Promise<T> {
  const workspace = requireWorkspace(ctx);
  const lockKey = `crm:${workspace.id}:${key}`;
  return withDeferredHealth(() =>
    ctx.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);
      return fn({ ...ctx, db: tx });
    }),
  );
}

/**
 * Makes sure a person has a contact (and their company a record) in one CRM, and returns the
 * ids. One caller per person and CRM at a time, with the links read again under the lock, so a
 * deal sync and a note job racing for the same new person create one contact, not two.
 * `update: false` leaves a contact the CRM already has untouched.
 */
export async function ensureCrmContact(
  ctx: OpContext,
  crm: CrmProvider,
  person: Person,
  company: Company | null,
  options: { update: boolean },
): Promise<{ contactId: string; companyId?: string; created: boolean }> {
  return withCrmLock(ctx, `${crm.id}:person:${person.id}`, async (locked) => {
    const entities: Array<{ type: CrmLinkType; id: string }> = [{ type: "person", id: person.id }];
    if (company) entities.push({ type: "company", id: company.id });
    const links = await readLinks(locked, crm.id, entities);
    const contactId = links.get(`person:${person.id}`);
    const companyId = company ? links.get(`company:${company.id}`) : undefined;
    if (contactId && !options.update) {
      return { contactId, ...(companyId ? { companyId } : {}), created: false };
    }
    const contact = await upsertPersonToCrm(locked, crm, person, company, {
      contactId,
      companyId,
    });
    return { ...contact, created: !contactId };
  });
}

/** Another opportunity already links to this deal in this CRM. */
async function dealOfAnotherOpportunity(
  ctx: OpContext,
  provider: string,
  dealId: string,
  opportunityId: string,
): Promise<boolean> {
  const workspace = requireWorkspace(ctx);
  const [row] = await ctx.db
    .select({ id: crm_links.entity_id })
    .from(crm_links)
    .where(
      and(
        eq(crm_links.workspace_id, workspace.id),
        eq(crm_links.provider, provider),
        eq(crm_links.entity_type, "opportunity"),
        eq(crm_links.external_id, dealId),
        ne(crm_links.entity_id, opportunityId),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Creates or updates a person (and their company) in one CRM and stores the links. Without a
 * contact link, the CRM is first asked for a contact with the same email, so a retry after a
 * lost answer updates that contact instead of creating another. Callers that may create run it
 * through `ensureCrmContact` (one at a time per person).
 */
export async function upsertPersonToCrm(
  ctx: OpContext,
  crm: CrmProvider,
  person: Person,
  company: Company | null,
  known: { contactId?: string | undefined; companyId?: string | undefined } = {},
): Promise<{ contactId: string; companyId?: string }> {
  let contactId = known.contactId;
  if (!contactId && person.email && crm.findContactByEmail) {
    contactId = (await crm.findContactByEmail(person.email)) ?? undefined;
  }
  const contact = await crm.upsertContact(person, company, {
    contactId,
    companyId: known.companyId,
  });
  await writeLink(ctx, crm.id, "person", person.id, contact.contactId);
  if (company && contact.companyId) {
    await writeLink(ctx, crm.id, "company", company.id, contact.companyId);
  }
  return contact;
}

async function syncWithProvider(
  ctx: OpContext,
  crm: CrmProvider,
  opportunity: Opportunity,
  person: Person | null,
  company: Company | null,
  preferences: CrmPreferences,
): Promise<CrmProviderResult> {
  let contactId: string | undefined;
  let companyId = company
    ? (await readLinks(ctx, crm.id, [{ type: "company", id: company.id }])).get(
        `company:${company.id}`,
      )
    : undefined;
  if (person) {
    const contact = await ensureCrmContact(ctx, crm, person, company, { update: true });
    contactId = contact.contactId;
    if (company && contact.companyId) companyId = contact.companyId;
  }
  const title = crmDealTitle(
    company?.name ?? (person ? displayName(person) : null),
    opportunity.id,
  );
  // One deal per opportunity: the link is read again once the lock is held.
  const { deal, dealId, reused } = await withCrmLock(
    ctx,
    `${crm.id}:opportunity:${opportunity.id}`,
    async (locked) => {
      let dealId = (
        await readLinks(locked, crm.id, [{ type: "opportunity", id: opportunity.id }])
      ).get(`opportunity:${opportunity.id}`);
      let reused = false;
      if (!dealId && contactId && crm.findDealForContact) {
        // The title names this opportunity; a deal another opportunity has is never taken.
        const found = (await crm.findDealForContact(contactId, title)) ?? undefined;
        if (found && !(await dealOfAnotherOpportunity(locked, crm.id, found, opportunity.id))) {
          dealId = found;
          reused = true;
        }
      }
      const deal = await crm.upsertDeal(
        opportunity,
        { contactId, companyId, dealId },
        { title, keepStage: preferences.stage_owner === "crm" },
      );
      await writeLink(locked, crm.id, "opportunity", opportunity.id, deal.dealId);
      if (opportunity.crm_refs[crm.id] !== deal.dealId) {
        // Direct update: no opportunity.updated event, so the sync never triggers itself.
        await locked.db
          .update(opportunities)
          .set({
            crm_refs: sql`${opportunities.crm_refs} || ${JSON.stringify({ [crm.id]: deal.dealId })}::jsonb`,
          })
          .where(eq(opportunities.id, opportunity.id));
      }
      return { deal, dealId, reused };
    },
  );
  return {
    provider: crm.id,
    ok: true,
    contact_id: contactId ?? null,
    company_id: companyId ?? null,
    deal_id: deal.dealId,
    reused_deal: reused && deal.dealId === dealId,
    error: null,
  };
}

/**
 * Syncs one opportunity to every configured CRM (only in `crm.mode` built_in). Failures are
 * reported per provider; throws (so the job retries) when a failure is temporary. Idempotent
 * through crm_links and the deal search.
 */
export async function syncOpportunityToCrm(
  ctx: OpContext,
  opportunityId: string,
): Promise<CrmSyncResult> {
  const preferences = crmPreferences(ctx);
  if (preferences.mode !== "built_in") {
    return {
      opportunity_id: opportunityId,
      skipped: preferences.mode === "agent" ? "mode_agent" : "mode_off",
      providers: [],
      rounds: 0,
    };
  }
  const crms = await ctx.providers.list("crm");
  let opportunity = await getOpportunity(ctx, opportunityId);
  if (!opportunity) {
    return { opportunity_id: opportunityId, skipped: "not_found", providers: [], rounds: 0 };
  }
  if (crms.length === 0) {
    return { opportunity_id: opportunityId, skipped: "no_crm_provider", providers: [], rounds: 0 };
  }

  let results: CrmProviderResult[] = [];
  let rounds = 0;
  while (opportunity && rounds < MAX_ROUNDS) {
    rounds += 1;
    const current: Opportunity = opportunity;
    const person = await findPerson(ctx, current.person_id);
    const company = await findCompany(ctx, current.company_id ?? person?.company_id ?? null);
    const retryable: Array<{ provider: string; error: unknown }> = [];
    results = [];
    for (const crm of crms) {
      try {
        results.push(await syncWithProvider(ctx, crm, current, person, company, preferences));
        await resolveCrmSyncProblem(ctx, crm.id);
      } catch (error) {
        ctx.log.warn(
          { err: error, provider: crm.id, opportunity: current.id },
          "inbox: CRM sync failed",
        );
        if (isRetryable(error)) retryable.push({ provider: crm.id, error });
        else await openCrmSyncProblem(ctx, crm.id, error);
        results.push({
          provider: crm.id,
          ok: false,
          contact_id: null,
          company_id: null,
          deal_id: null,
          reused_deal: false,
          error: errorMessage(error),
        });
      }
    }
    const first = retryable[0];
    if (first) {
      if (isLastAttempt(ctx)) {
        for (const failure of retryable) {
          await openCrmSyncProblem(ctx, failure.provider, failure.error);
        }
      }
      throw isOpenOutboundError(first.error)
        ? first.error
        : new OpenOutboundError("provider_error", "The CRM sync failed; it will retry.", {
            cause: first.error,
          });
    }
    const latest = await getOpportunity(ctx, opportunityId);
    opportunity = latest && fingerprint(latest) !== fingerprint(current) ? latest : null;
  }
  return { opportunity_id: opportunityId, skipped: null, providers: results, rounds };
}

export const crmSyncJob = defineJob({
  name: CRM_SYNC_JOB,
  payload: z.object({ opportunity_id: z.string() }),
  maxAttempts: 6,
  backoff: { type: "exponential", baseMs: 60_000, maxMs: 3_600_000 },
  handler: (ctx, payload) => syncOpportunityToCrm(ctx, payload.opportunity_id),
});

/** Queues one sync of the opportunity (a queued or running one is reused). */
export function enqueueCrmSync(ctx: OpContext, opportunityId: string) {
  return ctx.jobs.enqueue(
    CRM_SYNC_JOB,
    { opportunity_id: opportunityId },
    { singletonKey: `${CRM_SYNC_JOB}:${opportunityId}` },
  );
}

const NO_CRM_HINT =
  "Configure one with manage_providers (action set, slot crm, provider hubspot, pipedrive or webhook), then run providers test.";

/** The refusal for provider pushes while `crm.mode` is agent or off, naming the setting. */
export function crmModeRefusal(mode: "agent" | "off"): OpenOutboundError {
  const agent = mode === "agent";
  return new OpenOutboundError(
    "conflict",
    agent
      ? "The engine does not push to a CRM here: crm.mode is agent, so your agent syncs the CRM with its own tools."
      : "CRM sync is turned off: crm.mode is off.",
    {
      hint: agent
        ? `Sync with your own CRM tools (event_feed action list with consumer "crm", then manage_crm action link). ${askToChangeSettingAfter("To let the engine push through its providers instead", { "crm.mode": "built_in" })}`
        : `${askToChangeSetting({ "crm.mode": "built_in" })} Use "agent" instead of built_in to sync with your own CRM tools.`,
      details: { setting: "crm.mode", value: mode },
    },
  );
}

export const syncCrm = defineOperation({
  id: "crm.sync",
  summary: "Push opportunities to the configured CRM now",
  description:
    "Syncs one opportunity (or every open one, newest first) to the configured CRM providers in the background: contact, company and deal, updated in place on re-runs. Pipeline changes already sync automatically while crm.mode is built_in (live, or once a day with crm.timing daily), so use this after connecting a CRM or fixing its credentials. Refused while crm.mode is agent or off; in agent mode your agent writes to its CRM with its own tools. Use dry_run to see what would be synced.",
  effect: "write",
  input: z.object({
    opportunity_id: idSchema("opp").optional().describe("One opportunity (default: all open ones)"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(100)
      .describe("Max open opportunities when no id is given"),
  }),
  output: z.union([
    z.object({
      providers: z.array(z.string()),
      queued: z.number().int(),
      job_ids: z.array(z.string()).describe("First 20 job ids; check them with get_job"),
    }),
    dryRunOutput(
      z.object({
        providers: z.array(z.string()),
        opportunities: z.number().int(),
        sample: z.array(
          z.object({
            id: z.string(),
            stage: z.string(),
            crm_refs: z.record(z.string(), z.string()),
          }),
        ),
      }),
    ),
  ]),
  http: { method: "POST", path: "/v1/crm/sync" },
  dryRun: "supported",
  idempotent: true,
  workspace: "required",
  examples: [
    { title: "Sync everything open", input: {} },
    { title: "One opportunity", input: { opportunity_id: "opp_01k6a3v0q8x3m2n4p5r6s7t8v9" } },
  ],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const { mode } = crmPreferences(ctx);
    const providers = (await ctx.providers.list("crm")).map((crm) => crm.id);
    let rows: Opportunity[];
    if (input.opportunity_id) {
      const row = await getOpportunity(ctx, input.opportunity_id);
      if (!row) {
        throw new OpenOutboundError("not_found", `Opportunity ${input.opportunity_id} not found.`, {
          hint: "List opportunities with manage_pipeline (action list).",
        });
      }
      rows = [row];
    } else {
      rows = await ctx.db
        .select()
        .from(opportunities)
        .where(
          and(
            eq(opportunities.workspace_id, workspace.id),
            inArray(opportunities.stage, [...OPEN_STAGES]),
          ),
        )
        .orderBy(desc(opportunities.updated_at), desc(opportunities.id))
        .limit(input.limit);
    }
    if (ctx.request.dryRun) {
      const warnings: string[] = [];
      if (mode !== "built_in") {
        const refusal = crmModeRefusal(mode);
        warnings.push(`${refusal.message} ${refusal.hint ?? ""}`.trim());
      } else if (providers.length === 0) {
        warnings.push(`No CRM provider is configured. ${NO_CRM_HINT}`);
      }
      return dryRun(
        {
          providers,
          opportunities: rows.length,
          sample: rows.slice(0, 10).map((row) => ({
            id: row.id,
            stage: row.stage,
            crm_refs: row.crm_refs,
          })),
        },
        { warnings },
      );
    }
    if (mode !== "built_in") throw crmModeRefusal(mode);
    if (providers.length === 0) {
      throw new OpenOutboundError("provider_not_configured", "No CRM provider is configured.", {
        hint: NO_CRM_HINT,
        details: { slot: "crm" },
      });
    }
    const jobIds: string[] = [];
    for (const row of rows) jobIds.push((await enqueueCrmSync(ctx, row.id)).job_id);
    return { providers, queued: jobIds.length, job_ids: jobIds.slice(0, 20) };
  },
});
