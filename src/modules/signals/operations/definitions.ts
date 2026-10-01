/** Signal catalog operations: list, tune, define custom signals, remove custom signals. */
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { type OpContext, requireWorkspace } from "../../../core/context.js";
import { SIGNAL_DEFINITION_KINDS } from "../../../core/enums.js";
import { OpenOutboundError } from "../../../core/errors.js";
import { defineOperation, paginated, paginationInput } from "../../../core/operation.js";
import { decodeCursor, toPage } from "../../../core/pagination.js";
import { type SignalDetection, signal_definitions } from "../../../db/schema/index.js";
import {
  BUILTIN_COLLECTORS,
  DEFAULT_CUSTOM_MIN_STRENGTH,
  findDefinition,
  isBuiltinCollector,
  isBuiltinKey,
  loadDefinitions,
} from "../catalog.js";
import { definitionOutput, definitionView, signalKeySchema } from "../shapes.js";

/** A built-in collector or a signal provider id. */
const collectorName = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,40}$/)
  .describe(`Built-in collector (${BUILTIN_COLLECTORS.join(", ")}) or a signal provider id`);

/** "/pricing", "https://{domain}/blog" or an absolute http(s) URL. */
const definitionUrl = z
  .string()
  .trim()
  .max(300)
  .regex(/^(\/|https?:\/\/)/, { message: 'Use "/path", "https://{domain}/path" or a full URL' });

const tierInput = z
  .enum(["fast", "standard"])
  .describe("Brain tier for judging evidence (fast is cheaper; standard for subtle rules)");

const KNOWN_PROVIDERS = new Set(["predictleads", "crustdata", "webhook", "sandbox"]);

function collectorWarnings(collectors: readonly string[]): string[] {
  return collectors
    .filter((name) => !isBuiltinCollector(name) && !KNOWN_PROVIDERS.has(name))
    .map(
      (name) =>
        `"${name}" is not a built-in collector or known provider; it only works if a signals provider with that id is configured.`,
    );
}

/** Re-scores every company of the workspace soon (weights, half-lives or keys changed). */
export async function queueIntentRecompute(ctx: OpContext, workspaceId: string): Promise<void> {
  await ctx.jobs.enqueue(
    "signals.recompute_intent",
    { workspace_id: workspaceId },
    { workspaceId, singletonKey: `signals.recompute_intent:${workspaceId}`, delayMs: 5_000 },
  );
}

export const definitionsList = defineOperation({
  id: "signals.definitions.list",
  summary: "List signal definitions (built-in and custom)",
  description:
    "Lists the signal catalog of the workspace: the 15 built-in signals (funding, job changes, hiring, tech changes, website changes, news and more) and your custom plain-English signals, with weight, half-life and whether each is enabled. Use it to see which signal keys exist before creating monitors, automation rules or custom signals. To change one use signals.definitions.update; to add one use signals.definitions.create. Custom definitions always include their detection rules; built-ins include them with response_format detailed.",
  effect: "read",
  input: paginationInput.extend({
    kind: z.enum(SIGNAL_DEFINITION_KINDS).optional().describe("Only built-in or only custom"),
    enabled: z.boolean().optional().describe("Only enabled (true) or disabled (false)"),
  }),
  output: paginated(definitionOutput),
  http: { method: "GET", path: "/v1/signal-definitions" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [
    { title: "Every signal", input: {} },
    { title: "Custom signals", input: { kind: "custom" } },
  ],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const all = [...(await loadDefinitions(ctx.db, workspace.id)).values()]
      .filter((row) => (input.kind ? row.kind === input.kind : true))
      .filter((row) => (input.enabled === undefined ? true : row.enabled === input.enabled))
      .sort((a, b) =>
        a.kind === b.kind ? a.key.localeCompare(b.key) : a.kind === "builtin" ? -1 : 1,
      );
    const offset = input.cursor
      ? Math.max(0, Number(decodeCursor<{ offset: number }>(input.cursor).offset) || 0)
      : 0;
    return toPage(
      all.slice(offset, offset + input.limit + 1),
      input.limit,
      () => ({ offset: offset + input.limit }),
      (row) => definitionView(row, ctx.request.responseFormat),
    );
  },
});

