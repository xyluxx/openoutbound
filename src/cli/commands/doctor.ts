import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import type { EngineConfig } from "../../core/config.js";
import type { EngineModule } from "../../core/operation.js";
import { type Db, queryRows, type Schema } from "../../db/client.js";
import { createRemoteClient } from "../../http/client.js";
import { detectRunningServer, type ServerLock } from "../../http/lock-file.js";
import { errorPayload } from "../../mcp/errors.js";
import { hasPublicBaseUrl, PUBLIC_BASE_URL_FIX } from "../../modules/email/service.js";
import type { SendingReadiness } from "../../modules/workspaces/readiness.js";
import { type ProviderDefinition, SLOTS, type Slot } from "../../providers/types.js";
import { commandPrefix, withCommandPrefix } from "../command-prefix.js";
import type { CliContext } from "../context.js";
import { explainDatabaseLock } from "../database-lock.js";

export type CheckStatus = "ok" | "warn" | "fail" | "info";

export interface DoctorCheck {
  status: CheckStatus;
  label: string;
  fix?: string;
}

const MIN_NODE_MAJOR = 22;
/** Workspaces listed one line each without --workspace; the rest are counted. */
const MAX_WORKSPACE_LINES = 25;

/** Providers that can serve a slot from env vars alone (all required secrets have env values). */
export function envConfiguredProviders(
  definitions: readonly ProviderDefinition[],
  env: Readonly<Record<string, string | undefined>>,
): Map<Slot, string[]> {
  const out = new Map<Slot, string[]>();
  for (const definition of definitions) {
    if (definition.sandbox) continue;
    const required = definition.secrets.filter((secret) => secret.required);
    if (required.length === 0) continue;
    if (!required.every((secret) => secret.env && env[secret.env]?.trim())) continue;
    const vars = required.map((secret) => secret.env).join(" + ");
    out.set(definition.slot, [
      ...(out.get(definition.slot) ?? []),
      `${definition.id} (env ${vars})`,
    ]);
  }
  return out;
}

type Add = (status: CheckStatus, label: string, fix?: string) => void;

/** Formats a CLI command the way it works for how this CLI was started, in backticks. */
type RunHint = (command: string) => string;

/** What the checks need to know, from the database directly or from the running server. */
interface WorkspaceRow {
  slug: string;
  status: string;
  sandbox: boolean;
}

interface MailboxRow {
  id: string;
  /** Slug of the mailbox's workspace: every fix names it (several workspaces are common). */
  workspace: string;
  email: string;
  status: string;
  /** Null when DNS was never checked. */
  dns: { missing: string[]; issue: string | null } | null;
}

function envHints(definitions: readonly ProviderDefinition[], slot: Slot, run: RunHint): string {
  const vars = definitions
    .filter((d) => d.slot === slot && !d.sandbox)
    .map((d) => d.secrets.filter((s) => s.required && s.env).map((s) => s.env as string))
    .filter((list) => list.length > 0)
    .map((list) => list.join(" + "))
    .slice(0, 4);
  const command = `${run(`providers set --slot ${slot} --provider <id>`)} (see ${run("providers catalog")})`;
  return vars.length > 0 ? `set ${vars.join(" or ")} in .env, or run ${command}` : `run ${command}`;
}

async function loadProviderDefinitions(): Promise<ProviderDefinition[]> {
  const [{ builtinProviders }, { modules }] = await Promise.all([
    import("../../providers/all.js"),
    import("../../modules/index.js"),
  ]);
  return [
    ...builtinProviders,
    ...(modules as EngineModule[]).flatMap((module) => module.providers ?? []),
  ];
}

/**
 * `openoutbound doctor`: node version, home, config, base URL, secret key, database and
 * migrations, workspaces, providers per slot, mailbox DNS and sending readiness (every workspace
 * briefly, or the one given with `--workspace` in detail). When `serve` owns the PGlite database
 * the checks go through it. Prints OK/WARN/FAIL lines with fixes; exit 1 when anything FAILs.
 */
