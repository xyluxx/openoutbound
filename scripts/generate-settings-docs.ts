/**
 * Writes the settings tables in docs/reference/configuration.md from the zod schemas in
 * src/core/settings.ts, between `<!-- generated:<name>:start -->` and `:end -->` markers.
 * Types and defaults come from the schemas; meanings come from `.describe()` or NOTES below.
 *
 *   pnpm exec tsx scripts/generate-settings-docs.ts          # rewrite the tables
 *   pnpm exec tsx scripts/generate-settings-docs.ts --check  # exit 1 when they are stale
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { REPLY_CATEGORIES } from "../src/core/enums.js";
import {
  campaignSettingsSchema,
  DEFAULT_REPLY_RULES,
  workspaceSettingsSchema,
} from "../src/core/settings.js";

interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema | false;
  prefixItems?: JsonSchema[];
  enum?: unknown[];
  anyOf?: JsonSchema[];
  default?: unknown;
  description?: string;
  format?: string;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  additionalProperties?: JsonSchema | boolean;
}

/** Meanings for settings without a `.describe()` (or with one that is only an example). */
const NOTES: Record<string, string> = {
  "company.name":
    "Your company name: used in writing, reply drafts and the email footer. Campaign launch requires it.",
  "company.website":
    "Your website: grounds writing and is the only link reply drafts may add besides the booking link",
  "company.sender_company_line":
    "Sender line in the email footer, e.g. 'Helix Outbound on behalf of ...' (default: company.name)",
  "schedule.holidays": "Dates (YYYY-MM-DD) when nothing is sent",
  "schedule.blackout_ranges": "Date ranges `{ from, to }` when nothing is sent",
  "compliance.excluded_countries": "Never contact people in these countries",
  "compliance.ad_disclosure.countries": "Recipient countries that get the advertisement line",
  "compliance.ad_disclosure.text": "The advertisement line",
  "compliance.ai_disclosure.auto_replies":
    "Who gets the AI line on replies sent without review: eu (EU/EEA recipients, and anyone whose country is unknown), all, or off",
  "compliance.ai_disclosure.text": "The AI disclosure line",
  "compliance.include_unsubscribe_link":
    "Unsubscribe line in system and notification email (reports, alerts). Campaign email always carries the unsubscribe line and List-Unsubscribe headers, whatever this says",
  "compliance.include_postal_address":
    "Postal address in system and notification email. Campaign email always prints company.postal_address, and launching an email campaign requires it",
  "compliance.rest_days_after_campaign":
    "Days a person rests after a campaign ends before another campaign may enroll them",
  "compliance.one_active_campaign_per_person":
    "A person can be in only one active campaign at a time",
  "sending.require_verified_email": "Only email people whose address is verified valid",
  "sending.tracking.opens": "Not implemented yet (no tracking pixels)",
  "sending.tracking.clicks": "Not implemented yet (no link rewriting)",
  "ai.monthly_budget_usd":
    "Monthly AI spend limit in USD; brain calls fail with budget_exceeded once it is used up. Only priced calls count (Anthropic models in the price table, OpenRouter). null = no limit",
  "ai.language": "Default language for writing, replies, posts and research briefs (ISO code)",
  "ai.tone_notes": "Free-text tone guidance added to writing, reply and post prompts",
  "ai.task_models":
    'Overrides keyed by prompt id or tier name, each { provider?, model?, tier? }, e.g. { "campaign.email.write": { "provider": "anthropic", "model": "claude-opus-5" } }',
  "data.monthly_credit_budget":
    "Monthly data credit limit (searches, enrichment, research, signals); spend operations fail with budget_exceeded above it. null = no limit",
  "data.auto_research_min_fit":
    "New leads with a fit score at or above this get a research brief automatically",
  "data.enrichment.verify_existing": "Verify addresses that leads already have before using them",
  "approvals.agent_launch_requires_approval":
    "Campaign launches wait for an approval unless a person holding the approve scope launches (agents, services and people without approve ask); false lets everyone launch directly",
  "approvals.default_review_level": "Review level for new campaigns: every, first or unsure",
  "approvals.expire_days": "Days before a pending approval expires",
  "sandbox.use_real_brain":
    "Sandbox workspaces only: use your real AI brain instead of the fake one (costs AI budget)",
  review_level:
    "When messages wait for approval: every message, the first written message per person, or only when the checker is unsure",
  "schedule.start_hour": "Sending window start (hour, 0-24) in the schedule timezone",
  "schedule.end_hour": "Sending window end (hour, 0-24) in the schedule timezone",
  "schedule.start_at": "Do not send before this time (ISO 8601 with offset)",
  "schedule.end_at": "Do not send after this time (ISO 8601 with offset)",
  daily_new_leads: "New people started per day (queued enrollments beyond this wait)",
  "senders.mailbox_ids": "Mailboxes this campaign sends from (mbx_...)",
  "senders.linkedin_account_ids": "LinkedIn accounts this campaign acts from (lia_...)",
  priority: "0-100; higher-priority campaigns get sender capacity first",
  "writing.length": "Target email length: short or medium",
  "writing.style_notes": "Style guidance for the writer",
  "writing.instructions": "What to say and how: the campaign brief for the writer",
  missing_data:
    "When a step cannot run for a person (no email, not connected): skip the step, or stop the person",
  "end_action.type":
    "What to do when a person finishes the sequence: nothing, add a tag, or add to a list",
  "stop.on_reply": "Stop a person's sequence when they reply",
  "stop.on_company_reply": "Stop colleagues at the same company when someone there replies",
  "stop.on_meeting": "Stop the sequence when a meeting is booked",
  "tracking.opens": "Adds a minimal HTML part only; open tracking is not implemented yet",
  "tracking.clicks": "Adds a minimal HTML part only; click tracking is not implemented yet",
  "ab_test.enabled": "Split people evenly across the step variants",
  "ab_test.metric":
    "The metric the campaign report ranks variants on (leader, confidence, enough_data). End a test with campaigns pick-winner; the engine never picks a winner by itself",
};

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

