import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { type OpContext, requireWorkspace } from "../../../core/context.js";
import { OpenOutboundError } from "../../../core/errors.js";
import { idSchema } from "../../../core/ids.js";
import { defineOperation, dryRun, dryRunOutput } from "../../../core/operation.js";
import { type CampaignStep, enrollments, messages, people } from "../../../db/schema/index.js";
import { resolvePeople } from "../../leads/service.js";
import { getRecentPostForPerson } from "../../linkedin/service.js";
import { displayName, loadPeople, type PersonWithCompany } from "../people.js";
import { type LoadedCampaign, loadCampaign } from "../repo.js";
import {
  EXAMPLE_CAMPAIGN_ID,
  EXAMPLE_MESSAGE_ID,
  leadFilterInput,
  toLeadFilter,
} from "../schemas.js";
import { RECENT_POST_DAYS } from "../sequencer/channel-step.js";
import { anyStepConfig, stepChannel } from "../steps.js";
import { buildWritingContext } from "../writing/context.js";
import { type DraftWhy, writeDraft } from "../writing/pipeline.js";
import { teachPrompt } from "../writing/prompts.js";
import { applyCampaignUpdate } from "./campaigns.js";

const campaignId = idSchema("cmp").describe("Campaign id (cmp_...)");
const MAX_PREVIEW = 10;
const MAX_RULES = 50;

/** Steps whose text the pipeline writes or renders (not visits, likes or note-less invites). */
function hasText(step: CampaignStep): boolean {
  const config = anyStepConfig(step);
  switch (config.type) {
    case "email":
    case "linkedin_message":
    case "linkedin_comment":
      return true;
    case "linkedin_invite":
      return config.note !== "none";
    default:
      return false;
  }
}

const previewItem = z.object({
  person: z.object({
    id: z.string(),
    name: z.string(),
    title: z.string().nullable(),
    company: z.string().nullable(),
  }),
  variant: z.string().nullable(),
  subject: z.string().nullable(),
  body: z.string().nullable(),
  why: z.object({
    angle: z.string().nullable(),
    facts: z.array(z.object({ text: z.string(), source: z.string() })),
    signals: z.array(
      z.object({
        id: z.string(),
        type: z.string(),
        title: z.string(),
        evidence_url: z.string().nullable(),
      }),
    ),
    brief_id: z.string().nullable(),
  }),
  check: z
    .object({
      verdict: z.enum(["pass", "revise", "fail"]),
      confidence: z.number().nullable(),
      issues: z.array(
        z.object({ code: z.string(), message: z.string(), severity: z.enum(["error", "warning"]) }),
      ),
      revised: z.boolean(),
    })
    .nullable(),
  skipped_reason: z
    .string()
    .nullable()
    .describe(
      "Why no draft was produced (missing data, no recent post); the step would be skipped",
    ),
});

const previewOutput = z.object({
  campaign_id: z.string(),
  step: z.object({ id: z.string(), position: z.number(), type: z.string() }),
  items: z.array(previewItem),
});

async function samplePeople(
  ctx: OpContext,
  loaded: LoadedCampaign,
  input: {
    person_ids?: string[] | undefined;
    list_id?: string | undefined;
    filter?: z.output<typeof leadFilterInput> | undefined;
    count: number;
  },
): Promise<PersonWithCompany[]> {
  const workspace = requireWorkspace(ctx);
  let ids: string[];
  if (input.person_ids?.length) {
    ids = input.person_ids.slice(0, MAX_PREVIEW);
  } else if (input.list_id || input.filter) {
    ids = await resolvePeople(ctx, {
      ...(input.list_id ? { listId: input.list_id } : {}),
      ...(input.filter ? { filter: toLeadFilter(input.filter) ?? {} } : {}),
    });
  } else {
    const enrolled = await ctx.db
      .select({ id: enrollments.person_id })
      .from(enrollments)
      .where(eq(enrollments.campaign_id, loaded.campaign.id))
      .limit(500);
    ids = enrolled.map((row) => row.id);
    if (ids.length === 0) {
      const top = await ctx.db
        .select({ id: people.id })
        .from(people)
        .where(and(eq(people.workspace_id, workspace.id), isNotNull(people.fit_score)))
        .orderBy(desc(people.fit_score))
        .limit(input.count);
      ids = top.map((row) => row.id);
    }
  }
  const found = await loadPeople(ctx, ids);
  const ordered = input.person_ids?.length
    ? ids.map((id) => found.get(id)).filter((row) => row !== undefined)
    : [...found.values()].sort((a, b) => (b.person.fit_score ?? -1) - (a.person.fit_score ?? -1));
  return ordered.slice(0, input.person_ids?.length ? MAX_PREVIEW : input.count);
}

