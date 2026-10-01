/**
 * Imports a setup document into the context's workspace: merges settings, then creates
 * knowledge, lessons, offers, ICPs, custom signals, automation rules and campaign templates
 * through their owners' operations, skipping (and listing) every item whose name already
 * exists. A webhook copied from another workspace is that client's endpoint, so it never works
 * here on its own: rules with one come in switched off and template webhook steps without their
 * URL, each with a warning naming the host. A dry run reads the workspace and reports the same
 * lists and warnings without writing.
 */
import { and, eq, ne } from "drizzle-orm";
import type { z } from "zod";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import { toOpenOutboundError } from "../../core/errors.js";
import { mergeSettings, parseWorkspaceSettings } from "../../core/settings.js";
import {
  automation_rules,
  campaigns,
  icps,
  knowledge_items,
  lists,
  offers,
  templates,
  workspaces,
} from "../../db/schema/index.js";
import { mustRequestApproval } from "../../runtime/approval-rule.js";
import { createItem } from "../knowledge/items.js";
import { createOfferOp } from "../knowledge/operations/offers.js";
import { createIcp } from "../leads/operations/icps.js";
import { BUILTIN_KEYS, isBuiltinKey, loadDefinitions } from "../signals/catalog.js";
import { automationsCreate } from "../signals/operations/automations.js";
import { definitionsCreate, definitionsUpdate } from "../signals/operations/definitions.js";
import { updateWorkspace } from "./operations.js";
import { loosenedGateRefusal } from "./safety.js";
import {
  type SetupAutomation,
  type SetupDocument,
  type SetupItemType,
  type SetupKnowledge,
  type SetupTemplate,
  setupDocumentSchema,
  setupSettings,
} from "./setup-document.js";

export interface ImportedItem {
  type: SetupItemType;
  name: string;
  /** Null in a dry run. */
  id: string | null;
}

export interface SkippedItem {
  type: SetupItemType | "settings";
  name: string;
  reason: string;
}

export interface ImportSetupResult {
  created: ImportedItem[];
  skipped: SkippedItem[];
  /** Settings sections whose values change. */
  settings_changed: string[];
  /** Built-in signals switched on or off to match the setup. */
  signals_updated: Array<{ key: string; enabled: boolean }>;
  warnings: string[];
}

type Plain = Record<string, unknown>;

function isPlain(value: unknown): value is Plain {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nameKey(value: string): string {
  return value.trim().toLowerCase();
}

function knowledgeKey(kind: string, title: string): string {
  return `${kind}:${nameKey(title)}`;
}

function messageOf(error: unknown): string {
  return toOpenOutboundError(error).message;
}

/** Parses an owner operation's input; a readable reason when the item does not fit it. */
function parseInput<S extends z.ZodType>(
  schema: S,
  value: unknown,
): { ok: true; data: z.output<S> } | { ok: false; reason: string } {
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, data: parsed.data };
  const issue = parsed.error.issues[0];
  const where = issue?.path.map(String).join(".") || "value";
  return { ok: false, reason: `invalid ${where}: ${issue?.message ?? "not accepted"}` };
}

/** Settings sections whose effective values differ between two stored settings objects. */
function changedSections(before: Plain, after: Plain): string[] {
  const a = parseWorkspaceSettings(before) as unknown as Plain;
  const b = parseWorkspaceSettings(after) as unknown as Plain;
  return Object.keys(b)
    .filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]))
    .sort();
}

/** The host of a URL for warnings (the text itself when it does not parse). */
function hostOf(url: string): string {
  try {
    return new URL(url).host || url.slice(0, 80);
  } catch {
    return url.slice(0, 80);
  }
}

/** A template's webhook step (1-based) and the host its copied URL pointed at, if the file had one. */
interface TemplateWebhook {
  step: number;
  host: string | null;
}

/**
 * Template content without references to another workspace's records: no senders, list end
 * actions, webhook secrets or webhook URLs. `webhooks` lists the webhook steps that lost their URL.
 */
function templateContent(template: SetupTemplate): { content: Plain; webhooks: TemplateWebhook[] } {
  const settings = { ...template.settings };
  delete settings.senders;
  if (isPlain(settings.end_action) && settings.end_action.type === "list")
    delete settings.end_action;
  const webhooks: TemplateWebhook[] = [];
  const steps = template.steps.map((step, index) => {
    const config = { ...step.config };
    delete config.secret_id;
    if (step.type === "webhook") {
      const url = typeof config.url === "string" && config.url.trim() ? config.url : null;
      webhooks.push({ step: index + 1, host: url ? hostOf(url) : null });
      delete config.url;
    }
    return { ...step, config };
  });
  return {
    content: {
      ...(template.goal ? { goal: template.goal } : {}),
      why: template.why,
      settings,
      steps,
    },
    webhooks,
  };
}

