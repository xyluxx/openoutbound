import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mailboxes, messages, people, suppressions, threads } from "../../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../../testing/context.js";
import { seedMailbox, seedMessage, seedPerson, seedThread } from "../../../testing/factories.js";
import { HARD_BOUNCE_PREFIX, SENDER_REJECTION_PREFIX, SOFT_BOUNCE_PREFIX } from "../bounce.js";
import { ingestInboundEmail } from "./ingest.js";
import { parseRawEmail } from "./parse.js";
import type { InboundEmail } from "./types.js";

vi.mock(
  "../../leads/service.js",
  async () => (await import("../test-support.js")).fakeLeadsService,
);
vi.mock("../../../runtime/notify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../runtime/notify.js")>()),
  notify: vi.fn(async () => {}),
}));

const RECEIVED = new Date("2026-09-21T16:00:00Z");
let ctx: TestContext;

async function world() {
  const mailbox = await seedMailbox(ctx, { email: "sam@brand.example.com" });
  const person = await seedPerson(ctx, { email: "dana@harbor.example.com", status: "active" });
  const thread = await seedThread(ctx, { person_id: person.id, mailbox_id: mailbox.id });
  const outbound = await seedMessage(ctx, {
    thread_id: thread.id,
    person_id: person.id,
    mailbox_id: mailbox.id,
    to_address: "dana@harbor.example.com",
    from_address: "sam@brand.example.com",
    status: "sent",
    sent_at: new Date("2026-09-21T15:00:00Z"),
    message_id_header: "<out-1@brand.example.com>",
  });
  return { mailbox, person, thread, outbound };
}

function inbound(mailboxId: string, overrides: Partial<InboundEmail> = {}): InboundEmail {
  return {
    mailboxId,
    from: "Dana Reyes <dana@harbor.example.com>",
    to: ["sam@brand.example.com"],
    subject: "Re: Quick question",
    text: "Sounds good, what does it cost for three clinics?\n\nOn Mon, Sam wrote:\n> Worth a chat?",
    headers: {},
    messageIdHeader: "<reply-1@harbor.example.com>",
    inReplyTo: "<out-1@brand.example.com>",
    receivedAt: RECEIVED,
    ...overrides,
  };
}

beforeEach(async () => {
  ctx = await createTestContext({ now: RECEIVED });
});
afterEach(async () => {
  await ctx.close();
});

