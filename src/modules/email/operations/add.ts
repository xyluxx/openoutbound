import { z } from "zod";
import { requireWorkspace } from "../../../core/context.js";
import { defineOperation, dryRun, dryRunOutput } from "../../../core/operation.js";
import type { Mailbox } from "../../../db/schema/index.js";
import { CSV_MAX_BYTES, CSV_MAX_ROWS, importMailboxesCsv } from "../csv-import.js";
import { assertNewMailbox, insertMailbox, prepareMailbox, rampInput } from "../mailbox-create.js";
import { mailboxSummarySchema, summarizeMailboxes } from "../mailbox-summary.js";
import { type MailboxTestResult, testAndRecord } from "../mailbox-test.js";
import { MAILBOX_PRESETS } from "../presets.js";
import { localDate } from "../timezone.js";
import { credentialFields, resolveSecret, serverFields } from "./shared.js";

export const mailboxTestSchema = z.object({
  smtp: z.enum(["ok", "failed", "skipped"]),
  imap: z.enum(["ok", "failed", "skipped"]),
  error: z.string().nullable(),
  auth_failed: z.boolean(),
});

const serverPreview = z
  .object({ host: z.string(), port: z.number(), security: z.enum(["tls", "starttls"]) })
  .nullable();

const addPreview = z.object({
  email: z.string(),
  provider: z.string(),
  auth_type: z.string(),
  smtp: serverPreview,
  imap: serverPreview,
  daily_limit: z.number(),
  ramp_start: z.number().nullable(),
  will_test: z.boolean(),
});

const addResult = z.object({
  mailbox: mailboxSummarySchema,
  warnings: z.array(z.string()),
  test: mailboxTestSchema.nullable(),
  next_steps: z.array(z.string()),
});

function preview(server: { host: string; port: number; secure: boolean } | null | undefined): {
  host: string;
  port: number;
  security: "tls" | "starttls";
} | null {
  return server
    ? { host: server.host, port: server.port, security: server.secure ? "tls" : "starttls" }
    : null;
}

/** Which logins of a test failed, in words: "sending (SMTP) failed", "reading replies ...". */
export function failedLogins(test: Pick<MailboxTestResult, "smtp" | "imap">): string[] {
  const failed: string[] = [];
  if (test.smtp === "failed") failed.push("sending (SMTP) failed");
  if (test.imap === "failed") failed.push("reading replies (IMAP) failed");
  return failed;
}

/**
 * The first next step after a login test that failed: which login, what it means for the
 * mailbox (added either way) and what to do, or null when every login passed.
 */
function failedTestStep(
  mailbox: Pick<Mailbox, "id" | "email" | "auth_type">,
  test: MailboxTestResult,
  passwordEnv: string | undefined,
): string | null {
  const failed = failedLogins(test);
  if (failed.length === 0) return null;
  const effect = test.smtp === "failed" ? "cannot send" : "sends but reads no replies";
  const fix = !test.auth_failed
    ? `Check the host, port and security (TLS on 465/993, STARTTLS on 587) with manage_mailboxes action update (mailbox_id ${mailbox.id}).`
    : mailbox.auth_type === "password"
      ? `Check the password or app password: ${passwordEnv ?? "its MAILBOX_* variable"} is read from the engine's .env, so after changing it there restart \`openoutbound serve\`, or point to another variable with manage_mailboxes action update (mailbox_id ${mailbox.id}, password_env).`
      : `Reconnect it with manage_mailboxes action oauth_start (email ${mailbox.email}).`;
  return `The login test failed: ${failed.join(" and ")} (${test.error ?? "no details"}). The mailbox is added but ${effect} until it passes. ${fix} Then run manage_mailboxes action test (mailbox_id ${mailbox.id}) again.`;
}