export async function runDoctor(
  ctx: CliContext,
  options: { json: boolean; workspace?: string },
): Promise<number> {
  const checks: DoctorCheck[] = [];
  const add: Add = (status, label, fix) =>
    checks.push(fix ? { status, label, fix } : { status, label });
  const cli = commandPrefix(ctx);
  const run: RunHint = (command) => `\`${cli} ${command}\``;
  const words = (text: string) => withCommandPrefix(text, cli);

  const major = Number(process.versions.node.split(".")[0]);
  if (major >= MIN_NODE_MAJOR) add("ok", `Node.js ${process.versions.node}`);
  else
    add(
      "fail",
      `Node.js ${process.versions.node} is too old`,
      `Install Node.js ${MIN_NODE_MAJOR} or newer.`,
    );

  add("info", `Engine home: ${ctx.home.dir} (${describeHomeSource(ctx.home.source)})`);
  const envPath = join(ctx.home.dir, ".env");
  if (existsSync(envPath)) add("ok", `.env found at ${envPath}`);
  else add("warn", "No .env file in the engine home", `Run ${run("init")} (or pass --home <dir>).`);

  let config: EngineConfig;
  try {
    config = ctx.config();
    add("ok", `Configuration valid (database ${config.database.kind})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const hint = (error as { hint?: string }).hint;
    add("fail", `Configuration invalid: ${message}`, hint ?? "Fix the value in .env.");
    return finish(ctx, checks, options.json);
  }

  if (hasPublicBaseUrl(config)) {
    add("ok", `Base URL ${config.baseUrl} (public https: unsubscribe links work)`);
  } else {
    add(
      "warn",
      `Base URL ${config.baseUrl} is not a public https address: in real workspaces, campaigns with email steps cannot launch and their emails are held (the sandbox is not affected)`,
      words(PUBLIC_BASE_URL_FIX),
    );
  }

  if (config.secretKey) add("ok", "OPENOUTBOUND_SECRET_KEY is set");
  else if (config.database.kind === "memory")
    add("info", "No secret key (memory database uses a temporary one)");
  else add("fail", "OPENOUTBOUND_SECRET_KEY is not set", `Run ${run("init")} to generate one.`);

  const definitions = await loadProviderDefinitions().catch(() => [] as ProviderDefinition[]);
  const running =
    config.database.kind === "pglite"
      ? await detectRunningServer(config.stateDir, { fetch: ctx.fetch })
      : null;
  const checker: Checker = { add, run, words, definitions, only: options.workspace };
  if (running) {
    add(
      "ok",
      `Server running at ${running.url} (pid ${running.pid}); it owns the PGlite database, so these checks go through it`,
    );
    await serverChecks(ctx, config, running, checker);
  } else {
    const workspaces = await databaseChecks(config, checker, cli);
    if (workspaces) await engineReadiness(ctx, workspaces, checker);
    else if (options.workspace)
      add(
        "info",
        config.database.kind === "memory"
          ? `Sending, ${options.workspace}: not checked, a memory:// database starts empty in every process`
          : `Sending, ${options.workspace}: not checked until the database lines above pass`,
      );
  }
  return finish(ctx, checks, options.json);
}

interface Checker {
  add: Add;
  run: RunHint;
  /** Rewrites `openoutbound ...` in engine text to the command the person runs. */
  words: (text: string) => string;
  definitions: readonly ProviderDefinition[];
  /** `--workspace`: show this workspace's readiness in detail (and no other). */
  only: string | undefined;
}

function describeHomeSource(source: string): string {
  switch (source) {
    case "flag":
      return "from --home";
    case "env":
      return "from OPENOUTBOUND_HOME";
    case "cwd":
      return "current directory";
    case "package":
      return "package folder";
    default:
      return "current directory, no .env yet";
  }
}

