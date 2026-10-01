import { and, eq, ne } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { OpenOutboundError } from "../core/errors.js";
import {
  type FailureClass,
  failureOf,
  type ProviderFailureInput,
  providerFailure,
} from "../core/failures.js";
import type { EngineModule } from "../core/operation.js";
import {
  problems,
  provider_settings,
  secrets,
  type Workspace,
  workspaces,
} from "../db/schema/index.js";
import { modules as builtinModules } from "../modules/index.js";
import { resolveProblem } from "../modules/problems/service.js";
import {
  defineProvider,
  type ProviderDefinition,
  type VerifyEmailResult,
} from "../providers/types.js";
import { createTestEngine, type TestEngine } from "../testing/engine.js";
import {
  clearProviderHealth,
  FAILING_STREAK,
  providerDownKey,
  withDeferredHealth,
} from "./provider-health.js";
import { instantiateProvider, invalidateProviders, resolveSlot } from "./providers.js";

const HOUR = 60 * 60_000;
const KEY = providerDownKey("email_verifier", "test_flaky");

type Step = () => Promise<VerifyEmailResult>;
const script: Step[] = [];
let calls = 0;
let testOk = true;

const valid = (email: string): VerifyEmailResult => ({ email, status: "valid", creditsUsed: 1 });

function scripted(id: string, extra: Partial<ProviderDefinition<"email_verifier">> = {}) {
  return defineProvider<"email_verifier">({
    slot: "email_verifier",
    id,
    name: id === "test_flaky" ? "Test Flaky" : "Test Quiet",
    description: "A verifier whose answers the health tests script.",
    secrets: [{ key: "api_key", label: "API key", required: true }],
    create: () => ({
      id,
      verify: async (email: string) => {
        calls += 1;
        const next = script.shift();
        return next ? next() : valid(email);
      },
    }),
    test: async () => ({ ok: testOk, message: testOk ? "Connected" : "The key was rejected" }),
    ...extra,
  });
}

const plugins: EngineModule = {
  name: "health-plugins",
  providers: [
    scripted("test_flaky"),
    scripted("test_quiet", { health: false }),
    // No free check: its test confirms the settings only.
    scripted("test_offline", {
      test: async () => ({ ok: true, message: "Keys are set.", checked: false }),
    }),
    scripted("test_untested", { test: undefined }),
  ] as ProviderDefinition[],
};

function fail(failureClass: FailureClass, extra: Partial<ProviderFailureInput> = {}): Step {
  return async () => {
    throw providerFailure({
      provider: "test_flaky",
      name: "Test Flaky",
      class: failureClass,
      ...extra,
    });
  };
}

async function caught(promise: Promise<unknown>): Promise<OpenOutboundError> {
  try {
    await promise;
  } catch (error) {
    return error as OpenOutboundError;
  }
  throw new Error("expected the call to fail");
}

let engine: TestEngine;
let acme: Workspace;
let globex: Workspace;
let practice: Workspace;
const kernel = () => engine.runtime.kernel;

async function verifier(workspace: Workspace, id = "test_flaky") {
  const ctx = await engine.systemContext(workspace.id);
  return ctx.providers.get("email_verifier", { id });
}

async function verify(workspace: Workspace, id = "test_flaky") {
  return (await verifier(workspace, id)).verify("dana@example.com");
}

async function openProblems(workspace: Workspace) {
  return engine.db
    .select()
    .from(problems)
    .where(
      and(
        eq(problems.workspace_id, workspace.id),
        eq(problems.kind, "provider_down"),
        ne(problems.status, "resolved"),
      ),
    );
}

const set = (input: Record<string, unknown>, workspace?: string) =>
  engine.call("providers.set", input, workspace ? { workspace } : {});

beforeAll(async () => {
  engine = await createTestEngine({ modules: [...builtinModules, plugins] });
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
  script.length = 0;
  calls = 0;
  testOk = true;
  await engine.db.delete(problems);
  await engine.db.delete(provider_settings);
  await engine.db.delete(secrets);
  invalidateProviders(kernel().providerCache);
  clearProviderHealth(kernel().providerCache);
});

