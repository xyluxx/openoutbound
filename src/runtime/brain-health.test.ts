import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createConcurrencyLimiter } from "../brain/limiter.js";
import { createBrainService } from "../brain/service.js";
import { problems } from "../db/schema/index.js";
import { brainError } from "../providers/brain/errors.js";
import type { BrainProvider } from "../providers/types.js";
import { createTestEngine, type TestEngine } from "../testing/engine.js";
import { createFakeProviders } from "../testing/fakes.js";

let engine: TestEngine;
let working = false;

const brain: BrainProvider = {
  id: "main",
  capabilities: { structuredOutput: "native", maxConcurrency: 2, caching: false },
  defaultModels: { fast: "main-fast", standard: "main-standard", deep: "main-deep" },
  async generate(request) {
    if (!working) {
      throw brainError({ label: "Main", providerId: "main" }, "Main rejected the API key.", {
        reason: "auth",
        retryable: false,
        hint: "Set a new key with manage_providers.",
      });
    }
    const vars = (request as { vars?: { nonce?: string } }).vars;
    const json = { ok: true, echo: vars?.nonce ?? "" };
    return {
      text: JSON.stringify(json),
      json,
      model: "main-fast",
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  },
};

beforeAll(async () => {
  const providers = createFakeProviders({ brain });
  engine = await createTestEngine({
    // The runtime's deps (with the health reporter) around a scripted provider.
    brain: (deps) =>
      createBrainService({
        ...deps,
        providers,
        limiter: createConcurrencyLimiter(),
        sleep: async () => {},
      }),
  });
  await engine.call("workspaces.create", { name: "Northwind Example" });
});
afterAll(async () => {
  await engine.close();
});

describe("brain health in the runtime", () => {
  it("opens brain_down through the context and resolves it when the brain answers", async () => {
    const failed = (await engine.call("brain.test", {}, { workspace: "northwind-example" })) as {
      ok: boolean;
    };
    expect(failed.ok).toBe(false);
    const rows = await engine.testDb.db
      .select()
      .from(problems)
      .where(eq(problems.kind, "brain_down"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "open", severity: "high" });
    expect(rows[0]?.dedupe_key).toMatch(/^brain_down:main:main-/);

    working = true;
    const passed = (await engine.call("brain.test", {}, { workspace: "northwind-example" })) as {
      ok: boolean;
    };
    expect(passed.ok).toBe(true);
    const [after] = await engine.testDb.db
      .select()
      .from(problems)
      .where(eq(problems.kind, "brain_down"));
    expect(after?.status).toBe("resolved");
  });
});