function workspaceChecks(rows: readonly WorkspaceRow[], { add, run }: Checker): void {
  if (rows.length === 0) {
    add("warn", "No workspace yet", `Run ${run("init")} (creates "default") or ${run("sandbox")}.`);
    return;
  }
  const names = rows
    .map(
      (ws) =>
        `${ws.slug}${ws.sandbox ? " (sandbox)" : ""}${ws.status !== "active" ? ` [${ws.status}]` : ""}`,
    )
    .join(", ");
  add("ok", `${rows.length} workspace(s): ${names}`);
  for (const ws of rows.filter((w) => w.status === "paused")) {
    add(
      "warn",
      `Workspace ${ws.slug} is paused (no sending)`,
      `Resume it with ${run(`workspaces resume --workspace ${ws.slug}`)} once the reason for the pause is fixed.`,
    );
  }
}

/** One line per slot: configured providers (`name (source)`), or how to configure one. */
function providerChecks(configured: ReadonlyMap<Slot, string[]>, checker: Checker): void {
  const { add, run, definitions } = checker;
  for (const slot of SLOTS) {
    const names = [...new Set(configured.get(slot) ?? [])];
    const available = definitions.some((d) => d.slot === slot && !d.sandbox);
    if (names.length > 0) {
      add("ok", `${slot}: ${names.join(", ")}`);
    } else if (!available) {
      add("info", `${slot}: no provider installed in this build`);
    } else {
      add(
        slot === "brain" ? "warn" : "info",
        `${slot}: not configured`,
        envHints(definitions, slot, run),
      );
    }
  }
}

function mailboxChecks(rows: readonly MailboxRow[], { add, run }: Checker): void {
  for (const mailbox of rows) {
    const target = `--workspace ${mailbox.workspace} --mailbox-id ${mailbox.id}`;
    if (["paused", "error", "disconnected"].includes(mailbox.status)) {
      add(
        "warn",
        `Mailbox ${mailbox.email} is ${mailbox.status}`,
        `Check it with ${run(`mailboxes test ${target}`)} and ${run(`mailboxes check-dns ${target}`)}.`,
      );
    }
    if (!mailbox.dns) {
      add(
        "info",
        `Mailbox ${mailbox.email}: DNS not checked yet`,
        `Check it with ${run(`mailboxes check-dns ${target}`)}.`,
      );
    } else if (mailbox.dns.missing.length === 0) {
      add("ok", `Mailbox ${mailbox.email}: MX, SPF, DKIM and DMARC found`);
    } else {
      add(
        "warn",
        `Mailbox ${mailbox.email}: missing or broken ${mailbox.dns.missing.join(", ")}`,
        mailbox.dns.issue ?? "Fix the DNS records at your domain host, then re-check.",
      );
    }
  }
}

/**
 * Sending readiness: one line per workspace, or every blocker and warning of the workspace
 * given with --workspace. A workspace that cannot send is not a failure of the engine: blockers
 * are warnings here, and only an unknown --workspace fails.
 */
async function readinessChecks(
  rows: readonly WorkspaceRow[],
  readiness: (slug: string) => Promise<SendingReadiness>,
  checker: Checker,
): Promise<void> {
  const { add, run, words, only } = checker;
  if (only) {
    let result: SendingReadiness;
    try {
      result = await readiness(only);
    } catch (error) {
      const payload = errorPayload(error);
      add(
        "fail",
        `Sending, ${only}: ${payload.message}`,
        payload.hint ? words(payload.hint) : `List the workspaces with ${run("workspaces list")}.`,
      );
      return;
    }
    detailedReadiness(result, checker);
    return;
  }
  for (const row of rows.slice(0, MAX_WORKSPACE_LINES)) {
    try {
      const result = await readiness(row.slug);
      if (result.sandbox) {
        add("info", `Sending, ${row.slug}: ${result.summary}`);
      } else if (result.email.ready || result.linkedin.ready) {
        add("ok", `Sending, ${row.slug}: ${result.summary}`);
      } else {
        add(
          "info",
          `Sending, ${row.slug}: ${result.summary}`,
          `See what is missing: ${run(`doctor --workspace ${row.slug}`)}.`,
        );
      }
    } catch (error) {
      add("info", `Sending, ${row.slug}: not checked (${errorPayload(error).message})`);
    }
  }
  if (rows.length > MAX_WORKSPACE_LINES) {
    add(
      "info",
      `${rows.length - MAX_WORKSPACE_LINES} more workspace(s) not shown`,
      `Check one with ${run("doctor --workspace <slug>")}.`,
    );
  }
}

