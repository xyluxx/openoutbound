import { and, eq, isNull, like, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { BRAIN_WAIT_PREFIX, brainConfiguredWaitKey } from "../../brain/fallback.js";
import type { OpContext } from "../../core/context.js";
import { OpenOutboundError, toOpenOutboundError } from "../../core/errors.js";
import { defineOperation, isoDateTime } from "../../core/operation.js";
import type { ProviderSetting, Workspace } from "../../db/schema/index.js";
import { jobs, problems, provider_settings } from "../../db/schema/index.js";
import {
  type ProviderDefinition,
  type ProviderTestResult,
  SLOTS,
  type Slot,
} from "../../providers/types.js";
import { kernelOf, systemContext } from "../../runtime/context.js";
import { clearProviderHealth, providerDownKey } from "../../runtime/provider-health.js";
import {
  instantiateProvider,
  invalidateProviders,
  providerNotConfigured,
  type ResolvedProvider,
  resolveSlot,
} from "../../runtime/providers.js";
import { resolveProblemsFor } from "../problems/service.js";

const slotInput = z.enum(SLOTS).describe(`Provider slot: ${SLOTS.join(", ")}`);
const levelEnum = z.enum(["workspace", "instance"]);

function secretName(slot: Slot, provider: string, key: string): string {
  return `provider:${slot}:${provider}:${key}`;
}

function requireDefinition(ctx: OpContext, slot: Slot, id: string): ProviderDefinition {
  const catalog = kernelOf(ctx).registry.providers();
  const definition = catalog.find(slot, id);
  if (!definition) {
    const known = catalog
      .bySlot(slot)
      .filter((candidate) => !candidate.sandbox)
      .map((candidate) => candidate.id);
    throw new OpenOutboundError("validation_failed", `Unknown ${slot} provider "${id}".`, {
      hint: known.length
        ? `Use one of: ${known.join(", ")} (see manage_providers action catalog).`
        : `No ${slot} providers are installed.`,
      details: { field: "provider", slot, known },
    });
  }
  return definition;
}

/** Which rows a call manages: the workspace's, or instance-wide ones (unbound principals only). */
function resolveLevel(ctx: OpContext, requested: "workspace" | "instance" | undefined) {
  const level = requested ?? (ctx.workspace ? "workspace" : "instance");
  if (level === "instance" && ctx.principal.workspaceId) {
    throw new OpenOutboundError(
      "forbidden",
      "A workspace key cannot change instance-wide providers.",
      {
        hint: "Omit level (it defaults to your workspace), or use an instance admin key.",
        details: { reason: "workspace_scope" },
      },
    );
  }
  if (level === "workspace" && !ctx.workspace) {
    throw new OpenOutboundError("validation_failed", "level workspace needs a workspace.", {
      hint: "Pass `workspace`, or use level instance to configure every workspace at once.",
    });
  }
  return { level, workspaceId: level === "workspace" ? (ctx.workspace as Workspace).id : null };
}

async function findRow(
  ctx: OpContext,
  workspaceId: string | null,
  slot: Slot,
  provider: string,
): Promise<ProviderSetting | undefined> {
  const [row] = await ctx.db
    .select()
    .from(provider_settings)
    .where(
      and(
        workspaceId === null
          ? isNull(provider_settings.workspace_id)
          : eq(provider_settings.workspace_id, workspaceId),
        eq(provider_settings.slot, slot),
        eq(provider_settings.provider, provider),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Ends a provider health pause (runtime/provider-health.ts) after its settings changed or a
 * test passed: this process forgets the pause and the `provider_down` problems are resolved.
 * A workspace setting resolves that workspace's problem; an instance setting (workspaceId null)
 * resolves the problems of every workspace that used the instance setting or an env key.
 */
async function resumeProvider(
  ctx: OpContext,
  input: { workspaceId: string | null; slot: Slot; provider: string; resolution: string },
): Promise<void> {
  const kernel = kernelOf(ctx);
  clearProviderHealth(kernel.providerCache, {
    workspaceId: input.workspaceId,
    slot: input.slot,
    provider: input.provider,
  });
  if (input.slot === "brain") return;
  const dedupeKey = providerDownKey(input.slot, input.provider);
  if (input.workspaceId) {
    const target =
      ctx.workspace?.id === input.workspaceId
        ? ctx
        : await systemContext(kernel, input.workspaceId);
    await resolveProblemsFor(target, { dedupeKey }, input.resolution);
    return;
  }
  const rows = await ctx.db
    .selectDistinct({ workspace_id: problems.workspace_id })
    .from(problems)
    .where(
      and(
        eq(problems.dedupe_key, dedupeKey),
        ne(problems.status, "resolved"),
        sql`coalesce(${problems.data}->>'level', '') <> 'workspace'`,
      ),
    );
  for (const row of rows) {
    const target = await systemContext(kernel, row.workspace_id);
    await resolveProblemsFor(
      { ...target, principal: ctx.principal },
      { dedupeKey },
      input.resolution,
    );
  }
}

/**
 * Wakes the jobs parked until a brain is configured (`brain:configured:<workspace id>`): the
 * workspace's own, or every workspace's for an instance-level brain.
 */
async function wakeBrainWaiters(ctx: OpContext, workspaceId: string | null): Promise<number> {
  if (workspaceId) return ctx.jobs.wake(brainConfiguredWaitKey(workspaceId));
  const rows = await ctx.db
    .selectDistinct({ key: jobs.wait_for })
    .from(jobs)
    .where(and(eq(jobs.status, "waiting"), like(jobs.wait_for, `${BRAIN_WAIT_PREFIX}%`)));
  let woke = 0;
  for (const row of rows) if (row.key) woke += await ctx.jobs.wake(row.key);
  return woke;
}

function secretStatus(
  definition: ProviderDefinition,
  row: ProviderSetting | null,
  env: Record<string, string | undefined>,
) {
  const set: string[] = [];
  const missing: string[] = [];
  for (const spec of definition.secrets) {
    const fromRow = Boolean(row?.secret_ids?.[spec.key]);
    const fromEnv = Boolean(spec.env && env[spec.env]?.trim());
    if (fromRow || fromEnv) set.push(spec.key);
    else if (spec.required) missing.push(spec.key);
  }
  return { set, missing };
}

const secretSpecOutput = z.object({
  key: z.string(),
  label: z.string(),
  env: z.string().nullable(),
  required: z.boolean(),
  description: z.string().nullable(),
});

const catalogItem = z.object({
  slot: z.string(),
  id: z.string(),
  name: z.string(),
  description: z.string(),
  docs_url: z.string().nullable(),
  secrets: z.array(secretSpecOutput),
  sandbox: z.boolean(),
  configured: z.boolean().describe("Serves this workspace (or the instance) right now"),
  source: z.string().nullable().describe("workspace | instance | env | sandbox"),
  config_schema: z.record(z.string(), z.unknown()).nullable().optional(),
});

export const providerCatalog = defineOperation({
  id: "providers.catalog",
  summary: "List every available provider and whether it is configured",
  description:
    "Lists every provider plug-in (AI brains, lead sources, email finders and verifiers, research, signals, LinkedIn, social, CRM) with its slot, docs link, required secrets with their env var names, and whether it is configured for this workspace. Use it before manage_providers action set to learn the provider id and secret keys. Detailed format adds each provider's config JSON schema. It never reveals secret values.",
  effect: "read",
  input: z.object({ slot: slotInput.optional() }),
  output: z.object({ items: z.array(catalogItem), total: z.number() }),
  http: { method: "GET", path: "/v1/providers/catalog" },
  dryRun: "none",
  idempotent: true,
  workspace: "optional",
  examples: [{ title: "Research providers", input: { slot: "research" } }],
  handler: async (ctx, input) => {
    const kernel = kernelOf(ctx);
    const slots = input.slot ? [input.slot] : [...SLOTS];
    const detailed = ctx.request.responseFormat === "detailed";
    const items: Array<z.input<typeof catalogItem>> = [];
    for (const slot of slots) {
      const resolved = await resolveSlot(kernel, ctx.workspace, slot);
      for (const definition of kernel.registry.providers().bySlot(slot)) {
        const entry = resolved.find((candidate) => candidate.id === definition.id);
        let configSchema: Record<string, unknown> | null = null;
        if (detailed && definition.configSchema) {
          try {
            configSchema = z.toJSONSchema(definition.configSchema, {
              unrepresentable: "any",
            }) as Record<string, unknown>;
          } catch {
            configSchema = null;
          }
        }
        items.push({
          slot,
          id: definition.id,
          name: definition.name,
          description: definition.description,
          docs_url: definition.docsUrl ?? null,
          secrets: definition.secrets.map((spec) => ({
            key: spec.key,
            label: spec.label,
            env: spec.env ?? null,
            required: spec.required,
            description: spec.description ?? null,
          })),
          sandbox: definition.sandbox ?? false,
          configured: entry !== undefined,
          source: entry?.level ?? null,
          ...(detailed ? { config_schema: configSchema } : {}),
        });
      }
    }
    return { items, total: items.length };
  },
});

const configuredItem = z.object({
  slot: z.string(),
  provider: z.string(),
  name: z.string(),
  source: z.string().describe("workspace | instance | env | sandbox"),
  enabled: z.boolean(),
  priority: z.number(),
  config: z.record(z.string(), z.unknown()),
  secrets_set: z
    .array(z.string())
    .describe("Secret keys that have a value (values are never shown)"),
  secrets_missing: z.array(z.string()),
  updated_at: isoDateTime().nullable(),
});

function toConfiguredItem(
  entry: ResolvedProvider,
  env: Record<string, string | undefined>,
  enabled = true,
): z.input<typeof configuredItem> {
  const secrets = secretStatus(entry.definition, entry.row, env);
  return {
    slot: entry.slot,
    provider: entry.id,
    name: entry.definition.name,
    source: entry.level,
    enabled,
    priority: entry.row?.priority ?? 0,
    config: entry.row?.config ?? {},
    secrets_set: secrets.set,
    secrets_missing: secrets.missing,
    updated_at: entry.row?.updated_at ?? null,
  };
}

export const listProviders = defineOperation({
  id: "providers.list",
  summary: "List configured providers per slot",
  description:
    "Lists the providers that serve each slot for this workspace, in priority order, with where the setting comes from (workspace, instance, env var or sandbox), non-secret config, which secrets are set and which are missing, plus disabled entries. Use it to see why a provider is or is not used. Use providers.catalog to discover providers that are not configured yet. Secret values are never returned.",
  effect: "read",
  input: z.object({ slot: slotInput.optional() }),
  output: z.object({ items: z.array(configuredItem) }),
  http: { method: "GET", path: "/v1/providers" },
  dryRun: "none",
  idempotent: true,
  workspace: "optional",
  examples: [{ title: "Everything configured", input: {} }],
  handler: async (ctx, input) => {
    const kernel = kernelOf(ctx);
    const env = kernel.config.env as Record<string, string | undefined>;
    const items: Array<z.input<typeof configuredItem>> = [];
    for (const slot of input.slot ? [input.slot] : [...SLOTS]) {
      const resolved = await resolveSlot(kernel, ctx.workspace, slot);
      for (const entry of resolved) items.push(toConfiguredItem(entry, env));
      const disabled = await ctx.db
        .select()
        .from(provider_settings)
        .where(and(eq(provider_settings.slot, slot), eq(provider_settings.enabled, false)));
      for (const row of disabled) {
        if (row.workspace_id !== null && row.workspace_id !== ctx.workspace?.id) continue;
        const definition = kernel.registry.providers().find(slot, row.provider);
        if (!definition) continue;
        items.push(
          toConfiguredItem(
            {
              slot,
              id: row.provider,
              definition,
              level: row.workspace_id ? "workspace" : "instance",
              row,
            },
            env,
            false,
          ),
        );
      }
    }
    return { items };
  },
});

export const setProvider = defineOperation({
  id: "providers.set",
  summary: "Configure a provider (secrets, config, priority)",
  description:
    "Configures a provider for this workspace (or instance-wide with level instance): stores secrets encrypted in the vault, validates config against the provider schema, and sets enabled and priority (higher wins; waterfalls use the order). Use providers.catalog first for the provider id and secret keys; pass test: true to check the connection right away. Sending an empty string for a secret removes it. Env vars (e.g. EXA_API_KEY) keep working as a fallback without this.",
  effect: "admin",
  input: z.object({
    slot: slotInput,
    provider: z
      .string()
      .min(1)
      .describe("Provider id from the catalog, e.g. anthropic, apollo, exa"),
    level: levelEnum
      .optional()
      .describe("workspace (default when a workspace is given) or instance"),
    secrets: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Secret values by key, e.g. { "api_key": "..." }. Stored encrypted, never returned',
      ),
    config: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Non-secret settings (replaces the stored config)"),
    enabled: z.boolean().optional(),
    priority: z.number().int().min(-100).max(100).optional(),
    test: z.boolean().default(false).describe("Run the provider's connection test after saving"),
  }),
  output: configuredItem.extend({
    test: z.object({ ok: z.boolean(), message: z.string() }).nullable(),
  }),
  http: { method: "PUT", path: "/v1/providers/:slot/:provider" },
  dryRun: "none",
  idempotent: true,
  workspace: "optional",
  examples: [
    {
      title: "Exa for research",
      input: { slot: "research", provider: "exa", secrets: { api_key: "exa-key-from-dashboard" } },
    },
  ],
  handler: async (ctx, input) => {
    const kernel = kernelOf(ctx);
    const definition = requireDefinition(ctx, input.slot, input.provider);
    if (definition.sandbox) {
      throw new OpenOutboundError(
        "validation_failed",
        `"${definition.id}" is a sandbox provider.`,
        {
          hint: "Sandbox workspaces use sandbox providers automatically; nothing to configure.",
        },
      );
    }
    const { level, workspaceId } = resolveLevel(ctx, input.level);
    const existing = await findRow(ctx, workspaceId, input.slot, input.provider);

    let config = existing?.config ?? {};
    if (input.config !== undefined) {
      if (definition.configSchema) {
        const parsed = definition.configSchema.safeParse(input.config);
        if (!parsed.success) {
          throw new OpenOutboundError(
            "validation_failed",
            `Invalid config for ${definition.name}.`,
            {
              hint: "See the provider's config_schema in providers.catalog (response_format detailed).",
              details: {
                issues: parsed.error.issues.map((issue) => ({
                  path: issue.path.join("."),
                  message: issue.message,
                })),
              },
            },
          );
        }
      }
      config = input.config;
    }
    const secretIds = { ...(existing?.secret_ids ?? {}) };
    for (const [key, value] of Object.entries(input.secrets ?? {})) {
      if (!definition.secrets.some((spec) => spec.key === key)) {
        throw new OpenOutboundError(
          "validation_failed",
          `${definition.name} has no secret "${key}".`,
          {
            hint: `Secret keys: ${definition.secrets.map((spec) => spec.key).join(", ") || "none"}.`,
            details: { field: `secrets.${key}` },
          },
        );
      }
      if (value.trim() === "") {
        const id = secretIds[key];
        if (id) await ctx.vault.deleteSecret(id);
        delete secretIds[key];
        continue;
      }
      secretIds[key] = await ctx.vault.putSecret(
        workspaceId,
        secretName(input.slot, input.provider, key),
        value.trim(),
      );
    }
    const boundKey = Boolean(ctx.principal.workspaceId);
    const values = {
      workspace_id: workspaceId,
      slot: input.slot,
      provider: input.provider,
      enabled: input.enabled ?? existing?.enabled ?? true,
      priority: input.priority ?? existing?.priority ?? 0,
      config,
      secret_ids: secretIds,
      // Trusted again only when the instance owner sets the config themselves.
      set_by_workspace_key:
        boundKey || (input.config === undefined && (existing?.set_by_workspace_key ?? false)),
    };
    const [row] = existing
      ? await ctx.db
          .update(provider_settings)
          .set(values)
          .where(eq(provider_settings.id, existing.id))
          .returning()
      : await ctx.db.insert(provider_settings).values(values).returning();
    if (!row) throw new OpenOutboundError("internal", "Failed to save the provider settings.");
    invalidateProviders(kernel.providerCache, workspaceId);
    await resumeProvider(ctx, {
      workspaceId,
      slot: input.slot,
      provider: input.provider,
      resolution: `The ${definition.name} settings changed (manage_providers action set): calls go through again.`,
    });
    if (input.slot === "brain" && row.enabled) await wakeBrainWaiters(ctx, workspaceId);

    let test: { ok: boolean; message: string } | null = null;
    if (input.test) {
      const result = await runProviderTest(
        ctx,
        input.slot,
        input.provider,
        level === "workspace" ? ctx.workspace : null,
      );
      test = { ok: result.ok, message: result.message };
    }
    const env = kernel.config.env as Record<string, string | undefined>;
    return {
      ...toConfiguredItem(
        { slot: input.slot, id: input.provider, definition, level, row },
        env,
        row.enabled,
      ),
      test,
    };
  },
});

export const removeProvider = defineOperation({
  id: "providers.remove",
  summary: "Remove a provider configuration",
  description:
    "Deletes a provider setting and its stored secrets for this workspace (or instance-wide with level instance). Use it to stop using a provider or to fall back to the instance setting or env var. To keep the settings but stop using the provider, use providers.set enabled: false instead. Env vars cannot be removed here.",
  effect: "admin",
  input: z.object({
    slot: slotInput,
    provider: z.string().min(1),
    level: levelEnum.optional(),
  }),
  output: z.object({
    removed: z.boolean(),
    slot: z.string(),
    provider: z.string(),
    level: z.string(),
  }),
  http: { method: "DELETE", path: "/v1/providers/:slot/:provider" },
  dryRun: "none",
  idempotent: true,
  workspace: "optional",
  examples: [{ title: "Stop using Hunter", input: { slot: "email_finder", provider: "hunter" } }],
  handler: async (ctx, input) => {
    const { level, workspaceId } = resolveLevel(ctx, input.level);
    const row = await findRow(ctx, workspaceId, input.slot, input.provider);
    if (row) {
      for (const secretId of Object.values(row.secret_ids ?? {}))
        await ctx.vault.deleteSecret(secretId);
      await ctx.db.delete(provider_settings).where(eq(provider_settings.id, row.id));
      invalidateProviders(kernelOf(ctx).providerCache, workspaceId);
      await resumeProvider(ctx, {
        workspaceId,
        slot: input.slot,
        provider: input.provider,
        resolution: "The provider setting was removed (manage_providers action remove).",
      });
    }
    return { removed: Boolean(row), slot: input.slot, provider: input.provider, level };
  },
});

async function runProviderTest(
  ctx: OpContext,
  slot: Slot,
  providerId: string | undefined,
  workspace: Workspace | null,
): Promise<{
  ok: boolean;
  checked: boolean;
  provider: string | null;
  message: string;
  hint: string | null;
  latency_ms: number;
}> {
  const kernel = kernelOf(ctx);
  const started = Date.now();
  try {
    const entries = await resolveSlot(kernel, workspace, slot);
    let entry = providerId ? entries.find((candidate) => candidate.id === providerId) : entries[0];
    if (!entry && entries[0]?.level === "sandbox") entry = entries[0];
    if (!entry) throw providerNotConfigured(kernel, workspace, slot, providerId);
    const instance = await instantiateProvider(kernel, workspace, entry);
    const test = entry.definition.test as
      | ((instance: unknown) => Promise<ProviderTestResult>)
      | undefined;
    if (!test) {
      return {
        ok: true,
        checked: false,
        provider: entry.id,
        message:
          "Configuration is complete; this provider has no live test, so nothing was checked with it.",
        hint: null,
        latency_ms: Date.now() - started,
      };
    }
    const result = await test(instance);
    return {
      ok: result.ok,
      checked: result.checked !== false,
      provider: entry.id,
      message: result.message,
      hint: null,
      latency_ms: Date.now() - started,
    };
  } catch (error) {
    const failure = toOpenOutboundError(error);
    return {
      ok: false,
      checked: true,
      provider: providerId ?? null,
      message: failure.code === "internal" ? (error as Error).message : failure.message,
      hint: failure.hint ?? null,
      latency_ms: Date.now() - started,
    };
  }
}

export const testProvider = defineOperation({
  id: "providers.test",
  summary: "Check that a provider works",
  description:
    "Runs the provider's cheap live check (never spends credits) and reports ok, a one-line message, latency and a hint when it fails. Use it after providers.set or when calls fail with provider_error; a passing live check also ends a pause of the provider (provider_down). Without `provider` it tests the provider that currently serves the slot. Providers with no free check answer checked false: only their settings were looked at, so a pause stays; not configured providers return ok false with the fix in the hint.",
  effect: "read",
  input: z.object({ slot: slotInput, provider: z.string().optional() }),
  output: z.object({
    slot: z.string(),
    provider: z.string().nullable(),
    ok: z.boolean(),
    checked: z
      .boolean()
      .describe("False when nothing was verified live (no free check): a pause is not ended"),
    message: z.string(),
    hint: z.string().nullable(),
    latency_ms: z.number(),
  }),
  http: { method: "POST", path: "/v1/providers/:slot/test" },
  dryRun: "none",
  idempotent: true,
  workspace: "optional",
  examples: [{ title: "Test the brain", input: { slot: "brain" } }],
  handler: async (ctx, input) => {
    const result = await runProviderTest(ctx, input.slot, input.provider, ctx.workspace);
    // A passing live test ends a pause of this provider (provider health); a test that
    // checked nothing live (no free check) does not.
    if (result.ok && result.checked && result.provider) {
      await resumeProvider(ctx, {
        workspaceId: ctx.workspace?.id ?? null,
        slot: input.slot,
        provider: result.provider,
        resolution: `A provider test passed (manage_providers action test): ${result.message}`,
      });
    }
    return { slot: input.slot, ...result };
  },
});