export const previewCampaign = defineOperation({
  id: "campaigns.preview",
  summary: "Draft sample messages for a few leads without sending or storing anything",
  description:
    "Runs the full writing pipeline (research brief, signals, knowledge grounding, draft, automatic checks, checker model, one rewrite) for 1-10 sample leads and one step, and returns for each: subject, body, why (angle, facts with sources, signals) and the check verdict with issues. Use it before launching and after changing instructions, then fix problems with create_campaign action update or preview_campaign action teach. Samples default to the campaign's enrolled leads with the best fit (or explicit person_ids, a list or a filter). It spends AI budget but stores and sends nothing.",
  effect: "spend",
  input: z.object({
    campaign_id: campaignId,
    person_ids: z.array(z.string()).max(MAX_PREVIEW).optional(),
    list_id: z.string().optional(),
    filter: leadFilterInput.optional(),
    count: z
      .number()
      .int()
      .min(1)
      .max(MAX_PREVIEW)
      .default(3)
      .describe("How many sample leads (1-10)"),
    step_position: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Which step to draft (default: the first step with text)"),
  }),
  output: z.union([
    previewOutput,
    dryRunOutput(
      z.object({
        campaign_id: z.string(),
        step: z.object({ id: z.string(), position: z.number(), type: z.string() }),
        people: z.array(z.object({ id: z.string(), name: z.string() })),
      }),
    ),
  ]),
  http: { method: "POST", path: "/v1/campaigns/:campaign_id/preview" },
  dryRun: "supported",
  idempotent: false,
  workspace: "required",
  examples: [
    {
      title: "Three samples of the first email",
      input: { campaign_id: EXAMPLE_CAMPAIGN_ID, count: 3 },
    },
  ],
  handler: async (ctx, input) => {
    const loaded = await loadCampaign(ctx, input.campaign_id);
    const step =
      input.step_position !== undefined
        ? loaded.steps[input.step_position]
        : loaded.steps.find((candidate) => hasText(candidate));
    if (!step || !hasText(step)) {
      throw new OpenOutboundError(
        "validation_failed",
        input.step_position !== undefined
          ? `Step ${input.step_position} has no text to preview.`
          : "The campaign has no step with text to preview.",
        {
          hint: "Pick an email, LinkedIn message, invite-with-note or comment step (step_position).",
        },
      );
    }
    const sample = await samplePeople(ctx, loaded, input);
    if (sample.length === 0) {
      throw new OpenOutboundError("validation_failed", "No leads to preview with.", {
        hint: "Pass person_ids, list_id or filter, or enroll leads first with enroll_leads.",
      });
    }
    const stepInfo = { id: step.id, position: step.position, type: step.type };
    if (ctx.request.dryRun) {
      return dryRun(
        {
          campaign_id: loaded.campaign.id,
          step: stepInfo,
          people: sample.map(({ person }) => ({ id: person.id, name: displayName(person) })),
        },
        {
          estimatedCost: {
            usd: Math.round(sample.length * 0.012 * 1000) / 1000,
            note: "About one draft, one check and sometimes one rewrite per lead.",
          },
        },
      );
    }
    const earlierText = loaded.steps.some(
      (other) => other.position < step.position && hasText(other),
    );
    const channel = stepChannel(step.type) ?? "email";
    const config = anyStepConfig(step);
    const items: Array<z.input<typeof previewItem>> = [];
    for (const [index, { person, company }] of sample.entries()) {
      const context = await buildWritingContext(ctx, {
        campaign: loaded.campaign,
        settings: loaded.settings,
        person,
        company,
        channel,
      });
      let post = null;
      if (config.type === "linkedin_comment") {
        const accountId = loaded.settings.senders.linkedin_account_ids[0];
        post = accountId
          ? await getRecentPostForPerson(ctx, {
              accountId,
              personId: person.id,
              maxAgeDays: RECENT_POST_DAYS,
            })
          : null;
      }
      const result = await writeDraft(ctx, {
        context,
        step,
        firstTouch: !earlierText,
        variantSeed: index,
        threadSubject:
          config.type === "email" && config.mode === "reply" && earlierText
            ? "your earlier email"
            : null,
        post,
      });
      const personOut = {
        id: person.id,
        name: displayName(person),
        title: person.title,
        company: company?.name ?? null,
      };
      if (!result.ok) {
        items.push({
          person: personOut,
          variant: null,
          subject: null,
          body: null,
          why: { angle: null, facts: [], signals: [], brief_id: context.brief?.id ?? null },
          check: null,
          skipped_reason: result.reason,
        });
        continue;
      }
      const { draft } = result;
      const used = new Set(draft.why.signal_ids ?? []);
      items.push({
        person: personOut,
        variant: draft.variant,
        subject: draft.subject,
        body: draft.body,
        why: {
          angle: draft.why.angle ?? null,
          facts: draft.why.facts ?? [],
          signals: context.signals
            .filter((signal) => used.has(signal.id))
            .map((signal) => ({
              id: signal.id,
              type: signal.definition_key,
              title: signal.title,
              evidence_url: signal.evidence_url,
            })),
          brief_id: context.brief?.id ?? null,
        },
        check: {
          verdict: draft.check.verdict,
          confidence: draft.check.confidence ?? null,
          issues: draft.check.issues,
          revised: draft.check.revised ?? false,
        },
        skipped_reason: null,
      });
    }
    return { campaign_id: loaded.campaign.id, step: stepInfo, items };
  },
});

