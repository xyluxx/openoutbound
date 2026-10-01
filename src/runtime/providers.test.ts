import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { EngineModule } from "../core/operation.js";
import { provider_settings, secrets, type Workspace, workspaces } from "../db/schema/index.js";
import { module as providersAdmin } from "../modules/providers-admin/index.js";
import { builtinProviders } from "../providers/all.js";
import {
  defineProvider,
  type ProviderDefinition,
  type SecretSpec,
  type Slot,
} from "../providers/types.js";
import { createTestEngine, type TestEngine } from "../testing/engine.js";
import {
  createProviderResolver,
  invalidateProviders,
  resolveSlot,
  usesSandboxProviders,
} from "./providers.js";

interface Created {
  id: string;
  config: unknown;
  secrets: Record<string, string>;
  workspaceId: string | null;
}
const created: Created[] = [];

function verifier(
  id: string,
  secretSpecs: SecretSpec[],
  extra: Partial<ProviderDefinition<"email_verifier">> = {},
): ProviderDefinition<"email_verifier"> {
  return defineProvider<"email_verifier">({
    slot: "email_verifier",
    id,
    name: `Test ${id}`,
    description: "Verifier used by the runtime tests.",
    secrets: secretSpecs,
    create: ({ config, secrets: values, ctx }) => {
      created.push({ id, config, secrets: values, workspaceId: ctx.workspaceId });
      return {
        id,
        verify: async () => {
          throw new Error("not used in tests");
        },
      };
    },
    ...extra,
  });
}

const alpha = defineProvider<"email_verifier", { region: "us" | "eu" }>({
  slot: "email_verifier",
  id: "test_alpha",
  name: "Test alpha",
  description: "Needs an API key, has config and a live test.",
  configSchema: z.object({ region: z.enum(["us", "eu"]).default("us") }),
  secrets: [{ key: "api_key", label: "API key", env: "TEST_ALPHA_API_KEY", required: true }],
  create: ({ config, secrets: values, ctx }) => {
    created.push({ id: "test_alpha", config, secrets: values, workspaceId: ctx.workspaceId });
    return {
      id: "test_alpha",
      verify: async () => {
        throw new Error("not used in tests");
      },
    };
  },
  test: async () => ({ ok: true, message: "Connected to alpha" }),
});
const beta = verifier(
  "test_beta",
  [{ key: "token", label: "API token", env: "TEST_BETA_TOKEN", required: true }],
  { test: async () => ({ ok: false, message: "Beta rejected the token" }) },
);
const keyless = verifier("test_keyless", []);
const optional = verifier("test_optional", [
  { key: "api_key", label: "API key", env: "TEST_OPTIONAL_KEY", required: false },
]);

const builtin = (slot: Slot, id: string) =>
  builtinProviders.some((definition) => definition.slot === slot && definition.id === id);
const sandboxProviders: ProviderDefinition[] = [];
if (!builtin("email_verifier", "sandbox")) {
  sandboxProviders.push(verifier("sandbox", [], { sandbox: true }) as ProviderDefinition);
}
if (!builtin("brain", "fake")) {
  sandboxProviders.push(
    defineProvider<"brain">({
      slot: "brain",
      id: "fake",
      name: "Fake brain",
      description: "Sandbox brain for tests.",
      sandbox: true,
      secrets: [],
      create: () => {
        throw new Error("not instantiated in these tests");
      },
    }) as ProviderDefinition,
  );
}

const plugins: EngineModule = {
  name: "plugins",
  providers: [alpha, beta, keyless, optional, ...sandboxProviders] as ProviderDefinition[],
};

let engine: TestEngine;
let acme: Workspace;
let globex: Workspace;
let practice: Workspace;

const kernel = () => engine.runtime.kernel;
const ids = async (workspace: Workspace | null) =>
  (await resolveSlot(kernel(), workspace, "email_verifier")).map(
    (entry) => `${entry.id}:${entry.level}`,
  );
const set = (input: Record<string, unknown>, workspace?: string) =>
  engine.call("providers.set", input, workspace ? { workspace } : {});

beforeAll(async () => {
  engine = await createTestEngine({
    modules: [providersAdmin, plugins],
    config: { env: { TEST_ALPHA_API_KEY: "alpha-from-env" } },
  });
  const rows = await engine.db
    .insert(workspaces)
    .values([
      { slug: "acme", name: "Acme" },
      { slug: "globex", name: "Globex" },
      { slug: "practice", name: "Practice", is_sandbox: true },
    ])
    .returning();
  [acme, globex, practice] = rows as [Workspace, Workspace, Workspace];
});
afterAll(async () => {
  await engine.close();
});
beforeEach(async () => {
  created.length = 0;
  await engine.db.delete(provider_settings);
  await engine.db.delete(secrets);
  invalidateProviders(kernel().providerCache);
});