function detailedReadiness(result: SendingReadiness, { add, words }: Checker): void {
  const head = `Sending, ${result.workspace}: ${result.summary}`;
  if (result.sandbox) {
    add("info", head, words(result.email.blockers[0]?.fix ?? ""));
  } else {
    add(result.email.ready || result.linkedin.ready ? "ok" : "info", head);
    for (const [name, channel] of [
      ["Email", result.email],
      ["LinkedIn", result.linkedin],
    ] as const) {
      if (channel.ready) add("ok", `${name}: ready`);
      else if (channel.replies_ready) add("info", `${name} replies: ${channel.replies}`);
      for (const blocker of channel.blockers) {
        add("warn", `${name} blocked: ${blocker.label}: ${blocker.detail}`, words(blocker.fix));
      }
      for (const warning of channel.warnings) {
        add("info", `${name} warning: ${warning.label}: ${warning.detail}`, words(warning.fix));
      }
    }
  }
  add("info", `Review (${result.review.level}): ${result.review.summary}`);
}

/** Every check through the server that owns the PGlite database, with the local admin key. */
async function serverChecks(
  ctx: CliContext,
  config: EngineConfig,
  running: ServerLock,
  checker: Checker,
): Promise<void> {
  const { add, run, words } = checker;
  const client = createRemoteClient({
    url: running.url,
    apiKey: running.local_keys?.admin ?? config.apiKey,
    fetch: ctx.fetch,
  });
  try {
    const listed = (await client.call("workspaces.list", { limit: 100 })) as {
      items: Array<{ slug: string; status: string; is_sandbox: boolean }>;
    };
    const rows = listed.items.map((ws) => ({
      slug: ws.slug,
      status: ws.status,
      sandbox: ws.is_sandbox,
    }));
    workspaceChecks(rows, checker);

    const providers = (await client.call("providers.list", {})) as {
      items: Array<{ slot: string; provider: string; source: string; enabled: boolean }>;
    };
    const configured = new Map<Slot, string[]>();
    for (const entry of providers.items) {
      if (!entry.enabled || entry.source === "sandbox") continue;
      const slot = entry.slot as Slot;
      configured.set(slot, [
        ...(configured.get(slot) ?? []),
        `${entry.provider} (${entry.source})`,
      ]);
    }
    providerChecks(configured, checker);

    const mailboxes: MailboxRow[] = [];
    for (const ws of rows.filter((row) => !row.sandbox)) {
      const page = (await client.call(
        "mailboxes.list",
        { limit: 100 },
        { workspace: ws.slug },
      )) as {
        items: Array<{
          id: string;
          email: string;
          status: string;
          dns: { overall: string | null; issues: string[] } | null;
        }>;
      };
      for (const mailbox of page.items) {
        mailboxes.push({
          id: mailbox.id,
          workspace: ws.slug,
          email: mailbox.email,
          status: mailbox.status,
          dns: mailbox.dns
            ? {
                missing:
                  mailbox.dns.overall === "green"
                    ? []
                    : [`records (${mailbox.dns.overall ?? "?"})`],
                issue: mailbox.dns.issues[0] ?? null,
              }
            : null,
        });
      }
    }
    mailboxChecks(mailboxes, checker);

    await readinessChecks(
      rows,
      async (slug) =>
        (await client.call("workspaces.readiness", {}, { workspace: slug })) as SendingReadiness,
      checker,
    );
  } catch (error) {
    const payload = errorPayload(error);
    add(
      "fail",
      `The server at ${running.url} did not answer the checks: ${payload.message}`,
      payload.hint ? words(payload.hint) : `Restart ${run("serve")}.`,
    );
  }
}

/**
 * Database, migrations, workspaces, providers and mailboxes straight from the database. Returns
 * the workspaces when the database is migrated (null when a check failed or it is empty memory).
 */
