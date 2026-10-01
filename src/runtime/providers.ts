/**
 * Provider resolution (spec 4): workspace setting -> instance setting -> env vars -> not
 * configured. Sandbox workspaces resolve every slot to the `sandbox` provider (brain: `fake`
 * unless settings.sandbox.use_real_brain). Instances are cached per (workspace, slot, provider)
 * and rebuilt when the settings row changes (its updated_at is part of the cache key).
 * Instances handed to a workspace context are wrapped by provider health
 * (runtime/provider-health.ts): a provider with rejected credentials or no quota is paused.
 */
import { createHash, createHmac, hkdfSync } from "node:crypto";
import { and, eq, isNull, or } from "drizzle-orm";
import { resolveSecretKey } from "../core/config.js";
import type { OpContext, ProviderResolver } from "../core/context.js";
import { OpenOutboundError } from "../core/errors.js";
import { parseWorkspaceSettings } from "../core/settings.js";
import { type ProviderSetting, provider_settings, type Workspace } from "../db/schema/index.js";
import type {
  ProviderDefinition,
  ProviderRuntime,
  Slot,
  SlotInterfaces,
} from "../providers/types.js";
import type { Kernel } from "./kernel.js";
import {
  HEALTH_METHODS,
  loadProviderHealth,
  type ProviderHealthStore,
  trackProviderHealth,
} from "./provider-health.js";

const INSTANCE_TTL_MS = 10 * 60 * 1000;

export type ProviderLevel = "workspace" | "instance" | "env" | "sandbox" | "explicit";

export interface ResolvedProvider<S extends Slot = Slot> {
  slot: S;
  id: string;
  definition: ProviderDefinition<S>;
  level: ProviderLevel;
  row: ProviderSetting | null;
}

interface CacheEntry {
  version: string;
  createdAt: number;
  instance: Promise<unknown>;
}

export interface ProviderCache {
  entries: Map<string, CacheEntry>;
  /** Provider health per workspace, slot and provider (see runtime/provider-health.ts). */
  health: ProviderHealthStore;
}

export function createProviderCache(): ProviderCache {
  return { entries: new Map(), health: new Map() };
}

/** Drops cached instances for a workspace (or instance-level ones for null; everything for undefined). */
export function invalidateProviders(cache: ProviderCache, workspaceId?: string | null): void {
  if (workspaceId === undefined) {
    cache.entries.clear();
    return;
  }
  const prefix = `${workspaceId ?? "-"}:`;
  for (const key of cache.entries.keys()) {
    if (key.startsWith(prefix) || workspaceId === null) cache.entries.delete(key);
  }
}

/** True when the slot resolves to the sandbox provider for this workspace. */
export function usesSandboxProviders(workspace: Workspace | null, slot: Slot): boolean {
  if (!workspace?.is_sandbox) return false;
  if (slot !== "brain") return true;
  return !parseWorkspaceSettings(workspace.settings).sandbox.use_real_brain;
}

function byPriority(a: ProviderSetting, b: ProviderSetting): number {
  return b.priority - a.priority || a.created_at.getTime() - b.created_at.getTime();
}

function envValue(kernel: Pick<Kernel, "config">, name: string | undefined): string | null {
  if (!name) return null;
  const value = kernel.config.env[name]?.trim();
  return value ? value : null;
}

/** Providers available for a slot, highest priority first (workspace rows, instance rows, env). */
export async function resolveSlot<S extends Slot>(
  kernel: Kernel,
  workspace: Workspace | null,
  slot: S,
): Promise<ResolvedProvider<S>[]> {
  const catalog = kernel.registry.providers();
  if (usesSandboxProviders(workspace, slot)) {
    const id = slot === "brain" ? "fake" : "sandbox";
    const definition = catalog.find(slot, id);
    return definition ? [{ slot, id, definition, level: "sandbox", row: null }] : [];
  }
  const rows = await kernel.db
    .select()
    .from(provider_settings)
    .where(
      and(
        eq(provider_settings.slot, slot),
        workspace
          ? or(
              eq(provider_settings.workspace_id, workspace.id),
              isNull(provider_settings.workspace_id),
            )
          : isNull(provider_settings.workspace_id),
      ),
    );
  const out: ResolvedProvider<S>[] = [];
  const seen = new Set<string>();
  const levels: Array<[ProviderLevel, ProviderSetting[]]> = [
    [
      "workspace",
      rows.filter((row) => workspace && row.workspace_id === workspace.id).sort(byPriority),
    ],
    ["instance", rows.filter((row) => row.workspace_id === null).sort(byPriority)],
  ];
  for (const [level, levelRows] of levels) {
    for (const row of levelRows) {
      if (seen.has(row.provider)) continue;
      seen.add(row.provider);
      if (!row.enabled) continue;
      const definition = catalog.find(slot, row.provider);
      if (!definition) {
        kernel.log.warn(
          { slot, provider: row.provider },
          "provider setting for an unknown provider",
        );
        continue;
      }
      if (definition.sandbox) continue;
      out.push({ slot, id: row.provider, definition, level, row });
    }
  }
  for (const definition of catalog.bySlot(slot)) {
    if (seen.has(definition.id) || definition.sandbox) continue;
    const required = definition.secrets.filter((secret) => secret.required);
    if (required.length === 0) continue; // keyless providers are only used when configured
    if (required.every((secret) => envValue(kernel, secret.env) !== null)) {
      out.push({ slot, id: definition.id, definition, level: "env", row: null });
    }
  }
  return out;
}

