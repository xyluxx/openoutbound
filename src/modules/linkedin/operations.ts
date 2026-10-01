/** LinkedIn account and relation operations (MCP tool `manage_linkedin`). */
import { and, asc, eq, gt, inArray, or } from "drizzle-orm";
import { z } from "zod";
import { requireWorkspace } from "../../core/context.js";
import { LINKEDIN_ACCOUNT_STATUSES, LINKEDIN_RELATION_STATUSES } from "../../core/enums.js";
import { invalid, OpenOutboundError } from "../../core/errors.js";
import { idSchema } from "../../core/ids.js";
import {
  defineOperation,
  dryRun,
  dryRunOutput,
  jobHandleOutput,
  paginated,
  paginationInput,
} from "../../core/operation.js";
import { decodeCursor, toPage } from "../../core/pagination.js";
import {
  type LinkedInAccount,
  type LinkedInLimits,
  linkedin_accounts,
  linkedin_relations,
  messages,
  people,
  type WorkingHours,
} from "../../db/schema/index.js";
import { loadWorkspace, providerFor, requireAccount, unscheduleMessages } from "./accounts.js";
import {
  AUTH_LINK_TTL_MS,
  activate,
  encodeAuthState,
  LINKED_ELSEWHERE_REASON,
  linkedElsewhere,
} from "./hosted-auth.js";
import {
  type ActionLimits,
  DEFAULT_LINKEDIN_RAMP,
  DEFAULT_WORKING_HOURS,
  limitWarnings,
  MAX_LINKEDIN_LIMITS,
} from "./limits.js";
import { accountOutput, relationOutput, toAccountOutput } from "./outputs.js";
import { resolveAccountDown } from "./send-problems.js";
import { requeueApproved } from "./service.js";
import { resolveAccountReadDown } from "./sync.js";
import { dayKey, isValidTimezone } from "./time.js";
import { WEBHOOK_SECRET_ENV, WEBHOOK_SECRET_HEADER } from "./webhook.js";

const accountId = idSchema("lia").describe("LinkedIn account id (lia_...)");

const limitField = (key: keyof ActionLimits, label: string) =>
  z
    .number()
    .int()
    .min(0)
    .max(MAX_LINKEDIN_LIMITS[key])
    .optional()
    .describe(`${label} (0 disables the action)`);

const limitsInput = z
  .object({
    invites_per_day: limitField("invites_per_day", "Invitations per day, default 15"),
    invites_per_week: limitField("invites_per_week", "Invitations per rolling 7 days, default 80"),
    messages_per_day: limitField("messages_per_day", "Messages per day, default 40"),
    visits_per_day: limitField("visits_per_day", "Profile visits per day, default 60"),
    likes_per_day: limitField("likes_per_day", "Likes per day, default 30"),
    comments_per_day: limitField("comments_per_day", "Comments per day, default 10"),
    invite_notes_per_month: z
      .number()
      .int()
      .min(0)
      .max(MAX_LINKEDIN_LIMITS.invite_notes_per_month)
      .nullable()
      .optional()
      .describe(
        "Invitation notes per calendar month (null = unlimited). Default 3 for free accounts, unlimited for premium; when used up, invites go out without a note",
      ),
  })
  .describe("Per-account caps. Lowering is always safe; raising above defaults returns warnings.");

const workingHoursInput = z
  .object({
    days: z
      .array(z.number().int().min(1).max(7))
      .min(1)
      .optional()
      .describe("ISO weekdays, 1 = Monday. Default Monday to Friday"),
    start_hour: z.number().int().min(0).max(23).optional().describe("Default 9"),
    end_hour: z.number().int().min(1).max(24).optional().describe("Default 18"),
  })
  .describe("Working hours in the account timezone");

function checkTimezone(timezone: string | undefined): void {
  if (timezone !== undefined && !isValidTimezone(timezone)) {
    throw new OpenOutboundError("validation_failed", `Unknown timezone "${timezone}".`, {
      hint: 'Use an IANA timezone name such as "Europe/Berlin" or "America/Chicago".',
      details: { field: "timezone" },
    });
  }
}

