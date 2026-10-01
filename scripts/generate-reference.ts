/**
 * Writes docs/reference/{mcp-tools.md, cli.md, rest-api.md, openapi.json} from the real
 * registry (`createEngine` with an in-memory database), plus the Agent Skill's copies
 * skills/openoutbound/references/{tools.md, cli.md}.
 *
 *   pnpm generate:reference            # writes docs/reference/ and the skill copies
 *   pnpm generate:reference <out-dir>  # writes only the reference files, somewhere else
 *   pnpm generate:reference --check    # writes nothing; exits 1 and lists the stale files
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { renderReference } from "../src/cli/reference.js";
import {
  referenceTargets,
  staleReferenceMessage,
  staleReferenceTargets,
} from "../src/cli/reference-check.js";
import { buildStaticRegistry } from "../src/cli/static-registry.js";
import type { Registry } from "../src/core/engine.js";
import { VERSION } from "../src/core/version.js";
import { modules } from "../src/modules/index.js";

async function loadRegistry(): Promise<{ registry: Registry; close: () => Promise<void> }> {
  try {
    const { createEngine } = await import("../src/index.js");
    const engine = await createEngine({
      config: { database: { kind: "memory" }, databaseUrl: "memory://", logLevel: "silent" },
      worker: false,
    });
    return { registry: engine.registry, close: () => engine.close() };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `generate-reference: createEngine failed (${reason}); using the module definitions directly.\n`,
    );
    return { registry: buildStaticRegistry(modules), close: async () => {} };
  }
}

const args = process.argv.slice(2);
const check = args.includes("--check");
const outArg = args.find((arg) => !arg.startsWith("--"));
const root = process.cwd();
const shown = (path: string) => relative(root, path).split("\\").join("/");

const { registry, close } = await loadRegistry();
try {
  const targets = referenceTargets(renderReference(registry, VERSION), {
    outDir: resolve(outArg ?? "docs/reference"),
    root,
    skillCopies: outArg === undefined,
  });
  if (check) {
    const stale = staleReferenceTargets(targets);
    if (stale.length > 0) {
      process.stderr.write(staleReferenceMessage(stale.map((target) => shown(target.path))));
      process.exitCode = 1;
    } else {
      process.stdout.write("reference docs: up to date\n");
    }
  } else {
    for (const target of targets) {
      mkdirSync(dirname(target.path), { recursive: true });
      writeFileSync(target.path, target.content, "utf8");
      process.stdout.write(`wrote ${target.path}\n`);
    }
  }
} finally {
  await close();
}