/** Config fields that point a provider at another server (base_url, dsn, api_url, host...). */
const ENDPOINT_FIELD = /(?:^|_)(?:url|dsn|host|endpoint)$/i;
/** Untrusted provider traffic: generous limits, since model calls can take minutes. */
const UNTRUSTED_FETCH_TIMEOUT_MS = 10 * 60_000;
const UNTRUSTED_FETCH_MAX_BYTES = 25 * 1024 * 1024;

export function hasCustomEndpoint(config: unknown): boolean {
  if (!config || typeof config !== "object") return false;
  return Object.entries(config as Record<string, unknown>).some(
    ([key, value]) => ENDPOINT_FIELD.test(key) && typeof value === "string" && value.trim() !== "",
  );
}

/** The setting was last configured by a workspace-bound key, not by the instance owner. */
function setByWorkspaceKey(entry: ResolvedProvider): boolean {
  return entry.level === "workspace" && entry.row?.set_by_workspace_key === true;
}

/**
 * fetch for providers configured by a workspace-bound key: the SSRF-safe fetch (public
 * addresses only unless OPENOUTBOUND_ALLOW_PRIVATE_NETWORK, pinned connections, checked
 * redirects) with limits that fit API calls.
 */
function untrustedProviderFetch(kernel: Kernel): typeof globalThis.fetch {
  return async (input, init) => {
    if (input instanceof Request) {
      const body = input.body ? await input.arrayBuffer() : null;
      return kernel.safeFetch(input.url, {
        method: input.method,
        headers: input.headers,
        body,
        signal: init?.signal ?? input.signal,
        timeoutMs: UNTRUSTED_FETCH_TIMEOUT_MS,
        maxBytes: UNTRUSTED_FETCH_MAX_BYTES,
      });
    }
    return kernel.safeFetch(input, {
      ...init,
      timeoutMs: UNTRUSTED_FETCH_TIMEOUT_MS,
      maxBytes: UNTRUSTED_FETCH_MAX_BYTES,
    });
  };
}

async function loadSecrets(
  kernel: Kernel,
  entry: ResolvedProvider,
  workspace: Workspace | null,
): Promise<Record<string, string>> {
  const secrets: Record<string, string> = {};
  // Shared keys (env) are never sent to an endpoint that a workspace-bound key chose.
  const ownKeysOnly = setByWorkspaceKey(entry) && hasCustomEndpoint(entry.row?.config);
  for (const spec of entry.definition.secrets) {
    const secretId = entry.row?.secret_ids?.[spec.key];
    let value: string | null = null;
    if (secretId) value = await kernel.vault.getSecret(secretId, entry.row?.workspace_id ?? null);
    if (!ownKeysOnly) value ??= envValue(kernel, spec.env);
    if (value !== null) secrets[spec.key] = value;
    else if (spec.required && ownKeysOnly) {
      throw new OpenOutboundError(
        "provider_not_configured",
        `${entry.definition.name} points at a custom endpoint for this workspace, so it needs its own ${spec.label}.`,
        {
          hint: `Store it on the workspace setting: \`openoutbound providers set --slot ${entry.slot} --provider ${entry.id} --secrets '{"${spec.key}":"..."}'\`. Shared instance keys are never sent to endpoints chosen by a workspace key.`,
          details: {
            slot: entry.slot,
            provider: entry.id,
            secret: spec.key,
            workspace: workspace?.slug ?? null,
            reason: "custom_endpoint_needs_own_key",
          },
        },
      );
    } else if (spec.required) {
      throw new OpenOutboundError(
        "provider_not_configured",
        `${entry.definition.name} is missing its ${spec.label}.`,
        {
          hint: `Run \`openoutbound providers set --slot ${entry.slot} --provider ${entry.id} --secrets '{"${spec.key}":"..."}'\`${spec.env ? ` or set ${spec.env}` : ""}.`,
          details: {
            slot: entry.slot,
            provider: entry.id,
            secret: spec.key,
            workspace: workspace?.slug ?? null,
          },
        },
      );
    }
  }
  return secrets;
}