async function requireDefinition(ctx: OpContext, workspaceId: string, key: string) {
  const definition = await findDefinition(ctx.db, workspaceId, key);
  if (!definition) {
    throw new OpenOutboundError("not_found", `No signal definition with key "${key}".`, {
      hint: "List keys with manage_signals action list_definitions.",
      details: { key },
    });
  }
  return definition;
}

export const definitionsUpdate = defineOperation({
  id: "signals.definitions.update",
  summary: "Tune or toggle a signal definition",
  description:
    "Changes one signal definition: enable or disable it, tune weight (score at full strength when new), half_life_days (how fast it fades) and min_strength (weaker signals score 0), or edit its detection (collectors, keywords, instructions, urls). Use it to match the catalog to what predicts deals for you, for example raise job_change or disable news_mention. To add a new kind of signal use signals.definitions.create. Scoring changes re-score company intent in the background within a minute.",
  effect: "write",
  input: z.object({
    key: signalKeySchema,
    enabled: z.boolean().optional(),
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(2000).optional(),
    weight: z.number().int().min(0).max(100).optional().describe("0-100"),
    half_life_days: z.number().int().min(1).max(365).optional(),
    min_strength: z.number().min(0).max(1).optional().describe("0-1"),
    collectors: z.array(collectorName).max(12).optional(),
    keywords: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
    instructions: z.string().trim().max(2000).optional(),
    urls: z.array(definitionUrl).max(5).optional(),
    tier: tierInput.optional(),
  }),
  output: definitionOutput.extend({
    changed: z.array(z.string()),
    warnings: z.array(z.string()),
  }),
  http: { method: "PATCH", path: "/v1/signal-definitions/:key" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [
    { title: "Turn off news mentions", input: { key: "news_mention", enabled: false } },
    { title: "Make job changes count longer", input: { key: "job_change", half_life_days: 90 } },
  ],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const definition = await requireDefinition(ctx, workspace.id, input.key);
    const set: Partial<typeof signal_definitions.$inferInsert> = {};
    const changed: string[] = [];
    const scalar = [
      "enabled",
      "name",
      "description",
      "weight",
      "half_life_days",
      "min_strength",
    ] as const;
    for (const field of scalar) {
      const value = input[field];
      if (value !== undefined && value !== definition[field]) {
        Object.assign(set, { [field]: value });
        changed.push(field);
      }
    }
    const detection: SignalDetection = { ...definition.detection };
    const detectionFields = ["collectors", "keywords", "instructions", "urls", "tier"] as const;
    for (const field of detectionFields) {
      const value = input[field];
      if (value === undefined) continue;
      if (JSON.stringify(value) !== JSON.stringify(detection[field])) {
        Object.assign(detection, { [field]: value });
        changed.push(field);
      }
    }
    if (detectionFields.some((field) => changed.includes(field))) set.detection = detection;
    let row = definition;
    if (changed.length > 0) {
      const [updated] = await ctx.db
        .update(signal_definitions)
        .set(set)
        .where(eq(signal_definitions.id, definition.id))
        .returning();
      if (updated) row = updated;
    }
    if (
      changed.some((field) =>
        ["enabled", "weight", "half_life_days", "min_strength"].includes(field),
      )
    ) {
      await queueIntentRecompute(ctx, workspace.id);
    }
    return {
      ...definitionView(row, "detailed"),
      changed,
      warnings: collectorWarnings(input.collectors ?? []),
    };
  },
});

