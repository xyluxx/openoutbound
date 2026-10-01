/**
 * Referral replies ("talk to Sam, she owns this"): the inbox asks a human (approval kind
 * `referral`, payload type `inbox.referral`) before adding the referred person as a lead and
 * enrolling them in the same campaign through campaigns' `enrollPeople`, which applies every
 * enrollment check. Nothing is created or sent before approval.
 */
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import { isOpenOutboundError } from "../../core/errors.js";
import type { ApprovalResolver } from "../../core/operation.js";
import type { ReplyClassification } from "../../db/schema/index.js";
import { approvals, people } from "../../db/schema/index.js";
import { splitName } from "../../lib/web/extract.js";
import { type EnrollOutcome, enrollPeople } from "../campaigns/service.js";
import { personLabel } from "./notifications.js";
import type { ReplyContext } from "./reply-context.js";
import { findCampaign, findCompany, findPerson } from "./reply-context.js";
import { createTask } from "./tasks.js";

export const REFERRAL_APPROVAL_TYPE = "inbox.referral";

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export function normalizeEmail(value: string | null | undefined): string | null {
  const email = value?.trim().toLowerCase() ?? "";
  return EMAIL.test(email) ? email : null;
}

const referralPayloadSchema = z.object({
  type: z.literal(REFERRAL_APPROVAL_TYPE),
  referrer_person_id: z.string(),
  thread_id: z.string().nullable(),
  message_id: z.string(),
  campaign_id: z.string().nullable(),
  referral: z.object({
    name: z.string().nullable(),
    email: z.string().nullable(),
    title: z.string().nullable(),
  }),
});

/**
 * Requests the referral approval (or, without an address, creates a task to find one).
 * Returns effect codes. Idempotent per inbound message.
 */
export async function requestReferralApproval(
  ctx: OpContext,
  reply: ReplyContext,
  classification: ReplyClassification,
): Promise<{ effects: string[]; attention: string[] }> {
  const { person, message, campaign, thread, company } = reply;
  if (!person) return { effects: [], attention: ["referral_without_known_sender"] };
  const email = normalizeEmail(classification.referral?.email);
  const name = classification.referral?.name?.trim() || null;
  const title = classification.referral?.title?.trim() || null;
  const from = personLabel(person, company);
  if (!email && !name) return { effects: [], attention: ["referral_without_contact"] };
  if (!email || email === person.email) {
    const { task, created } = await createTask(ctx, {
      title: `Find contact details for ${name ?? "the referred person"} (referred by ${from})`,
      type: "other",
      notes: title ? `Title: ${title}` : null,
      personId: person.id,
      campaignId: campaign?.id ?? null,
      threadId: thread?.id ?? null,
      dedupeKey: `referral:${message.id}`,
    });
    return {
      effects: [created ? `task_created:${task.id}` : `task_exists:${task.id}`],
      attention: ["referral_needs_contact_details"],
    };
  }
  const workspace = requireWorkspace(ctx);
  const [pending] = await ctx.db
    .select({ id: approvals.id })
    .from(approvals)
    .where(
      and(
        eq(approvals.workspace_id, workspace.id),
        eq(approvals.kind, "referral"),
        eq(approvals.status, "pending"),
        eq(approvals.target_type, "message"),
        eq(approvals.target_id, message.id),
      ),
    )
    .limit(1);
  if (pending) return { effects: [`referral_approval_exists:${pending.id}`], attention: [] };
  const who = `${name ?? email}${title ? `, ${title}` : ""}`;
  const { id } = await ctx.approvals.request({
    kind: "referral",
    title: `Add referral ${name ?? email} (from ${from})`,
    summary: `${from} pointed us to ${who} <${email}>. Approve to add them as a lead${
      campaign ? ` and queue them in "${campaign.name}"` : ""
    }. Nothing is sent before the campaign's own review and checks.`,
    payload: {
      type: REFERRAL_APPROVAL_TYPE,
      referrer_person_id: person.id,
      thread_id: thread?.id ?? null,
      message_id: message.id,
      campaign_id: campaign?.id ?? null,
      referral: { name, email, title },
    },
    target: { type: "message", id: message.id },
  });
  return { effects: [`referral_approval:${id}`], attention: [] };
}

/**
 * Applies an approved referral: creates (or reuses) the person at the referrer's company,
 * then enrolls them in the referrer's campaign (when it is active or paused) through
 * `enrollPeople`, reporting why they were skipped otherwise. Approvals without a referral
 * payload are left alone.
 */