/** The warning for a template whose webhook steps come in without their URL. */
function templateWebhookWarning(name: string, webhooks: TemplateWebhook[]): string | null {
  if (webhooks.length === 0) return null;
  const steps = webhooks.map((hook) =>
    hook.host
      ? `webhook step ${hook.step} pointed at ${hook.host}, an address copied from another workspace`
      : `webhook step ${hook.step} has no URL (the export left it out)`,
  );
  return `Template "${name}" is imported without its webhook URLs: ${steps.join("; ")}. Enter the URL again (the step's config.url) when you create a campaign from it with create_campaign action create and steps.`;
}

class SetupImporter {
  readonly result: ImportSetupResult = {
    created: [],
    skipped: [],
    settings_changed: [],
    signals_updated: [],
    warnings: [],
  };
  /** Knowledge kinds and titles this import creates (offers may cite them as proof). */
  private readonly knowledgeCreated = new Set<string>();

  constructor(
    private readonly ctx: OpContext,
    private readonly workspaceId: string,
    private readonly dryRun: boolean,
  ) {}

  private created(type: SetupItemType, name: string, id: string | null): void {
    this.result.created.push({ type, name, id: this.dryRun ? null : id });
  }

  private skip(type: SkippedItem["type"], name: string, reason: string): void {
    this.result.skipped.push({ type, name, reason });
  }

  async settings(raw: Plain): Promise<void> {
    const patch = setupSettings(raw, { includeCompany: true });
    const ignored = ["sandbox"].filter((key) => key in raw);
    const providers =
      (isPlain(raw.ai) && ("task_models" in raw.ai || "fallback_provider" in raw.ai)) ||
      (isPlain(raw.data) &&
        isPlain(raw.data.enrichment) &&
        ("finders" in raw.data.enrichment || "verifier" in raw.data.enrichment));
    if (providers) ignored.push("provider settings");
    if (ignored.length > 0) {
      this.result.warnings.push(
        `Settings not imported: ${ignored.join(" and ")} (set providers up with manage_providers).`,
      );
    }
    if (Object.keys(patch).length === 0) return;
    const [row] = await this.ctx.db
      .select({ settings: workspaces.settings })
      .from(workspaces)
      .where(eq(workspaces.id, this.workspaceId));
    const stored = isPlain(row?.settings) ? (row.settings as Plain) : {};
    let changed: string[];
    try {
      changed = changedSections(stored, mergeSettings(stored, patch));
    } catch (error) {
      this.skip("settings", "settings", `invalid settings: ${messageOf(error)}`);
      return;
    }
    if (changed.length === 0) return;
    // The dry run says what the import will do: settings that loosen a gate are skipped then too.
    const refusal = loosenedGateRefusal(this.ctx.principal, stored, mergeSettings(stored, patch));
    if (refusal) {
      this.skip("settings", "settings", `${refusal.message} ${refusal.hint ?? ""}`.trim());
      return;
    }
    if (!this.dryRun) {
      try {
        await updateWorkspace.handler(this.ctx, updateWorkspace.input.parse({ settings: patch }));
      } catch (error) {
        this.skip("settings", "settings", messageOf(error));
        return;
      }
    }
    this.result.settings_changed = changed;
  }

  /** Knowledge items and lessons, skipped when an item of the same kind and title exists. */
  async knowledge(items: SetupKnowledge[], type: "knowledge" | "lesson"): Promise<void> {
    const now = this.ctx.clock.now();
    const taken = await this.knowledgeKeys();
    for (const item of items) {
      const key = knowledgeKey(item.kind, item.title);
      if (taken.has(key)) {
        this.skip(type, item.title, `a ${item.kind} item with this title already exists`);
        continue;
      }
      if (item.expires_at && new Date(item.expires_at).getTime() <= now.getTime()) {
        this.skip(type, item.title, "it has expired");
        continue;
      }
      taken.add(key);
      if (this.dryRun) {
        this.knowledgeCreated.add(key);
        this.created(type, item.title, null);
        continue;
      }
      try {
        // A lesson exported without an expiry gets the default lifetime (createItem).
        const { item: row, created } = await createItem(this.ctx, {
          kind: item.kind,
          title: item.title,
          body: item.body,
          status: item.status,
          sourceType: item.source_url ? "url" : "manual",
          sourceRef: item.source_url,
          tags: item.tags,
          ...(item.expires_at ? { expiresAt: new Date(item.expires_at) } : {}),
        });
        if (!created) {
          this.skip(type, item.title, "an identical item already exists");
          continue;
        }
        this.created(type, item.title, row.id);
      } catch (error) {
        this.skip(type, item.title, messageOf(error));
      }
    }
  }

