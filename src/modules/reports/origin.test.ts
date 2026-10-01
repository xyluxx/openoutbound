/**
 * Emails a person wrote from the mailbox itself (origin external) and sends with an unknown
 * outcome never count as the engine's sends. Clock: Saturday 2026-09-19 12:00 UTC, period
 * last_7_days = [09-12, 09-19).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Mailbox } from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { seedMailbox, seedMessage, seedPerson } from "../../testing/factories.js";
import { HARD_BOUNCE_PREFIX } from "../email/bounce.js";
import { bounceStats } from "../email/health-job.js";
import { getReport } from "./operations/get-report.js";
import type { ReportOutput } from "./schemas.js";

const NOW = "2026-09-19T12:00:00.000Z";
const t = (iso: string) => new Date(iso);

let ctx: TestContext;
let mailbox: Mailbox;

async function run(input: Record<string, unknown>) {
  const raw = await getReport.handler(ctx, getReport.input.parse(input));
  return getReport.output.parse(raw) as ReportOutput;
}

function data<T extends NonNullable<ReportOutput["data"]>["type"]>(
  output: ReportOutput,
  type: T,
): Extract<NonNullable<ReportOutput["data"]>, { type: T }> {
  if (output.data?.type !== type) throw new Error(`expected ${type} data`);
  return output.data as Extract<NonNullable<ReportOutput["data"]>, { type: T }>;
}

beforeAll(async () => {
  ctx = await createTestContext({ now: NOW });
  mailbox = await seedMailbox(ctx, { email: "sam@northwind.example.org", daily_limit: 30 });
  const dana = await seedPerson(ctx, { email: "dana@harbor.example.com" });
  const lee = await seedPerson(ctx, { email: "lee@cedar.example.com" });
  const email = { mailbox_id: mailbox.id, channel: "email" as const, action: "email" as const };

  // The engine: one sent and one bounced in the period, one sent today.
  await seedMessage(ctx, {
    ...email,
    person_id: dana.id,
    status: "sent",
    sent_at: t("2026-09-15T10:00:00Z"),
  });
  await seedMessage(ctx, {
    ...email,
    person_id: lee.id,
    status: "bounced",
    error: `${HARD_BOUNCE_PREFIX}550 5.1.1 no such user`,
    sent_at: t("2026-09-16T10:00:00Z"),
  });
  await seedMessage(ctx, {
    ...email,
    person_id: dana.id,
    status: "sent",
    sent_at: t("2026-09-19T09:00:00Z"),
  });

  // A person's own emails from the mailbox, in the period and today.
  for (const at of ["2026-09-16T11:00:00Z", "2026-09-17T11:00:00Z", "2026-09-19T10:00:00Z"]) {
    await seedMessage(ctx, {
      ...email,
      action: "reply",
      origin: "external",
      person_id: dana.id,
      status: "sent",
      sent_at: t(at),
    });
  }
  // A new email a person wrote to someone the engine never contacted.
  const kim = await seedPerson(ctx, { email: "kim@bluefield.example.com" });
  await seedMessage(ctx, {
    ...email,
    origin: "external",
    person_id: kim.id,
    status: "sent",
    sent_at: t("2026-09-17T12:00:00Z"),
  });
  // Sends with an unknown outcome: never sent as far as counting goes.
  await seedMessage(ctx, {
    ...email,
    person_id: lee.id,
    status: "unknown",
    dispatch_started_at: t("2026-09-17T09:00:00Z"),
  });
});
afterAll(async () => {
  await ctx.close();
});

describe("engine sends only", () => {
  it("overview counts the engine's emails, not a person's own or unknown ones", async () => {
    const m = data(await run({ type: "overview", compare: false }), "overview").metrics;
    expect(m.emails_sent.value).toBe(2);
    expect(m.bounced.value).toBe(1);
    expect(m.contacted.value).toBe(2);
  });

  it("senders report usage and bounce rate from the engine's emails", async () => {
    const report = data(await run({ type: "senders", compare: false }), "senders");
    expect(report.mailboxes.find((row) => row.id === mailbox.id)).toMatchObject({
      sent: 2,
      bounced: 1,
      bounce_rate: 50,
      sent_today: 1,
    });
  });

  it("mailbox health measures bounces against the engine's emails", async () => {
    expect(await bounceStats(ctx.jobContext(), mailbox, t(NOW))).toEqual({ sent: 3, bounced: 1 });
  });
});
