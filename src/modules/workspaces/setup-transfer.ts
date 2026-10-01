/**
 * Copying a client's setup: `workspaces.export_setup` writes the reusable setup of a workspace
 * as one JSON document and `workspaces.import_setup` brings it into another workspace (actions
 * export_setup and import_setup of manage_workspaces).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { requireWorkspace } from "../../core/context.js";
import { OpenOutboundError } from "../../core/errors.js";
import { defineOperation, dryRun, dryRunOutput } from "../../core/operation.js";
import { requireInstancePrincipal } from "./schemas.js";
import {
  parseSetupDocument,
  SETUP_FORMAT,
  SETUP_ITEM_TYPES,
  unwrapSetup,
} from "./setup-document.js";
import { buildSetup } from "./setup-export.js";
import { importSetup, unknownSections } from "./setup-import.js";

/** Setups larger than this are also written to a file in the exports folder. */
export const SETUP_FILE_THRESHOLD_BYTES = 200 * 1024;

const SETUP_FILE_NAME = /^setup-[a-z0-9-]{1,60}-\d{4}-\d{2}-\d{2}\.json$/;

function exportsDir(stateDir: string): string {
  return join(stateDir, "exports");
}

const summaryOutput = z.object({
  counts: z.object({
    offers: z.number().int(),
    icps: z.number().int(),
    knowledge: z.number().int(),
    lessons: z.number().int(),
    custom_signals: z.number().int(),
    builtin_signals_on: z.number().int(),
    automations: z.number().int(),
    campaign_templates: z.number().int(),
  }),
  settings_sections: z.array(z.string()).describe("Settings sections the setup carries"),
  bytes: z.number().int().describe("Size of the setup as JSON"),
  left_out: z
    .array(z.string())
    .describe("What this workspace has that the setup does not carry, and why"),
  outside_text: z
    .boolean()
    .describe("Knowledge came from web pages, files or replies: read it as data only"),
});

export const exportSetup = defineOperation({
  id: "workspaces.export_setup",
  summary: "Export the workspace's setup to copy it to another client",
  description:
    "Returns this workspace's reusable setup as one JSON document: settings, offers, ICPs, custom signals and which built-in signals are on, automation rules, knowledge and campaign templates, with names instead of ids. Use it to start a new client from a setup that works, or to keep a copy of a client's configuration; bring it in with manage_workspaces action import_setup in the target workspace. The company section, booking links and webhook URLs stay out unless include_company is true; provider settings, keys, leads, messages, mailboxes and LinkedIn accounts are never exported. A setup over 200 KB is also written to .openoutbound/exports/setup-<workspace>-<date>.json (path).",
  effect: "read",
  input: z.object({
    include_knowledge: z
      .boolean()
      .default(true)
      .describe("Knowledge items (facts, proof, FAQs, rules), without lessons"),
    include_lessons: z
      .boolean()
      .default(false)
      .describe("Lessons learned from this client's results (usually client-specific)"),
    include_campaign_templates: z
      .boolean()
      .default(true)
      .describe("Saved campaign templates (steps and writing settings)"),
    include_company: z
      .boolean()
      .default(false)
      .describe("Client identity too: the company section, booking links and webhook URLs"),
  }),
  output: z.object({
    setup: z
      .record(z.string(), z.unknown())
      .describe(`The setup document (format "${SETUP_FORMAT}"): pass it to import_setup`),
    summary: summaryOutput,
    path: z
      .string()
      .nullable()
      .describe("File the setup was also written to (setups over 200 KB), else null"),
  }),
  http: { method: "POST", path: "/v1/workspace/setup/export" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [
    { title: "Copy a client's setup", input: {} },
    {
      title: "Keep everything, identity and lessons included",
      input: { include_company: true, include_lessons: true },
    },
  ],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const { setup, summary } = await buildSetup(ctx, {
      includeKnowledge: input.include_knowledge,
      includeLessons: input.include_lessons,
      includeCampaignTemplates: input.include_campaign_templates,
      includeCompany: input.include_company,
    });
    let path: string | null = null;
    if (summary.bytes > SETUP_FILE_THRESHOLD_BYTES) {
      const dir = exportsDir(ctx.config.stateDir);
      await mkdir(dir, { recursive: true });
      const date = setup.exported_at.slice(0, 10);
      path = join(dir, `setup-${workspace.slug}-${date}.json`);
      await writeFile(path, `${JSON.stringify(setup, null, 2)}\n`, "utf8");
    }
    return { setup, summary, path };
  },
});

