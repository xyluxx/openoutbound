import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ALL_SCOPES,
  type ApprovalDecision,
  type OpContext,
  type Principal,
} from "../core/context.js";
import { OpenOutboundError } from "../core/errors.js";
import { newId } from "../core/ids.js";
import {
  awaitingApproval,
  awaitingApprovalOutput,
  defineOperation,
  type EngineModule,
} from "../core/operation.js";
import {
  type Approval,
  approvals,
  events,
  type Workspace,
  workspaces,
} from "../db/schema/index.js";
import { module as keys } from "../modules/keys/index.js";
import { module as system } from "../modules/system/index.js";
import { createTestEngine, type TestEngine } from "../testing/engine.js";
import { expireApprovals, pendingApprovalCounts } from "./approvals.js";

const applied: Array<{ approval: Approval; decision: ApprovalDecision; actor: string }> = [];

const reviewer: EngineModule = {
  name: "reviewer",
  operations: [
    defineOperation({
      id: "reviewer.ask",
      summary: "Ask for an approval",
      description: "Asks a person to approve sending a message, as the caller.",
      effect: "write",
      input: z.object({ subject: z.string() }),
      output: awaitingApprovalOutput,
      dryRun: "none",
      idempotent: false,
      workspace: "required",
      examples: [],
      handler: async (ctx, input) => {
        const { id } = await ctx.approvals.request({
          kind: "message",
          title: "Send email",
          summary: `Subject: ${input.subject}`,
          payload: { subject: input.subject },
          target: { type: "message", id: newId("msg") },
        });
        return awaitingApproval(id, "Waiting for a person");
      },
    }),
  ],
  approvalResolvers: [
    {
      kind: "message",
      apply: async (ctx, approval, decision) => {
        applied.push({ approval, decision, actor: ctx.principal.id });
        if (approval.payload.fail) {
          throw new OpenOutboundError("provider_error", "Mailbox offline.", {
            hint: "Reconnect the mailbox.",
          });
        }
        return {
          message: decision.decision === "reject" ? "Draft discarded" : "Email scheduled",
          target: { type: "message", id: approval.target_id ?? "" },
          data: { subject: approval.payload.subject },
        };
      },
    },
    {
      kind: "custom",
      editable: ["gift"],
      apply: async (ctx, approval, decision) => {
        applied.push({ approval, decision, actor: ctx.principal.id });
        return { message: `Gift: ${String(approval.payload.gift)}` };
      },
    },
  ],
};

let engine: TestEngine;
let acme: Workspace;
let globex: Workspace;
let ctx: OpContext;

let requestCount = 0;
/** Each call gets its own payload (`n`), since identical pending requests are deduplicated. */
const request = (overrides: Record<string, unknown> = {}, context = ctx) =>
  context.approvals.request({
    kind: "message",
    title: "Send email to Sam Rivera (Example Dental)",
    summary: "First touch of the Q4 campaign.",
    payload: { subject: "Quick question", body: "Hi Sam", n: ++requestCount, ...overrides },
    target: { type: "message", id: "msg_01k6a3v0q8x3m2n4p5r6s7t8v9" },
  });
const decide = (input: Record<string, unknown>, options: Record<string, unknown> = {}) =>
  engine.call("approvals.decide", input, { workspace: "acme", ...options }) as Promise<{
    results: Array<Record<string, unknown>>;
    approved: number;
    rejected: number;
    failed: number;
  }>;
const load = async (id: string) =>
  (await engine.db.select().from(approvals).where(eq(approvals.id, id)))[0];

beforeAll(async () => {
  engine = await createTestEngine({ modules: [system, keys, reviewer] });
  const rows = await engine.db
    .insert(workspaces)
    .values([
      { slug: "acme", name: "Acme" },
      { slug: "globex", name: "Globex", settings: { approvals: { expire_days: 2 } } },
    ])
    .returning();
  [acme, globex] = rows as [Workspace, Workspace];
});
afterAll(async () => {
  await engine.close();
});
beforeEach(async () => {
  applied.length = 0;
  await engine.db.delete(approvals);
  await engine.db.delete(events);
  ctx = await engine.systemContext(acme.id);
});