describe("provider health: pauses", () => {
  it("pauses a provider whose key was rejected: one problem, then no calls", async () => {
    await set(
      { slot: "email_verifier", provider: "test_flaky", secrets: { api_key: "flaky-key-01" } },
      "acme",
    );
    script.push(fail("auth_invalid", { upstreamStatus: 401 }));
    const first = await caught(verify(acme));
    expect(failureOf(first)).toMatchObject({ class: "auth_invalid", retryable: false });
    expect(calls).toBe(1);
    const opened = await openProblems(acme);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      kind: "provider_down",
      severity: "high",
      owner: "person",
      dedupe_key: KEY,
      data: expect.objectContaining({
        slot: "email_verifier",
        provider: "test_flaky",
        paused: true,
      }),
    });
    expect(opened[0]?.remedy).toContain("manage_providers action set");
    expect(opened[0]?.remedy).toContain("manage_providers action test");

    // Paused: calls fail at once with the stored failure and never reach the provider.
    const again = await caught(verify(acme));
    expect(failureOf(again)).toMatchObject({ class: "auth_invalid", retryable: false });
    expect(again.details).toMatchObject({ paused: true });
    expect(again.message).toContain("paused");
    expect(calls).toBe(1);
    // Hours later it is still paused: only new credentials or a passing test end it.
    engine.advance(6 * HOUR);
    await caught(verify(acme));
    expect(calls).toBe(1);
    expect(await openProblems(acme)).toHaveLength(1);
  });

  it("resumes after a passing provider test", async () => {
    await set(
      { slot: "email_verifier", provider: "test_flaky", secrets: { api_key: "flaky-key-01" } },
      "acme",
    );
    script.push(fail("forbidden", { upstreamStatus: 403 }));
    await caught(verify(acme));
    testOk = false;
    const failing = (await engine.call(
      "providers.test",
      { slot: "email_verifier", provider: "test_flaky" },
      { workspace: "acme" },
    )) as { ok: boolean };
    expect(failing.ok).toBe(false);
    await caught(verify(acme));
    expect(calls).toBe(1);

    testOk = true;
    const passing = (await engine.call(
      "providers.test",
      { slot: "email_verifier", provider: "test_flaky" },
      { workspace: "acme" },
    )) as { ok: boolean };
    expect(passing).toMatchObject({ ok: true, checked: true });
    expect(await openProblems(acme)).toEqual([]);
    await expect(verify(acme)).resolves.toMatchObject({ status: "valid" });
    expect(calls).toBe(2);
  });

  it.each([
    ["test_offline", "Keys are set."],
    ["test_untested", "no live test"],
  ])("keeps the pause when the test of %s checks nothing live", async (id, message) => {
    await set(
      { slot: "email_verifier", provider: id, secrets: { api_key: "quiet-key-01" } },
      "acme",
    );
    script.push(fail("auth_invalid", { upstreamStatus: 401 }));
    await caught(verify(acme, id));
    const result = (await engine.call(
      "providers.test",
      { slot: "email_verifier", provider: id },
      { workspace: "acme" },
    )) as { ok: boolean; checked: boolean; message: string };
    expect(result).toMatchObject({ ok: true, checked: false });
    expect(result.message).toContain(message);
    expect(await openProblems(acme)).toHaveLength(1);
    await caught(verify(acme, id));
    expect(calls).toBe(1);
  });

  it("resumes when the credentials change", async () => {
    await set(
      { slot: "email_verifier", provider: "test_flaky", secrets: { api_key: "flaky-key-01" } },
      "acme",
    );
    script.push(fail("auth_invalid", { upstreamStatus: 401 }));
    await caught(verify(acme));
    await caught(verify(acme));
    expect(calls).toBe(1);
    await set(
      { slot: "email_verifier", provider: "test_flaky", secrets: { api_key: "flaky-key-02" } },
      "acme",
    );
    expect(await openProblems(acme)).toEqual([]);
    await expect(verify(acme)).resolves.toMatchObject({ status: "valid" });
    expect(calls).toBe(2);
  });

  it("pauses on a used-up quota until the wait passes, then lets one trial call through", async () => {
    await set(
      { slot: "email_verifier", provider: "test_flaky", secrets: { api_key: "flaky-key-01" } },
      "acme",
    );
    script.push(fail("quota_exhausted", { upstreamStatus: 402, retryAfterSeconds: 120 }));
    await caught(verify(acme));
    const blocked = await caught(verify(acme));
    expect(failureOf(blocked)).toMatchObject({ class: "quota_exhausted", retryable: false });
    expect(blocked.retryAfterSeconds).toBe(120);
    expect(calls).toBe(1);

    // After the wait, one trial call goes through; still out of quota: paused again, one hour.
    engine.advance(121_000);
    script.push(fail("quota_exhausted", { upstreamStatus: 402 }));
    await caught(verify(acme));
    expect(calls).toBe(2);
    const later = await caught(verify(acme));
    expect(later.retryAfterSeconds).toBe(3600);
    expect(calls).toBe(2);
    expect(await openProblems(acme)).toHaveLength(1);

    // While the next trial is under way, other calls still wait.
    engine.advance(HOUR);
    const instance = await verifier(acme);
    let release: (value: VerifyEmailResult) => void = () => {};
    script.push(() => new Promise<VerifyEmailResult>((resolve) => (release = resolve)));
    const trial = instance.verify("dana@example.com");
    expect(calls).toBe(3);
    await caught(verify(acme));
    expect(calls).toBe(3);
    release(valid("dana@example.com"));
    await expect(trial).resolves.toMatchObject({ status: "valid" });
    expect(await openProblems(acme)).toEqual([]);
    await expect(verify(acme)).resolves.toMatchObject({ status: "valid" });
    expect(calls).toBe(4);
  });

  it("counts an instance key for each workspace on its own", async () => {
    await set({
      slot: "email_verifier",
      provider: "test_flaky",
      secrets: { api_key: "flaky-key-01" },
    });
    script.push(fail("auth_invalid", { upstreamStatus: 401 }));
    await caught(verify(acme));
    await caught(verify(acme));
    expect(calls).toBe(1);
    expect(await openProblems(acme)).toHaveLength(1);
    // Globex uses the same instance key but has not failed: its calls go through.
    await expect(verify(globex)).resolves.toMatchObject({ status: "valid" });
    expect(calls).toBe(2);
    expect(await openProblems(globex)).toEqual([]);
    // A new instance key resumes every workspace that used the old one.
    await set({
      slot: "email_verifier",
      provider: "test_flaky",
      secrets: { api_key: "flaky-key-02" },
    });
    expect(await openProblems(acme)).toEqual([]);
    await expect(verify(acme)).resolves.toMatchObject({ status: "valid" });
  });

  it("lifts a pause that a person resolved, at the next check", async () => {
    await set(
      { slot: "email_verifier", provider: "test_flaky", secrets: { api_key: "flaky-key-01" } },
      "acme",
    );
    script.push(fail("auth_invalid", { upstreamStatus: 401 }));
    await caught(verify(acme));
    const [problem] = await openProblems(acme);
    await resolveProblem(await engine.systemContext(acme.id), problem?.id ?? "", {
      resolution: "Fixed the key in the provider console.",
    });
    engine.advance(61_000);
    await expect(verify(acme)).resolves.toMatchObject({ status: "valid" });
    expect(calls).toBe(2);
  });

  it("stores the outcome after the transaction when deferred", async () => {
    await set(
      { slot: "email_verifier", provider: "test_flaky", secrets: { api_key: "flaky-key-01" } },
      "acme",
    );
    const instance = await verifier(acme);
    script.push(fail("auth_invalid", { upstreamStatus: 401 }));
    await withDeferredHealth(() =>
      engine.db.transaction(async (tx) => {
        await tx.select().from(workspaces).limit(1);
        await caught(instance.verify("dana@example.com"));
      }),
    );
    expect(await openProblems(acme)).toHaveLength(1);
    await caught(instance.verify("dana@example.com"));
    expect(calls).toBe(1);
  });
});