function code(value: string): string {
  return `\`${value}\``;
}

function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function typeOf(schema: JsonSchema): string {
  if (schema.anyOf) {
    const parts = schema.anyOf.filter((part) => part.type !== "null").map(typeOf);
    const nullable = schema.anyOf.some((part) => part.type === "null");
    return `${parts.join(" or ")}${nullable ? " or null" : ""}`;
  }
  if (schema.enum) return schema.enum.map((value) => code(String(value))).join(" | ");
  if (schema.prefixItems) return `[${schema.prefixItems.map(typeOf).join(", ")}]`;
  if (schema.type === "array") {
    return schema.items ? `list of ${typeOf(schema.items)}` : "list";
  }
  if (schema.type === "object") return "object";
  if (schema.type === "string" && schema.pattern === "^[A-Z]{2}$") return "country code";
  if (schema.type === "string" && schema.format === "date") return "date";
  if (schema.type === "string" && schema.format === "date-time") return "date-time";
  if (schema.type === "string" && schema.format === "uri") return "URL";
  if (schema.type === "integer" || schema.type === "number") {
    const min = schema.minimum;
    const max =
      schema.maximum !== undefined && schema.maximum < MAX_SAFE ? schema.maximum : undefined;
    const range =
      min !== undefined && max !== undefined
        ? ` (${min}-${max})`
        : min !== undefined && min !== 0
          ? ` (min ${min})`
          : "";
    return `${schema.type}${range}`;
  }
  return Array.isArray(schema.type) ? schema.type.join(" or ") : (schema.type ?? "any");
}

function defaultOf(schema: JsonSchema): string {
  if (!("default" in schema)) return "none";
  return code(JSON.stringify(schema.default));
}

interface Row {
  path: string;
  type: string;
  defaultValue: string;
  meaning: string;
}

function collect(schema: JsonSchema, prefix: string, rows: Row[], skip: Set<string>): void {
  for (const [name, child] of Object.entries(schema.properties ?? {})) {
    const path = prefix ? `${prefix}.${name}` : name;
    if (skip.has(path)) continue;
    if (child.type === "object" && child.properties) {
      if (child.description || NOTES[path]) {
        rows.push({
          path,
          type: "object",
          defaultValue: "see below",
          meaning: NOTES[path] ?? child.description ?? "",
        });
      }
      collect(child, path, rows, skip);
      continue;
    }
    const meaning = NOTES[path] ?? child.description ?? "";
    if (!meaning)
      throw new Error(`No meaning for setting ${path}: add a .describe() or a NOTES entry`);
    rows.push({ path, type: typeOf(child), defaultValue: defaultOf(child), meaning });
  }
}

function table(rows: Row[]): string {
  const lines = ["| Setting | Type | Default | Meaning |", "| --- | --- | --- | --- |"];
  for (const row of rows) {
    lines.push(
      `| ${code(row.path)} | ${cell(row.type)} | ${cell(row.defaultValue)} | ${cell(row.meaning)} |`,
    );
  }
  return lines.join("\n");
}

function jsonSchema(schema: z.ZodType): JsonSchema {
  return z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as JsonSchema;
}

function workspaceTable(): string {
  const rows: Row[] = [];
  collect(jsonSchema(workspaceSettingsSchema), "", rows, new Set(["replies"]));
  return table(rows);
}

function replyRulesTable(): string {
  const lines = ["| Category | Default action | Locked |", "| --- | --- | --- |"];
  for (const category of REPLY_CATEGORIES) {
    const rule = DEFAULT_REPLY_RULES[category];
    lines.push(`| ${code(category)} | ${code(rule.action)} | ${rule.locked ? "yes" : "no"} |`);
  }
  return lines.join("\n");
}

function campaignTable(): string {
  const rows: Row[] = [];
  collect(jsonSchema(campaignSettingsSchema), "", rows, new Set());
  return table(rows);
}

const SECTIONS: Record<string, () => string> = {
  "workspace-settings": workspaceTable,
  "reply-rules": replyRulesTable,
  "campaign-settings": campaignTable,
};

const file = resolve("docs/reference/configuration.md");
const original = readFileSync(file, "utf8");
let text = original;
for (const [name, render] of Object.entries(SECTIONS)) {
  const start = `<!-- generated:${name}:start -->`;
  const end = `<!-- generated:${name}:end -->`;
  const from = text.indexOf(start);
  const to = text.indexOf(end);
  if (from === -1 || to === -1 || to < from) {
    throw new Error(`Missing markers ${start} ... ${end} in ${file}`);
  }
  text = `${text.slice(0, from + start.length)}\n${render()}\n${text.slice(to)}`;
}

if (process.argv.includes("--check")) {
  if (text !== original) {
    process.stderr.write(
      "configuration.md settings tables are stale: run pnpm exec tsx scripts/generate-settings-docs.ts\n",
    );
    process.exit(1);
  }
  process.stdout.write("settings docs: up to date\n");
} else {
  writeFileSync(file, text, "utf8");
  process.stdout.write(`wrote ${file}\n`);
}