async function databaseChecks(
  config: EngineConfig,
  checker: Checker,
  cli: string,
): Promise<WorkspaceRow[] | null> {
  const { add, run, definitions } = checker;
  const [{ createDb }, { MIGRATIONS_FOLDER }, schema] = await Promise.all([
    import("../../db/client.js"),
    import("../../db/migrate.js"),
    import("../../db/schema/index.js"),
  ]);
  let handle: Awaited<ReturnType<typeof createDb>>;
  try {
    handle = await createDb(config);
    await handle.db.execute(sql`select 1`);
    add("ok", `Database reachable (${config.database.kind})`);
  } catch (error) {
    // Another process holding the embedded database is the usual cause: say which and the way out.
    const held = explainDatabaseLock(error, cli);
    if (held) {
      add("fail", held.message, held.hint);
      return null;
    }
    add(
      "fail",
      `Cannot open the database: ${error instanceof Error ? error.message : String(error)}`,
      "Check DATABASE_URL (postgres://..., pglite://<dir> or memory://).",
    );
    return null;
  }
  try {
    if (config.database.kind === "memory") {
      add("info", "memory:// database: nothing is kept after the process exits");
      return null;
    }
    let expected = 0;
    try {
      const journal = JSON.parse(
        readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"),
      ) as { entries?: unknown[] };
      expected = journal.entries?.length ?? 0;
    } catch {
      // No journal shipped: skip the comparison.
    }
    let applied: number | null = null;
    try {
      const rows = await queryRows<{ n: number }>(
        handle.db,
        sql`select count(*)::int as n from drizzle.__drizzle_migrations`,
      );
      applied = Number(rows[0]?.n ?? 0);
    } catch {
      applied = null;
    }
    if (applied === null || applied === 0) {
      add("fail", "Database is not migrated", `Run ${run("db migrate")} (or ${run("init")}).`);
      return null;
    }
    const pending = applied < expected;
    if (pending) {
      add("warn", `${expected - applied} pending migration(s)`, `Run ${run("db migrate")}.`);
    } else {
      add("ok", `Migrations up to date (${applied})`);
    }
    // No server owns the PGlite database, so no worker runs (an agent's embedded session would
    // hold the database and fail the check above).
    if (config.database.kind === "pglite") {
      await workerCheck(handle.db, schema, checker);
    }

    const workspaces = await handle.db
      .select({
        slug: schema.workspaces.slug,
        status: schema.workspaces.status,
        sandbox: schema.workspaces.is_sandbox,
      })
      .from(schema.workspaces);
    workspaceChecks(workspaces, checker);

    const stored = await handle.db
      .select({ slot: schema.provider_settings.slot, provider: schema.provider_settings.provider })
      .from(schema.provider_settings)
      .where(eq(schema.provider_settings.enabled, true));
    const configured = new Map<Slot, string[]>(envConfiguredProviders(definitions, config.env));
    for (const row of stored) {
      const slot = row.slot as Slot;
      configured.set(slot, [row.provider, ...(configured.get(slot) ?? [])]);
    }
    providerChecks(configured, checker);

    const mailboxes = await handle.db
      .select({
        id: schema.mailboxes.id,
        workspace: schema.workspaces.slug,
        email: schema.mailboxes.email,
        status: schema.mailboxes.status,
        dns: schema.mailboxes.dns,
      })
      .from(schema.mailboxes)
      .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.mailboxes.workspace_id))
      // Sandbox mailboxes are fake: their DNS and status say nothing about real sending.
      .where(eq(schema.workspaces.is_sandbox, false));
    mailboxChecks(
      mailboxes.map((mailbox) => ({
        id: mailbox.id,
        workspace: mailbox.workspace,
        email: mailbox.email,
        status: mailbox.status,
        dns: mailbox.dns
          ? {
              missing: (["mx", "spf", "dkim", "dmarc"] as const)
                .filter((key) => !mailbox.dns?.[key])
                .map((key) => key.toUpperCase()),
              issue: mailbox.dns.issues?.[0] ?? null,
            }
          : null,
      })),
      checker,
    );
    // Readiness needs the engine, which expects every migration: skip it until they are applied.
    return pending ? null : workspaces;
  } catch (error) {
    add(
      "fail",
      `Database check failed: ${error instanceof Error ? error.message : String(error)}`,
      `Run ${run("db migrate")}.`,
    );
    return null;
  } finally {
    await handle.close();
  }
}

