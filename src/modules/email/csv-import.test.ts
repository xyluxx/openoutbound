import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mailboxes } from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { seedMailbox } from "../../testing/factories.js";
import { mapColumns, normalizeHeader, parseMailboxCsv } from "./csv-import.js";
import { importMailboxesCsvOperation } from "./operations/add.js";

vi.mock("../../runtime/notify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/notify.js")>()),
  notify: vi.fn(async () => {}),
}));

const SMARTLEAD = [
  "from_name,from_email,user_name,password,smtp_host,smtp_port,imap_host,imap_port,max_email_per_day,warmup_enabled",
  "Sam Carter,sam@brand.example.com,sam@brand.example.com,pw-one,smtp.brandmail.example.com,465,imap.brandmail.example.com,993,25,TRUE",
  "Sam Again,SAM@brand.example.com,sam@brand.example.com,pw-two,smtp.brandmail.example.com,465,imap.brandmail.example.com,993,25,TRUE",
  "Lee Park,lee@brand.example.com,lee@brand.example.com,pw-three,smtp.office365.com,587,outlook.office365.com,993,30,FALSE",
  ",,,,,,,,,",
  "Ana Ruiz,ana@brand.example.com,ana@brand.example.com,pw-four,smtp.brandmail.example.com,465,imap.brandmail.example.com,993,abc,TRUE",
  "Old One,old@brand.example.com,old@brand.example.com,pw-five,smtp.brandmail.example.com,465,imap.brandmail.example.com,993,20,TRUE",
].join("\n");

let ctx: TestContext;
afterEach(async () => {
  await ctx?.close();
});

async function run(input: Record<string, unknown>, dryRun = false) {
  const op = importMailboxesCsvOperation;
  const context = dryRun ? ctx.with({ request: { dryRun: true } }) : ctx;
  return op.output.parse(await op.handler(context, op.input.parse(input)));
}

describe("CSV column mapping", () => {
  it("understands Instantly, Smartlead and generic headers", () => {
    expect(normalizeHeader(" SMTP Host ")).toBe("smtp_host");
    const instantly = mapColumns(
      [
        "Email",
        "First Name",
        "Last Name",
        "IMAP Username",
        "IMAP Password",
        "IMAP Host",
        "IMAP Port",
        "SMTP Username",
        "SMTP Password",
        "SMTP Host",
        "SMTP Port",
        "Daily Limit",
        "Warmup Enabled",
      ].map(normalizeHeader),
    );
    expect(instantly.mapping).toMatchObject({
      email: "email",
      first_name: "first_name",
      smtp_password: "smtp_password",
      imap_password: "imap_password",
      daily_limit: "daily_limit",
    });
    expect(instantly.ignored).toEqual(["warmup_enabled"]);
    const parsed = parseMailboxCsv(
      "Email,First Name,Last Name,SMTP Password,SMTP Host,SMTP Port,IMAP Host\nlee@x.example.com,Lee,Park,pw,smtp.x.example.com,587,imap.x.example.com",
    );
    expect(parsed.rows[0]?.input).toMatchObject({
      email: "lee@x.example.com",
      from_name: "Lee Park",
      password: "pw",
      smtp_port: 587,
    });
  });

  it("refuses files without an email column or with too many rows", () => {
    expect(() => parseMailboxCsv("name,password\nSam,pw")).toThrow(/no email column/);
    const big = ["email", ...Array.from({ length: 501 }, (_, i) => `u${i}@x.example.com`)].join(
      "\n",
    );
    expect(() => parseMailboxCsv(big)).toThrow(/limit is 500/);
    expect(() => parseMailboxCsv('email\n"unterminated')).toThrow(/could not be parsed/);
  });
});

describe("mailboxes.import_csv", () => {
  it("reports every row and writes nothing on a dry run", async () => {
    ctx = await createTestContext();
    await seedMailbox(ctx, { email: "old@brand.example.com" });
    const result = await run({ csv_credentials: SMARTLEAD }, true);
    if (!("preview" in result)) throw new Error("expected a dry run");
    const rows = result.preview.rows.map((row) => [row.row, row.email, row.status]);
    expect(rows).toEqual([
      [1, "sam@brand.example.com", "valid"],
      [2, "sam@brand.example.com", "skipped"],
      [3, "lee@brand.example.com", "error"],
      [4, null, "error"],
      [5, null, "error"],
      [6, "old@brand.example.com", "skipped"],
    ]);
    expect(result.preview.rows[2]?.reason).toContain("oauth_start");
    expect(result.preview.rows[4]?.reason).toContain("daily_limit");
    expect(result.preview.ignored_columns).toEqual(["warmup_enabled"]);
    expect(result.warnings[0]).toContain("3 row(s) have errors");
    expect(await ctx.db.select().from(mailboxes)).toHaveLength(1);
  });

  it("creates the valid mailboxes with their passwords in the vault", async () => {
    ctx = await createTestContext();
    const result = await run({ csv_credentials: SMARTLEAD, warmed_up: true });
    if ("preview" in result) throw new Error("expected a real import");
    expect(result).toMatchObject({ total: 6, created: 2, skipped: 1, errors: 3 });
    const rows = await ctx.db
      .select()
      .from(mailboxes)
      .where(eq(mailboxes.email, "sam@brand.example.com"));
    const row = rows[0];
    expect(row).toMatchObject({
      email: "sam@brand.example.com",
      from_name: "Sam Carter",
      daily_limit: 25,
      // Pre-warmed: the ramp starts at week 5 (15 a day) and still climbs.
      ramp: { start: 15, increment: 5, every_days: 7, delay_days: 0 },
      status: "warming",
      smtp: { host: "smtp.brandmail.example.com", port: 465, secure: true },
      imap: { host: "imap.brandmail.example.com", port: 993, secure: true },
    });
    expect(await ctx.vault.getSecret(row?.secret_id ?? "")).toContain("pw-one");
    expect(JSON.stringify(result)).not.toContain("pw-one");
  });

  it("tests each new login when asked", async () => {
    ctx = await createTestContext({ sandbox: true });
    const result = await run({
      csv_credentials:
        "email,password,smtp_host\nsam@brand.example.com,pw,smtp.brandmail.example.com",
      test: true,
    });
    if ("preview" in result) throw new Error("expected a real import");
    expect(result.rows[0]).toMatchObject({
      status: "created",
      test: { smtp: "ok", error: null },
    });
    expect(result.test_failed).toBe(0);
  });
});