describe("approval requests", () => {
  it("stores the request with the workspace expiry and emits approval.requested", async () => {
    const { id } = await request();
    const row = await load(id);
    expect(row).toMatchObject({
      workspace_id: acme.id,
      kind: "message",
      status: "pending",
      target_type: "message",
      requested_by: { type: "system", id: "system" },
    });
    expect(row?.expires_at?.getTime()).toBe(engine.clock.now().getTime() + 7 * 24 * 3_600_000);
    const [event] = await engine.db
      .select()
      .from(events)
      .where(and(eq(events.type, "approval.requested"), eq(events.subject_id, id)));
    expect(event?.data).toMatchObject({ approval_id: id, kind: "message" });

    const other = await request({}, await engine.systemContext(globex.id));
    expect((await load(other.id))?.expires_at?.getTime()).toBe(
      engine.clock.now().getTime() + 2 * 24 * 3_600_000,
    );
    expect(await pendingApprovalCounts(engine.db, acme.id)).toEqual({ message: 1 });
  });

  it("lists pending items (payload only when detailed) and gets one in full", async () => {
    const { id } = await request();
    const concise = (await engine.call("approvals.list", {}, { workspace: "acme" })) as {
      items: Array<Record<string, unknown>>;
    };
    expect(concise.items).toHaveLength(1);
    expect(concise.items[0]).not.toHaveProperty("payload");
    const detailed = (await engine.call(
      "approvals.list",
      { kind: "message" },
      { workspace: "acme", responseFormat: "detailed" },
    )) as { items: Array<Record<string, unknown>> };
    expect(detailed.items[0]?.payload).toEqual({
      subject: "Quick question",
      body: "Hi Sam",
      n: expect.any(Number),
    });
    await expect(
      engine.call("approvals.get", { approval_id: id }, { workspace: "acme" }),
    ).resolves.toMatchObject({ id, status: "pending", payload: { subject: "Quick question" } });
    await expect(
      engine.call("approvals.get", { approval_id: id }, { workspace: "globex" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("lists pending approvals oldest first and resolved ones newest first, page by page", async () => {
    type Page = { items: Array<{ id: string }>; next_cursor: string | null };
    const list = (input: Record<string, unknown>) =>
      engine.call("approvals.list", input, { workspace: "acme" }) as Promise<Page>;
    const first = await request();
    const second = await request();
    const third = await request();

    const page = await list({ limit: 2 });
    expect(page.items.map((item) => item.id)).toEqual([first.id, second.id]);
    const rest = await list({ limit: 2, cursor: page.next_cursor });
    expect(rest.items.map((item) => item.id)).toEqual([third.id]);
    expect(rest.next_cursor).toBeNull();

    await decide({ approval_ids: [first.id, second.id, third.id], decision: "reject" });
    const history = await list({ status: "rejected", limit: 2 });
    expect(history.items.map((item) => item.id)).toEqual([third.id, second.id]);
    const older = await list({ status: "rejected", limit: 2, cursor: history.next_cursor });
    expect(older.items.map((item) => item.id)).toEqual([first.id]);
  });

  it("reuses an identical pending request and can supersede older ones", async () => {
    const same = () =>
      ctx.approvals.request({
        kind: "message",
        title: "Send email to Sam Rivera (Example Dental)",
        summary: "First touch of the Q4 campaign.",
        payload: { subject: "Same", body: "Same body" },
        target: { type: "message", id: "msg_01k6a3v0q8x3m2n4p5r6s7t8w1" },
      });
    const first = await same();
    expect(first.deduplicated).toBeUndefined();
    expect(await same()).toEqual({ id: first.id, deduplicated: true });

    const target = { type: "campaign", id: "cmp_01k6a3v0q8x3m2n4p5r6s7t8v9" };
    const launch = (queued: number) =>
      ctx.approvals.request({
        kind: "campaign_launch",
        title: "Launch campaign",
        summary: `${queued} queued`,
        payload: { queued },
        target,
        supersede: true,
      });
    const older = await launch(1);
    const newer = await launch(2);
    const rows = await engine.db
      .select({ id: approvals.id, status: approvals.status })
      .from(approvals)
      .where(eq(approvals.target_id, target.id));
    expect(rows).toEqual(
      expect.arrayContaining([
        { id: older.id, status: "cancelled" },
        { id: newer.id, status: "pending" },
      ]),
    );
  });

  it("cancels by target and refuses unfiltered cancels", async () => {
    await request();
    await request();
    expect(
      await ctx.approvals.cancel({
        target: { type: "message", id: "msg_01k6a3v0q8x3m2n4p5r6s7t8v9" },
      }),
    ).toBe(2);
    await expect(ctx.approvals.cancel({})).rejects.toBeInstanceOf(OpenOutboundError);
    expect(await pendingApprovalCounts(engine.db, acme.id)).toEqual({});
  });
});

describe("decisions", () => {
  it("approves through the kind's resolver and records who decided", async () => {
    const { id } = await request();
    const result = await decide({ approval_id: id, decision: "approve", note: "Looks good" });
    expect(result).toMatchObject({ approved: 1, rejected: 0, failed: 0 });
    expect(result.results[0]).toMatchObject({
      approval_id: id,
      ok: true,
      status: "approved",
      message: "Email scheduled",
      target: { type: "message", id: "msg_01k6a3v0q8x3m2n4p5r6s7t8v9" },
      data: { subject: "Quick question" },
      error: null,
    });
    expect(applied[0]?.decision).toMatchObject({
      decision: "approve",
      note: "Looks good",
      decidedBy: { type: "human", id: "test-admin" },
    });
    expect(applied[0]?.actor).toBe("test-admin");
    expect(await load(id)).toMatchObject({
      status: "approved",
      decision_note: "Looks good",
      decided_by: { id: "test-admin" },
      edited: false,
    });
    const decided = await engine.db
      .select()
      .from(events)
      .where(eq(events.type, "approval.decided"));
    expect(decided[0]?.data).toMatchObject({
      approval_id: id,
      decision: "approve",
      status: "approved",
    });

    const again = await decide({ approval_id: id, decision: "reject" });
    expect(again.results[0]).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("applies edits before approving and rejects with the resolver too", async () => {
    const first = await request();
    const second = await request();
    const edited = await decide({
      approval_id: first.id,
      decision: "edit",
      edits: { subject: "Better subject" },
    });
    expect(edited.results[0]).toMatchObject({ ok: true, status: "approved" });
    expect(applied[0]?.approval.payload).toEqual({
      subject: "Better subject",
      body: "Hi Sam",
      n: expect.any(Number),
    });
    expect(applied[0]?.decision.edits).toEqual({ subject: "Better subject" });
    expect(await load(first.id)).toMatchObject({
      edited: true,
      payload: { subject: "Better subject" },
    });
    await expect(decide({ approval_id: second.id, decision: "edit" })).rejects.toMatchObject({
      code: "validation_failed",
    });
    await expect(decide({ decision: "approve" })).rejects.toMatchObject({
      code: "validation_failed",
    });

    const rejected = await decide({ approval_id: second.id, decision: "reject" });
    expect(rejected).toMatchObject({ rejected: 1 });
    expect(rejected.results[0]).toMatchObject({ status: "rejected", message: "Draft discarded" });
  });

  it("reports each approval of a bulk decision separately", async () => {
    const good = await request();
    const failing = await request({ fail: true });
    const done = await request();
    await decide({ approval_id: done.id, decision: "reject" });
    const missing = newId("apr");
    const result = await decide({
      approval_ids: [good.id, failing.id, done.id, missing, good.id],
      decision: "approve",
    });
    expect(result).toMatchObject({ approved: 1, failed: 3 });
    expect(result.results.map((entry) => [entry.approval_id, entry.ok, entry.status])).toEqual([
      [good.id, true, "approved"],
      [failing.id, false, "pending"],
      [done.id, false, "rejected"],
      [missing, false, null],
    ]);
    expect(result.results[1]?.error).toEqual({
      code: "provider_error",
      message: "Mailbox offline.",
      hint: "Reconnect the mailbox.",
    });
    expect(result.results[3]?.error).toMatchObject({ code: "not_found" });
    expect(await load(failing.id)).toMatchObject({
      status: "pending",
      decided_by: null,
      decided_at: null,
    });
  });

  it("never approves expired items", async () => {
    const stale = await request();
    const other = await request();
    engine.advance(8 * 24 * 3_600_000);
    const result = await decide({ approval_id: stale.id, decision: "approve" });
    expect(result.results[0]).toMatchObject({
      ok: false,
      status: "expired",
      error: { code: "conflict" },
    });
    expect(applied).toHaveLength(0);
    expect(await expireApprovals(engine.db, engine.clock.now())).toBe(1);
    expect((await load(other.id))?.status).toBe("expired");
  });

  it("needs the approve scope and stays inside the workspace", async () => {
    const { id } = await request();
    await expect(
      decide({ approval_id: id, decision: "approve" }, { scopes: ["read", "write", "send"] }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const agent = engine.principal({
      type: "agent",
      id: "key_agent",
      name: "Agent key",
      scopes: ["read", "write", "send", "spend"],
      workspaceId: acme.id,
    });
    await expect(
      engine.call(
        "approvals.decide",
        { approval_id: id, decision: "approve" },
        { principal: agent },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    const foreign = await decide({ approval_id: id, decision: "approve" }, { workspace: "globex" });
    expect(foreign.results[0]).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect((await load(id))?.status).toBe("pending");
  });

  it("never lets an agent decide its own request, even holding approve", async () => {
    const agent = engine.principal({
      type: "agent",
      id: "key_agent",
      name: "Agent key",
      scopes: [...ALL_SCOPES],
      workspaceId: acme.id,
    });
    const asked = (await engine.call(
      "reviewer.ask",
      { subject: "Pricing" },
      { principal: agent },
    )) as { approval_id: string };
    const fromEngine = await request();
    expect((await load(asked.approval_id))?.requested_by).toMatchObject({
      type: "agent",
      id: "key_agent",
    });

    const own = (await engine.call(
      "approvals.decide",
      { approval_ids: [asked.approval_id, fromEngine.id], decision: "approve" },
      { principal: agent },
    )) as { results: Array<Record<string, unknown>>; approved: number; failed: number };
    expect(own).toMatchObject({ approved: 1, failed: 1 });
    expect(own.results[0]).toMatchObject({
      approval_id: asked.approval_id,
      ok: false,
      status: "pending",
      error: { code: "forbidden", hint: expect.stringContaining("person") },
    });
    // Requests the engine made itself can be decided by anyone holding approve.
    expect(own.results[1]).toMatchObject({ approval_id: fromEngine.id, ok: true });
    expect((await load(asked.approval_id))?.status).toBe("pending");
    expect(applied.map((entry) => entry.approval.id)).toEqual([fromEngine.id]);

    // The same principal is refused through every way of deciding: a person decides it.
    const rejectOwn = (await engine.call(
      "approvals.decide",
      { approval_id: asked.approval_id, decision: "reject" },
      { principal: agent },
    )) as { results: Array<Record<string, unknown>> };
    expect(rejectOwn.results[0]).toMatchObject({ ok: false, error: { code: "forbidden" } });
    const human = await decide({ approval_id: asked.approval_id, decision: "approve" });
    expect(human.results[0]).toMatchObject({ ok: true, status: "approved" });

    // A person holding approve could have made the change directly: their own request is theirs
    // to decide (one-person setups ask themselves, e.g. ask_first saved searches).
    const owner = engine.principal({ id: "key_owner", name: "Owner", workspaceId: acme.id });
    const mine = (await engine.call(
      "reviewer.ask",
      { subject: "Owner pricing" },
      { principal: owner },
    )) as { approval_id: string };
    const decided = (await engine.call(
      "approvals.decide",
      { approval_id: mine.approval_id, decision: "approve" },
      { principal: owner },
    )) as { results: Array<Record<string, unknown>> };
    expect(decided.results[0]).toMatchObject({ ok: true, status: "approved" });
  });

  it("records decisions for kinds without a resolver", async () => {
    const { id } = await ctx.approvals.request({
      kind: "comment",
      title: "Comment action",
      summary: "Nothing handles it.",
      payload: {},
    });
    const result = await decide({ approval_id: id, decision: "approve" });
    expect(result.results[0]).toMatchObject({
      ok: true,
      status: "approved",
      message: 'Decision recorded. No module handles "comment" approvals.',
    });
  });
});

describe("edits", () => {
  it("changes only the fields the kind allows and never the target", async () => {
    const { id } = await request();
    const retarget = await decide({
      approval_id: id,
      decision: "edit",
      edits: { message_id: "msg_01k6a3v0q8x3m2n4p5r6s7t8va", body: "Hi Sam, other text" },
    });
    expect(retarget).toMatchObject({ failed: 1 });
    expect(retarget.results[0]).toMatchObject({
      ok: false,
      status: "pending",
      error: {
        code: "validation_failed",
        message: expect.stringMatching(/message_id.*subject, body/),
      },
    });
    expect(applied).toHaveLength(0);
    expect(await load(id)).toMatchObject({
      status: "pending",
      edited: false,
      payload: { subject: "Quick question", body: "Hi Sam" },
    });

    const fine = await decide({ approval_id: id, decision: "edit", edits: { body: "Hi Sam!" } });
    expect(fine.results[0]).toMatchObject({ ok: true, status: "approved" });
    expect(applied[0]?.approval.payload).toMatchObject({ body: "Hi Sam!" });
  });

  it("refuses edits to kinds that take none", async () => {
    const { id } = await ctx.approvals.request({
      kind: "campaign_launch",
      title: "Launch",
      summary: "Launch the campaign.",
      payload: { campaign_id: "cmp_01k6a3v0q8x3m2n4p5r6s7t8v9" },
      target: { type: "campaign", id: "cmp_01k6a3v0q8x3m2n4p5r6s7t8v9" },
    });
    const result = await decide({
      approval_id: id,
      decision: "edit",
      edits: { campaign_id: "cmp_01k6a3v0q8x3m2n4p5r6s7t8va" },
    });
    expect(result.results[0]).toMatchObject({
      ok: false,
      status: "pending",
      error: { code: "validation_failed", message: expect.stringContaining("takes no edits") },
    });
    const resend = await request({ action: "resend", attempt: 1 });
    const edited = await decide({ approval_id: resend.id, decision: "edit", edits: { body: "x" } });
    expect(edited.results[0]).toMatchObject({ error: { code: "validation_failed" } });
    expect(applied).toHaveLength(0);
  });

  it("lets a list only shrink", async () => {
    const ask = () =>
      ctx.approvals.request({
        kind: "lead_import",
        title: "Add 2 leads",
        summary: "Two people matched.",
        payload: {
          source: "leads",
          person_ids: ["pe_a", "pe_b"],
          list_id: "lst_a",
          n: ++requestCount,
        },
      });
    const grown = await ask();
    const more = await decide({
      approval_id: grown.id,
      decision: "edit",
      edits: { person_ids: ["pe_a", "pe_c"] },
    });
    expect(more.results[0]).toMatchObject({
      ok: false,
      error: { code: "validation_failed", message: expect.stringContaining("person_ids") },
    });
    const moved = await decide({
      approval_id: grown.id,
      decision: "edit",
      edits: { list_id: "lst_b" },
    });
    expect(moved.results[0]).toMatchObject({ ok: false, error: { code: "validation_failed" } });
    const fewer = await decide({
      approval_id: grown.id,
      decision: "edit",
      edits: { person_ids: ["pe_b"] },
    });
    expect(fewer.results[0]).toMatchObject({ ok: true, status: "approved" });
    expect((await load(grown.id))?.payload).toMatchObject({
      person_ids: ["pe_b"],
      list_id: "lst_a",
    });
  });

  it("takes the fields a module's resolver declares for its own kind", async () => {
    const { id } = await ctx.approvals.request({
      kind: "custom",
      title: "Send a gift",
      summary: "A book for Sam.",
      payload: { gift: "book", person_id: "pe_a" },
    });
    const other = await decide({
      approval_id: id,
      decision: "edit",
      edits: { person_id: "pe_b" },
    });
    expect(other.results[0]).toMatchObject({ error: { code: "validation_failed" } });
    const coffee = await decide({ approval_id: id, decision: "edit", edits: { gift: "coffee" } });
    expect(coffee.results[0]).toMatchObject({ ok: true, message: "Gift: coffee" });
  });
});

describe("requests from keys a decider created", () => {
  interface Key {
    id: string;
    key: string;
  }
  const mint = async (name: string, scopes: string[] | undefined, by?: Principal) =>
    (await engine.call(
      "keys.create",
      { name, kind: "agent", ...(scopes ? { scopes } : {}) },
      { workspace: "acme", ...(by ? { principal: by } : {}) },
    )) as Key;
  const login = async (created: Key): Promise<Principal> => {
    const principal = await engine.authenticate(created.key, "http");
    if (!principal) throw new Error("key does not authenticate");
    return principal;
  };
  const ask = async (principal: Principal, subject: string) =>
    (
      (await engine.call("reviewer.ask", { subject }, { principal, workspace: "acme" })) as {
        approval_id: string;
      }
    ).approval_id;
  const decideAs = async (principal: Principal, approvalId: string) =>
    (
      (await engine.call(
        "approvals.decide",
        { approval_id: approvalId, decision: "approve" },
        { principal, workspace: "acme" },
      )) as { results: Array<Record<string, unknown>> }
    ).results[0];

  it("counts every key an agent minted, directly or further down, as the agent itself", async () => {
    // An owner gave agent X approve and admin; X mints keys of its own.
    const x = await login(await mint("Agent X", [...ALL_SCOPES]));
    const child = await login(
      await mint("Child of X", ["read", "write", "send", "spend", "admin"], x),
    );
    const grandchild = await login(await mint("Grandchild of X", undefined, child));
    const sibling = await login(await mint("Second key of X", ["read", "write", "approve"], x));

    for (const requester of [child, grandchild]) {
      const asked = await ask(requester, `From ${requester.name}`);
      expect(await decideAs(x, asked)).toMatchObject({
        ok: false,
        status: "pending",
        error: { code: "forbidden", message: expect.stringContaining("keys an agent creates") },
      });
      expect(await decideAs(sibling, asked)).toMatchObject({ error: { code: "forbidden" } });
    }
    // The other way round too: a key X minted cannot decide X's own request.
    const fromX = await ask(x, "From X");
    expect(await decideAs(sibling, fromX)).toMatchObject({ error: { code: "forbidden" } });
    expect(applied).toHaveLength(0);

    // Another agent the owner gave approve decides them, and so does a person.
    const reviewerKey = await login(await mint("Reviewer agent", ["read", "approve"]));
    const fromChild = await ask(child, "Child again");
    expect(await decideAs(reviewerKey, fromChild)).toMatchObject({ ok: true, status: "approved" });
    expect((await decide({ approval_id: fromX, decision: "approve" })).results[0]).toMatchObject({
      ok: true,
    });
  });
});
