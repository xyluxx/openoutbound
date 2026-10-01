import { writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Registry } from "../../core/engine.js";
import { VERSION } from "../../core/version.js";
import { buildOpenApi } from "../../http/openapi.js";
import type { CliContext } from "../context.js";
import { assertNoRunningServer } from "./long-running.js";

/** `openoutbound db migrate`: applies pending migrations to DATABASE_URL. */
export async function runMigrate(ctx: CliContext): Promise<number> {
  await assertNoRunningServer(ctx, "`db migrate`");
  const config = ctx.config();
  const [{ createDb }, { migrate }] = await Promise.all([
    import("../../db/client.js"),
    import("../../db/migrate.js"),
  ]);
  const handle = await createDb(config);
  try {
    await migrate(handle);
  } finally {
    await handle.close();
  }
  ctx.io.stdout(`${ctx.out.green("OK")}  Migrations applied (${config.database.kind}).\n`);
  return 0;
}

/**
 * `openoutbound db reencrypt-secrets`: after a key rotation (new OPENOUTBOUND_SECRET_KEY, higher
 * OPENOUTBOUND_SECRET_KEY_VERSION, old keys in OPENOUTBOUND_PREVIOUS_SECRET_KEYS), rewrites every
 * stored secret with the current key. Safe to run again: secrets already on the current key are
 * skipped.
 */
export async function runReencryptSecrets(ctx: CliContext): Promise<number> {
  await assertNoRunningServer(ctx, "`db reencrypt-secrets`");
  const config = ctx.config();
  const [{ createDb }, { migrate }, { createRuntimeVault, reencryptSecrets }] = await Promise.all([
    import("../../db/client.js"),
    import("../../db/migrate.js"),
    import("../../runtime/vault.js"),
  ]);
  const handle = await createDb(config);
  try {
    await migrate(handle);
    const vault = createRuntimeVault(handle.db, config);
    const version = vault.keyVersion();
    const count = await reencryptSecrets(handle.db, vault);
    const p = ctx.out;
    const lines = [
      count === 0
        ? `${p.green("OK")}  Every stored secret already uses key version ${version}. Nothing to do.`
        : `${p.green("OK")}  Re-encrypted ${count} secret${count === 1 ? "" : "s"} with key version ${version}.`,
    ];
    if (config.env.OPENOUTBOUND_PREVIOUS_SECRET_KEYS?.trim()) {
      lines.push(
        "Keep OPENOUTBOUND_PREVIOUS_SECRET_KEYS: unsubscribe links in emails sent before the rotation are checked with the old keys.",
      );
    }
    ctx.io.stdout(`${lines.join("\n")}\n`);
  } finally {
    await handle.close();
  }
  return 0;
}

/** `openoutbound openapi [--out file]`: prints or writes the OpenAPI 3.1 document. */
export function runOpenapi(ctx: CliContext, registry: Registry, options: { out?: string }): number {
  const doc = buildOpenApi(registry, { serverUrl: ctx.setting("OPENOUTBOUND_BASE_URL") });
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  if (options.out) {
    const path = isAbsolute(options.out) ? options.out : resolve(ctx.cwd, options.out);
    writeFileSync(path, text, "utf8");
    ctx.io.stderr(`Wrote ${path}\n`);
  } else {
    ctx.io.stdout(text);
  }
  return 0;
}

/** `openoutbound version` */
export function runVersion(ctx: CliContext, options: { json: boolean }): number {
  ctx.io.stdout(
    options.json
      ? `${JSON.stringify({ version: VERSION, node: process.versions.node })}\n`
      : `openoutbound ${VERSION} (node ${process.versions.node})\n`,
  );
  return 0;
}
