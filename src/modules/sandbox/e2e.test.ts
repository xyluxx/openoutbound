/**
 * End-to-end coverage for the sandbox's fake-brain answers (src/sandbox/brain/answers.ts), on a
 * real engine: sandbox.seed really runs, campaigns.preview really runs the writing pipeline
 * (research, signals, knowledge grounding, the deterministic checks, the checker prompt), and a
 * simulated reply really goes through ingestInboundEmail and the inbox.classify job. None of
 * this mocks the brain: sandbox workspaces always resolve to the fake brain
 * (src/brain/service.ts), which serves the answers registered by registerSandboxBrainAnswers().
 */
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { campaigns, messages } from "../../db/schema/index.js";
import { ingestInboundEmail } from "../../modules/email/service.js";
import { buildReplyBody, buildReplySubject } from "../../sandbox/simulator/content.js";
import { createTestEngine, type TestEngine } from "../../testing/engine.js";
import { seedMailbox, seedMessage, seedPerson, seedThread } from "../../testing/factories.js";

interface SeedWorkspace {
  workspace_id: string;
  slug: string;
}

interface PreviewItem {
  person: { id: string; name: string; company: string | null };
  subject: string | null;
  body: string | null;
  check: { verdict: string; issues: Array<{ code: string; message: string }> } | null;
  skipped_reason: string | null;
}

describe("sandbox brain answers, end to end", () => {
  let engine: TestEngine;

  afterEach(async () => {
    await engine?.close();
  });

  it("drafts a first-touch email that names the lead and their company, and passes the checker", async () => {
    engine = await createTestEngine();
    const seeded = (await engine.call("sandbox.seed", {})) as { workspaces: SeedWorkspace[] };
    const northwind = seeded.workspaces.find((w) => w.slug === "northwind");
    expect(northwind).toBeDefined();
    if (!northwind) throw new Error("northwind workspace was not seeded");

    const ctx = await engine.systemContext(northwind.workspace_id);
    const [campaign] = await ctx.db
      .select()
      .from(campaigns)
      .where(
        and(
          eq(campaigns.workspace_id, northwind.workspace_id),
          eq(campaigns.name, "Re-engage cold list"),
        ),
      );
    expect(campaign).toBeDefined();
    if (!campaign) throw new Error('"Re-engage cold list" campaign was not seeded');

    // Step 0 of this campaign is a free-style, first-touch email step (see
    // src/sandbox/world/blueprints.ts), so this genuinely exercises buildWriteEmailAnswer
    // rather than the guided/exact template-merge path.
    const output = (await engine.call(
      "campaigns.preview",
      { campaign_id: campaign.id, count: 1, step_position: 0 },
      { workspace: northwind.workspace_id },
    )) as { items: PreviewItem[] };

    expect(output.items.length).toBeGreaterThan(0);
    const item = output.items[0];
    if (!item) throw new Error("campaigns.preview returned no items");
    expect(item.skipped_reason).toBeNull();
    expect(item.body).toBeTruthy();

    const firstName = item.person.name.split(/\s+/)[0] ?? "";
    expect(firstName.length).toBeGreaterThan(0);
    expect(item.body).toContain(firstName);
    // The draft names the company by its first word (e.g. "Brightline" for "Brightline
    // Apparel"), the way a peer would actually write it, whatever language it is written in.
    const companyShort = item.person.company?.split(/\s+/)[0] ?? "";
    expect(companyShort.length).toBeGreaterThan(0);
    expect(item.body).toContain(companyShort);
    expect(item.check?.verdict).toBe("pass");
  });

  it("classifies a simulated interested reply and a simulated unsubscribe reply correctly", async () => {
    engine = await createTestEngine();
    const seeded = (await engine.call("sandbox.seed", {})) as { workspaces: SeedWorkspace[] };
    const northwind = seeded.workspaces.find((w) => w.slug === "northwind");
    expect(northwind).toBeDefined();
    if (!northwind) throw new Error("northwind workspace was not seeded");
    const ctx = await engine.systemContext(northwind.workspace_id);

    async function simulateReply(kind: "interested" | "unsubscribe") {
      const mailbox = await seedMailbox(ctx);
      const person = await seedPerson(ctx, {
        first_name: "Jamie",
        last_name: "Cole",
        full_name: "Jamie Cole",
        email: `jamie.cole.${kind}@example.com`,
      });
      const subject = "quick idea for your team";
      const thread = await seedThread(ctx, { subject });
      const outbound = await seedMessage(ctx, {
        thread_id: thread.id,
        person_id: person.id,
        mailbox_id: mailbox.id,
        direction: "outbound",
        status: "sent",
        subject,
        message_id_header: `<out_${kind}@example.com>`,
        sent_at: ctx.clock.now(),
      });

      const replySubject = buildReplySubject(subject, "en");
      const replyText = buildReplyBody(
        kind,
        {
          prospectFirstName: person.first_name ?? "there",
          senderName: mailbox.from_name ?? "there",
          originalSubject: subject,
        },
        "en",
      );
      const result = await ingestInboundEmail(ctx, {
        mailboxId: mailbox.id,
        from: person.email ?? `jamie.cole.${kind}@example.com`,
        to: [mailbox.email],
        subject: replySubject,
        text: replyText,
        headers: {
          From: person.email ?? "",
          To: mailbox.email,
          Subject: replySubject,
          "Message-ID": `<reply_${kind}@example.com>`,
          "In-Reply-To": outbound.message_id_header ?? "",
        },
        messageIdHeader: `<reply_${kind}@example.com>`,
        inReplyTo: outbound.message_id_header ?? undefined,
        references: outbound.message_id_header ? [outbound.message_id_header] : [],
        receivedAt: ctx.clock.now(),
      });
      // Neither reply is a recognized bounce or automated header, so ingest stores it as a
      // plain, not-yet-classified reply on the matched thread; classification is decided by the
      // inbox.classify job below (either its own deterministic precheck, or the fake brain's
      // registered inbox.reply.classify answer).
      expect(result.kind).toBe("reply");
      return result.messageId;
    }

    const interestedMessageId = await simulateReply("interested");
    const unsubscribeMessageId = await simulateReply("unsubscribe");

    await engine.runJobs();

    const [interestedRow] = await ctx.db
      .select()
      .from(messages)
      .where(eq(messages.id, interestedMessageId));
    expect(interestedRow?.classification?.category).toBe("interested");

    const [unsubscribeRow] = await ctx.db
      .select()
      .from(messages)
      .where(eq(messages.id, unsubscribeMessageId));
    expect(unsubscribeRow?.classification?.category).toBe("unsubscribe");
  });
});
