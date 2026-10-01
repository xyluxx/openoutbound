/**
 * Provider failures in the enrichment waterfall: a step whose provider failed is
 * `provider_failed` (never "not found"), `email_not_found_at` is set only when every finder
 * answered "no match", the next run asks only what failed, and the job retries temporary
 * failures by itself (at most twice).
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EmailStatus } from "../../core/enums.js";
import { type FailureClass, providerFailure } from "../../core/failures.js";
import { type Company, type Person, people } from "../../db/schema/index.js";
import { createHunter, hunterConfigSchema } from "../../providers/email-finder/hunter.js";
import { createIcypeas, icypeasConfigSchema } from "../../providers/email-finder/icypeas.js";
import type {
  EmailFinderProvider,
  EmailVerifierProvider,
  FindEmailInput,
  FindEmailResult,
} from "../../providers/types.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { truncateAll } from "../../testing/db.js";
import { seedCompany, seedPerson, seedWorkspace } from "../../testing/factories.js";
import { createFakeFetch } from "../../testing/fake-fetch.js";
import { checkContactable } from "../leads/service.js";
import { ENRICH_AUTO_RETRIES, enrichJob } from "./jobs.js";
import { runEnrichment } from "./run.js";
import { EnrichmentSession } from "./session.js";
import { type EnrichPersonOptions, enrichPerson } from "./waterfall.js";

const fail = (provider: string, failureClass: FailureClass, retryAfterSeconds?: number) =>
  providerFailure({
    provider,
    class: failureClass,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  });

type Answer = Partial<FindEmailResult> | Error;

/** A finder answering from a script, one entry per call (the last one repeats). */
function finder(id: string, ...script: Answer[]) {
  const calls: FindEmailInput[] = [];
  const provider: EmailFinderProvider = {
    id,
    async findEmail(input) {
      calls.push(input);
      const answer = script[Math.min(calls.length - 1, script.length - 1)] ?? {};
      if (answer instanceof Error) throw answer;
      return { email: null, creditsUsed: answer.email ? 1 : 0, ...answer };
    },
  };
  return { provider, calls };
}

function verifier(...script: Array<EmailStatus | Error>) {
  const calls: string[] = [];
  const provider: EmailVerifierProvider = {
    id: "fakeverify",
    async verify(email) {
      calls.push(email);
      const answer = script[Math.min(calls.length - 1, script.length - 1)] ?? "valid";
      if (answer instanceof Error) throw answer;
      return { email, status: answer, creditsUsed: answer === "unknown" ? 0 : 1 };
    },
  };
  return { provider, calls };
}

let ctx: TestContext;
let company: Company;
let person: Person;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

async function setup(over: Partial<Person> = {}) {
  await truncateAll(ctx.db);
  const workspace = await seedWorkspace(ctx.db, {
    settings: { data: { enrichment: { website_crawler: false, finders: ["hunter", "icypeas"] } } },
  });
  ctx = ctx.with({ workspace });
  for (const list of [ctx.recorded.events, ctx.recorded.usage, ctx.recorded.jobs]) list.length = 0;
  ctx.providers.set("email_finder", null);
  ctx.providers.set("email_verifier", null);
  company = await seedCompany(ctx, { domain: "brightsmile.test", country: "US" });
  person = await seedPerson(ctx, {
    company_id: company.id,
    first_name: "Dana",
    last_name: "Rivers",
    full_name: "Dana Rivers",
    email: null,
    email_status: "unknown",
    country: "US",
    ...over,
  });
}

async function stored(id = person.id): Promise<Person> {
  return (await ctx.db.select().from(people).where(eq(people.id, id)))[0] as Person;
}

async function enrich(options: Partial<EnrichPersonOptions> = {}) {
  const session = new EnrichmentSession(ctx, { operation: "test.enrich" });
  const fresh = await stored();
  const reasons = (await checkContactable(ctx, { personId: person.id, channel: "email" })).reasons;
  const outcome = await enrichPerson(session, fresh, company, reasons, {
    mode: "find_and_verify",
    ...options,
  });
  return { outcome, stored: await stored() };
}