  private async knowledgeKeys(): Promise<Set<string>> {
    const rows = await this.ctx.db
      .select({ kind: knowledge_items.kind, title: knowledge_items.title })
      .from(knowledge_items)
      .where(
        and(
          eq(knowledge_items.workspace_id, this.workspaceId),
          ne(knowledge_items.status, "archived"),
        ),
      );
    return new Set(rows.map((row) => knowledgeKey(row.kind, row.title)));
  }

  async offers(setup: SetupDocument): Promise<void> {
    // Proof ids are read after the knowledge import; a dry run counts the planned items.
    const rows = await this.ctx.db
      .select({ name: offers.name, is_default: offers.is_default, status: offers.status })
      .from(offers)
      .where(and(eq(offers.workspace_id, this.workspaceId), ne(offers.status, "archived")));
    const taken = new Set(rows.map((row) => nameKey(row.name)));
    const hadDefault = rows.some((row) => row.is_default && row.status === "active");
    const items = await this.ctx.db
      .select({ id: knowledge_items.id, kind: knowledge_items.kind, title: knowledge_items.title })
      .from(knowledge_items)
      .where(
        and(
          eq(knowledge_items.workspace_id, this.workspaceId),
          ne(knowledge_items.status, "archived"),
        ),
      );
    const itemIds = new Map(items.map((row) => [knowledgeKey(row.kind, row.title), row.id]));
    for (const offer of setup.offers) {
      if (taken.has(nameKey(offer.name))) {
        this.skip("offer", offer.name, "an offer with this name already exists");
        continue;
      }
      const proofIds: string[] = [];
      for (const proof of offer.proof) {
        const key = knowledgeKey(proof.kind, proof.title);
        const id = itemIds.get(key);
        if (id) proofIds.push(id);
        else if (!this.knowledgeCreated.has(key)) {
          this.result.warnings.push(
            `Offer "${offer.name}": proof "${proof.title}" is not in this workspace and was left out.`,
          );
        }
      }
      const input = parseInput(createOfferOp.input, {
        name: offer.name,
        summary: offer.summary,
        details: offer.details,
        value_props: offer.value_props,
        proof_item_ids: proofIds,
        ...(offer.cta !== null ? { cta: offer.cta } : {}),
        ...(offer.booking_url !== null ? { booking_url: offer.booking_url } : {}),
        ...(offer.is_default && !hadDefault ? { is_default: true } : {}),
      });
      if (!input.ok) {
        this.skip("offer", offer.name, input.reason);
        continue;
      }
      taken.add(nameKey(offer.name));
      if (this.dryRun) {
        this.created("offer", offer.name, null);
        continue;
      }
      try {
        const view = await createOfferOp.handler(this.ctx, input.data);
        this.created("offer", offer.name, (view as { id: string }).id);
      } catch (error) {
        this.skip("offer", offer.name, messageOf(error));
      }
    }
  }

  async icps(setup: SetupDocument): Promise<void> {
    const rows = await this.ctx.db
      .select({ name: icps.name })
      .from(icps)
      .where(eq(icps.workspace_id, this.workspaceId));
    const taken = new Set(rows.map((row) => nameKey(row.name)));
    const hadIcps = rows.length > 0;
    for (const icp of setup.icps) {
      if (taken.has(nameKey(icp.name))) {
        this.skip("icp", icp.name, "an ICP with this name already exists");
        continue;
      }
      const input = parseInput(createIcp.input, {
        name: icp.name,
        ...(icp.description ? { description: icp.description } : {}),
        criteria: icp.criteria,
        scoring: icp.scoring,
        signal_keys: icp.signal_keys,
        ...(icp.is_default && !hadIcps ? { is_default: true } : {}),
      });
      if (!input.ok) {
        this.skip("icp", icp.name, input.reason);
        continue;
      }
      taken.add(nameKey(icp.name));
      if (this.dryRun) {
        this.created("icp", icp.name, null);
        continue;
      }
      try {
        const view = await createIcp.handler(this.ctx, input.data);
        this.created("icp", icp.name, (view as { id: string }).id);
      } catch (error) {
        this.skip("icp", icp.name, messageOf(error));
      }
    }
  }