export const referralResolver: ApprovalResolver = {
  kind: "referral",
  apply: async (ctx, approval, decision) => {
    const parsed = referralPayloadSchema.safeParse(approval.payload);
    if (!parsed.success) return {};
    if (decision.decision === "reject") return { message: "Referral skipped." };
    const edits = decision.edits ?? {};
    const payload = parsed.data;
    const email = normalizeEmail(
      typeof edits.email === "string" ? edits.email : payload.referral.email,
    );
    if (!email) {
      return {
        message: "Referral not added: no valid email address. Edit the email and approve again.",
      };
    }
    const name =
      (typeof edits.name === "string" ? edits.name : payload.referral.name)?.trim() || null;
    const title =
      (typeof edits.title === "string" ? edits.title : payload.referral.title)?.trim() || null;
    const campaignId =
      typeof edits.campaign_id === "string" ? edits.campaign_id : payload.campaign_id;
    const workspace = requireWorkspace(ctx);

    const referrer = await findPerson(ctx, payload.referrer_person_id);
    const referrerCompany = await findCompany(ctx, referrer?.company_id ?? null);
    const sameDomain =
      referrerCompany?.domain && email.endsWith(`@${referrerCompany.domain.toLowerCase()}`);

    let [person] = await ctx.db
      .select()
      .from(people)
      .where(and(eq(people.workspace_id, workspace.id), eq(people.email, email)))
      .limit(1);
    let created = false;
    if (!person) {
      const parts = name ? splitName(name) : { first_name: null, last_name: null };
      [person] = await ctx.db
        .insert(people)
        .values({
          workspace_id: workspace.id,
          company_id: sameDomain ? (referrerCompany?.id ?? null) : null,
          first_name: parts.first_name,
          last_name: parts.last_name,
          full_name: name,
          title,
          email,
          email_status: "unknown",
          email_source: "referral",
          country: referrer?.country ?? null,
          timezone: referrer?.timezone ?? null,
          language: referrer?.language ?? null,
          source: "referral",
          custom: {
            referred_by_person_id: payload.referrer_person_id,
            referred_by_name: referrer?.full_name ?? null,
          },
        })
        .onConflictDoNothing()
        .returning();
      if (!person) {
        [person] = await ctx.db
          .select()
          .from(people)
          .where(and(eq(people.workspace_id, workspace.id), eq(people.email, email)))
          .limit(1);
      } else {
        created = true;
        await ctx.events.emit("lead.created", {
          subject: { type: "person", id: person.id },
          data: { kind: "person", id: person.id, source: "referral", import_id: null },
        });
      }
    }
    if (!person) throw new Error("referralResolver: person could not be created");

    const who = `${created ? "Added" : "Found"} ${name ?? email}`;
    const target = { type: "person", id: person.id };
    const campaign = await findCampaign(ctx, campaignId);
    if (!campaign || !["active", "paused"].includes(campaign.status)) {
      return {
        message: `${who}; not enrolled (no active campaign).`,
        target,
        data: { person_id: person.id, created },
      };
    }
    // The campaigns binding applies every enrollment check: suppressions and consent rules,
    // one campaign at a time, the rest period and the per-company cap.
    let outcome: EnrollOutcome;
    try {
      outcome = await enrollPeople(ctx, {
        campaignId: campaign.id,
        personIds: [person.id],
        source: "referral",
      });
    } catch (error) {
      if (!isOpenOutboundError(error)) throw error;
      return {
        message: `${who}; not enrolled: ${error.message}`,
        target,
        data: { person_id: person.id, created, reasons: [error.code] },
      };
    }
    const enrollmentId = outcome.enrollment_ids[0] ?? null;
    if (!enrollmentId) {
      const reasons = outcome.skipped_people[0]?.reasons ?? [];
      return {
        message: reasons.includes("already_enrolled")
          ? `${who}; they were already enrolled in "${campaign.name}".`
          : `${who}; not enrolled in "${campaign.name}": ${reasons.join(", ") || "skipped"}.`,
        target,
        data: { person_id: person.id, created, reasons },
      };
    }
    return {
      message: `${who} and queued them in "${campaign.name}".`,
      target,
      data: { person_id: person.id, created, enrollment_id: enrollmentId },
    };
  },
};