describe("a finder that fails", () => {
  beforeEach(async () => {
    await setup();
  });

  it("is provider_failed with its failure, never not found, and the person is looked for again", async () => {
    const hunter = finder("hunter", fail("hunter", "timeout"));
    const icypeas = finder("icypeas", {});
    ctx.providers.set("email_finder", [hunter.provider, icypeas.provider]);

    const { outcome, stored: after } = await enrich();
    expect(outcome).toMatchObject({
      status: "provider_failed",
      reason: "timeout",
      email: null,
      credits_used: 0,
      steps: ["hunter:provider_failed", "icypeas:not_found"],
      failed: [
        {
          step: "finder",
          provider: "hunter",
          failure: { class: "timeout", retryable: true, scope: "call", provider: "hunter" },
        },
      ],
    });
    // Not every finder answered "no match": the person is not parked for 30 days.
    expect(after.email_not_found_at).toBeNull();
    expect(after.enrichment).toMatchObject({
      status: "provider_failed",
      at: ctx.clock.now().toISOString(),
      no_match: { icypeas: ctx.clock.now().toISOString() },
      failed: [{ step: "finder", provider: "hunter", failure: { class: "timeout" } }],
      retry_at: null,
    });
  });

  it("is the only one asked again on the next run, and every no match then parks the person", async () => {
    const hunter = finder("hunter", fail("hunter", "rate_limited", 30), {});
    const icypeas = finder("icypeas", {});
    ctx.providers.set("email_finder", [hunter.provider, icypeas.provider]);
    await enrich();

    ctx.clock.advance(60 * 60_000);
    const { outcome, stored: after } = await enrich();
    expect(outcome).toMatchObject({
      status: "not_found",
      steps: ["hunter:not_found", "icypeas:not_found_recently"],
      failed: [],
    });
    expect(hunter.calls).toHaveLength(2);
    expect(icypeas.calls).toHaveLength(1);
    // Every finder has now answered: parked from the oldest answer on.
    expect(after.email_not_found_at).toEqual(new Date(ctx.clock.now().getTime() - 60 * 60_000));
    expect(after.enrichment).toMatchObject({ status: "not_found", failed: [] });

    const third = await enrich();
    expect(third.outcome).toMatchObject({
      status: "not_found",
      reason: "not_found_recently",
      steps: ["finders:not_found_recently"],
    });
    expect(hunter.calls).toHaveLength(2);
  });

  it("keeps the address the failed finder finds on the next run", async () => {
    const hunter = finder("hunter", fail("hunter", "unavailable"), {
      email: "dana@brightsmile.test",
      status: "valid",
    });
    const icypeas = finder("icypeas", {});
    ctx.providers.set("email_finder", [hunter.provider, icypeas.provider]);
    await enrich();
    const { outcome, stored: after } = await enrich();
    expect(outcome).toMatchObject({ status: "found", email: "dana@brightsmile.test", failed: [] });
    expect(after).toMatchObject({ email: "dana@brightsmile.test", email_status: "valid" });
    expect(after.enrichment).toMatchObject({ status: "found", failed: [] });
  });

  it("says which failures a retry can fix", async () => {
    for (const [failureClass, retryable, scope] of [
      ["auth_invalid", false, "account"],
      ["quota_exhausted", false, "account"],
      ["malformed", false, "call"],
      ["rate_limited", true, "account"],
      ["timeout", true, "call"],
    ] as const) {
      await setup();
      ctx.providers.set("email_finder", [finder("hunter", fail("hunter", failureClass)).provider]);
      const { outcome } = await enrich();
      expect(outcome.status).toBe("provider_failed");
      expect(outcome.failed[0]?.failure).toMatchObject({ class: failureClass, retryable, scope });
    }
  });

  it("does not let a recent check of the address on file stop the retry of the failed finder", async () => {
    await setup({
      email: "dana@brightsmile.test",
      email_status: "unknown",
      email_checked_at: new Date(ctx.clock.now().getTime() - 40 * 86_400_000),
    });
    ctx.providers.set("email_verifier", verifier("risky").provider);
    const hunter = finder("hunter", fail("hunter", "network"), {});
    const icypeas = finder("icypeas", {});
    ctx.providers.set("email_finder", [hunter.provider, icypeas.provider]);

    const first = await enrich();
    expect(first.outcome).toMatchObject({
      status: "provider_failed",
      email: "dana@brightsmile.test",
      email_status: "risky",
    });
    // The address was checked a minute ago; the finders still owe an answer.
    ctx.clock.advance(60_000);
    const second = await enrich();
    expect(second.outcome.steps).toEqual(["hunter:not_found", "icypeas:not_found_recently"]);
    expect(second.outcome).toMatchObject({ status: "not_found", email_status: "risky" });
  });

  it("is asked again with force even after the others answered", async () => {
    const hunter = finder("hunter", fail("hunter", "timeout"));
    const icypeas = finder("icypeas", {});
    ctx.providers.set("email_finder", [hunter.provider, icypeas.provider]);
    await enrich();
    await enrich({ force: true });
    expect(icypeas.calls).toHaveLength(2);
  });
});