describe("provider health: failing streaks", () => {
  it("opens a normal problem after five unavailable or timeout failures in a row, without pausing", async () => {
    await set(
      { slot: "email_verifier", provider: "test_flaky", secrets: { api_key: "flaky-key-01" } },
      "acme",
    );
    for (let index = 0; index < FAILING_STREAK - 1; index++) {
      script.push(fail(index % 2 === 0 ? "unavailable" : "timeout"));
      await caught(verify(acme));
    }
    // An answer, even a refusal of this input, breaks the streak.
    script.push(fail("bad_request", { upstreamStatus: 400 }));
    await caught(verify(acme));
    expect(await openProblems(acme)).toEqual([]);

    for (let index = 0; index < FAILING_STREAK; index++) {
      script.push(fail("unavailable", { upstreamStatus: 503 }));
      await caught(verify(acme));
    }
    const [problem] = await openProblems(acme);
    expect(problem).toMatchObject({ severity: "normal", owner: "person", dedupe_key: KEY });
    expect(problem?.data).toMatchObject({ paused: false });
    // Not paused: the next call reaches the provider, and its success resolves the problem.
    const before = calls;
    await expect(verify(acme)).resolves.toMatchObject({ status: "valid" });
    expect(calls).toBe(before + 1);
    expect(await openProblems(acme)).toEqual([]);
  });

  it("does not count a page or item that is down (unavailable, scope call)", async () => {
    await set(
      { slot: "email_verifier", provider: "test_flaky", secrets: { api_key: "flaky-key-01" } },
      "acme",
    );
    for (let index = 0; index < FAILING_STREAK + 1; index++) {
      script.push(fail("unavailable", { scope: "call", upstreamStatus: 503 }));
      await caught(verify(acme));
    }
    expect(await openProblems(acme)).toEqual([]);
  });
});