function hoursWarnings(hours: WorkingHours): string[] {
  const warnings: string[] = [];
  if (hours.days.some((day) => day >= 6)) {
    warnings.push(
      "Weekend days are enabled; activity on weekends looks less human for most roles.",
    );
  }
  if (hours.start_hour < 7 || hours.end_hour > 20) {
    warnings.push("Working hours reach outside 07:00-20:00; night-time activity looks automated.");
  }
  return warnings;
}

// --- list ------------------------------------------------------------------------------------

export const listAccounts = defineOperation({
  id: "linkedin.accounts.list",
  summary: "List LinkedIn accounts with status, limits and today's usage",
  description:
    "Lists the workspace's connected LinkedIn accounts with status, working hours, configured limits, today's caps after the ramp and how many actions are done or reserved today. Use it to pick account ids for campaigns and to check health before planning LinkedIn steps. For people-level connection state use action `relations` instead. Restricted accounts stay restricted until a human resumes them.",
  effect: "read",
  input: paginationInput.extend({
    status: z.enum(LINKEDIN_ACCOUNT_STATUSES).optional().describe("Only accounts in this status"),
  }),
  output: paginated(accountOutput),
  http: { method: "GET", path: "/v1/linkedin/accounts" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [
    { title: "All accounts", input: {} },
    { title: "Restricted only", input: { status: "restricted" } },
  ],
  handler: async (ctx, input) => {
    const workspace = await loadWorkspace(ctx, requireWorkspace(ctx).id);
    const conditions = [eq(linkedin_accounts.workspace_id, workspace.id)];
    if (input.status) conditions.push(eq(linkedin_accounts.status, input.status));
    if (input.cursor) {
      const cursor = decodeCursor<{ id: string }>(input.cursor);
      conditions.push(gt(linkedin_accounts.id, String(cursor.id)));
    }
    const rows = await ctx.db
      .select()
      .from(linkedin_accounts)
      .where(and(...conditions))
      .orderBy(asc(linkedin_accounts.id))
      .limit(input.limit + 1);
    const page = toPage(rows, input.limit, (row) => ({ id: row.id }));
    const items = [];
    for (const row of page.items) items.push(await toAccountOutput(ctx, row, workspace));
    return { ...page, items };
  },
});

// --- connect ---------------------------------------------------------------------------------

export const connectAccount = defineOperation({
  id: "linkedin.accounts.connect",
  summary: "Connect a LinkedIn account through the provider's hosted login",
  description:
    "Creates a pending LinkedIn account and returns a hosted login link (Unipile) that the human opens to connect their own account; the provider callback or the next sync turns it active. Use it only after the human has accepted in writing that LinkedIn's terms forbid automation and the account may be restricted (set accept_risk). Never ask for or pass a LinkedIn password: login happens on the provider's page. If the account is already connected in the provider dashboard, pass external_account_id to link it directly.",
  effect: "write",
  input: z.object({
    accept_risk: z
      .boolean()
      .describe(
        "Must be true: the human accepted that LinkedIn automation breaks LinkedIn's terms and can get the account restricted",
      ),
    provider: z.string().default("unipile").describe("LinkedIn provider id (default unipile)"),
    name: z.string().min(1).max(100).optional().describe("Display name, e.g. the account owner"),
    timezone: z
      .string()
      .optional()
      .describe("IANA timezone for working hours; default workspace timezone"),
    premium: z
      .boolean()
      .optional()
      .describe("Premium or Sales Navigator account: 300-char invite notes, no monthly note cap"),
    ramp: z
      .boolean()
      .default(true)
      .describe("Start at 40% of limits and ramp up over 2 weeks (recommended)"),
    external_account_id: z
      .string()
      .min(1)
      .optional()
      .describe("Provider account id when the account is already connected at the provider"),
    success_url: z.url().optional().describe("Where the provider sends the human after login"),
    failure_url: z.url().optional().describe("Where the provider sends the human when login fails"),
  }),
  output: z.object({
    account: accountOutput,
    auth_url: z
      .string()
      .nullable()
      .describe("Open in a browser to log in; null when linked directly"),
    expires_at: z.string().nullable(),
    next_steps: z.array(z.string()),
    warnings: z.array(z.string()),
  }),
  http: { method: "POST", path: "/v1/linkedin/accounts" },
  dryRun: "none",
  idempotent: false,
  workspace: "required",
  examples: [
    {
      title: "Hosted login for a new account",
      input: { accept_risk: true, name: "Dana Reyes", timezone: "America/Chicago" },
    },
  ],
  handler: async (ctx, input) => {
    const workspace = await loadWorkspace(ctx, requireWorkspace(ctx).id);
    if (input.accept_risk !== true) {
      throw new OpenOutboundError(
        "validation_failed",
        "Connecting LinkedIn needs the human's explicit acceptance of the account risk.",
        {
          hint: "Explain to the human that LinkedIn's User Agreement forbids automation and the account can be restricted; only after they accept in writing, call again with accept_risk: true.",
          details: { field: "accept_risk" },
        },
      );
    }
    checkTimezone(input.timezone);
    const provider = await providerFor(ctx, { provider: input.provider });
    const providerId = ctx.workspace?.is_sandbox ? provider.id : input.provider;
    const now = ctx.clock.now();
    const timezone = input.timezone ?? workspace.timezone ?? "UTC";
    const ramp = input.ramp
      ? { ...DEFAULT_LINKEDIN_RAMP }
      : { ...DEFAULT_LINKEDIN_RAMP, enabled: false };
    const warnings = input.ramp
      ? []
      : ["Ramp disabled: a new account starts at full limits, which raises the restriction risk."];
    const webhookNote = ctx.config.env[WEBHOOK_SECRET_ENV]
      ? `Replies and accepted invites also arrive by webhook at ${ctx.config.baseUrl}/hooks/unipile.`
      : `Optional: set ${WEBHOOK_SECRET_ENV} and register a Unipile webhook to ${ctx.config.baseUrl}/hooks/unipile with header ${WEBHOOK_SECRET_HEADER}; otherwise sync polls every 15 minutes.`;

    if (input.external_account_id) {
      const external = input.external_account_id;
      const [existing] = await ctx.db
        .select({ id: linkedin_accounts.id })
        .from(linkedin_accounts)
        .where(
          and(
            eq(linkedin_accounts.workspace_id, workspace.id),
            eq(linkedin_accounts.provider, providerId),
            eq(linkedin_accounts.external_account_id, external),
          ),
        );
      if (existing) {
        throw new OpenOutboundError(
          "conflict",
          `This LinkedIn account is already connected as ${existing.id}.`,
          {
            hint: "Use the existing account id; resume it if it is paused.",
            details: { account_id: existing.id },
          },
        );
      }
      if (
        await linkedElsewhere(
          ctx,
          { id: "", workspace_id: workspace.id, provider: providerId },
          external,
        )
      ) {
        throw new OpenOutboundError("conflict", LINKED_ELSEWHERE_REASON, {
          hint: "Remove the account in the other workspace with manage_linkedin action remove, then connect it here.",
          details: { field: "external_account_id" },
        });
      }
      if (provider.listAccounts) {
        const known = await provider.listAccounts();
        if (!known.some((item) => item.external_account_id === external)) {
          throw new OpenOutboundError(
            "validation_failed",
            `The provider has no account ${external}.`,
            {
              hint: "Copy the account id from the provider dashboard, or omit external_account_id to get a login link.",
              details: { field: "external_account_id" },
            },
          );
        }
      }
      const [row] = await ctx.db
        .insert(linkedin_accounts)
        .values({
          workspace_id: workspace.id,
          provider: providerId,
          name: input.name ?? null,
          status: "pending",
          timezone,
          premium: input.premium ?? false,
          ramp,
        })
        .returning();
      if (!row) throw new Error("linkedin: account insert returned no row");
      await activate(ctx, row, external);
      const account = await requireAccount(ctx, workspace.id, row.id);
      return {
        account: await toAccountOutput(ctx, account, workspace),
        auth_url: null,
        expires_at: null,
        next_steps: [
          "The account is active. Add its id to a campaign's senders.linkedin_account_ids.",
          webhookNote,
        ],
        warnings,
      };
    }

    if (!provider.createAuthLink) {
      throw new OpenOutboundError(
        "unsupported",
        `Provider ${providerId} has no hosted login link.`,
        {
          hint: "Connect the account in the provider dashboard and pass its id as external_account_id.",
        },
      );
    }
    let knownIds: string[] | null = null;
    try {
      knownIds = provider.listAccounts
        ? (await provider.listAccounts()).map((item) => item.external_account_id)
        : null;
    } catch (error) {
      ctx.log.warn({ err: String(error) }, "linkedin: could not list provider accounts");
    }
    const [row] = await ctx.db
      .insert(linkedin_accounts)
      .values({
        workspace_id: workspace.id,
        provider: providerId,
        name: input.name ?? null,
        status: "pending",
        timezone,
        premium: input.premium ?? false,
        ramp,
        sync_state: {
          pending_auth: { requested_at: now.toISOString(), known_account_ids: knownIds },
        },
      })
      .returning();
    if (!row) throw new Error("linkedin: account insert returned no row");
    const state = encodeAuthState(ctx.vault, {
      ws: workspace.id,
      acc: row.id,
      exp: now.getTime() + AUTH_LINK_TTL_MS,
    });
    let link: { url: string; expiresAt?: string };
    try {
      link = await provider.createAuthLink({
        workspaceId: workspace.id,
        state: row.id,
        notifyUrl: `${ctx.config.baseUrl}/hooks/unipile/auth?state=${state}`,
        ...(input.success_url ? { successUrl: input.success_url } : {}),
        ...(input.failure_url ? { failureUrl: input.failure_url } : {}),
      });
    } catch (error) {
      await ctx.db.delete(linkedin_accounts).where(eq(linkedin_accounts.id, row.id));
      throw error;
    }
    const expiresAt = link.expiresAt ?? new Date(now.getTime() + AUTH_LINK_TTL_MS).toISOString();
    const [updated] = await ctx.db
      .update(linkedin_accounts)
      .set({
        sync_state: {
          pending_auth: {
            requested_at: now.toISOString(),
            expires_at: expiresAt,
            known_account_ids: knownIds,
          },
        },
      })
      .where(eq(linkedin_accounts.id, row.id))
      .returning();
    return {
      account: await toAccountOutput(ctx, updated ?? row, workspace),
      auth_url: link.url,
      expires_at: expiresAt,
      next_steps: [
        "Give auth_url to the human: they open it and log in to LinkedIn on the provider's page (never share the password with an agent).",
        "The account turns active by itself after login; check with manage_linkedin action list, or run action sync.",
        webhookNote,
      ],
      warnings,
    };
  },
});

// --- update ----------------------------------------------------------------------------------

export const updateAccount = defineOperation({
  id: "linkedin.accounts.update",
  summary: "Change a LinkedIn account's limits, hours, timezone, premium flag or ramp",
  description:
    "Updates limits, working hours, timezone, name, premium flag or ramp of one LinkedIn account; unspecified fields keep their values. Use it to lower volume, fit hours to the account owner's day, or mark a Premium account (longer invite notes). Raising limits above the safe defaults is allowed but returns warnings, and new values apply to planning from now on. To stop all actions use action `pause` instead.",
  effect: "write",
  input: z.object({
    account_id: accountId,
    name: z.string().min(1).max(100).optional(),
    timezone: z.string().optional().describe("IANA timezone, e.g. Europe/Berlin"),
    premium: z.boolean().optional(),
    limits: limitsInput.optional(),
    working_hours: workingHoursInput.optional(),
    ramp: z
      .enum(["on", "off", "restart"])
      .optional()
      .describe("on = enable, off = full limits now (warned), restart = back to week 1"),
  }),
  output: z.object({ account: accountOutput, warnings: z.array(z.string()) }),
  http: { method: "PATCH", path: "/v1/linkedin/accounts/:account_id" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [
    {
      title: "Fewer invites, later start",
      input: {
        account_id: "lia_01k6a3v0q8x3m2n4p5r6s7t8v9",
        limits: { invites_per_day: 10 },
        working_hours: { start_hour: 10 },
      },
    },
  ],
  handler: async (ctx, input) => {
    const workspace = await loadWorkspace(ctx, requireWorkspace(ctx).id);
    const account = await requireAccount(ctx, workspace.id, input.account_id);
    checkTimezone(input.timezone);
    const values: Partial<typeof linkedin_accounts.$inferInsert> = {};
    const warnings: string[] = [];
    if (input.name !== undefined) values.name = input.name;
    if (input.timezone !== undefined) values.timezone = input.timezone;
    if (input.premium !== undefined) values.premium = input.premium;
    if (input.limits) {
      const merged: LinkedInLimits = { ...account.limits };
      for (const [key, value] of Object.entries(input.limits) as Array<
        [keyof LinkedInLimits, number | null | undefined]
      >) {
        if (value === undefined) continue;
        if (key === "invite_notes_per_month") merged.invite_notes_per_month = value;
        else if (value !== null) merged[key] = value;
      }
      values.limits = merged;
      warnings.push(...limitWarnings(merged, input.premium ?? account.premium));
    }
    if (input.working_hours) {
      const hours: WorkingHours = {
        ...DEFAULT_WORKING_HOURS,
        ...(account.working_hours ?? {}),
        ...Object.fromEntries(
          Object.entries(input.working_hours).filter(([, v]) => v !== undefined),
        ),
      };
      if (hours.start_hour >= hours.end_hour) {
        throw invalid("working_hours.start_hour must be before end_hour.", {
          start_hour: hours.start_hour,
          end_hour: hours.end_hour,
        });
      }
      hours.days = [...new Set(hours.days)].sort();
      values.working_hours = hours;
      warnings.push(...hoursWarnings(hours));
    }
    if (input.ramp) {
      const today = dayKey(
        ctx.clock.now(),
        input.timezone ?? account.timezone ?? workspace.timezone,
      );
      const base = { ...DEFAULT_LINKEDIN_RAMP, ...(account.ramp ?? {}) };
      if (input.ramp === "off") {
        values.ramp = { ...base, enabled: false };
        warnings.push("Ramp disabled: the account now runs at its full limits.");
      } else if (input.ramp === "restart") {
        values.ramp = { ...base, enabled: true, started_at: today };
      } else {
        values.ramp = { ...base, enabled: true, started_at: base.started_at ?? today };
      }
    }
    let row = account;
    if (Object.keys(values).length > 0) {
      const [updated] = await ctx.db
        .update(linkedin_accounts)
        .set(values)
        .where(eq(linkedin_accounts.id, account.id))
        .returning();
      if (updated) row = updated;
    }
    return { account: await toAccountOutput(ctx, row, workspace), warnings };
  },
});

// --- pause / resume --------------------------------------------------------------------------

export const pauseAccount = defineOperation({
  id: "linkedin.accounts.pause",
  summary: "Pause every LinkedIn action of an account",
  description:
    "Pauses one LinkedIn account: nothing new is planned on it and its queued actions go back to approved until it is resumed. Use it when the owner wants a break, before changing the profile, or at the first warning sign from LinkedIn. To stop the whole workspace (email too) pause the workspace instead. Inbound replies keep syncing while paused.",
  effect: "write",
  input: z.object({ account_id: accountId }),
  output: z.object({ account: accountOutput, actions_paused: z.number() }),
  http: { method: "POST", path: "/v1/linkedin/accounts/:account_id/pause" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [
    {
      title: "Pause",
      input: { account_id: "lia_01k6a3v0q8x3m2n4p5r6s7t8v9" },
    },
  ],
  handler: async (ctx, input) => {
    const workspace = await loadWorkspace(ctx, requireWorkspace(ctx).id);
    const account = await requireAccount(ctx, workspace.id, input.account_id);
    let row: LinkedInAccount = account;
    if (account.status === "active" || account.status === "pending") {
      const [updated] = await ctx.db
        .update(linkedin_accounts)
        .set({ status: "paused", status_reason: ctx.request.reason ?? "Paused by a user" })
        .where(eq(linkedin_accounts.id, account.id))
        .returning();
      if (updated) row = updated;
    }
    const paused = await unscheduleMessages(ctx.db, account, "paused: account paused");
    return { account: await toAccountOutput(ctx, row, workspace), actions_paused: paused };
  },
});

export const resumeAccount = defineOperation({
  id: "linkedin.accounts.resume",
  summary: "Resume a paused, restricted or disconnected LinkedIn account",
  description:
    "Sets the account active again and re-queues its paused actions with fresh slots. Use it after a pause, or after a restriction once the human has logged in manually, cleared every check and used the account by hand for about 7 days. Only a human can resume a restricted account (agents get forbidden); the ramp restarts at week 1 in that case. It does not fix a lost session: reconnect first if the provider reports disconnected.",
  effect: "write",
  input: z.object({ account_id: accountId }),
  output: z.object({
    account: accountOutput,
    actions_requeued: z.number(),
    warnings: z.array(z.string()),
  }),
  http: { method: "POST", path: "/v1/linkedin/accounts/:account_id/resume" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Resume", input: { account_id: "lia_01k6a3v0q8x3m2n4p5r6s7t8v9" } }],
  handler: async (ctx, input) => {
    const workspace = await loadWorkspace(ctx, requireWorkspace(ctx).id);
    const account = await requireAccount(ctx, workspace.id, input.account_id);
    const warnings: string[] = [];
    if (account.status === "pending") {
      throw new OpenOutboundError("conflict", "The account has not finished connecting yet.", {
        hint: "Open the login link from connect, then run manage_linkedin action sync.",
      });
    }
    if (account.status === "restricted" && ctx.principal.type !== "human") {
      throw new OpenOutboundError(
        "forbidden",
        "Only a human can resume a restricted LinkedIn account.",
        {
          hint: "Ask the account owner to check LinkedIn manually and run `openoutbound linkedin accounts resume --account-id <id>` themselves.",
          details: { account_id: account.id },
        },
      );
    }
    let row = account;
    if (account.status !== "active") {
      const values: Partial<typeof linkedin_accounts.$inferInsert> = {
        status: "active",
        status_reason: null,
        health: { ...account.health, consecutive_failures: 0, last_error: null },
      };
      if (account.status === "restricted") {
        const today = dayKey(ctx.clock.now(), account.timezone ?? workspace.timezone);
        values.ramp = {
          ...DEFAULT_LINKEDIN_RAMP,
          ...(account.ramp ?? {}),
          enabled: true,
          started_at: today,
        };
        warnings.push(
          "Resumed after a restriction: the ramp restarted at week 1. Stop again at the first warning from LinkedIn.",
        );
      }
      const [updated] = await ctx.db
        .update(linkedin_accounts)
        .set(values)
        .where(eq(linkedin_accounts.id, account.id))
        .returning();
      if (updated) row = updated;
    }
    const requeued = await requeueApproved(ctx, workspace.id, account.id);
    await resolveAccountDown(ctx, account, `Resumed by ${ctx.principal.name}.`);
    return {
      account: await toAccountOutput(ctx, row, workspace),
      actions_requeued: requeued,
      warnings,
    };
  },
});

// --- remove ----------------------------------------------------------------------------------

export const removeAccount = defineOperation({
  id: "linkedin.accounts.remove",
  summary: "Disconnect a LinkedIn account from OpenOutbound",
  description:
    "Removes the account from the workspace: queued and approved actions on it are cancelled and its relation history is deleted; sent messages and threads stay. Use it when the owner leaves or no longer wants automation. It does not delete the account at the provider or on LinkedIn. Prefer `pause` for a temporary stop; run with dry_run first to see what would be cancelled.",
  effect: "destructive",
  input: z.object({ account_id: accountId }),
  output: z.union([
    z.object({ removed: z.literal(true), account_id: z.string(), actions_cancelled: z.number() }),
    dryRunOutput(
      z.object({
        account_id: z.string(),
        name: z.string().nullable(),
        actions_to_cancel: z.number(),
        relations: z.number(),
      }),
    ),
  ]),
  http: { method: "DELETE", path: "/v1/linkedin/accounts/:account_id" },
  dryRun: "supported",
  idempotent: false,
  workspace: "required",
  examples: [{ title: "Remove", input: { account_id: "lia_01k6a3v0q8x3m2n4p5r6s7t8v9" } }],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const account = await requireAccount(ctx, workspace.id, input.account_id);
    const pending = and(
      eq(messages.workspace_id, workspace.id),
      eq(messages.linkedin_account_id, account.id),
      eq(messages.channel, "linkedin"),
      eq(messages.direction, "outbound"),
      inArray(messages.status, ["approved", "scheduled"]),
    );
    if (ctx.request.dryRun) {
      const toCancel = await ctx.db.select({ id: messages.id }).from(messages).where(pending);
      const relations = await ctx.db
        .select({ person_id: linkedin_relations.person_id })
        .from(linkedin_relations)
        .where(eq(linkedin_relations.account_id, account.id));
      return dryRun({
        account_id: account.id,
        name: account.name,
        actions_to_cancel: toCancel.length,
        relations: relations.length,
      });
    }
    const cancelled = await ctx.db
      .update(messages)
      .set({ status: "cancelled", error: "account removed" })
      .where(pending)
      .returning({ id: messages.id });
    await ctx.db.delete(linkedin_accounts).where(eq(linkedin_accounts.id, account.id));
    await resolveAccountDown(ctx, account, "The LinkedIn account was removed.");
    await resolveAccountReadDown(ctx, account, "The LinkedIn account was removed.");
    return { removed: true as const, account_id: account.id, actions_cancelled: cancelled.length };
  },
});

// --- sync ------------------------------------------------------------------------------------

export const syncAccounts = defineOperation({
  id: "linkedin.accounts.sync",
  summary: "Sync accepted invitations, replies and pending connections now",
  description:
    "Starts a background sync that picks up accepted invitations, inbound LinkedIn messages and finished hosted logins, and withdraws invitations pending for more than 21 days. Use it right after the human completed a login link or when you expect a reply; it also runs every 15 minutes by itself. It never sends anything. Check progress with get_job.",
  effect: "write",
  input: z.object({ account_id: accountId.optional().describe("Default: every account") }),
  output: jobHandleOutput,
  http: { method: "POST", path: "/v1/linkedin/sync" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Sync everything", input: {} }],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    if (input.account_id) {
      const account = await requireAccount(ctx, workspace.id, input.account_id);
      return ctx.jobs.enqueue(
        "linkedin.sync",
        { account_id: account.id },
        { singletonKey: `linkedin.sync:${account.id}` },
      );
    }
    return ctx.jobs.enqueue(
      "linkedin.sync_workspace",
      { workspace_id: workspace.id },
      { singletonKey: `linkedin.sync_workspace:${workspace.id}` },
    );
  },
});

// --- relations -------------------------------------------------------------------------------

export const listRelations = defineOperation({
  id: "linkedin.relations.list",
  summary: "List connection state between LinkedIn accounts and people",
  description:
    "Lists relations between the workspace's LinkedIn accounts and people: none, invited, connected, withdrawn or failed, with invite and connect times. Use it to see who accepted, who is still pending and which invites were withdrawn after 21 days. For account health and caps use action `list` instead. Relations update on sync (every 15 minutes) and on webhooks, so acceptances can lag by hours.",
  effect: "read",
  input: paginationInput.extend({
    account_id: accountId.optional(),
    person_id: idSchema("pe").optional(),
    status: z
      .array(z.enum(LINKEDIN_RELATION_STATUSES))
      .optional()
      .describe("Any of these statuses"),
  }),
  output: paginated(relationOutput),
  http: { method: "GET", path: "/v1/linkedin/relations" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Accepted invitations", input: { status: ["connected"] } }],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const conditions = [eq(linkedin_relations.workspace_id, workspace.id)];
    if (input.account_id) conditions.push(eq(linkedin_relations.account_id, input.account_id));
    if (input.person_id) conditions.push(eq(linkedin_relations.person_id, input.person_id));
    if (input.status?.length) conditions.push(inArray(linkedin_relations.status, input.status));
    if (input.cursor) {
      const cursor = decodeCursor<{ p: string; a: string }>(input.cursor);
      const after = or(
        gt(linkedin_relations.person_id, String(cursor.p)),
        and(
          eq(linkedin_relations.person_id, String(cursor.p)),
          gt(linkedin_relations.account_id, String(cursor.a)),
        ),
      );
      if (after) conditions.push(after);
    }
    const rows = await ctx.db
      .select({
        account_id: linkedin_relations.account_id,
        person_id: linkedin_relations.person_id,
        person_name: people.full_name,
        linkedin_url: people.linkedin_url,
        status: linkedin_relations.status,
        invited_at: linkedin_relations.invited_at,
        connected_at: linkedin_relations.connected_at,
        updated_at: linkedin_relations.updated_at,
      })
      .from(linkedin_relations)
      .innerJoin(people, eq(people.id, linkedin_relations.person_id))
      .where(and(...conditions))
      .orderBy(asc(linkedin_relations.person_id), asc(linkedin_relations.account_id))
      .limit(input.limit + 1);
    return toPage(rows, input.limit, (row) => ({ p: row.person_id, a: row.account_id }));
  },
});

export const linkedinOperations = [
  listAccounts,
  connectAccount,
  updateAccount,
  pauseAccount,
  resumeAccount,
  removeAccount,
  syncAccounts,
  listRelations,
];