export const addMailbox = defineOperation({
  id: "mailboxes.add",
  summary: "Add a sending mailbox (Google, Zoho or custom SMTP/IMAP with a password)",
  description:
    "Adds one mailbox for sending and for reading replies over IMAP. Use preset google or zoho with an app password, or custom with smtp_host and imap_host; pass the secret as password_env (a MAILBOX_* variable on the engine host) so it never enters the conversation. Microsoft 365 only supports OAuth, so use action oauth_start for it (it is also the better path for Google Workspace). New mailboxes follow the deliverability ramp: no cold email for 2 weeks, then 5 a day, +5 a week, up to daily_limit (30 from week 8); status is warming until then. warmed_up starts a bought, pre-warmed mailbox at week 5 (15 a day); ramp null turns the ramp off. Run check_dns afterwards.",
  effect: "write",
  input: z.object({
    email: z.string().min(3).max(320).describe("Sender address, e.g. sam@brand.example.com"),
    from_name: z.string().max(100).optional().describe("Display name in the From header"),
    preset: z
      .enum(MAILBOX_PRESETS)
      .optional()
      .describe("Server settings to start from (default: from smtp_host, else custom)"),
    ...serverFields,
    ...credentialFields,
    daily_limit: z.number().int().min(1).max(500).optional().describe("Emails a day (default 30)"),
    min_gap_seconds: z.number().int().min(0).max(86_400).optional().describe("Default 240"),
    max_gap_seconds: z.number().int().min(0).max(86_400).optional().describe("Default 720"),
    ramp: rampInput.nullable().optional().describe("Custom ramp, or null for none"),
    warmed_up: z
      .boolean()
      .optional()
      .describe("Pre-warmed mailbox: start the ramp at week 5 (15 a day, +5 a week)"),
    signature: z.string().max(2000).optional().describe("Plain-text signature added to emails"),
    warmup_patterns: z
      .array(z.string().min(3).max(200))
      .max(20)
      .optional()
      .describe("Extra warmup-tool markers to ignore in the inbox (text or header:<name>)"),
    test: z.boolean().default(false).describe("Log in to SMTP and IMAP right after adding"),
  }),
  output: z.union([addResult, dryRunOutput(addPreview)]),
  http: { method: "POST", path: "/v1/mailboxes" },
  dryRun: "supported",
  idempotent: false,
  workspace: "required",
  examples: [
    {
      title: "Google Workspace mailbox with an app password",
      input: {
        email: "sam@brand.example.com",
        from_name: "Sam Carter",
        preset: "google",
        password_env: "MAILBOX_SAM_PASSWORD",
        daily_limit: 30,
        test: true,
      },
    },
  ],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const password = resolveSecret(ctx, input.password, input.password_env, "password");
    const imapPassword = resolveSecret(
      ctx,
      input.imap_password,
      input.imap_password_env,
      "imap_password",
    );
    const prepared = prepareMailbox(
      { ...input, password: password ?? null, imap_password: imapPassword ?? null },
      {
        workspace,
        today: localDate(ctx.clock.now(), workspace.timezone),
        allowPrivateNetwork: ctx.config.allowPrivateNetwork,
      },
    );
    const { values } = prepared;
    await assertNewMailbox(ctx, workspace.id, values.email);
    if (ctx.request.dryRun) {
      return dryRun(
        {
          email: values.email,
          provider: values.provider_label ?? "custom",
          auth_type: values.auth_type ?? "password",
          smtp: preview(values.smtp),
          imap: preview(values.imap),
          daily_limit: values.daily_limit ?? 30,
          ramp_start: values.ramp?.enabled ? values.ramp.start : null,
          will_test: input.test,
        },
        { warnings: prepared.warnings },
      );
    }
    let mailbox = await insertMailbox(ctx, prepared);
    let test: z.input<typeof mailboxTestSchema> | null = null;
    if (input.test) {
      const tested = await testAndRecord(ctx, workspace, mailbox);
      test = tested.result;
      mailbox = tested.mailbox;
    }
    const [summary] = await summarizeMailboxes(ctx, workspace, [mailbox]);
    const nextSteps = [
      `Check the domain: manage_mailboxes action check_dns (mailbox_id ${mailbox.id}).`,
    ];
    const failedTest = test ? failedTestStep(mailbox, test, input.password_env) : null;
    if (failedTest) nextSteps.unshift(failedTest);
    if (!input.test) {
      nextSteps.unshift(
        `Verify the login: manage_mailboxes action test (mailbox_id ${mailbox.id}).`,
      );
    }
    const quietDays = mailbox.ramp?.enabled ? (mailbox.ramp.delay_days ?? 0) : 0;
    if (quietDays > 0) {
      nextSteps.push(
        `No cold email for the first ${quietDays} days (ramp): finish DNS, the profile photo and signature, and send a few real emails meanwhile. Campaigns using only this mailbox start sending after that.`,
      );
    }
    if (!summary) throw new Error("mailboxes.add: summary missing");
    return { mailbox: summary, warnings: prepared.warnings, test, next_steps: nextSteps };
  },
});

