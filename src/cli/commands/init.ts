import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { count } from "drizzle-orm";
import { loadConfig } from "../../core/config.js";
import { detectRunningServer } from "../../http/lock-file.js";
import { cliCommandPrefix, mcpLaunchCommand } from "../command-prefix.js";
import type { CliContext } from "../context.js";

/** The first-hour guide, for people who installed the package and have no docs folder. */
const FIRST_HOUR_URL =
  "https://github.com/xyluxx/openoutbound/blob/main/docs/getting-started/first-hour.md";

interface EnvDefault {
  key: string;
  value: () => string;
  comment: string;
}

const ENV_DEFAULTS: EnvDefault[] = [
  {
    key: "OPENOUTBOUND_SECRET_KEY",
    value: () => randomBytes(32).toString("base64"),
    comment:
      "Encrypts stored secrets (provider keys, mailbox passwords). Back it up: without it they cannot be read.",
  },
  {
    key: "DATABASE_URL",
    value: () => "pglite://.openoutbound/pglite",
    comment:
      "Embedded Postgres (PGlite) on disk. Use postgres://user:pass@host:5432/db for Postgres.",
  },
  {
    key: "OPENOUTBOUND_BASE_URL",
    value: () => "http://localhost:7331",
    comment: "Public URL of this instance (unsubscribe links, OAuth callbacks, webhooks).",
  },
];

/**
 * Adds missing settings to `.env` without touching existing values (empty values count as
 * missing). Returns the keys it added.
 */
export function ensureEnvFile(path: string): string[] {
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const current = parseEnv(existing);
  let text = existing;
  const added: string[] = [];
  for (const entry of ENV_DEFAULTS) {
    if (current[entry.key]?.trim()) continue;
    const line = `${entry.key}=${entry.value()}`;
    const pattern = new RegExp(`^${entry.key}=[ \\t]*$`, "m");
    if (pattern.test(text)) {
      text = text.replace(pattern, line);
    } else {
      if (text !== "" && !text.endsWith("\n")) text += "\n";
      text += `# ${entry.comment}\n${line}\n`;
    }
    added.push(entry.key);
  }
  if (added.length > 0) {
    writeFileSync(path, text, { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(path, 0o600);
    } catch {
      // Not supported on every platform.
    }
  }
  return added;
}

/**
 * `openoutbound init`: writes `.env` (random secret key, PGlite database, base URL) without
 * overwriting values, creates and migrates the database, creates a `default` workspace when
 * there is none, then prints next steps.
 */
export async function runInit(ctx: CliContext, options: { home?: string }): Promise<number> {
  const dir = options.home ? resolve(ctx.cwd, options.home) : ctx.cwd;
  mkdirSync(dir, { recursive: true });
  const envPath = join(dir, ".env");
  const added = ensureEnvFile(envPath);
  const p = ctx.out;
  const lines: string[] = [];
  lines.push(
    added.length > 0
      ? `${p.green("OK")}    Wrote ${envPath} (added ${added.join(", ")})`
      : `${p.green("OK")}    ${envPath} already has every setting (nothing changed)`,
  );

  const config = loadConfig({ ...ctx.env }, { cwd: dir, envFile: envPath });
  const running =
    config.database.kind === "pglite"
      ? await detectRunningServer(config.stateDir, { fetch: ctx.fetch })
      : null;
  if (running) {
    lines.push(
      `${p.yellow("SKIP")}  Database belongs to the server running at ${running.url} (pid ${running.pid}); it applies migrations on start.`,
    );
  } else {
    const [{ createDb }, { migrate }, { workspaces }] = await Promise.all([
      import("../../db/client.js"),
      import("../../db/migrate.js"),
      import("../../db/schema/index.js"),
    ]);
    const handle = await createDb(config);
    try {
      await migrate(handle);
      lines.push(
        `${p.green("OK")}    Database ready (${config.database.kind}, migrations applied)`,
      );
      const [row] = await handle.db.select({ n: count() }).from(workspaces);
      if (!row || row.n === 0) {
        await handle.db.insert(workspaces).values({ slug: "default", name: "Default" });
        lines.push(`${p.green("OK")}    Created workspace "default"`);
      } else {
        lines.push(`${p.green("OK")}    ${row.n} workspace(s) already exist`);
      }
    } finally {
      await handle.close();
    }
  }

  const script = ctx.deps.scriptPath ?? process.argv[1] ?? "dist/cli/main.js";
  // The agent works in the sandbox workspace: without --workspace its calls land in "default".
  const launch = `${mcpLaunchCommand(resolve(script), dir)} --workspace northwind`;
  const cli = cliCommandPrefix({ scriptPath: script, home: dir, cwd: ctx.cwd, env: ctx.env });
  lines.push(
    "",
    p.bold("Next steps"),
    "  1. Create the sandbox: practice workspaces with fake data, nothing reaches a real person:",
    `       ${cli} sandbox`,
    "  2. Start the server in its own terminal and leave it running (the CLI and your agent",
    "     share the database through it, so start it before the agent):",
    `       ${cli} serve`,
    "  3. Connect your agent to the sandbox workspace northwind (stdio MCP):",
    `       claude mcp add openoutbound -- ${launch}`,
    `       codex mcp add openoutbound -- ${launch}`,
    `  4. Check the setup: ${cli} doctor`,
    "",
    `  For REST or remote MCP, create an API key: ${cli} keys create --name my-agent --kind agent`,
    "  The first hour, step by step: docs/getting-started/first-hour.md",
    `  (${FIRST_HOUR_URL})`,
    "",
  );
  ctx.io.stdout(lines.join("\n"));
  return 0;
}