describe("provider health: exemptions", () => {
  it("never pauses providers that opt out", async () => {
    await set(
      { slot: "email_verifier", provider: "test_quiet", secrets: { api_key: "quiet-key-01" } },
      "acme",
    );
    for (let index = 0; index < 2; index++) {
      script.push(fail("auth_invalid", { upstreamStatus: 401 }));
      await caught(verify(acme, "test_quiet"));
    }
    expect(calls).toBe(2);
    expect(await openProblems(acme)).toEqual([]);
  });

  it("leaves sandbox providers alone", async () => {
    const [entry] = await resolveSlot(kernel(), practice, "email_verifier");
    expect(entry?.level).toBe("sandbox");
    if (!entry) return;
    const raw = await instantiateProvider(kernel(), practice, entry);
    const ctx = await engine.systemContext(practice.id);
    expect(await ctx.providers.get("email_verifier")).toBe(raw);
  });
});

describe("provider health: get_status", () => {
  it("shows each slot's health next to configured", async () => {
    await set(
      { slot: "email_verifier", provider: "test_flaky", secrets: { api_key: "flaky-key-01" } },
      "acme",
    );
    const healthy = (await engine.call("workspaces.status", {}, { workspace: "acme" })) as {
      providers: Array<{ slot: string; health: unknown }>;
    };
    expect(healthy.providers.find((item) => item.slot === "email_verifier")?.health).toMatchObject({
      status: "ok",
      class: null,
    });
    script.push(fail("auth_invalid", { upstreamStatus: 401 }));
    await caught(verify(acme));
    const status = (await engine.call("workspaces.status", {}, { workspace: "acme" })) as {
      providers: Array<{ slot: string; health: Record<string, unknown> | null }>;
      warnings: Array<{ code: string; message: string; hint: string }>;
    };
    const slot = status.providers.find((item) => item.slot === "email_verifier");
    expect(slot?.health).toMatchObject({
      status: "paused",
      class: "auth_invalid",
      since: engine.clock.now().toISOString(),
      until: null,
    });
    expect(String(slot?.health?.fix)).toContain("manage_providers action test");
    expect(status.warnings).toContainEqual(
      expect.objectContaining({
        code: "provider_down",
        hint: expect.stringContaining("manage_providers"),
      }),
    );
  });
});