describe("provider resolution", () => {
  it("falls back to env only for providers whose required secrets are all set", async () => {
    expect(await ids(acme)).toEqual(["test_alpha:env"]);
    expect(await ids(null)).toEqual(["test_alpha:env"]);
    const resolver = createProviderResolver(kernel(), acme);
    const instance = await resolver.get("email_verifier");
    expect(instance.id).toBe("test_alpha");
    expect(created).toEqual([
      {
        id: "test_alpha",
        config: { region: "us" },
        secrets: { api_key: "alpha-from-env" },
        workspaceId: acme.id,
      },
    ]);
  });

  it("orders workspace rows, then instance rows, then env, by priority", async () => {
    await set({
      slot: "email_verifier",
      provider: "test_beta",
      secrets: { token: "beta-instance" },
    });
    expect(await ids(acme)).toEqual(["test_beta:instance", "test_alpha:env"]);

    await set({ slot: "email_verifier", provider: "test_keyless", priority: 5 }, "acme");
    await set(
      {
        slot: "email_verifier",
        provider: "test_alpha",
        priority: 10,
        secrets: { api_key: "alpha-acme" },
        config: { region: "eu" },
      },
      "acme",
    );
    expect(await ids(acme)).toEqual([
      "test_alpha:workspace",
      "test_keyless:workspace",
      "test_beta:instance",
    ]);
    expect(await ids(globex)).toEqual(["test_beta:instance", "test_alpha:env"]);

    const resolver = createProviderResolver(kernel(), acme);
    expect((await resolver.get("email_verifier")).id).toBe("test_alpha");
    expect((await resolver.get("email_verifier", { id: "test_beta" })).id).toBe("test_beta");
    expect((await resolver.list("email_verifier")).map((instance) => instance.id)).toEqual([
      "test_alpha",
      "test_keyless",
      "test_beta",
    ]);
    expect(created.find((entry) => entry.id === "test_alpha")).toMatchObject({
      config: { region: "eu" },
      secrets: { api_key: "alpha-acme" },
    });
    expect(created.find((entry) => entry.id === "test_beta")?.secrets).toEqual({
      token: "beta-instance",
    });

    const listed = await engine.call(
      "providers.list",
      { slot: "email_verifier" },
      { workspace: "acme" },
    );
    expect(JSON.stringify(listed)).not.toMatch(/beta-instance|alpha-acme|alpha-from-env/);
    expect(
      (listed as { items: Array<{ provider: string; secrets_set: string[] }> }).items[0],
    ).toMatchObject({
      provider: "test_alpha",
      secrets_set: ["api_key"],
    });
  });

  it("lets a disabled workspace row hide instance and env settings of that provider", async () => {
    await set({
      slot: "email_verifier",
      provider: "test_beta",
      secrets: { token: "beta-instance" },
    });
    await set({ slot: "email_verifier", provider: "test_beta", enabled: false }, "acme");
    await set({ slot: "email_verifier", provider: "test_alpha", enabled: false }, "acme");
    expect(await ids(acme)).toEqual([]);
    expect(await ids(globex)).toEqual(["test_beta:instance", "test_alpha:env"]);
    const listed = (await engine.call(
      "providers.list",
      { slot: "email_verifier" },
      { workspace: "acme" },
    )) as { items: Array<{ provider: string; enabled: boolean; source: string }> };
    expect(listed.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "test_beta", enabled: false, source: "workspace" }),
      ]),
    );
    await expect(
      createProviderResolver(kernel(), acme).get("email_verifier"),
    ).rejects.toMatchObject({
      code: "provider_not_configured",
    });
  });

  it("gives actionable errors for missing providers, secrets and config", async () => {
    const resolver = createProviderResolver(kernel(), acme);
    expect((await resolver.get("email_verifier", { id: "test_keyless" })).id).toBe("test_keyless");
    await expect(resolver.get("email_verifier", { id: "test_beta" })).rejects.toMatchObject({
      code: "provider_not_configured",
      hint: expect.stringContaining(
        "openoutbound providers set --slot email_verifier --provider test_beta` or set TEST_BETA_TOKEN",
      ),
    });
    await expect(resolver.tryGet("email_verifier", { id: "test_beta" })).resolves.toBeNull();

    await set({ slot: "email_verifier", provider: "test_beta" });
    await expect(resolver.get("email_verifier", { id: "test_beta" })).rejects.toMatchObject({
      code: "provider_not_configured",
      message: "Test test_beta is missing its API token.",
      hint: expect.stringContaining(`--secrets '{"token":"..."}'\` or set TEST_BETA_TOKEN`),
    });

    await set({ slot: "email_verifier", provider: "test_alpha" }, "acme");
    await engine.db
      .update(provider_settings)
      .set({ config: { region: "mars" } })
      .where(eq(provider_settings.provider, "test_alpha"));
    await expect(resolver.get("email_verifier", { id: "test_alpha" })).rejects.toMatchObject({
      code: "provider_not_configured",
      hint: expect.stringContaining("--config"),
    });
    await expect(
      set({ slot: "email_verifier", provider: "test_alpha", config: { region: "mars" } }, "acme"),
    ).rejects.toMatchObject({ code: "validation_failed" });
    await expect(
      set({ slot: "email_verifier", provider: "test_alpha", secrets: { password: "x" } }, "acme"),
    ).rejects.toMatchObject({ code: "validation_failed", hint: "Secret keys: api_key." });
    await expect(set({ slot: "email_verifier", provider: "nope" }, "acme")).rejects.toMatchObject({
      code: "validation_failed",
    });
  });

  it("serves sandbox workspaces from sandbox providers only", async () => {
    await set({
      slot: "email_verifier",
      provider: "test_beta",
      secrets: { token: "beta-instance" },
    });
    expect(usesSandboxProviders(practice, "email_verifier")).toBe(true);
    expect(usesSandboxProviders(acme, "email_verifier")).toBe(false);
    expect(await ids(practice)).toEqual(["sandbox:sandbox"]);
    const brain = await resolveSlot(kernel(), practice, "brain");
    expect(brain.map((entry) => `${entry.id}:${entry.level}`)).toEqual(["fake:sandbox"]);
    const realBrain = { ...practice, settings: { sandbox: { use_real_brain: true } } } as Workspace;
    expect(usesSandboxProviders(realBrain, "brain")).toBe(false);
    expect(usesSandboxProviders(realBrain, "email_verifier")).toBe(true);

    await engine.db.insert(provider_settings).values({
      workspace_id: acme.id,
      slot: "email_verifier",
      provider: "sandbox",
    });
    expect(await ids(acme)).toEqual(["test_beta:instance", "test_alpha:env"]);
    await expect(
      set({ slot: "email_verifier", provider: "sandbox" }, "acme"),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("caches instances until the setting changes or the TTL passes", async () => {
    const resolver = createProviderResolver(kernel(), acme);
    const first = await resolver.get("email_verifier");
    expect(await resolver.get("email_verifier")).toBe(first);
    expect(created).toHaveLength(1);

    await set(
      { slot: "email_verifier", provider: "test_alpha", secrets: { api_key: "rotated" } },
      "acme",
    );
    const second = await resolver.get("email_verifier");
    expect(second).not.toBe(first);
    expect(created.at(-1)?.secrets).toEqual({ api_key: "rotated" });

    engine.advance(11 * 60_000);
    const third = await resolver.get("email_verifier");
    expect(third).not.toBe(second);
    expect(created).toHaveLength(3);

    await engine.call(
      "providers.remove",
      { slot: "email_verifier", provider: "test_alpha" },
      {
        workspace: "acme",
      },
    );
    expect(await engine.db.select().from(secrets)).toHaveLength(0);
    expect(await ids(acme)).toEqual(["test_alpha:env"]);
    await resolver.get("email_verifier");
    expect(created.at(-1)?.secrets).toEqual({ api_key: "alpha-from-env" });
  });
});

describe("provider admin operations", () => {
  it("reports the catalog and runs live tests without leaking secrets", async () => {
    await set({
      slot: "email_verifier",
      provider: "test_beta",
      secrets: { token: "beta-instance" },
    });
    const catalog = (await engine.call(
      "providers.catalog",
      { slot: "email_verifier" },
      { workspace: "acme", responseFormat: "detailed" },
    )) as {
      items: Array<{
        id: string;
        configured: boolean;
        source: string | null;
        secrets: Array<{ env: string | null }>;
        config_schema?: Record<string, unknown> | null;
      }>;
    };
    const byId = Object.fromEntries(catalog.items.map((item) => [item.id, item]));
    expect(byId.test_alpha).toMatchObject({
      configured: true,
      source: "env",
      secrets: [{ env: "TEST_ALPHA_API_KEY" }],
    });
    expect(byId.test_alpha?.config_schema).toMatchObject({ type: "object" });
    expect(byId.test_beta).toMatchObject({ configured: true, source: "instance" });
    expect(byId.test_keyless).toMatchObject({ configured: false, source: null });
    expect(JSON.stringify(catalog)).not.toMatch(/beta-instance|alpha-from-env/);

    await expect(
      engine.call("providers.test", { slot: "email_verifier" }, { workspace: "acme" }),
    ).resolves.toMatchObject({
      ok: false,
      provider: "test_beta",
      message: "Beta rejected the token",
    });
    await expect(
      engine.call(
        "providers.test",
        { slot: "email_verifier", provider: "test_alpha" },
        { workspace: "acme" },
      ),
    ).resolves.toMatchObject({ ok: true, message: "Connected to alpha" });
    await expect(
      engine.call("providers.test", { slot: "crm" }, { workspace: "acme" }),
    ).resolves.toMatchObject({ ok: false, message: expect.stringContaining("No crm provider") });
    const withTest = await set(
      { slot: "email_verifier", provider: "test_alpha", secrets: { api_key: "k" }, test: true },
      "acme",
    );
    expect(withTest).toMatchObject({ source: "workspace", test: { ok: true } });
  });

  it("keeps workspace keys away from instance-wide providers", async () => {
    const principal = engine.principal({ workspaceId: acme.id });
    await expect(
      engine.call(
        "providers.set",
        { slot: "email_verifier", provider: "test_keyless", level: "instance" },
        { principal },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    const own = await engine.call(
      "providers.set",
      { slot: "email_verifier", provider: "test_keyless" },
      { principal },
    );
    expect(own).toMatchObject({ source: "workspace" });
    await expect(
      engine.call("providers.set", {
        slot: "email_verifier",
        provider: "test_keyless",
        level: "workspace",
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });
});

describe("providers configured by a workspace key", () => {
  it("never borrow shared keys for custom endpoints and fetch through the safe fetch", async () => {
    const safeFetch = vi.fn(async () => new Response("ok"));
    const providerFetch = vi.fn(async () => new Response("ok"));
    let captured: typeof globalThis.fetch | undefined;
    const endpoint = defineProvider<"email_verifier", { base_url?: string }>({
      slot: "email_verifier",
      id: "test_endpoint",
      name: "Test endpoint",
      description: "Has a configurable base URL.",
      configSchema: z.object({ base_url: z.string().optional() }),
      secrets: [{ key: "api_key", label: "API key", env: "TEST_ENDPOINT_KEY", required: true }],
      create: ({ ctx }) => {
        captured = ctx.fetch;
        return {
          id: "test_endpoint",
          verify: async () => {
            throw new Error("not used in tests");
          },
        };
      },
    });
    const local = await createTestEngine({
      modules: [
        providersAdmin,
        { name: "endpoint", providers: [endpoint as unknown as ProviderDefinition] },
      ],
      config: { env: { TEST_ENDPOINT_KEY: "shared-instance-key" } },
      safeFetch,
      providerFetch,
    });
    try {
      const [client] = await local.db
        .insert(workspaces)
        .values({ slug: "client", name: "Client" })
        .returning();
      if (!client) throw new Error("insert failed");
      const clientKey = local.principal({ workspaceId: client.id });
      const target = { slot: "email_verifier", provider: "test_endpoint" };
      await local.call(
        "providers.set",
        { ...target, config: { base_url: "https://collector.example.org" } },
        { principal: clientKey },
      );
      const resolve = () =>
        createProviderResolver(local.runtime.kernel, client).get("email_verifier", {
          id: "test_endpoint",
        });
      await expect(resolve()).rejects.toMatchObject({
        code: "provider_not_configured",
        details: { reason: "custom_endpoint_needs_own_key" },
      });

      await local.call(
        "providers.set",
        { ...target, secrets: { api_key: "client-own-key" } },
        { principal: clientKey },
      );
      await resolve();
      await captured?.("https://collector.example.org/v1/verify");
      expect(safeFetch).toHaveBeenCalledWith(
        "https://collector.example.org/v1/verify",
        expect.objectContaining({ timeoutMs: 600_000 }),
      );
      expect(providerFetch).not.toHaveBeenCalled();

      // The instance owner setting the config makes the row trusted again.
      await local.call(
        "providers.set",
        { ...target, config: { base_url: "https://collector.example.org" } },
        { workspace: "client" },
      );
      await resolve();
      await captured?.("https://collector.example.org/v1/verify");
      expect(providerFetch).toHaveBeenCalledTimes(1);
    } finally {
      await local.close();
    }
  });
});