export const teachCampaign = defineOperation({
  id: "campaigns.teach",
  summary: "Turn corrections into writing rules for a campaign",
  description:
    "Derives short, general writing rules from corrections (original vs corrected text, or a note) and appends them to the campaign's settings.writing.rules, which every future draft and check follows; the change is recorded in the change log (operation campaigns.teach), so it can be undone. Pass corrections directly, or message_ids of drafts a human or agent edited (their original text is kept). Use it after reviewing previews or approvals, not for one-off typos. Archived and completed campaigns cannot learn: duplicate them first. Returns only the rules that were new.",
  effect: "write",
  input: z.object({
    campaign_id: campaignId,
    corrections: z
      .array(
        z.object({
          original: z.string().max(5000).optional(),
          corrected: z.string().max(5000).optional(),
          note: z.string().max(1000).optional().describe("What was wrong, in plain words"),
        }),
      )
      .max(20)
      .optional(),
    message_ids: z.array(z.string()).max(20).optional(),
  }),
  output: z.object({
    campaign_id: z.string(),
    rules_added: z.array(z.string()),
    rules: z.array(z.string()),
  }),
  http: { method: "POST", path: "/v1/campaigns/:campaign_id/teach" },
  dryRun: "none",
  idempotent: false,
  workspace: "required",
  examples: [
    {
      title: "From a note",
      input: {
        campaign_id: EXAMPLE_CAMPAIGN_ID,
        corrections: [{ note: "Never mention how much funding they raised." }],
      },
    },
    {
      title: "From edited drafts",
      input: { campaign_id: EXAMPLE_CAMPAIGN_ID, message_ids: [EXAMPLE_MESSAGE_ID] },
    },
  ],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const loaded = await loadCampaign(ctx, input.campaign_id);
    const { campaign } = loaded;
    // Checked before the brain call: the update below refuses these campaigns too.
    if (campaign.status === "archived" || campaign.status === "completed") {
      throw new OpenOutboundError("conflict", `Campaign ${campaign.name} is ${campaign.status}.`, {
        hint: "Duplicate it with create_campaign action duplicate and teach the copy.",
        details: { campaign_id: campaign.id, status: campaign.status },
      });
    }
    const corrections = (input.corrections ?? []).map((correction) => ({
      original: correction.original ?? null,
      corrected: correction.corrected ?? null,
      note: correction.note ?? null,
    }));
    if (input.message_ids?.length) {
      const rows = await ctx.db
        .select()
        .from(messages)
        .where(
          and(eq(messages.workspace_id, workspace.id), inArray(messages.id, input.message_ids)),
        );
      for (const row of rows) {
        const why = (row.why as DraftWhy | null) ?? {};
        if (!why.original) continue;
        corrections.push({
          original: [why.original.subject, why.original.body].filter(Boolean).join("\n"),
          corrected: [row.subject, row.body_text].filter(Boolean).join("\n"),
          note: why.notes ?? null,
        });
      }
    }
    const useful = corrections.filter(
      (c) => c.note || (c.original && c.corrected && c.original !== c.corrected),
    );
    if (useful.length === 0) {
      throw new OpenOutboundError("validation_failed", "Nothing to learn from.", {
        hint: "Pass corrections with a note or with original and corrected text, or message_ids of edited drafts (manage_messages action update keeps the original).",
      });
    }
    const existing = loaded.settings.writing.rules;
    const { output } = await ctx.brain.run(teachPrompt, {
      corrections: useful,
      existing_rules: existing,
    });
    const seen = new Set(existing.map((rule) => rule.trim().toLowerCase()));
    const added: string[] = [];
    for (const rule of output.rules) {
      const clean = rule.trim().replace(/\s+/g, " ");
      const key = clean.toLowerCase();
      if (!clean || seen.has(key)) continue;
      seen.add(key);
      added.push(clean);
    }
    const rules = [...existing, ...added].slice(-MAX_RULES);
    if (added.length > 0) {
      // Through the campaign update, so the new rules are recorded in the change log.
      await applyCampaignUpdate(
        ctx,
        campaign.id,
        { settings: { writing: { rules } } },
        { operation: "campaigns.teach" },
      );
    }
    return { campaign_id: campaign.id, rules_added: added, rules };
  },
});