  /** Custom signals, then built-in signals switched on or off to match the setup. */
  async signals(setup: SetupDocument): Promise<Set<string>> {
    const definitions = await loadDefinitions(this.ctx.db, this.workspaceId);
    const available = new Set([...definitions.keys(), ...BUILTIN_KEYS]);
    for (const signal of setup.signals.custom) {
      if (isBuiltinKey(signal.key)) {
        this.skip("signal", signal.key, "it is a built-in signal key");
        continue;
      }
      if (definitions.has(signal.key)) {
        this.skip("signal", signal.key, "a signal with this key already exists");
        continue;
      }
      const { enabled, ...fields } = signal;
      const input = parseInput(definitionsCreate.input, {
        ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
        enabled,
      });
      if (!input.ok) {
        this.skip("signal", signal.key, input.reason);
        continue;
      }
      available.add(signal.key);
      if (this.dryRun) {
        this.created("signal", signal.key, null);
        continue;
      }
      try {
        const view = await definitionsCreate.handler(this.ctx, input.data);
        for (const warning of view.warnings ?? []) {
          this.result.warnings.push(`Signal "${signal.key}": ${warning}`);
        }
        // Signals are addressed by key.
        this.created("signal", signal.key, signal.key);
      } catch (error) {
        available.delete(signal.key);
        this.skip("signal", signal.key, messageOf(error));
      }
    }
    const wanted = setup.signals.builtin_enabled;
    if (wanted) {
      const unknown = wanted.filter((key) => !isBuiltinKey(key));
      if (unknown.length > 0) {
        this.result.warnings.push(`Unknown built-in signals ignored: ${unknown.join(", ")}.`);
      }
      const on = new Set(wanted);
      for (const key of BUILTIN_KEYS) {
        const row = definitions.get(key);
        const enabled = on.has(key);
        if (!row || row.enabled === enabled) continue;
        if (!this.dryRun) {
          await definitionsUpdate.handler(
            this.ctx,
            definitionsUpdate.input.parse({ key, enabled }),
          );
        }
        this.result.signals_updated.push({ key, enabled });
      }
    }
    return available;
  }

  /** Automation rules whose lists, campaigns, signals and webhook secrets are all here. */
  async automations(rules: SetupAutomation[], signalKeys: Set<string>): Promise<void> {
    const existing = await this.ctx.db
      .select({ name: automation_rules.name })
      .from(automation_rules)
      .where(eq(automation_rules.workspace_id, this.workspaceId));
    const taken = new Set(existing.map((row) => nameKey(row.name)));
    const listRows = await this.ctx.db
      .select({ id: lists.id, name: lists.name, kind: lists.kind })
      .from(lists)
      .where(eq(lists.workspace_id, this.workspaceId));
    const listByName = new Map(listRows.map((row) => [nameKey(row.name), row]));
    const campaignRows = await this.ctx.db
      .select({ id: campaigns.id, name: campaigns.name })
      .from(campaigns)
      .where(eq(campaigns.workspace_id, this.workspaceId));
    const campaignByName = new Map<string, string>();
    for (const row of campaignRows) {
      if (!campaignByName.has(nameKey(row.name))) campaignByName.set(nameKey(row.name), row.id);
    }

    for (const rule of rules) {
      if (taken.has(nameKey(rule.name))) {
        this.skip("automation", rule.name, "a rule with this name already exists");
        continue;
      }
      const missing: string[] = [];
      const { list, ...filters } = rule.filters;
      const filterList = list ? listByName.get(nameKey(list)) : undefined;
      if (list && !filterList) missing.push(`list "${list}" does not exist here`);
      for (const key of filters.definition_keys ?? []) {
        if (!signalKeys.has(key)) missing.push(`signal "${key}" does not exist here`);
      }
      const actions: Plain[] = [];
      const hosts = new Set<string>();
      for (const action of rule.actions) {
        switch (action.type) {
          case "add_to_list": {
            const target = listByName.get(nameKey(action.list));
            if (target?.kind !== "static") {
              missing.push(`static list "${action.list}" does not exist here`);
            } else {
              const { list: _name, ...rest } = action;
              actions.push({ ...rest, list_id: target.id });
            }
            break;
          }
          case "enroll": {
            const id = campaignByName.get(nameKey(action.campaign));
            if (!id) missing.push(`campaign "${action.campaign}" does not exist here`);
            else {
              const { campaign: _name, ...rest } = action;
              actions.push({ ...rest, campaign_id: id });
            }
            break;
          }
          case "webhook":
            if (action.signed) {
              missing.push(
                "its webhook signing secret is never exported: create the rule again with the secret",
              );
            } else if (!action.url) {
              missing.push(
                "its webhook URL is not in the setup (URLs are exported only with include_company): create the rule again with manage_automations action create and the URL",
              );
            } else {
              actions.push({ type: "webhook", url: action.url });
              hosts.add(hostOf(action.url));
            }
            break;
          default:
            actions.push(action);
        }
      }
      if (missing.length > 0) {
        this.skip("automation", rule.name, missing.join("; "));
        continue;
      }
      // A copied webhook posts this workspace's leads to the source client's endpoint: the rule
      // stays off until a person checks the address.
      const hookWarning =
        hosts.size > 0
          ? `Automation "${rule.name}" is imported switched off: its webhook sends leads to ${[...hosts].join(", ")}, an address copied from another workspace. Check it, then switch the rule on with manage_automations action update (rule_id, enabled true).`
          : null;
      // Enrolling without asking is a gate: an importer who must ask keeps approvals on.
      const keepApprovals =
        rule.require_approval === false &&
        actions.some((action) => action.type === "enroll") &&
        mustRequestApproval(this.ctx.principal);
      const approvalWarning = keepApprovals
        ? `Automation "${rule.name}" is imported with require_approval on, so each enrollment it makes waits for approval: only a person with the approve scope can turn it off (manage_automations action update, require_approval false).`
        : null;
      const input = parseInput(automationsCreate.input, {
        name: rule.name,
        filters: { ...filters, ...(filterList ? { list_id: filterList.id } : {}) },
        actions,
        require_approval: keepApprovals ? true : rule.require_approval,
        enabled: hookWarning ? false : rule.enabled,
      });
      if (!input.ok) {
        this.skip("automation", rule.name, input.reason);
        continue;
      }
      taken.add(nameKey(rule.name));
      if (this.dryRun) {
        this.created("automation", rule.name, null);
        if (hookWarning) this.result.warnings.push(hookWarning);
        if (approvalWarning) this.result.warnings.push(approvalWarning);
        continue;
      }
      try {
        const view = (await automationsCreate.handler(this.ctx, input.data)) as { id: string };
        this.created("automation", rule.name, view.id);
        if (hookWarning) this.result.warnings.push(hookWarning);
        if (approvalWarning) this.result.warnings.push(approvalWarning);
      } catch (error) {
        this.skip("automation", rule.name, messageOf(error));
      }
    }
  }

