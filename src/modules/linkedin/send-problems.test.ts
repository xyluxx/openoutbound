/**
 * The LinkedIn side of the outage and failure problems: a restriction or a lost session opens
 * `mailbox_down` for the account (never a person's pause), a resume or a reconnect resolves it;
 * an action that fails for good counts in `send_failed`.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { OpenOutboundError } from "../../core/errors.js";
import { problems } from "../../db/schema/index.js";
import type { LinkedInProvider } from "../../providers/types.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import {
  seedCampaign,
  seedLinkedInAccount,
  seedMessage,
  seedPerson,
} from "../../testing/factories.js";
import { runLinkedInAction } from "./action-job.js";
import { pauseAccount, resumeAccount } from "./operations.js";
import { processLinkedInEvent } from "./sync.js";

vi.mock("../../runtime/notify.js", () => ({ notify: vi.fn(async () => {}) }));

/** Tuesday 2026-09-22 10:00 in Chicago (inside the account's working hours). */
const NOW = "2026-09-22T15:00:00.000Z";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

function fakeProvider() {
  return {
    id: "unipile",
    getProfile: vi.fn(async (_account: string, target: { profile_url?: string | null }) => ({
      provider_id: "ACoAAmember",
      profile_url: target.profile_url ?? "",
      connection_degree: 2 as 1 | 2 | 3 | null,
      invitation_pending: false,
    })),
    visitProfile: vi.fn(async () => {}),
    sendInvite: vi.fn(async () => ({ providerRef: "ACoAAmember" })),
    sendMessage: vi.fn(async () => ({ messageId: "li_msg_1", chatId: "chat_1" })),
    listRecentPosts: vi.fn(
      async () => [] as Array<{ id: string; text: string; published_at: string }>,
    ),
    reactToPost: vi.fn(async () => {}),
    commentOnPost: vi.fn(async () => ({ commentId: "comment_1" })),
  } satisfies LinkedInProvider;
}

async function setup() {
  const provider = fakeProvider();
  const ctx = await createTestContext({ db, now: NOW, providers: { linkedin: provider } });
  const account = await seedLinkedInAccount(ctx, { provider: "unipile", name: "Sam on LinkedIn" });
  const person = await seedPerson(ctx, {
    full_name: "Omar Haddad",
    linkedin_url: "https://www.linkedin.com/in/omar-haddad-example",
  });
  const action = (over: Parameters<typeof seedMessage>[1] = {}) =>
    seedMessage(ctx, {
      channel: "linkedin",
      action: "visit",
      status: "scheduled",
      subject: null,
      body_text: "",
      linkedin_account_id: account.id,
      person_id: person.id,
      scheduled_for: new Date(NOW),
      ...over,
    });
  const run = (messageId: string) =>
    runLinkedInAction(ctx.jobContext({ name: "linkedin.action" }), messageId);
  return { ctx, provider, account, person, action, run };
}

async function problemsOf(ctx: TestContext, kind: "mailbox_down" | "send_failed") {
  return ctx.db
    .select()
    .from(problems)
    .where(and(eq(problems.workspace_id, ctx.workspace.id), eq(problems.kind, kind)));
}

const restricted = () =>
  new OpenOutboundError("provider_error", "Checkpoint required", {
    details: { restricted: true },
  });

describe("mailbox_down for LinkedIn accounts", () => {
  it("opens once when LinkedIn restricts the account; a person's resume resolves it", async () => {
    const s = await setup();
    s.provider.visitProfile.mockRejectedValueOnce(restricted());
    expect(await s.run((await s.action()).id)).toMatchObject({ status: "paused" });

    const [problem] = await problemsOf(s.ctx, "mailbox_down");
    expect(problem).toMatchObject({
      severity: "high",
      owner: "person",
      status: "open",
      title: "LinkedIn account Sam on LinkedIn stopped sending",
      dedupe_key: `mailbox_down:${s.account.id}`,
      subject_type: "linkedin_account",
      subject_id: s.account.id,
    });
    expect(problem?.reason).toBe(
      "LinkedIn restricted it: Checkpoint required. Every queued action waits until it is resumed.",
    );
    expect(problem?.remedy).toContain(
      `then resumes it with manage_linkedin action resume (account_id ${s.account.id})`,
    );

    await resumeAccount.handler(s.ctx, resumeAccount.input.parse({ account_id: s.account.id }));
    const [resolved] = await problemsOf(s.ctx, "mailbox_down");
    expect(resolved).toMatchObject({ status: "resolved", resolution: "Resumed by Test User." });

    // Restricted again later: a new problem, still one open at a time.
    s.provider.visitProfile.mockRejectedValueOnce(restricted());
    await s.run((await s.action()).id);
    const rows = await problemsOf(s.ctx, "mailbox_down");
    expect(rows.filter((row) => row.status === "open")).toHaveLength(1);
  });

  it("opens for a lost session and resolves when LinkedIn reports it reconnected", async () => {
    const s = await setup();
    await processLinkedInEvent(s.ctx, s.account, {
      type: "account_status",
      account_id: s.account.external_account_id ?? "",
      status: "disconnected",
      reason: "session expired",
    });
    const [problem] = await problemsOf(s.ctx, "mailbox_down");
    expect(problem?.reason).toBe(
      "Its LinkedIn session was lost: Provider reported session expired. Every queued action waits until it is reconnected.",
    );
    expect(problem?.remedy).toBe(
      `Reconnect it with manage_linkedin action connect, then resume it with manage_linkedin action resume (account_id ${s.account.id}).`,
    );

    await processLinkedInEvent(
      s.ctx,
      { ...s.account, status: "disconnected" },
      {
        type: "account_status",
        account_id: s.account.external_account_id ?? "",
        status: "active",
        reason: "RECONNECTED",
      },
    );
    const [resolved] = await problemsOf(s.ctx, "mailbox_down");
    expect(resolved).toMatchObject({
      status: "resolved",
      resolution: "LinkedIn reported it reconnected.",
    });
  });

  it("opens nothing for a pause a person made", async () => {
    const s = await setup();
    await pauseAccount.handler(s.ctx, pauseAccount.input.parse({ account_id: s.account.id }));
    expect(await problemsOf(s.ctx, "mailbox_down")).toHaveLength(0);
  });
});

describe("send_failed for LinkedIn actions", () => {
  it("counts an invitation note that is too long, not an action whose person is gone", async () => {
    const s = await setup();
    const { campaign, steps } = await seedCampaign(s.ctx, {
      name: "LinkedIn touch",
      status: "active",
      steps: [{ type: "linkedin_invite" }],
      settings: { senders: { linkedin_account_ids: [s.account.id] } },
    });
    const long = await s.action({
      action: "invite",
      body_text: "x".repeat(320),
      campaign_id: campaign.id,
      step_id: steps[0]?.id ?? null,
    });
    expect(await s.run(long.id)).toMatchObject({ status: "failed" });
    const [problem] = await problemsOf(s.ctx, "send_failed");
    expect(problem).toMatchObject({
      dedupe_key: `send_failed:${campaign.id}:too_long`,
      title: "Sends fail in campaign LinkedIn touch: text too long",
    });
    expect(problem?.remedy).toContain(
      `Fix the step's text with create_campaign action update (campaign_id ${campaign.id})`,
    );

    const orphan = await s.action({ person_id: null });
    expect(await s.run(orphan.id)).toMatchObject({ status: "failed", reason: "missing_person" });
    expect(await problemsOf(s.ctx, "send_failed")).toHaveLength(1);
  });
});
