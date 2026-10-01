import { existsSync } from "node:fs";
import { Command, CommanderError, Option } from "commander";
import type { Registry } from "../core/engine.js";
import { OpenOutboundError } from "../core/errors.js";
import { VERSION } from "../core/version.js";
import { buildCatalog, type Catalog } from "../mcp/catalog.js";
import { commandPrefix } from "./command-prefix.js";
import { type CliContext, type CliDeps, createCliContext } from "./context.js";
import { explainDatabaseLock } from "./database-lock.js";
import { EXIT_OK, EXIT_VALIDATION, exitCodeFor, reportError } from "./errors.js";
import { homeFlag, resolveHome } from "./home.js";
import { processIO } from "./io.js";
import { addOperationCommands } from "./operation-commands.js";

async function defaultRegistry(): Promise<Registry> {
  const [{ buildStaticRegistry }, { modules }] = await Promise.all([
    import("./static-registry.js"),
    import("../modules/index.js"),
  ]);
  return buildStaticRegistry(modules);
}

/** One catalog per registry: building it converts every input schema, and registries never change. */
const catalogs = new WeakMap<Registry, Catalog>();

function catalogFor(registry: Registry): Catalog {
  let catalog = catalogs.get(registry);
  if (!catalog) {
    catalog = buildCatalog(registry, VERSION);
    catalogs.set(registry, catalog);
  }
  return catalog;
}

/** Builds the commander program: built-ins plus one command per operation. */
export function buildProgram(
  ctx: CliContext,
  registry: Registry,
  setExitCode: (code: number) => void,
): Command {
  const program = new Command("openoutbound");
  program
    .description("OpenOutbound: the open-source AI SDR engine any agent can drive.")
    .version(VERSION, "-v, --version", "Print the version")
    .enablePositionalOptions()
    .exitOverride()
    .showSuggestionAfterError()
    .configureOutput({
      writeOut: (text) => ctx.io.stdout(text),
      writeErr: (text) => ctx.io.stderr(text),
      outputError: (text, write) => write(ctx.err.red(text)),
    })
    .option("--home <dir>", "Engine home with .env and .openoutbound/ (env OPENOUTBOUND_HOME)")
    .option(
      "--workspace <id|slug>",
      "Workspace for operation commands (env OPENOUTBOUND_WORKSPACE)",
    )
    .option("--url <url>", "Call a running server (bridge mode; env OPENOUTBOUND_URL)")
    .option("--api-key <key>", "API key for bridge mode (env OPENOUTBOUND_API_KEY)")
    .option("--json", "Print raw JSON")
    .option("--reason <text>", "Why, in one sentence (audit log)")
    .option("--idempotency-key <key>", "Makes retries safe")
    .addOption(new Option("--dry-run", "Preview without writing, sending or spending"))
    .addOption(new Option("--no-dry-run", "Apply for real (operations that preview by default)"));
  program.addHelpText(
    "after",
    `\nOperation commands accept --input <json|@file> and --json. Global options go before the command:\n  openoutbound --url http://127.0.0.1:7331 leads search --query "vp operations"\n`,
  );

  const globalJson = () => program.opts().json === true;

  program
    .command("init")
    .description("Write .env, create the database and a default workspace, print next steps")
    .option("--home <dir>", "Folder to set up (default: the current directory)")
    .action(async (options: { home?: string }) => {
      const { runInit } = await import("./commands/init.js");
      setExitCode(await runInit(ctx, { home: options.home ?? program.opts().home }));
    });

  program
    .command("doctor")
    .description(
      "Check node, config, base URL, secret key, database, workspaces, providers, mailbox DNS and sending readiness",
    )
    .option("--json", "Print the checks as JSON")
    .option("--workspace <slug>", "Show this workspace's sending readiness in detail")
    .action(async (options: { json?: boolean; workspace?: string }) => {
      const { runDoctor } = await import("./commands/doctor.js");
      const workspace = options.workspace ?? program.opts().workspace;
      setExitCode(
        await runDoctor(ctx, {
          json: options.json === true || globalJson(),
          ...(workspace ? { workspace } : {}),
        }),
      );
    });

  program
    .command("serve")
    .description("Run the HTTP server (REST, OpenAPI, /mcp) and the worker")
    .option("--port <port>", "Port (env PORT, default 7331)")
    .option("--host <host>", "Bind address (env HOST, default 127.0.0.1)")
    .option("--no-worker", "Do not run jobs and schedules in this process")
    .option(
      "--cors-origin <origin...>",
      "Allow browser calls from these origins (CORS is off by default)",
    )
    .option("--rate-limit <n>", "Requests per minute per API key (default 600)")
    .action(async (options) => {
      const { runServe } = await import("./commands/serve.js");
      setExitCode(await runServe(ctx, options));
    });

  program
    .command("worker")
    .description("Run only the worker (jobs and schedules)")
    .action(async () => {
      const { runWorker } = await import("./commands/serve.js");
      setExitCode(await runWorker(ctx));
    });

  program
    .command("mcp")
    .description("Run the MCP server over stdio (embedded, or bridge to a running server)")
    .option("--url <url>", "Bridge to this server instead of opening the database")
    .option(
      "--api-key <key>",
      "Act as this API key instead of the local agent (env OPENOUTBOUND_API_KEY counts only with --url)",
    )
    .option(
      "--workspace <slug>",
      "Bind the session to this workspace: other workspaces are refused (env OPENOUTBOUND_WORKSPACE is only a default)",
    )
    .option("--home <dir>", "Engine home with .env and .openoutbound/ (env OPENOUTBOUND_HOME)")
    .option(
      "--toolsets <list>",
      "core (default), leads, campaigns, inbox, signals, content, admin, agent_brain, all",
    )
    .action(async (options) => {
      const { runMcp } = await import("./commands/mcp.js");
      const global = program.opts();
      setExitCode(
        await runMcp(ctx, {
          url: options.url ?? global.url,
          apiKey: options.apiKey ?? global.apiKey,
          workspace: options.workspace ?? global.workspace,
          toolsets: options.toolsets,
        }),
      );
    });

  const db = program.command("db").description("Database commands");
  db.command("migrate")
    .description("Apply pending migrations")
    .action(async () => {
      const { runMigrate } = await import("./commands/misc.js");
      setExitCode(await runMigrate(ctx));
    });
  db.command("reencrypt-secrets")
    .description(
      "Re-encrypt stored secrets with the current OPENOUTBOUND_SECRET_KEY after a key rotation",
    )
    .action(async () => {
      const { runReencryptSecrets } = await import("./commands/misc.js");
      setExitCode(await runReencryptSecrets(ctx));
    });

  program
    .command("openapi")
    .description("Print the OpenAPI 3.1 document (or write it with --out)")
    .option("--out <file>", "Write to this file")
    .action(async (options: { out?: string }) => {
      const { runOpenapi } = await import("./commands/misc.js");
      setExitCode(runOpenapi(ctx, registry, options));
    });

  program
    .command("version")
    .description("Print the version")
    .option("--json", "Print JSON")
    .action(async (options: { json?: boolean }) => {
      const { runVersion } = await import("./commands/misc.js");
      setExitCode(runVersion(ctx, { json: options.json === true || globalJson() }));
    });

  addOperationCommands(program, catalogFor(registry), ctx, setExitCode);

  if (!registry.operation("sandbox.seed")) {
    const sandbox = program.commands.find((command) => command.name() === "sandbox");
    if (!sandbox) {
      program
        .command("sandbox")
        .description("Seed (or reset) the sandbox workspace")
        .action(() => {
          throw new OpenOutboundError(
            "unsupported",
            "The sandbox module is not available in this build.",
            {
              hint: "Update openoutbound, or run `openoutbound doctor` to check the installation.",
            },
          );
        });
    }
  }
  acceptHomeEverywhere(program);
  return program;
}

