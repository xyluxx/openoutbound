import { parse } from "csv-parse/sync";
import { and, eq, inArray } from "drizzle-orm";
import type { OpContext } from "../../core/context.js";
import { isOpenOutboundError, OpenOutboundError } from "../../core/errors.js";
import { mailboxes, type Workspace } from "../../db/schema/index.js";
import {
  insertMailbox,
  type MailboxInput,
  type PreparedMailbox,
  prepareMailbox,
} from "./mailbox-create.js";
import { type MailboxTestResult, testAndRecord } from "./mailbox-test.js";
import type { MailboxPreset } from "./presets.js";
import { localDate } from "./timezone.js";

export const CSV_MAX_ROWS = 500;
export const CSV_MAX_BYTES = 2_000_000;

type Field =
  | "email"
  | "first_name"
  | "last_name"
  | "from_name"
  | "provider"
  | "smtp_host"
  | "smtp_port"
  | "smtp_username"
  | "smtp_password"
  | "smtp_security"
  | "imap_host"
  | "imap_port"
  | "imap_username"
  | "imap_password"
  | "imap_security"
  | "daily_limit"
  | "signature";

/**
 * Normalized header names per field (Instantly, Smartlead and generic exports). The first
 * matching column wins; unknown columns are reported and ignored.
 */
const ALIASES: Record<Field, string[]> = {
  email: ["email", "email_address", "from_email", "sender_email", "mailbox", "address"],
  first_name: ["first_name", "firstname", "first"],
  last_name: ["last_name", "lastname", "last"],
  from_name: ["from_name", "sender_name", "display_name", "name", "full_name"],
  provider: ["provider", "preset", "esp", "email_provider", "provider_type", "type"],
  smtp_host: ["smtp_host", "smtp_server", "smtp_hostname", "outgoing_server", "outgoing_host"],
  smtp_port: ["smtp_port", "outgoing_port"],
  smtp_username: [
    "smtp_username",
    "smtp_user",
    "smtp_user_name",
    "smtp_login",
    "user_name",
    "username",
  ],
  smtp_password: [
    "smtp_password",
    "smtp_pass",
    "smtp_app_password",
    "app_password",
    "password",
    "pass",
  ],
  smtp_security: ["smtp_security", "smtp_encryption", "smtp_ssl", "security", "encryption"],
  imap_host: ["imap_host", "imap_server", "imap_hostname", "incoming_server", "incoming_host"],
  imap_port: ["imap_port", "incoming_port"],
  imap_username: ["imap_username", "imap_user", "imap_user_name", "imap_login"],
  imap_password: ["imap_password", "imap_pass", "imap_app_password"],
  imap_security: ["imap_security", "imap_encryption", "imap_ssl"],
  daily_limit: [
    "daily_limit",
    "max_email_per_day",
    "max_emails_per_day",
    "daily_send_limit",
    "sending_limit",
    "limit",
  ],
  signature: ["signature", "email_signature"],
};

export function normalizeHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Maps normalized CSV headers to mailbox fields. */
export function mapColumns(headers: string[]): {
  mapping: Partial<Record<Field, string>>;
  ignored: string[];
} {
  const mapping: Partial<Record<Field, string>> = {};
  const used = new Set<string>();
  for (const field of Object.keys(ALIASES) as Field[]) {
    const column = ALIASES[field].find((alias) => headers.includes(alias) && !used.has(alias));
    if (column) {
      mapping[field] = column;
      used.add(column);
    }
  }
  return { mapping, ignored: headers.filter((header) => header && !used.has(header)) };
}

function preset(value: string): MailboxPreset | undefined {
  const v = value.trim().toLowerCase();
  if (!v) return undefined;
  if (/google|gmail|gsuite|g suite|workspace/.test(v)) return "google";
  if (/microsoft|outlook|office|o365|m365|exchange|hotmail/.test(v)) return "microsoft";
  if (/zoho/.test(v)) return "zoho";
  return "custom";
}

function security(value: string): "tls" | "starttls" | undefined {
  const v = value.trim().toLowerCase();
  if (!v) return undefined;
  if (/starttls|none|false|^no$|^0$/.test(v)) return "starttls";
  if (/ssl|tls|true|^yes$|^1$|implicit/.test(v)) return "tls";
  return undefined;
}