  async templates(list: SetupTemplate[]): Promise<void> {
    const rows = await this.ctx.db
      .select({ name: templates.name })
      .from(templates)
      .where(and(eq(templates.workspace_id, this.workspaceId), eq(templates.kind, "campaign")));
    const taken = new Set(rows.map((row) => nameKey(row.name)));
    for (const template of list) {
      if (taken.has(nameKey(template.name))) {
        this.skip("campaign_template", template.name, "a template with this name already exists");
        continue;
      }
      taken.add(nameKey(template.name));
      const { content, webhooks } = templateContent(template);
      const hookWarning = templateWebhookWarning(template.name, webhooks);
      if (this.dryRun) {
        this.created("campaign_template", template.name, null);
        if (hookWarning) this.result.warnings.push(hookWarning);
        continue;
      }
      const [row] = await this.ctx.db
        .insert(templates)
        .values({
          workspace_id: this.workspaceId,
          kind: "campaign",
          name: template.name,
          description: template.description,
          content,
        })
        .returning({ id: templates.id });
      this.created("campaign_template", template.name, row?.id ?? null);
      if (hookWarning) this.result.warnings.push(hookWarning);
    }
  }
}

/** Top-level keys of a setup file that this engine does not read. */
export function unknownSections(raw: unknown): string[] {
  if (!isPlain(raw)) return [];
  const known = new Set(Object.keys(setupDocumentSchema.shape));
  return Object.keys(raw)
    .filter((key) => !known.has(key))
    .sort();
}

/** Imports (or, with dryRun, plans) a parsed setup into the context's workspace. */
export async function importSetup(
  ctx: OpContext,
  setup: SetupDocument,
  options: { dryRun: boolean; unknownSections?: string[] },
): Promise<ImportSetupResult> {
  const workspace = requireWorkspace(ctx);
  const importer = new SetupImporter(ctx, workspace.id, options.dryRun);
  if (options.unknownSections?.length) {
    importer.result.warnings.push(
      `Ignored sections: ${options.unknownSections.join(", ")} (a setup never carries leads, messages, mailboxes, accounts, providers or credentials).`,
    );
  }
  await importer.settings(setup.settings);
  await importer.knowledge(setup.knowledge, "knowledge");
  await importer.knowledge(setup.lessons, "lesson");
  await importer.offers(setup);
  await importer.icps(setup);
  const signalKeys = await importer.signals(setup);
  await importer.automations(setup.automations, signalKeys);
  await importer.templates(setup.campaign_templates);
  return importer.result;
}
