import { and, eq, like } from "drizzle-orm";
import { z } from "zod";
import { requireWorkspace } from "../../../core/context.js";
import { OpenOutboundError } from "../../../core/errors.js";
import { defineOperation } from "../../../core/operation.js";
import { type MailboxDnsCheck, mailboxes } from "../../../db/schema/index.js";
import { checkDomainDns, type DnsCheckResult } from "../dns-check.js";
import { loadMailbox } from "./shared.js";

const status = z.enum(["green", "yellow", "red"]);
const DOMAIN = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** What `mailboxes.dns` stores (booleans for quick filters plus the fix hints). */
export function toStoredCheck(result: DnsCheckResult): MailboxDnsCheck {
  const passed = (name: string) =>
    result.checks.find((check) => check.name === name)?.status === "green";
  return {
    checked_at: result.checked_at,
    domain: result.domain,
    overall: result.overall,
    mx: passed("mx"),
    spf: passed("spf"),
    dkim: passed("dkim"),
    dmarc: passed("dmarc"),
    statuses: Object.fromEntries(result.checks.map((check) => [check.name, check.status])),
    issues: result.checks
      .filter((check) => check.status !== "green")
      .map(
        (check) =>
          `${check.name.toUpperCase()}: ${check.summary}${check.fix ? ` Fix: ${check.fix}` : ""}`,
      ),
  };
}

export const checkDnsOperation = defineOperation({
  id: "mailboxes.check_dns",
  summary: "Check a sending domain's MX, SPF, DKIM and DMARC records",
  description:
    "Looks up the sending domain's MX, SPF (present, includes the provider, a single record, no +all), DKIM (probe of common selectors) and DMARC (present, policy) and rates each green, yellow or red with the exact fix. Pass mailbox_id to check that mailbox's domain and store the result on every mailbox of the domain (shown by action list), or domain to check before adding mailboxes. A missing DKIM guess is not proof: providers may use another selector.",
  effect: "write",
  input: z.object({
    mailbox_id: z.string().optional().describe("Check this mailbox's domain and store the result"),
    domain: z.string().max(253).optional().describe("Or a bare domain, e.g. brand.example.com"),
  }),
  output: z.object({
    domain: z.string(),
    overall: status,
    checked_at: z.string(),
    checks: z.array(
      z.object({
        name: z.enum(["mx", "spf", "dkim", "dmarc"]),
        status,
        summary: z.string(),
        fix: z.string().nullable(),
        records: z.array(z.string()),
      }),
    ),
    mailboxes_updated: z.number().int(),
  }),
  http: { method: "POST", path: "/v1/mailboxes/dns-check" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [
    { title: "Check a domain before adding mailboxes", input: { domain: "brand.example.com" } },
  ],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    if (!input.mailbox_id === !input.domain) {
      throw new OpenOutboundError(
        "validation_failed",
        "Pass exactly one of mailbox_id or domain.",
        {
          hint: "Use mailbox_id for a connected mailbox, or domain to check before adding one.",
        },
      );
    }
    const mailbox = input.mailbox_id
      ? await loadMailbox(ctx, workspace.id, input.mailbox_id)
      : null;
    const domain = (
      mailbox ? mailbox.email.slice(mailbox.email.lastIndexOf("@") + 1) : (input.domain ?? "")
    )
      .trim()
      .toLowerCase()
      .replace(/\.$/, "");
    if (!DOMAIN.test(domain)) {
      throw new OpenOutboundError("validation_failed", `"${domain}" is not a domain name.`, {
        hint: "Pass the part after @ of the sending address, e.g. brand.example.com.",
      });
    }
    const provider = mailbox?.provider_label;
    const result = await checkDomainDns(domain, ctx.dns, {
      ...(provider && provider !== "sandbox" && provider !== "custom" ? { provider } : {}),
      now: ctx.clock.now(),
    });
    let updated = 0;
    if (mailbox) {
      const rows = await ctx.db
        .update(mailboxes)
        .set({ dns: toStoredCheck(result) })
        .where(and(eq(mailboxes.workspace_id, workspace.id), like(mailboxes.email, `%@${domain}`)))
        .returning({ id: mailboxes.id });
      updated = rows.length;
    }
    return { ...result, mailboxes_updated: updated };
  },
});