function parseConfig(entry: ResolvedProvider, raw: unknown): unknown {
  const schema = entry.definition.configSchema;
  if (!schema) return raw ?? {};
  const parsed = schema.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;
  throw new OpenOutboundError(
    "provider_not_configured",
    `The ${entry.definition.name} configuration is invalid: ${parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ")}.`,
    {
      hint: `Fix it with \`openoutbound providers set --slot ${entry.slot} --provider ${entry.id} --config '{...}'\`.`,
      details: { slot: entry.slot, provider: entry.id },
    },
  );
}

const fingerprints = new WeakMap<object, string>();
const fingerprintKeys = new WeakMap<object, Buffer | null>();

/** A key only this engine knows, so a fingerprint says nothing about the secrets it covers. */
function fingerprintKey(kernel: Kernel): Buffer | null {
  if (fingerprintKeys.has(kernel.config)) return fingerprintKeys.get(kernel.config) ?? null;
  let key: Buffer | null = null;
  try {
    const secret = resolveSecretKey(kernel.config);
    key = Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), "provider-fingerprint", 32));
  } catch {
    key = null;
  }
  fingerprintKeys.set(kernel.config, key);
  return key;
}

/**
 * A short fingerprint of what an instance was built with (where the setting came from, its
 * config and secrets): provider health lets a call through when it changes. Keyed with the
 * engine secret key, so it can be stored next to a problem without revealing anything.
 */
function fingerprintOf(
  kernel: Kernel,
  entry: ResolvedProvider,
  config: unknown,
  secrets: Record<string, string>,
): string {
  const key = fingerprintKey(kernel);
  const setting = [entry.level, entry.id, entry.row?.id ?? null];
  if (!key) {
    const version = entry.row?.updated_at.getTime() ?? null;
    return createHash("sha256")
      .update(JSON.stringify([...setting, version]))
      .digest("hex")
      .slice(0, 16);
  }
  const values = Object.entries(secrets).sort(([a], [b]) => (a < b ? -1 : 1));
  return createHmac("sha256", key)
    .update(JSON.stringify([...setting, config ?? null, values]))
    .digest("hex")
    .slice(0, 16);
}

/** The fingerprint of an instance built by `instantiateProvider`, or null. */
export function providerFingerprint(instance: unknown): string | null {
  return instance && typeof instance === "object" ? (fingerprints.get(instance) ?? null) : null;
}

/** Builds (or reuses) the provider instance for a resolved entry. */
export function instantiateProvider<S extends Slot>(
  kernel: Kernel,
  workspace: Workspace | null,
  entry: ResolvedProvider<S>,
): Promise<SlotInterfaces[S]> {
  const key = `${workspace?.id ?? "-"}:${entry.slot}:${entry.id}`;
  const version = `${entry.level}:${entry.row?.id ?? ""}:${entry.row?.updated_at.getTime() ?? ""}`;
  const now = kernel.clock.now().getTime();
  const cached = kernel.providerCache.entries.get(key);
  if (cached && cached.version === version && now - cached.createdAt < INSTANCE_TTL_MS) {
    return cached.instance as Promise<SlotInterfaces[S]>;
  }
  const runtime: ProviderRuntime = {
    fetch: setByWorkspaceKey(entry) ? untrustedProviderFetch(kernel) : kernel.providerFetch,
    safeFetch: kernel.safeFetch,
    log: kernel.log.child({ provider: entry.id, slot: entry.slot }),
    clock: kernel.clock,
    baseUrl: kernel.config.baseUrl,
    workspaceId: workspace?.id ?? null,
    db: kernel.db,
  };
  const instance = (async () => {
    const config = parseConfig(entry, entry.row?.config);
    const secrets = await loadSecrets(kernel, entry, workspace);
    const created = await entry.definition.create({ config, secrets, ctx: runtime });
    if (created && typeof created === "object") {
      fingerprints.set(created, fingerprintOf(kernel, entry, config, secrets));
    }
    return created;
  })();
  kernel.providerCache.entries.set(key, { version, createdAt: now, instance });
  instance.catch(() => {
    if (kernel.providerCache.entries.get(key)?.instance === instance) {
      kernel.providerCache.entries.delete(key);
    }
  });
  return instance;
}