/**
 * Global options must come before the command, but `--home` is often written after it
 * (`openoutbound mcp --home <dir>`), so every command also accepts it. `runCli` reads the
 * value from argv before parsing, wherever it appears.
 */
function acceptHomeEverywhere(parent: Command): void {
  for (const command of parent.commands) {
    if (!command.options.some((option) => option.long === "--home")) {
      command.addOption(new Option("--home <dir>", "Engine home").hideHelp());
    }
    acceptHomeEverywhere(command);
  }
}

/**
 * Runs the CLI and returns the exit code: 0 ok, 1 error, 2 validation or usage error.
 * Resolves the engine home first and changes into it, so `.env` and `.openoutbound/` load
 * from there wherever the command was started.
 */
export async function runCli(argv: readonly string[], deps: CliDeps = {}): Promise<number> {
  const io = deps.io ?? processIO();
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const home = resolveHome({
    flag: homeFlag(argv),
    env,
    cwd,
    ...(deps.packageRoot ? { packageRoot: deps.packageRoot } : {}),
  });
  const isInit = argv.includes("init");
  if (home.dir !== cwd && existsSync(home.dir)) (deps.chdir ?? process.chdir)(home.dir);
  const ctx = createCliContext(deps, io, env, cwd, home);
  const wantsJson = argv.includes("--json");
  const prefix = commandPrefix(ctx);

  if (home.source === "flag" && !existsSync(home.dir) && !isInit) {
    return reportError(
      io,
      new OpenOutboundError(
        "validation_failed",
        `The --home directory ${home.dir} does not exist.`,
        {
          hint: "Create it with `openoutbound init --home <dir>` or fix the path.",
        },
      ),
      // The hint names --home itself, so the prefix must not add the missing one.
      {
        json: wantsJson,
        palette: ctx.err,
        prefix: commandPrefix({ ...ctx, home: { ...home, dir: cwd } }),
      },
    );
  }

  let exitCode = EXIT_OK;
  try {
    const registry = deps.registry ?? (await defaultRegistry());
    const program = buildProgram(ctx, registry, (code) => {
      exitCode = code;
    });
    if (argv.length === 0) {
      program.outputHelp();
      return EXIT_OK;
    }
    await program.parseAsync([...argv], { from: "user" });
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      const code = exitCodeFor(error);
      return code === EXIT_OK || error.exitCode === 0 ? EXIT_OK : EXIT_VALIDATION;
    }
    // The embedded database held by another process: say which one and the way out.
    return reportError(io, explainDatabaseLock(error, prefix) ?? error, {
      json: wantsJson,
      palette: ctx.err,
      prefix,
    });
  }
}