function integer(value: string, field: string, min: number, max: number): number | undefined {
  const v = value.trim();
  if (!v) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${field} "${v.slice(0, 20)}" must be a whole number from ${min} to ${max}`);
  }
  return n;
}

export interface CsvRow {
  /** 1-based data row number (the header row is not counted). */
  row: number;
  input: MailboxInput | null;
  error: string | null;
}

/** Parses a mailbox CSV into mailbox inputs (one per row, with row-level errors). */
export function parseMailboxCsv(
  csv: string,
  defaults: { daily_limit?: number | undefined; warmed_up?: boolean | undefined } = {},
): { rows: CsvRow[]; columns: Partial<Record<Field, string>>; ignored_columns: string[] } {
  let headers: string[] = [];
  let records: Array<Record<string, string>>;
  try {
    records = parse(csv, {
      bom: true,
      trim: true,
      skip_empty_lines: true,
      relax_column_count: true,
      columns: (header: string[]) => {
        headers = header.map(normalizeHeader);
        return headers;
      },
    }) as Array<Record<string, string>>;
  } catch (error) {
    throw new OpenOutboundError(
      "validation_failed",
      `The CSV could not be parsed: ${String((error as Error).message).slice(0, 200)}`,
      {
        hint: "Export the mailboxes again as comma-separated CSV with a header row (email, password, smtp_host, ...).",
      },
    );
  }
  const { mapping, ignored } = mapColumns(headers);
  if (!mapping.email) {
    throw new OpenOutboundError("validation_failed", "The CSV has no email column.", {
      hint: `Add a header row with an "email" column (found: ${headers.slice(0, 12).join(", ") || "none"}).`,
    });
  }
  if (records.length > CSV_MAX_ROWS) {
    throw new OpenOutboundError(
      "validation_failed",
      `The CSV has ${records.length} rows; the limit is ${CSV_MAX_ROWS}.`,
      { hint: `Split the file into parts of at most ${CSV_MAX_ROWS} mailboxes.` },
    );
  }
  const get = (record: Record<string, string>, field: Field): string => {
    const column = mapping[field];
    return column ? (record[column] ?? "").trim() : "";
  };
  const rows = records.map((record, index): CsvRow => {
    const row = index + 1;
    try {
      const email = get(record, "email");
      if (!email) throw new Error("email is empty");
      const name =
        get(record, "from_name") ||
        [get(record, "first_name"), get(record, "last_name")].filter(Boolean).join(" ");
      const input: MailboxInput = {
        email,
        from_name: name || null,
        preset: preset(get(record, "provider")),
        smtp_host: get(record, "smtp_host") || undefined,
        smtp_port: integer(get(record, "smtp_port"), "smtp_port", 1, 65_535),
        smtp_security: security(get(record, "smtp_security")),
        smtp_username: get(record, "smtp_username") || undefined,
        imap_host: get(record, "imap_host") || undefined,
        imap_port: integer(get(record, "imap_port"), "imap_port", 1, 65_535),
        imap_security: security(get(record, "imap_security")),
        imap_username: get(record, "imap_username") || undefined,
        password: get(record, "smtp_password") || null,
        imap_password: get(record, "imap_password") || null,
        daily_limit:
          integer(get(record, "daily_limit"), "daily_limit", 1, 500) ?? defaults.daily_limit,
        warmed_up: defaults.warmed_up,
        signature: get(record, "signature") || null,
      };
      return { row, input, error: null };
    } catch (error) {
      return { row, input: null, error: (error as Error).message };
    }
  });
  return { rows, columns: mapping, ignored_columns: ignored };
}

export interface ImportRowResult {
  row: number;
  email: string | null;
  status: "created" | "valid" | "skipped" | "error";
  mailbox_id?: string;
  reason?: string;
  warnings?: string[];
  test?: MailboxTestResult;
}

export interface ImportSummary {
  total: number;
  created: number;
  valid: number;
  skipped: number;
  errors: number;
  test_failed: number;
  columns: Record<string, string>;
  ignored_columns: string[];
  rows: ImportRowResult[];
}

function rowError(error: unknown): string {
  if (isOpenOutboundError(error)) {
    return error.hint ? `${error.message} ${error.hint}` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Imports mailboxes from CSV text: validates every row (same rules as action add), skips
 * duplicates in the file and addresses the workspace already has, stores passwords in the
 * vault and optionally tests each login. With `dryRun` nothing is written.
 */
export async function importMailboxesCsv(
  ctx: OpContext,
  workspace: Workspace,
  input: {
    csv: string;
    daily_limit?: number | undefined;
    warmed_up?: boolean | undefined;
    test: boolean;
    dryRun: boolean;
  },
): Promise<ImportSummary> {
  const parsed = parseMailboxCsv(input.csv, input);
  const today = localDate(ctx.clock.now(), workspace.timezone);
  const emails = parsed.rows
    .map((row) => row.input?.email.trim().toLowerCase())
    .filter((email): email is string => Boolean(email));
  const existing = emails.length
    ? await ctx.db
        .select({ email: mailboxes.email, id: mailboxes.id })
        .from(mailboxes)
        .where(and(eq(mailboxes.workspace_id, workspace.id), inArray(mailboxes.email, emails)))
    : [];
  const existingIds = new Map(existing.map((row) => [row.email, row.id]));
  const seen = new Set<string>();
  const results: ImportRowResult[] = [];
  for (const row of parsed.rows) {
    if (!row.input) {
      results.push({
        row: row.row,
        email: null,
        status: "error",
        reason: row.error ?? "invalid row",
      });
      continue;
    }
    const email = row.input.email.trim().toLowerCase();
    if (seen.has(email)) {
      results.push({
        row: row.row,
        email,
        status: "skipped",
        reason: "duplicate of an earlier row",
      });
      continue;
    }
    seen.add(email);
    const existingId = existingIds.get(email);
    if (existingId) {
      results.push({
        row: row.row,
        email,
        status: "skipped",
        mailbox_id: existingId,
        reason: "mailbox already exists (change it with action update)",
      });
      continue;
    }
    let prepared: PreparedMailbox;
    try {
      prepared = prepareMailbox(row.input, {
        workspace,
        today,
        allowPrivateNetwork: ctx.config.allowPrivateNetwork,
      });
    } catch (error) {
      results.push({ row: row.row, email, status: "error", reason: rowError(error) });
      continue;
    }
    const warnings = prepared.warnings.length ? { warnings: prepared.warnings } : {};
    if (input.dryRun) {
      results.push({ row: row.row, email, status: "valid", ...warnings });
      continue;
    }
    try {
      const mailbox = await insertMailbox(ctx, prepared);
      results.push({
        row: row.row,
        email,
        status: "created",
        mailbox_id: mailbox.id,
        ...warnings,
      });
    } catch (error) {
      results.push({ row: row.row, email, status: "error", reason: rowError(error) });
    }
  }
  if (input.test && !input.dryRun) {
    const created = results.filter((result) => result.status === "created" && result.mailbox_id);
    const ids = created.map((result) => result.mailbox_id as string);
    const rows = ids.length
      ? await ctx.db.select().from(mailboxes).where(inArray(mailboxes.id, ids))
      : [];
    const byId = new Map(rows.map((mailbox) => [mailbox.id, mailbox]));
    // A few logins at a time: providers throttle bursts of new connections.
    for (let i = 0; i < created.length; i += 4) {
      await Promise.all(
        created.slice(i, i + 4).map(async (result) => {
          const mailbox = byId.get(result.mailbox_id as string);
          if (mailbox) result.test = (await testAndRecord(ctx, workspace, mailbox)).result;
        }),
      );
    }
  }
  const count = (status: ImportRowResult["status"]) =>
    results.filter((result) => result.status === status).length;
  return {
    total: parsed.rows.length,
    created: count("created"),
    valid: count("valid"),
    skipped: count("skipped"),
    errors: count("error"),
    test_failed: results.filter((result) => result.test && result.test.error !== null).length,
    columns: parsed.columns as Record<string, string>,
    ignored_columns: parsed.ignored_columns,
    rows: results,
  };
}