export function providerNotConfigured(
  kernel: Kernel,
  workspace: Workspace | null,
  slot: Slot,
  id?: string,
): OpenOutboundError {
  const where = workspace ? ` for workspace "${workspace.slug}"` : "";
  if (usesSandboxProviders(workspace, slot)) {
    return new OpenOutboundError(
      "provider_not_configured",
      `The sandbox ${slot} provider is not installed${where}.`,
      {
        hint:
          slot === "brain"
            ? "Sandbox workspaces use the fake brain from the brain module; make sure it is loaded, or set settings.sandbox.use_real_brain to true."
            : "Sandbox workspaces use the sandbox module's providers; make sure the sandbox module is loaded.",
        details: { slot, provider: id ?? null },
      },
    );
  }
  const definitions = kernel.registry
    .providers()
    .bySlot(slot)
    .filter((definition) => !definition.sandbox);
  const example =
    (id ? definitions.find((definition) => definition.id === id) : undefined) ??
    definitions.find((definition) => definition.secrets.some((s) => s.required && s.env)) ??
    definitions[0];
  const envVar = example?.secrets.find((secret) => secret.required && secret.env)?.env;
  const hint = example
    ? `Run \`openoutbound providers set --slot ${slot} --provider ${example.id}\`${envVar ? ` or set ${envVar}` : ""}.`
    : `No ${slot} provider is installed in this engine.`;
  return new OpenOutboundError(
    "provider_not_configured",
    id
      ? `The ${slot} provider "${id}" is not configured${where}.`
      : `No ${slot} provider is configured${where}.`,
    {
      hint,
      details: { slot, provider: id ?? null, available: definitions.map((d) => d.id) },
    },
  );
}

export interface ProviderResolverOptions {
  /**
   * A context of the workspace (system principal) for provider health bookkeeping. Without it
   * instances are handed out as they are, with no pause and no `provider_down` problems.
   */
  healthContext?: () => OpContext;
}

/** True when provider health guards this entry's calls. */
function tracksHealth(entry: ResolvedProvider, workspace: Workspace | null): boolean {
  return (
    workspace !== null &&
    entry.slot !== "brain" &&
    entry.level !== "sandbox" &&
    entry.definition.sandbox !== true &&
    entry.definition.health !== false &&
    entry.slot in HEALTH_METHODS
  );
}

/** The ProviderResolver of a context. */
export function createProviderResolver(
  kernel: Kernel,
  workspace: Workspace | null,
  options: ProviderResolverOptions = {},
): ProviderResolver {
  const build = async <S extends Slot>(entry: ResolvedProvider<S>): Promise<SlotInterfaces[S]> => {
    const instance = await instantiateProvider(kernel, workspace, entry);
    const context = options.healthContext;
    if (!context || !workspace || !tracksHealth(entry, workspace)) return instance;
    const binding = {
      store: kernel.providerCache.health,
      workspaceId: workspace.id,
      slot: entry.slot as Exclude<Slot, "brain">,
      provider: entry.id,
      name: entry.definition.name,
      level: entry.level,
      settings: providerFingerprint(instance),
      clock: kernel.clock,
      log: kernel.log,
      context,
    };
    await loadProviderHealth(kernel.db, binding);
    return trackProviderHealth(instance as SlotInterfaces[S] & object, binding);
  };
  const pick = async <S extends Slot>(slot: S, id?: string): Promise<SlotInterfaces[S] | null> => {
    const entries = await resolveSlot(kernel, workspace, slot);
    const first = entries[0];
    if (id === undefined || first?.level === "sandbox") {
      return first ? build(first) : null;
    }
    const entry = entries.find((candidate) => candidate.id === id);
    if (entry) return build(entry);
    const definition = kernel.registry.providers().find(slot, id);
    if (
      definition &&
      !definition.sandbox &&
      !usesSandboxProviders(workspace, slot) &&
      definition.secrets.every((secret) => !secret.required)
    ) {
      return build({
        slot,
        id,
        definition,
        level: "explicit",
        row: null,
      });
    }
    return null;
  };
  return {
    async get(slot, options) {
      const instance = await pick(slot, options?.id);
      if (!instance) throw providerNotConfigured(kernel, workspace, slot, options?.id);
      return instance;
    },
    async tryGet(slot, options) {
      try {
        return await pick(slot, options?.id);
      } catch (error) {
        if (error instanceof OpenOutboundError && error.code === "provider_not_configured")
          return null;
        throw error;
      }
    },
    async list(slot) {
      const entries = await resolveSlot(kernel, workspace, slot);
      return Promise.all(entries.map((entry) => build(entry)));
    },
  };
}
