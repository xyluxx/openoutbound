/** GDPR forget: erase a person and keep only hashed suppressions. */
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { requireWorkspace } from "../../../core/context.js";
import { notFound, OpenOutboundError } from "../../../core/errors.js";
import { idSchema } from "../../../core/ids.js";
import { defineOperation, dryRun, dryRunOutput } from "../../../core/operation.js";
import { type Person, people } from "../../../db/schema/index.js";
import { forgetLead } from "../forget.js";
import { normalizeEmail, normalizePersonLinkedin } from "../normalize.js";
import { loadPerson } from "../records.js";
import { ERASED, redactionPattern } from "../redaction.js";
import { EXAMPLE } from "./shapes.js";

const forgetShape = z.object({
  person_id: z.string().nullable(),
  person_deleted: z.boolean(),
  hashed_suppressions: z.number().int(),
  plain_suppressions_removed: z.boolean(),
  approvals_cancelled: z.number().int(),
  enrollments_stopped: z.number().int().nullable().describe("null when campaigns are unavailable"),
  messages_scrubbed: z.number().int(),
  messages_cancelled: z.number().int(),
  threads_scrubbed: z.number().int(),
  briefs_deleted: z.number().int(),
  signals_deleted: z.number().int(),
  tasks_deleted: z.number().int(),
  opportunities_unlinked: z.number().int(),
  meetings_unlinked: z.number().int(),
  facts_deleted: z.number().int().describe("Lead-file facts and notes"),
  problems_resolved: z.number().int().describe('Resolved with resolution "forgotten"'),
  redacted: z
    .object({
      events: z.number().int(),
      audit_entries: z.number().int(),
      webhook_deliveries: z.number().int(),
      problems: z.number().int(),
      jobs: z.number().int(),
      approvals: z.number().int(),
      agent_tasks: z.number().int(),
    })
    .describe('Stored copies where the address, profile URL or name became "[erased]"'),
  crm_links: z
    .array(z.object({ provider: z.string(), entity_type: z.string(), external_id: z.string() }))
    .describe(
      "The person's CRM records (their contacts and the deals of their opportunities); the CRM step follows crm.on_forget",
    ),
});

/** The audit log keeps that a forget ran, never the address or profile it was asked to forget. */
function forgetAuditInput(input: Record<string, unknown>): Record<string, unknown> {
  const out = { ...input };
  if (out.email !== undefined) out.email = ERASED;
  if (out.linkedin_url !== undefined) out.linkedin_url = ERASED;
  return out;
}

/** Any email address, and any LinkedIn profile URL (with or without scheme or subdomain). */
const ANY_EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
const ANY_PROFILE = /(?:https?:\/\/)?(?:[a-z0-9-]+\.)*linkedin\.com\/in\/[^\s"'<>(),;]+/giu;

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&");
}

/**
 * The reason and error message of a forget call lose what it was asked to forget: the email and
 * LinkedIn URL as given (also when they are not valid, as an error message quotes them), their
 * normalized forms, and any other address or profile URL, which can only be the person's
 * (a forget by person_id does not name them in its input).
 */
export function forgetAuditText(text: string, input: Record<string, unknown>): string {
  let out = text;
  for (const raw of [input.email, input.linkedin_url]) {
    if (typeof raw === "string" && raw.trim()) {
      out = out.replace(new RegExp(escapeRegExp(raw.trim()), "giu"), ERASED);
    }
  }
  const email = typeof input.email === "string" ? normalizeEmail(input.email) : null;
  const linkedin =
    typeof input.linkedin_url === "string" ? normalizePersonLinkedin(input.linkedin_url) : null;
  const pattern = redactionPattern({
    emails: email ? [email] : [],
    linkedinUrls: linkedin ? [linkedin] : [],
  });
  if (pattern) out = out.replace(new RegExp(pattern, "gi"), ERASED);
  return out.replace(ANY_PROFILE, ERASED).replace(ANY_EMAIL, ERASED);
}

export const forgetLeadOp = defineOperation({
  id: "leads.forget",
  summary: "Erase a person for a privacy request (GDPR), keeping a hashed block",
  description:
    "Erases a person for a GDPR or privacy request: stops their campaigns, cancels pending messages and approvals, removes message and thread content, research, signals, tasks and lead-file facts about them, resolves their problems, replaces their email and LinkedIn URL with [erased] in stored events, audit entries and problems, deletes the person, keeps only sha256-hashed suppressions so they are never imported or contacted again, and emits lead.forgotten for the CRM step (crm.on_forget). Use it when someone asks to be forgotten; pass email alone to block an address you hold no record for. Not for ordinary opt-outs (use manage_suppressions action add, which keeps the record) or cleanup (use manage_leads action delete). It cannot be undone; run it with dry_run first to see what would be removed.",
  effect: "destructive",
  input: z.object({
    person_id: idSchema("pe").optional(),
    email: z.string().max(320).optional().describe("Find the person by email, or block an address"),
    linkedin_url: z.string().max(500).optional(),
  }),
  output: z.union([forgetShape, dryRunOutput(forgetShape)]),
  http: { method: "POST", path: "/v1/leads/forget" },
  dryRun: "supported",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Erase a person", input: { person_id: EXAMPLE.person } }],
  auditInput: forgetAuditInput,
  auditText: forgetAuditText,
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    if (!input.person_id && !input.email && !input.linkedin_url) {
      throw new OpenOutboundError("validation_failed", "Say who to forget.", {
        hint: "Pass person_id, or the email or linkedin_url from the request.",
      });
    }
    const email = input.email ? normalizeEmail(input.email) : null;
    if (input.email && !email) {
      throw new OpenOutboundError("validation_failed", `"${input.email}" is not a valid email.`, {
        hint: "Pass the address exactly as the person wrote it.",
      });
    }
    const linkedin = input.linkedin_url ? normalizePersonLinkedin(input.linkedin_url) : null;
    let person: Person | null = null;
    if (input.person_id) {
      person = await loadPerson(ctx, input.person_id);
      if (!person) throw notFound("Person", input.person_id);
    } else {
      const condition = email
        ? eq(people.email, email)
        : linkedin
          ? eq(people.linkedin_url, linkedin)
          : null;
      if (condition) {
        [person = null] = await ctx.db
          .select()
          .from(people)
          .where(and(eq(people.workspace_id, workspace.id), condition))
          .limit(1);
      }
    }
    const result = await forgetLead(
      ctx,
      { person, email, linkedinUrl: linkedin },
      !ctx.request.dryRun,
    );
    if (ctx.request.dryRun) {
      const warnings = person
        ? []
        : ["No person matches; only hashed suppressions would be added."];
      return dryRun(result, { warnings });
    }
    return result;
  },
});