const importRow = z.object({
  row: z.number().int(),
  email: z.string().nullable(),
  status: z.enum(["created", "valid", "skipped", "error"]),
  mailbox_id: z.string().optional(),
  reason: z.string().optional(),
  warnings: z.array(z.string()).optional(),
  test: mailboxTestSchema.optional(),
});

const importResult = z.object({
  total: z.number().int(),
  created: z.number().int(),
  valid: z.number().int(),
  skipped: z.number().int(),
  errors: z.number().int(),
  test_failed: z.number().int(),
  columns: z.record(z.string(), z.string()).describe("Mailbox field -> CSV column used"),
  ignored_columns: z.array(z.string()),
  rows: z.array(importRow),
});

export const importMailboxesCsvOperation = defineOperation({
  id: "mailboxes.import_csv",
  summary: "Import mailboxes from a CSV export (Instantly, Smartlead or generic)",
  description: `Creates many mailboxes from CSV text (csv_credentials) with a header row: email, from name or first/last name, smtp/imap host, port and username, password or app password, daily limit, signature, provider. Every row gets the same checks as action add and a result (created, skipped as duplicate or existing, or error with the reason); run with dry_run first to see the mapping. Microsoft 365 rows are refused (OAuth only: use action oauth_start per mailbox). Up to ${CSV_MAX_ROWS} rows; test: true logs in to each new mailbox, which takes a few seconds per row.`,
  effect: "write",
  input: z.object({
    csv_credentials: z
      .string()
      .min(1)
      .max(CSV_MAX_BYTES)
      .describe(
        "The CSV text with a header row. It holds passwords, so the audit log redacts this field; send it over a trusted channel.",
      ),
    daily_limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe("Daily limit for rows without one (default 30)"),
    warmed_up: z
      .boolean()
      .optional()
      .describe("Pre-warmed mailboxes: start every imported mailbox at ramp week 5 (15 a day)"),
    test: z.boolean().default(false).describe("Log in to each created mailbox"),
  }),
  output: z.union([importResult, dryRunOutput(importResult)]),
  http: { method: "POST", path: "/v1/mailboxes/import" },
  dryRun: "supported",
  idempotent: false,
  workspace: "required",
  examples: [
    {
      title: "Preview a Smartlead export",
      input: {
        csv_credentials:
          "from_name,from_email,user_name,password,smtp_host,smtp_port,imap_host,imap_port,max_email_per_day\nSam Carter,sam@brand.example.com,sam@brand.example.com,<app password>,smtp.example.com,465,imap.example.com,993,30",
      },
    },
  ],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const summary = await importMailboxesCsv(ctx, workspace, {
      csv: input.csv_credentials,
      daily_limit: input.daily_limit,
      warmed_up: input.warmed_up,
      test: input.test,
      dryRun: ctx.request.dryRun,
    });
    if (!ctx.request.dryRun) return summary;
    const warnings =
      summary.errors > 0 ? [`${summary.errors} row(s) have errors; see rows[].reason.`] : [];
    return dryRun(summary, { warnings });
  },
});