describe("ingestInboundEmail", () => {
  it("threads a reply by In-Reply-To, marks the person replied and emits once", async () => {
    const { mailbox, person, thread } = await world();
    const result = await ingestInboundEmail(ctx, inbound(mailbox.id));
    expect(result).toMatchObject({ kind: "reply", threadId: thread.id });
    const [stored] = await ctx.db.select().from(messages).where(eq(messages.id, result.messageId));
    expect(stored).toMatchObject({
      direction: "inbound",
      status: "received",
      thread_id: thread.id,
      person_id: person.id,
      in_reply_to: "<out-1@brand.example.com>",
    });
    const [updatedThread] = await ctx.db.select().from(threads).where(eq(threads.id, thread.id));
    expect(updatedThread?.needs_attention).toBe(true);
    expect(updatedThread?.last_inbound_at?.toISOString()).toBe(RECEIVED.toISOString());
    const [updatedPerson] = await ctx.db.select().from(people).where(eq(people.id, person.id));
    expect(updatedPerson?.status).toBe("replied");
    expect(ctx.emitted("reply.received")).toHaveLength(1);
    expect(ctx.emitted("reply.received")[0]?.data).toMatchObject({
      message_id: result.messageId,
      thread_id: thread.id,
      person_id: person.id,
      auto_reply: false,
    });

    // The same message again (IMAP re-sync) changes nothing.
    const again = await ingestInboundEmail(ctx, inbound(mailbox.id));
    expect(again).toEqual(result);
    expect(ctx.emitted("reply.received")).toHaveLength(1);
  });

  it("keeps the latest reply time when an older reply is synced late", async () => {
    const { mailbox, thread } = await world();
    await ingestInboundEmail(ctx, inbound(mailbox.id));
    const older = new Date(RECEIVED.getTime() - 3 * 86_400_000);
    await ingestInboundEmail(
      ctx,
      inbound(mailbox.id, {
        messageIdHeader: "<reply-0@harbor.example.com>",
        text: "Checking in on my earlier note.",
        receivedAt: older,
      }),
    );
    const [updated] = await ctx.db.select().from(threads).where(eq(threads.id, thread.id));
    expect(updated?.last_inbound_at?.toISOString()).toBe(RECEIVED.toISOString());
  });

  it("threads by sender address when the headers are missing", async () => {
    const { mailbox, thread } = await world();
    const result = await ingestInboundEmail(
      ctx,
      inbound(mailbox.id, {
        inReplyTo: undefined,
        subject: "question",
        messageIdHeader: "<r2@harbor.example.com>",
      }),
    );
    expect(result).toMatchObject({ kind: "reply", threadId: thread.id });
  });

  it("stores auto-replies with the return date and keeps the person active", async () => {
    const { mailbox, person, thread } = await world();
    const result = await ingestInboundEmail(
      ctx,
      inbound(mailbox.id, {
        subject: "Automatic reply: Quick question",
        text: "I am out of the office and back on October 5, 2026.",
        headers: { "auto-submitted": "auto-replied" },
      }),
    );
    expect(result).toMatchObject({ kind: "auto_reply", threadId: thread.id });
    expect(ctx.emitted("reply.received")[0]?.data).toMatchObject({
      auto_reply: true,
      return_date: "2026-10-05",
    });
    const [stored] = await ctx.db.select().from(messages).where(eq(messages.id, result.messageId));
    expect(stored?.classification).toMatchObject({
      category: "out_of_office",
      return_date: "2026-10-05",
    });
    const [updatedThread] = await ctx.db.select().from(threads).where(eq(threads.id, thread.id));
    expect(updatedThread?.needs_attention).toBe(false);
    const [samePerson] = await ctx.db.select().from(people).where(eq(people.id, person.id));
    expect(samePerson?.status).toBe("active");
  });

  it("turns a short 'remove me' reply into an unsubscribe", async () => {
    const { mailbox, person } = await world();
    const result = await ingestInboundEmail(
      ctx,
      inbound(mailbox.id, { text: "Please remove me from your list." }),
    );
    expect(result.kind).toBe("unsubscribe");
    expect(ctx.emitted("reply.received")).toHaveLength(0);
    expect(ctx.emitted("unsubscribe.received")[0]?.data).toMatchObject({
      person_id: person.id,
      email: "dana@harbor.example.com",
      source: "reply",
    });
    const rows = await ctx.db.select().from(suppressions);
    expect(rows.map((row) => [row.value, row.reason])).toEqual([
      ["dana@harbor.example.com", "unsubscribed"],
    ]);
  });

  it("sends a short opt-out that also asks to delete their data to the classifier", async () => {
    const { mailbox, thread } = await world();
    const result = await ingestInboundEmail(
      ctx,
      inbound(mailbox.id, { text: "Unsubscribe me and delete my data." }),
    );
    // The privacy action (inbox) suppresses everywhere and opens the request with its deadline.
    expect(result).toMatchObject({ kind: "reply", threadId: thread.id });
    expect(ctx.emitted("reply.received")).toHaveLength(1);
    expect(ctx.emitted("unsubscribe.received")).toHaveLength(0);
    expect(await ctx.db.select().from(suppressions)).toHaveLength(0);
  });

  it("sends privacy wording with auto-reply headers to the classifier, not the auto-reply shelf", async () => {
    const { mailbox, thread } = await world();
    const result = await ingestInboundEmail(
      ctx,
      inbound(mailbox.id, {
        subject: "Automatic reply: Quick question",
        text: "I am away until Monday. Please delete my data.",
        headers: { "auto-submitted": "auto-replied" },
      }),
    );
    // No auto-reply classification is stored, so the classifier's privacy action runs.
    expect(result).toMatchObject({ kind: "reply", threadId: thread.id });
    const [stored] = await ctx.db.select().from(messages).where(eq(messages.id, result.messageId));
    expect(stored?.classification ?? null).toBeNull();
    expect(stored?.headers).toMatchObject({ "auto-submitted": "auto-replied" });
    expect(ctx.emitted("reply.received")).toHaveLength(1);
    const [updatedThread] = await ctx.db.select().from(threads).where(eq(threads.id, thread.id));
    expect(updatedThread?.needs_attention).toBe(true);

    // A plain auto-reply with a privacy policy footer stays an auto-reply.
    const plain = await ingestInboundEmail(
      ctx,
      inbound(mailbox.id, {
        subject: "Automatic reply: Quick question",
        text: "I am away until Monday. To have your data erased, write to privacy@harbor.example.com.",
        headers: { "auto-submitted": "auto-replied" },
        messageIdHeader: "<reply-2@harbor.example.com>",
      }),
    );
    expect(plain.kind).toBe("auto_reply");
  });

  it("still suppresses an unknown sender whose opt-out asks about their data", async () => {
    const { mailbox } = await world();
    const result = await ingestInboundEmail(
      ctx,
      inbound(mailbox.id, {
        from: "stranger@elsewhere.example.org",
        text: "Unsubscribe me and delete my data.",
        inReplyTo: undefined,
        messageIdHeader: "<s1@elsewhere.example.org>",
      }),
    );
    expect(result.kind).toBe("unsubscribe");
    const rows = await ctx.db.select().from(suppressions);
    expect(rows.map((row) => row.value)).toEqual(["stranger@elsewhere.example.org"]);
  });

  it("ignores warmup mail and mail from unknown senders", async () => {
    const { mailbox } = await world();
    expect(
      await ingestInboundEmail(ctx, inbound(mailbox.id, { headers: { "x-lemwarm": "abc" } })),
    ).toEqual({ messageId: "", threadId: null, kind: "warmup" });
    expect(
      await ingestInboundEmail(
        ctx,
        inbound(mailbox.id, {
          from: "news@vendor.example.org",
          inReplyTo: undefined,
          messageIdHeader: "<n1@vendor.example.org>",
        }),
      ),
    ).toEqual({ messageId: "", threadId: null, kind: "unmatched" });
    expect(
      await ctx.db.select().from(messages).where(eq(messages.direction, "inbound")),
    ).toHaveLength(0);
  });

  it("opens a new thread for known people writing out of the blue", async () => {
    const { mailbox } = await world();
    const other = await seedPerson(ctx, { email: "omar@bluefield.example.com" });
    const result = await ingestInboundEmail(
      ctx,
      inbound(mailbox.id, {
        from: "omar@bluefield.example.com",
        subject: "Your services",
        inReplyTo: undefined,
        messageIdHeader: "<o1@bluefield.example.com>",
      }),
    );
    expect(result.kind).toBe("unmatched");
    const [thread] = await ctx.db.select().from(threads).where(eq(threads.person_id, other.id));
    expect(thread?.id).toBe(result.threadId);
    expect(ctx.emitted("reply.received")[0]?.data).toMatchObject({ kind: "unmatched" });
  });

  it("applies a hard DSN bounce to the original message", async () => {
    const { mailbox, thread } = await world();
    const person = await seedPerson(ctx, { email: "nobody@harbor.example.com", status: "active" });
    const original = await seedMessage(ctx, {
      thread_id: thread.id,
      person_id: person.id,
      mailbox_id: mailbox.id,
      to_address: "nobody@harbor.example.com",
      status: "sent",
      sent_at: new Date("2026-09-21T15:00:00Z"),
      message_id_header: "<orig-gmail@brand.example.com>",
    });
    const raw = readFileSync(new URL("./fixtures/gmail-bounce.eml", import.meta.url), "utf8");
    const email = await parseRawEmail(raw, mailbox.id, RECEIVED);
    const result = await ingestInboundEmail(ctx, email);
    expect(result).toMatchObject({ kind: "bounce", messageId: original.id });
    const [bounced] = await ctx.db.select().from(messages).where(eq(messages.id, original.id));
    expect(bounced?.status).toBe("bounced");
    expect(bounced?.error?.startsWith(HARD_BOUNCE_PREFIX)).toBe(true);
    const [updatedPerson] = await ctx.db.select().from(people).where(eq(people.id, person.id));
    expect(updatedPerson).toMatchObject({ status: "bounced", email_status: "invalid" });
    expect(ctx.emitted("message.bounced")[0]?.data).toMatchObject({
      message_id: original.id,
      person_id: person.id,
      email: "nobody@harbor.example.com",
      bounce_type: "hard",
    });
    const [suppressed] = await ctx.db.select().from(suppressions);
    expect(suppressed).toMatchObject({ value: "nobody@harbor.example.com", reason: "bounced" });
    expect(ctx.emitted("reply.received")).toHaveLength(0);
  });

  it("pauses the whole sending domain instead of blaming the address on sender-authentication rejections", async () => {
    const { mailbox, person, outbound } = await world();
    const sibling = await seedMailbox(ctx, { email: "lee@brand.example.com" });
    const otherDomain = await seedMailbox(ctx, { email: "sam@other.example.org" });
    const result = await ingestInboundEmail(
      ctx,
      inbound(mailbox.id, {
        from: "MAILER-DAEMON@mail.brand.example.com",
        subject: "Undelivered Mail Returned to Sender",
        text: "Final-Recipient: rfc822; dana@harbor.example.com\nAction: failed\nStatus: 5.7.26\nDiagnostic-Code: smtp; 550 5.7.26 Unauthenticated email is not accepted",
        inReplyTo: undefined,
        messageIdHeader: "<dsn-2@mail.brand.example.com>",
      }),
    );
    expect(result).toMatchObject({ kind: "bounce", messageId: outbound.id });
    const rows = await ctx.db.select().from(mailboxes);
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const id of [mailbox.id, sibling.id]) {
      expect(byId.get(id)).toMatchObject({ status: "paused" });
      // An authentication failure waits for a person (fix DNS, then resume): no end time.
      expect(byId.get(id)?.health.auto_pause).toMatchObject({
        kind: "provider_block",
        status: "5.7.26",
        domain: "brand.example.com",
        until: null,
      });
    }
    expect(byId.get(otherDomain.id)?.status).toBe("active");
    expect(ctx.emitted("mailbox.paused")).toHaveLength(2);
    const [message] = await ctx.db.select().from(messages).where(eq(messages.id, outbound.id));
    expect(message?.status).toBe("bounced");
    expect(message?.error?.startsWith(SENDER_REJECTION_PREFIX)).toBe(true);
    const [samePerson] = await ctx.db.select().from(people).where(eq(people.id, person.id));
    expect(samePerson?.status).toBe("active");
    expect(await ctx.db.select().from(suppressions)).toHaveLength(0);
    expect(ctx.emitted("message.bounced")).toHaveLength(0);
  });

  /** A DSN for one of our messages, with the remote server's answer. */
  function dsn(
    mailboxId: string,
    id: string,
    original: string,
    status: string,
    diagnostic: string,
    to = "dana@harbor.example.com",
  ): InboundEmail {
    return inbound(mailboxId, {
      from: "MAILER-DAEMON@mail.brand.example.com",
      subject: "Undelivered Mail Returned to Sender",
      text: [
        `X-Original-Message-ID: ${original}`,
        "",
        `Final-Recipient: rfc822; ${to}`,
        "Action: failed",
        `Status: ${status}`,
        `Diagnostic-Code: smtp; ${diagnostic}`,
      ].join("\n"),
      inReplyTo: undefined,
      messageIdHeader: `<${id}@mail.brand.example.com>`,
    });
  }

  /** A second message to the person in the world, so two bounces can refer to two sends. */
  async function secondSend(w: Awaited<ReturnType<typeof world>>, header: string) {
    return seedMessage(ctx, {
      thread_id: w.thread.id,
      person_id: w.person.id,
      mailbox_id: w.mailbox.id,
      to_address: "dana@harbor.example.com",
      from_address: "sam@brand.example.com",
      status: "sent",
      sent_at: new Date("2026-09-21T15:30:00Z"),
      message_id_header: header,
    });
  }

  async function recipientState(personId: string) {
    const [person] = await ctx.db.select().from(people).where(eq(people.id, personId));
    return {
      status: person?.status,
      email_status: person?.email_status,
      suppressions: await ctx.db.select().from(suppressions),
      bounced_events: ctx.emitted("message.bounced").length,
    };
  }

  it("never counts reputation or policy rejections of the sender against the recipient", async () => {
    const w = await world();
    const second = await secondSend(w, "<out-2@brand.example.com>");
    const blocked =
      "550 5.7.1 Service unavailable; client host [192.0.2.10] blocked using zen.spamhaus.org";
    for (const [id, original] of [
      ["dsn-a", "<out-1@brand.example.com>"],
      ["dsn-b", "<out-2@brand.example.com>"],
    ] as const) {
      const result = await ingestInboundEmail(
        ctx,
        dsn(w.mailbox.id, id, original, "5.7.1", blocked),
      );
      expect(result.kind).toBe("bounce");
    }

    // Two rejections within 14 days: the recipient is still clean.
    expect(await recipientState(w.person.id)).toEqual({
      status: "active",
      email_status: w.person.email_status,
      suppressions: [],
      bounced_events: 0,
    });
    // The messages did bounce, marked as rejections of the sender.
    const rows = await ctx.db.select().from(messages).where(eq(messages.person_id, w.person.id));
    for (const id of [w.outbound.id, second.id]) {
      const row = rows.find((message) => message.id === id);
      expect(row?.status).toBe("bounced");
      expect(row?.error?.startsWith(SENDER_REJECTION_PREFIX)).toBe(true);
    }
    // The sending mailbox pays: two failures on its health.
    const [mailbox] = await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, w.mailbox.id));
    expect(mailbox?.health.consecutive_failures).toBe(2);
    expect(mailbox?.health.last_error).toContain("5.7.1");
    expect(mailbox?.status).toBe("active");
  });

  it("never lets two provider blocks suppress the recipient", async () => {
    const w = await world();
    await secondSend(w, "<out-2@brand.example.com>");
    await ingestInboundEmail(
      ctx,
      dsn(
        w.mailbox.id,
        "dsn-a",
        "<out-1@brand.example.com>",
        "5.7.26",
        "550 5.7.26 Unauthenticated email from brand.example.com is not accepted",
      ),
    );
    await ingestInboundEmail(
      ctx,
      dsn(
        w.mailbox.id,
        "dsn-b",
        "<out-2@brand.example.com>",
        "4.7.28",
        "421 4.7.28 Our system has detected an unusual rate of unsolicited mail",
      ),
    );
    expect(await recipientState(w.person.id)).toMatchObject({
      status: "active",
      suppressions: [],
      bounced_events: 0,
    });
    const [mailbox] = await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, w.mailbox.id));
    expect(mailbox?.status).toBe("paused");
    expect(mailbox?.health.auto_pause).toMatchObject({ kind: "provider_block" });
  });

  it("throttles the mailbox, not the recipient, when the provider rate-limits the sender", async () => {
    const w = await world();
    await ingestInboundEmail(
      ctx,
      dsn(
        w.mailbox.id,
        "dsn-rate",
        "<out-1@brand.example.com>",
        "4.7.1",
        "450 4.7.1 Please try again later, rate limited",
      ),
    );
    expect(await recipientState(w.person.id)).toMatchObject({
      status: "active",
      suppressions: [],
      bounced_events: 0,
    });
    const [mailbox] = await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, w.mailbox.id));
    expect(mailbox?.health.throttled_until).toBeTruthy();
    const [message] = await ctx.db.select().from(messages).where(eq(messages.id, w.outbound.id));
    expect(message?.error?.startsWith(SENDER_REJECTION_PREFIX)).toBe(true);
  });

  it.each([
    [
      "an unknown user",
      "5.1.1",
      "550 5.1.1 <dana@harbor.example.com>: Recipient address rejected: User unknown",
    ],
    [
      "a disabled mailbox",
      "5.2.1",
      "550 5.2.1 The email account that you tried to reach is disabled",
    ],
    ["no such domain", "5.4.4", "550 5.4.4 Unrouteable address: host or domain name not found"],
  ])(
    "still hard-bounces and suppresses the recipient for %s",
    async (_label, status, diagnostic) => {
      const w = await world();
      await ingestInboundEmail(
        ctx,
        dsn(w.mailbox.id, "dsn-hard", "<out-1@brand.example.com>", status, diagnostic),
      );
      expect(await recipientState(w.person.id)).toMatchObject({
        status: "bounced",
        email_status: "invalid",
        bounced_events: 1,
      });
      const [message] = await ctx.db.select().from(messages).where(eq(messages.id, w.outbound.id));
      expect(message?.error?.startsWith(HARD_BOUNCE_PREFIX)).toBe(true);
      const [mailbox] = await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, w.mailbox.id));
      expect(mailbox?.health.consecutive_failures ?? 0).toBe(0);
    },
  );

  it("counts recipient soft bounces, but not an earlier rejection of the sender", async () => {
    const w = await world();
    const second = await secondSend(w, "<out-2@brand.example.com>");
    const third = await secondSend(w, "<out-3@brand.example.com>");
    const full = "452 4.2.2 The email account that you tried to reach is over quota";
    // A sender rejection first: it must not count as the first soft bounce.
    await ingestInboundEmail(
      ctx,
      dsn(
        w.mailbox.id,
        "dsn-policy",
        "<out-1@brand.example.com>",
        "5.7.1",
        "550 5.7.1 Message rejected due to poor sender reputation",
      ),
    );
    await ingestInboundEmail(
      ctx,
      dsn(w.mailbox.id, "dsn-full-1", "<out-2@brand.example.com>", "4.2.2", full),
    );
    expect(await recipientState(w.person.id)).toMatchObject({
      status: "active",
      suppressions: [],
    });
    const [soft] = await ctx.db.select().from(messages).where(eq(messages.id, second.id));
    expect(soft?.error?.startsWith(SOFT_BOUNCE_PREFIX)).toBe(true);
    // A second recipient soft bounce within 14 days counts as hard.
    await ingestInboundEmail(
      ctx,
      dsn(w.mailbox.id, "dsn-full-2", "<out-3@brand.example.com>", "4.2.2", full),
    );
    expect(await recipientState(w.person.id)).toMatchObject({
      status: "bounced",
      email_status: "invalid",
    });
    const [hard] = await ctx.db.select().from(messages).where(eq(messages.id, third.id));
    expect(hard?.error?.startsWith(HARD_BOUNCE_PREFIX)).toBe(true);
  });

  it("ignores delayed-delivery notices", async () => {
    const { mailbox } = await world();
    const raw = readFileSync(new URL("./fixtures/postfix-delayed.eml", import.meta.url), "utf8");
    const result = await ingestInboundEmail(ctx, await parseRawEmail(raw, mailbox.id, RECEIVED));
    expect(result).toEqual({ messageId: "", threadId: null, kind: "bounce" });
    expect(ctx.emitted("message.bounced")).toHaveLength(0);
  });
});