describe("a verifier that fails", () => {
  it("is provider_failed in verify_only and leaves the stored status alone", async () => {
    await setup({ email: "dana@brightsmile.test", email_status: "unknown" });
    ctx.providers.set("email_verifier", verifier(fail("fakeverify", "unavailable")).provider);
    const { outcome, stored: after } = await enrich({ mode: "verify_only" });
    expect(outcome).toMatchObject({
      status: "provider_failed",
      reason: "unavailable",
      email_status: "unknown",
      steps: ["fakeverify:provider_failed"],
      failed: [{ step: "verifier", provider: "fakeverify", failure: { class: "unavailable" } }],
    });
    expect(after).toMatchObject({ email_status: "unknown", email_checked_at: null });
  });

  it("keeps a found address unverified and lists the failure", async () => {
    await setup();
    ctx.providers.set("email_finder", [
      finder("hunter", { email: "dana@brightsmile.test", status: "unknown" }).provider,
    ]);
    ctx.providers.set("email_verifier", verifier(fail("fakeverify", "timeout")).provider);
    const { outcome } = await enrich();
    expect(outcome).toMatchObject({
      status: "found",
      email: "dana@brightsmile.test",
      email_status: "unknown",
      failed: [{ step: "verifier", provider: "fakeverify", failure: { class: "timeout" } }],
    });
  });
});