const NO_WORKER =
  "campaigns, sends, reply sync and the sandbox simulator only run while serve (or an agent's embedded session) runs.";

function counted(n: number, one: string, many: string): string | null {
  return n === 0 ? null : `${n} ${n === 1 ? one : many}`;
}

/**
 * Without `serve` nothing runs in the background: launched campaigns write no emails, approved
 * messages are not sent and the sandbox simulator delivers nothing. A warning while such work
 * waits, else a note.
 */
async function workerCheck(db: Db, schema: Schema, { add, run }: Checker): Promise<void> {
  const fix = `Start it in its own terminal and leave it running: ${run("serve")}.`;
  const [campaigns] = await db
    .select({ n: count() })
    .from(schema.campaigns)
    .where(eq(schema.campaigns.status, "active"));
  const [messages] = await db
    .select({ n: count() })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.direction, "outbound"),
        inArray(schema.messages.status, ["approved", "scheduled"]),
      ),
    );
  const [jobs] = await db
    .select({ n: count() })
    .from(schema.jobs)
    .where(eq(schema.jobs.status, "queued"));
  const parts = [
    counted(campaigns?.n ?? 0, "active campaign", "active campaigns"),
    counted(messages?.n ?? 0, "message to send", "messages to send"),
    counted(jobs?.n ?? 0, "queued job", "queued jobs"),
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) {
    add("info", `No server is running: ${NO_WORKER}`, fix);
    return;
  }
  const single = parts.length === 1 && /^1 /.test(parts[0] as string);
  const list =
    parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  add(
    "warn",
    `No server is running, and ${list} ${single ? "waits" : "wait"} for it: ${NO_WORKER}`,
    fix,
  );
}

/** Sending readiness in process: opens the engine (without migrating) after the raw checks. */
async function engineReadiness(
  ctx: CliContext,
  workspaces: readonly WorkspaceRow[],
  checker: Checker,
): Promise<void> {
  if (workspaces.length === 0 && !checker.only) return;
  let engine: Awaited<ReturnType<CliContext["createEngine"]>>;
  try {
    engine = await ctx.createEngine({ autoMigrate: false });
  } catch (error) {
    const held = explainDatabaseLock(error, commandPrefix(ctx));
    const payload = errorPayload(held ?? error);
    checker.add(
      "info",
      `Sending readiness not checked: ${payload.message}`,
      payload.hint ? checker.words(payload.hint) : undefined,
    );
    return;
  }
  try {
    const principal = engine.localPrincipal("admin", "cli");
    await readinessChecks(
      workspaces,
      async (slug) =>
        (await engine.call(
          "workspaces.readiness",
          {},
          { workspace: slug, principal },
        )) as SendingReadiness,
      checker,
    );
  } finally {
    await engine.close();
  }
}

function finish(ctx: CliContext, checks: DoctorCheck[], json: boolean): number {
  const failed = checks.some((check) => check.status === "fail");
  if (json) {
    ctx.io.stdout(`${JSON.stringify({ ok: !failed, checks }, null, 2)}\n`);
    return failed ? 1 : 0;
  }
  const p = ctx.out;
  const tag: Record<CheckStatus, string> = {
    ok: p.green("OK  "),
    warn: p.yellow("WARN"),
    fail: p.red("FAIL"),
    info: p.dim("INFO"),
  };
  const lines = checks.map((check) =>
    check.fix
      ? `${tag[check.status]}  ${check.label}\n      Fix: ${check.fix}`
      : `${tag[check.status]}  ${check.label}`,
  );
  const warnings = checks.filter((check) => check.status === "warn").length;
  lines.push(
    "",
    failed
      ? p.red("Some checks failed. Fix the FAIL lines above.")
      : warnings > 0
        ? p.yellow(`Ready, with ${warnings} warning(s).`)
        : p.green("All good."),
  );
  ctx.io.stdout(`${lines.join("\n")}\n`);
  return failed ? 1 : 0;
}