export const definitionsCreate = defineOperation({
  id: "signals.definitions.create",
  summary: "Define a custom signal in plain English",
  description:
    "Creates a custom signal from a plain-English rule, for example 'Opened a new clinic location' or 'Mentions switching payroll providers'. Monitors then gather evidence with the chosen collectors and URLs, and the brain judges it against your description and instructions; a match must cite one of the gathered sources, otherwise it is discarded. Use it when no built-in signal (see signals.definitions.list) captures what predicts a deal for you; to tune a built-in use signals.definitions.update. Custom signals start conservative (min_strength 0.5) and cost one brain call per company when their evidence changed.",
  effect: "write",
  input: z.object({
    key: signalKeySchema,
    name: z.string().trim().min(3).max(120),
    description: z
      .string()
      .trim()
      .min(10)
      .max(2000)
      .describe("What counts as this signal and why it matters, in plain English"),
    instructions: z
      .string()
      .trim()
      .max(2000)
      .optional()
      .describe("How to judge evidence: what qualifies, what does not (default: the description)"),
    collectors: z
      .array(collectorName)
      .min(1)
      .max(12)
      .default(["website_changes", "news_gdelt", "rss"])
      .describe("Where evidence comes from (default website_changes, news_gdelt, rss)"),
    keywords: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
    urls: z
      .array(definitionUrl)
      .max(5)
      .default([])
      .describe(
        'Pages to read for every company: "/careers", "https://{domain}/blog" or full URLs',
      ),
    weight: z.number().int().min(1).max(100).default(40),
    half_life_days: z.number().int().min(1).max(365).default(30),
    min_strength: z.number().min(0).max(1).default(DEFAULT_CUSTOM_MIN_STRENGTH),
    tier: tierInput.default("fast"),
    enabled: z.boolean().default(true),
  }),
  output: definitionOutput.extend({ warnings: z.array(z.string()) }),
  http: { method: "POST", path: "/v1/signal-definitions" },
  dryRun: "none",
  idempotent: false,
  workspace: "required",
  examples: [
    {
      title: "Dental clinic opening a new location",
      input: {
        key: "new_clinic_location",
        name: "Opened a new clinic location",
        description:
          "The practice announced or opened an additional clinic location in the last 60 days. New sites need equipment and supplies.",
        collectors: ["website_changes", "news_gdelt"],
        urls: ["/locations", "/contact"],
        weight: 55,
        half_life_days: 45,
      },
    },
  ],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    if (isBuiltinKey(input.key)) {
      throw new OpenOutboundError("conflict", `"${input.key}" is a built-in signal key.`, {
        hint: `Tune it with manage_signals action update_definition (key "${input.key}"), or pick another key.`,
        details: { field: "key" },
      });
    }
    const existing = await findDefinition(ctx.db, workspace.id, input.key);
    if (existing) {
      throw new OpenOutboundError("conflict", `A signal with key "${input.key}" already exists.`, {
        hint: "Change it with manage_signals action update_definition, or pick another key.",
        details: { field: "key" },
      });
    }
    const [row] = await ctx.db
      .insert(signal_definitions)
      .values({
        workspace_id: workspace.id,
        key: input.key,
        name: input.name,
        description: input.description,
        kind: "custom",
        detection: {
          collectors: input.collectors,
          keywords: input.keywords,
          instructions: input.instructions ?? input.description,
          urls: input.urls,
          tier: input.tier,
        },
        weight: input.weight,
        half_life_days: input.half_life_days,
        min_strength: input.min_strength,
        enabled: input.enabled,
      })
      .onConflictDoNothing({ target: [signal_definitions.workspace_id, signal_definitions.key] })
      .returning();
    if (!row) {
      throw new OpenOutboundError("conflict", `A signal with key "${input.key}" already exists.`, {
        hint: "Change it with manage_signals action update_definition, or pick another key.",
      });
    }
    return { ...definitionView(row, "detailed"), warnings: collectorWarnings(input.collectors) };
  },
});

export const definitionsDelete = defineOperation({
  id: "signals.definitions.delete",
  summary: "Remove a custom signal definition",
  description:
    "Deletes a custom signal definition so monitors stop looking for it; signals already found stay in history but no longer count toward intent. Use it for custom signals that proved useless. Built-in signals cannot be removed: disable them with signals.definitions.update (enabled false). Monitors and automation rules that name the key simply stop matching it.",
  effect: "destructive",
  input: z.object({ key: signalKeySchema }),
  output: z.object({ key: z.string(), deleted: z.boolean() }),
  http: { method: "DELETE", path: "/v1/signal-definitions/:key" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Remove a custom signal", input: { key: "new_clinic_location" } }],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    if (isBuiltinKey(input.key)) {
      throw new OpenOutboundError("validation_failed", `"${input.key}" is a built-in signal.`, {
        hint: `Disable it instead: manage_signals action update_definition with key "${input.key}" and enabled false.`,
        details: { field: "key" },
      });
    }
    const deleted = await ctx.db
      .delete(signal_definitions)
      .where(
        and(
          eq(signal_definitions.workspace_id, workspace.id),
          eq(signal_definitions.key, input.key),
        ),
      )
      .returning({ id: signal_definitions.id });
    if (deleted.length > 0) await queueIntentRecompute(ctx, workspace.id);
    return { key: input.key, deleted: deleted.length > 0 };
  },
});

export const definitionOperations = [
  definitionsList,
  definitionsUpdate,
  definitionsCreate,
  definitionsDelete,
];