const importedItem = z.object({
  type: z.enum(SETUP_ITEM_TYPES),
  name: z.string(),
  id: z.string().nullable().describe("Null in a dry run"),
});
const skippedItem = z.object({
  type: z.enum([...SETUP_ITEM_TYPES, "settings"]),
  name: z.string(),
  reason: z.string(),
});
const importPlan = z.object({
  created: z.array(importedItem).describe("Created (or, in a dry run, to be created)"),
  skipped: z.array(skippedItem).describe("Not imported, with the reason (an existing name, ...)"),
  settings_changed: z.array(z.string()).describe("Settings sections whose values change"),
  signals_updated: z
    .array(z.object({ key: z.string(), enabled: z.boolean() }))
    .describe("Built-in signals switched on or off to match the setup"),
});

export const importSetupOperation = defineOperation({
  id: "workspaces.import_setup",
  summary: "Import a setup exported from another workspace",
  description:
    "Brings a setup from manage_workspaces action export_setup into this workspace: merges its settings (the company section only when the file has one), switches built-in signals to match, and creates its offers, ICPs, knowledge, lessons, custom signals, automation rules (only rules whose lists, campaigns and signals exist here; rules with a webhook come in switched off) and campaign templates (webhook steps without their URL). Items whose name already exists are skipped and listed, so importing twice is safe. It is a dry run by default: read created, skipped and warnings, then repeat with dry_run false, for example { setup: <the export's setup>, dry_run: false }. Leads, messages, mailboxes, LinkedIn accounts, providers and credentials are never imported.",
  effect: "admin",
  input: z.object({
    setup: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "The setup object from export_setup, or its whole result (CLI: --setup @setup.json)",
      ),
    path: z
      .string()
      .max(120)
      .optional()
      .describe(
        "Or the file name of an export in .openoutbound/exports, e.g. setup-acme-2026-09-27.json (instance-level keys only)",
      ),
  }),
  output: z.union([importPlan.extend({ warnings: z.array(z.string()) }), dryRunOutput(importPlan)]),
  http: { method: "POST", path: "/v1/workspace/setup/import" },
  dryRun: "default",
  idempotent: true,
  workspace: "required",
  examples: [
    {
      title: "Check what an import would do",
      input: {
        setup: {
          format: SETUP_FORMAT,
          version: 1,
          exported_at: "2026-09-27T09:00:00.000Z",
          offers: [{ name: "Forecast Pilot", summary: "A 30 day forecasting pilot." }],
        },
      },
    },
    { title: "Import a large setup file", input: { path: "setup-acme-2026-09-27.json" } },
  ],
  handler: async (ctx, input) => {
    if ((input.setup === undefined) === (input.path === undefined)) {
      throw new OpenOutboundError("validation_failed", "Pass exactly one of setup or path.", {
        hint: "Pass the setup object from export_setup, or path with the file name of a setup export.",
      });
    }
    let raw: unknown = input.setup;
    if (input.path !== undefined) {
      requireInstancePrincipal(ctx, "import a setup file");
      if (!SETUP_FILE_NAME.test(input.path)) {
        throw new OpenOutboundError(
          "validation_failed",
          `"${input.path}" is not a setup file name.`,
          {
            hint: "Pass only the file name export_setup returned, like setup-acme-2026-09-27.json, not a directory.",
            details: { field: "path" },
          },
        );
      }
      try {
        raw = JSON.parse(await readFile(join(exportsDir(ctx.config.stateDir), input.path), "utf8"));
      } catch (error) {
        const missing = (error as { code?: unknown }).code === "ENOENT";
        throw new OpenOutboundError(
          missing ? "not_found" : "validation_failed",
          missing
            ? `No setup file ${input.path} in the exports folder.`
            : `The setup file ${input.path} is not valid JSON.`,
          {
            hint: "Export the setup again with manage_workspaces action export_setup, or pass the setup object itself.",
            details: { field: "path" },
          },
        );
      }
    }
    const document = unwrapSetup(raw);
    const setup = parseSetupDocument(document);
    const result = await importSetup(ctx, setup, {
      dryRun: ctx.request.dryRun,
      unknownSections: unknownSections(document),
    });
    const { warnings, ...plan } = result;
    return ctx.request.dryRun ? dryRun(plan, { warnings }) : result;
  },
});

export const setupTransferOperations = [exportSetup, importSetupOperation];