describe("runs and the job", () => {
  async function secondPerson() {
    return seedPerson(ctx, {
      company_id: company.id,
      first_name: "Marco",
      last_name: "Pellegrini",
      full_name: "Marco Pellegrini",
      email: null,
      country: "US",
    });
  }

  it("lists each person's step outcomes and failures in the run result", async () => {
    await setup();
    const marco = await secondPerson();
    ctx.providers.set("email_finder", [
      finder("hunter", fail("hunter", "timeout")).provider,
      finder("icypeas", {}).provider,
    ]);
    const summary = await runEnrichment(ctx, [person.id, marco.id], {
      mode: "find_and_verify",
      operation: "test",
    });
    expect(summary).toMatchObject({ total: 2, provider_failed: 2, not_found: 0 });
    expect(summary.results[0]).toMatchObject({
      person_id: person.id,
      status: "provider_failed",
      steps: ["hunter:provider_failed", "icypeas:not_found"],
      failed: [{ step: "finder", provider: "hunter", failure: { class: "timeout" } }],
      retry_at: null,
    });
    expect(summary.failures).toEqual([
      { step: "finder", provider: "hunter", class: "timeout", retryable: true, people: 2 },
    ]);
    expect(ctx.emitted("enrichment.completed").map((event) => event.data.status)).toEqual([
      "provider_failed",
      "provider_failed",
    ]);
  });

  it("retries temporary failures by itself, and only for those people", async () => {
    await setup();
    const marco = await secondPerson();
    // Dana's lookup times out (a retry can help); Marco's key is rejected (it cannot).
    const hunter = finder("hunter");
    hunter.provider.findEmail = async (input) => {
      hunter.calls.push(input);
      throw input.first_name === "Dana"
        ? fail("hunter", "timeout")
        : fail("hunter", "auth_invalid");
    };
    ctx.providers.set("email_finder", [hunter.provider, finder("icypeas", {}).provider]);
    const result = (await enrichJob.handler(ctx.jobContext({ name: "enrichment.run" }), {
      person_ids: [person.id, marco.id],
      mode: "find_and_verify",
      allow_role_addresses: false,
      force: false,
      retry_round: 0,
    })) as Record<string, unknown>;

    const runAt = new Date(ctx.clock.now().getTime() + 15 * 60_000);
    const queued = ctx.enqueued("enrichment.run");
    expect(queued).toHaveLength(1);
    expect(queued[0]?.payload).toEqual({
      person_ids: [person.id],
      mode: "find_and_verify",
      allow_role_addresses: false,
      force: false,
      retry_round: 1,
    });
    expect(queued[0]?.options.runAt).toEqual(runAt);
    expect(result.retry).toEqual({ job_id: queued[0]?.job_id, at: runAt.toISOString(), people: 1 });
    expect(result).not.toHaveProperty("retry_person_ids");
    expect((await stored(person.id)).enrichment?.retry_at).toBe(runAt.toISOString());
    expect((await stored(marco.id)).enrichment).toMatchObject({
      status: "provider_failed",
      failed: [{ provider: "hunter", failure: { class: "auth_invalid", retryable: false } }],
      retry_at: null,
    });

    // The retry asks only Hunter for Dana; this time it answers.
    hunter.provider.findEmail = async () => ({
      email: "dana@brightsmile.test",
      status: "valid",
      creditsUsed: 1,
    });
    ctx.recorded.jobs.length = 0;
    const retry = (await enrichJob.handler(ctx.jobContext({ name: "enrichment.run" }), {
      person_ids: [person.id],
      mode: "find_and_verify",
      allow_role_addresses: false,
      force: false,
      retry_round: 1,
    })) as Record<string, unknown>;
    expect(retry).toMatchObject({ found: 1, retry: null });
    expect(ctx.enqueued("enrichment.run")).toHaveLength(0);
    expect((await stored(person.id)).enrichment).toMatchObject({
      status: "found",
      failed: [],
      retry_at: null,
    });
  });

  it("does not follow up a paid finder call that timed out, and says why with its class", async () => {
    await setup();
    const hunterFetch = createFakeFetch([
      {
        match: /api\.hunter\.io/,
        response: () => {
          throw Object.assign(new Error("The operation was aborted due to timeout"), {
            name: "TimeoutError",
          });
        },
      },
    ]);
    ctx.providers.set("email_finder", [
      createHunter({
        apiKey: "hunter-test-key",
        config: hunterConfigSchema.parse({}),
        fetch: hunterFetch as unknown as typeof globalThis.fetch,
      }),
      finder("icypeas", {}).provider,
    ]);
    const result = (await enrichJob.handler(ctx.jobContext({ name: "enrichment.run" }), {
      person_ids: [person.id],
      mode: "find_and_verify",
      allow_role_addresses: false,
      force: false,
      retry_round: 0,
    })) as Record<string, unknown>;

    // The lookup may already have used Hunter credits: not repeated by itself, and the key is
    // fine, which the class (timeout, not auth_invalid) tells.
    const failure = { class: "timeout", retryable: false, scope: "call", provider: "hunter" };
    expect(result).toMatchObject({
      provider_failed: 1,
      retry: null,
      failures: [{ step: "finder", provider: "hunter", class: "timeout", retryable: false }],
    });
    expect(hunterFetch.calls).toHaveLength(1);
    expect(ctx.enqueued("enrichment.run")).toHaveLength(0);
    expect((await stored()).enrichment).toMatchObject({
      status: "provider_failed",
      failed: [{ step: "finder", provider: "hunter", failure }],
      retry_at: null,
    });
  });

  it("pays only the failed finder again in the follow-up, not the one whose address is on file", async () => {
    await setup();
    const hunter = finder("hunter", fail("hunter", "unavailable"), {});
    const icypeas = finder("icypeas", { email: "dana@brightsmile.test", status: "unknown" });
    const check = verifier("risky");
    ctx.providers.set("email_finder", [hunter.provider, icypeas.provider]);
    ctx.providers.set("email_verifier", check.provider);
    const payload = {
      person_ids: [person.id],
      mode: "find_and_verify" as const,
      allow_role_addresses: false,
      force: false,
    };
    const first = (await enrichJob.handler(ctx.jobContext({ name: "enrichment.run" }), {
      ...payload,
      retry_round: 0,
    })) as Record<string, unknown>;
    expect(first).toMatchObject({ found: 1, retry: { people: 1 } });

    ctx.clock.advance(15 * 60_000);
    const followUp = (await enrichJob.handler(ctx.jobContext({ name: "enrichment.run" }), {
      ...payload,
      retry_round: 1,
    })) as Record<string, unknown>;
    expect(followUp).toMatchObject({
      kept: 1,
      retry: null,
      results: [
        {
          status: "kept",
          reason: "found_recently",
          email: "dana@brightsmile.test",
          email_status: "risky",
          provider: "icypeas",
          steps: ["hunter:not_found", "icypeas:found_recently"],
          failed: [],
        },
      ],
    });
    expect([hunter.calls.length, icypeas.calls.length, check.calls.length]).toEqual([2, 1, 1]);
    expect(ctx.recorded.usage.map((usage) => [usage.provider, usage.credits])).toEqual([
      ["icypeas", 1],
      ["fakeverify", 1],
    ]);
    const after = await stored();
    // Hunter's "no match" is remembered; Icypeas still answered with an address.
    expect(after.email_not_found_at).toBeNull();
    expect(after.enrichment).toMatchObject({
      status: "kept",
      no_match: { hunter: ctx.clock.now().toISOString() },
      failed: [],
      retry_at: null,
    });
    expect(after.enrichment?.no_match).not.toHaveProperty("icypeas");

    // Forced, or once the address is no longer on file, the finder is asked again.
    await enrich({ force: true });
    expect(icypeas.calls).toHaveLength(2);
  });

  it("clears the retry of every person when the follow-up is stopped by the data budget", async () => {
    await setup();
    const marco = await seedPerson(ctx, {
      company_id: company.id,
      first_name: "Marco",
      last_name: "Pellegrini",
      full_name: "Marco Pellegrini",
      email: null,
      email_status: "unknown",
      country: "US",
    });
    ctx.providers.set("email_finder", [finder("hunter", fail("hunter", "unavailable")).provider]);
    const payload = {
      person_ids: [person.id, marco.id],
      mode: "find_and_verify" as const,
      allow_role_addresses: false,
      force: false,
    };
    const first = (await enrichJob.handler(ctx.jobContext({ name: "enrichment.run" }), {
      ...payload,
      retry_round: 0,
    })) as Record<string, unknown>;
    expect(first).toMatchObject({ provider_failed: 2, retry: { people: 2 } });
    const at = (first.retry as { at: string }).at;
    for (const id of [person.id, marco.id]) {
      expect((await stored(id)).enrichment?.retry_at).toBe(at);
    }

    // The follow-up starts a minute late, with the data budget used up.
    ctx.clock.advance(16 * 60_000);
    ctx.usage.setOverBudget("data");
    const followUp = (await enrichJob.handler(ctx.jobContext({ name: "enrichment.run" }), {
      ...payload,
      retry_round: 1,
    })) as Record<string, unknown>;
    expect(followUp).toMatchObject({ skipped: 2, budget_exceeded: true, retry: null });
    for (const id of [person.id, marco.id]) {
      expect((await stored(id)).enrichment).toMatchObject({
        at: ctx.clock.now().toISOString(),
        status: "skipped",
        failed: [{ step: "finder", provider: "hunter", failure: { class: "unavailable" } }],
        retry_at: null,
      });
    }
  });

  it("does not start a second paid Icypeas search in the follow-up another finder's failure brings", async () => {
    await setup();
    const icypeasFetch = createFakeFetch([
      {
        match: /\/email-search$/,
        method: "POST",
        response: { json: { success: true, item: { _id: "p_exampleSearch0001", status: "NONE" } } },
      },
      {
        match: /\/bulk-single-searchs\/read$/,
        method: "POST",
        response: { status: 429, json: { message: "Too many requests" } },
      },
    ]);
    const searches = () => icypeasFetch.calls.filter((call) => call.url.endsWith("/email-search"));
    const hunter = finder("hunter", fail("hunter", "unavailable"), {});
    ctx.providers.set("email_finder", [
      hunter.provider,
      createIcypeas({
        apiKey: "icypeas-test-key",
        config: icypeasConfigSchema.parse({ poll_interval_ms: 0, max_polls: 2 }),
        fetch: icypeasFetch as unknown as typeof globalThis.fetch,
        sleep: async () => {},
      }),
    ]);
    const payload = {
      person_ids: [person.id],
      mode: "find_and_verify" as const,
      allow_role_addresses: false,
      force: false,
    };
    const first = (await enrichJob.handler(ctx.jobContext({ name: "enrichment.run" }), {
      ...payload,
      retry_round: 0,
    })) as Record<string, unknown>;
    // Hunter's server error brings a follow-up; the started Icypeas search is not repeated.
    expect(first).toMatchObject({
      provider_failed: 1,
      retry: { people: 1 },
      failures: [
        { provider: "hunter", class: "unavailable", retryable: true },
        { provider: "icypeas", class: "rate_limited", retryable: false },
      ],
    });

    ctx.clock.advance(15 * 60_000);
    const followUp = (await enrichJob.handler(ctx.jobContext({ name: "enrichment.run" }), {
      ...payload,
      retry_round: 1,
    })) as Record<string, unknown>;
    expect(searches()).toHaveLength(1);
    expect(hunter.calls).toHaveLength(2);
    const icypeasFailure = {
      step: "finder",
      provider: "icypeas",
      failure: { class: "rate_limited", retryable: false },
    };
    expect(followUp).toMatchObject({
      provider_failed: 1,
      retry: null,
      results: [
        {
          status: "provider_failed",
          reason: "rate_limited",
          steps: ["hunter:not_found", "icypeas:not_repeated"],
          failed: [icypeasFailure],
        },
      ],
    });
    expect((await stored()).enrichment).toMatchObject({
      status: "provider_failed",
      failed: [icypeasFailure],
      retry_at: null,
    });
    expect((await stored()).email_not_found_at).toBeNull();

    // Enriching the person again by hand asks Icypeas again.
    await enrichJob.handler(ctx.jobContext({ name: "enrichment.run" }), {
      ...payload,
      retry_round: 0,
    });
    expect(searches()).toHaveLength(2);
  });

  it("does not repeat a paid check of the address on file in a follow-up", async () => {
    await setup();
    const hunter = finder("hunter", fail("hunter", "unavailable"), {});
    const icypeas = finder("icypeas", { email: "dana@brightsmile.test", status: "unknown" });
    // The verifier lost its answer after the request was sent: it may have charged.
    const check = verifier(
      providerFailure({ provider: "fakeverify", class: "timeout", retryable: false }),
    );
    ctx.providers.set("email_finder", [hunter.provider, icypeas.provider]);
    ctx.providers.set("email_verifier", check.provider);
    const payload = {
      person_ids: [person.id],
      mode: "find_and_verify" as const,
      allow_role_addresses: false,
      force: false,
    };
    const first = (await enrichJob.handler(ctx.jobContext({ name: "enrichment.run" }), {
      ...payload,
      retry_round: 0,
    })) as Record<string, unknown>;
    expect(first).toMatchObject({ found: 1, retry: { people: 1 } });

    ctx.clock.advance(15 * 60_000);
    const followUp = (await enrichJob.handler(ctx.jobContext({ name: "enrichment.run" }), {
      ...payload,
      retry_round: 1,
    })) as Record<string, unknown>;
    expect(check.calls).toHaveLength(1);
    expect(followUp).toMatchObject({
      retry: null,
      results: [
        {
          status: "kept",
          email: "dana@brightsmile.test",
          email_status: "unknown",
          steps: ["fakeverify:not_repeated", "hunter:not_found", "icypeas:found_recently"],
          failed: [{ step: "verifier", failure: { class: "timeout", retryable: false } }],
        },
      ],
    });
  });

  it("waits as long as the provider asks, and stops retrying by itself after two rounds", async () => {
    await setup();
    ctx.providers.set("email_finder", [
      finder("hunter", fail("hunter", "rate_limited", 1_800)).provider,
    ]);
    await enrichJob.handler(ctx.jobContext({ name: "enrichment.run" }), {
      person_ids: [person.id],
      mode: "find_and_verify",
      allow_role_addresses: false,
      force: false,
      retry_round: 0,
    });
    expect(ctx.enqueued("enrichment.run")[0]?.options.runAt).toEqual(
      new Date(ctx.clock.now().getTime() + 1_800_000),
    );

    ctx.recorded.jobs.length = 0;
    const last = (await enrichJob.handler(ctx.jobContext({ name: "enrichment.run" }), {
      person_ids: [person.id],
      mode: "find_and_verify",
      allow_role_addresses: false,
      force: false,
      retry_round: ENRICH_AUTO_RETRIES,
    })) as Record<string, unknown>;
    expect(last).toMatchObject({ provider_failed: 1, retry: null });
    expect(ctx.enqueued("enrichment.run")).toHaveLength(0);
    expect((await stored()).enrichment?.retry_at).toBeNull();
  });

  it("stops asking a provider for the rest of the run after a failure of its account", async () => {
    await setup();
    const marco = await secondPerson();
    const hunter = finder("hunter", fail("hunter", "quota_exhausted"));
    ctx.providers.set("email_finder", [hunter.provider]);
    const summary = await runEnrichment(ctx, [person.id, marco.id], {
      mode: "find_and_verify",
      operation: "test",
    });
    expect(hunter.calls).toHaveLength(1);
    expect(
      summary.results.map((result) => [result.status, result.failed[0]?.failure.class]),
    ).toEqual([
      ["provider_failed", "quota_exhausted"],
      ["provider_failed", "quota_exhausted"],
    ]);
  });

  it("does not retry a person whose address is settled even when a finder failed", async () => {
    await setup();
    ctx.providers.set("email_finder", [
      finder("hunter", fail("hunter", "timeout")).provider,
      finder("icypeas", { email: "dana@brightsmile.test", status: "valid" }).provider,
    ]);
    const result = (await enrichJob.handler(ctx.jobContext({ name: "enrichment.run" }), {
      person_ids: [person.id],
      mode: "find_and_verify",
      allow_role_addresses: false,
      force: false,
      retry_round: 0,
    })) as Record<string, unknown>;
    expect(result).toMatchObject({ found: 1, retry: null });
    expect(ctx.enqueued("enrichment.run")).toHaveLength(0);
  });
});
