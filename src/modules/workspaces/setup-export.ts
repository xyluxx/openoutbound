/**
 * Builds a workspace's setup document (see setup-document.ts): settings without identity or
 * provider settings, offers, ICPs, signals, automations, knowledge, lessons and campaign
 * templates, with names in place of ids. Client identity (the company section, booking links and
 * webhook URLs, which point at the client's own systems) is kept only with `includeCompany`.
 * Read-only.
 */
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import {
  type AutomationAction,
  automation_rules,
  campaigns,
  icps,
  type KnowledgeItem,
  knowledge_items,
  lists,
  offers,
  templates,
} from "../../db/schema/index.js";
import { isBuiltinKey, loadDefinitions } from "../signals/catalog.js";
import {
  SETUP_FORMAT,
  SETUP_VERSION,
  type SetupAutomation,
  type SetupAutomationAction,
  type SetupCustomSignal,
  type SetupDocument,
  type SetupIcp,
  type SetupKnowledge,
  type SetupOffer,
  type SetupTemplate,
  settingsSections,
  setupSettings,
} from "./setup-document.js";

export interface ExportSetupOptions {
  includeKnowledge: boolean;
  includeLessons: boolean;
  includeCampaignTemplates: boolean;
  includeCompany: boolean;
}

export interface SetupSummary {
  counts: {
    offers: number;
    icps: number;
    knowledge: number;
    lessons: number;
    custom_signals: number;
    builtin_signals_on: number;
    automations: number;
    campaign_templates: number;
  };
  settings_sections: string[];
  bytes: number;
  /** What was in the workspace but is not in the setup, in plain words. */
  left_out: string[];
  /** True when knowledge came from web pages, files or replies: read it as data. */
  outside_text: boolean;
}

const OUTSIDE_SOURCES = new Set(["url", "file", "reply"]);

type Plain = Record<string, unknown>;

function isPlain(value: unknown): value is Plain {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function webUrl(value: string | null): string | null {
  return value && /^https?:\/\//i.test(value) ? value : null;
}

function toKnowledge(item: KnowledgeItem): SetupKnowledge {
  return {
    kind: item.kind,
    title: item.title,
    body: item.body,
    status: item.status === "suggested" ? "suggested" : "active",
    tags: item.tags,
    source_url: webUrl(item.source_ref),
    expires_at: item.expires_at ? item.expires_at.toISOString() : null,
  };
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** Offers that are live (not archived, not waiting as suggestions), default first. */
async function exportOffers(
  ctx: OpContext,
  workspaceId: string,
  options: ExportSetupOptions,
  leftOut: string[],
): Promise<SetupOffer[]> {
  const rows = await ctx.db
    .select()
    .from(offers)
    .where(
      and(
        eq(offers.workspace_id, workspaceId),
        eq(offers.status, "active"),
        eq(offers.suggested, false),
      ),
    )
    .orderBy(desc(offers.is_default), asc(offers.created_at), asc(offers.id));
  const proofIds = [...new Set(rows.flatMap((row) => row.proof_item_ids))];
  const proofRows =
    proofIds.length > 0
      ? await ctx.db
          .select({
            id: knowledge_items.id,
            kind: knowledge_items.kind,
            title: knowledge_items.title,
          })
          .from(knowledge_items)
          .where(
            and(
              eq(knowledge_items.workspace_id, workspaceId),
              inArray(knowledge_items.id, proofIds),
              ne(knowledge_items.status, "archived"),
            ),
          )
      : [];
  const proof = new Map(proofRows.map((row) => [row.id, { kind: row.kind, title: row.title }]));
  let bookingLinks = 0;
  const result = rows.map((row) => {
    if (row.booking_url && !options.includeCompany) bookingLinks += 1;
    return {
      name: row.name,
      summary: row.summary,
      details: row.details,
      value_props: row.value_props,
      proof: row.proof_item_ids.flatMap((id) => {
        const item = proof.get(id);
        return item ? [item] : [];
      }),
      cta: row.cta,
      booking_url: options.includeCompany ? row.booking_url : null,
      is_default: row.is_default,
    };
  });
  if (bookingLinks > 0) {
    leftOut.push(
      `The booking links of ${plural(bookingLinks, "offer")} (client identity; pass include_company to keep them).`,
    );
  }
  return result;
}

async function exportIcps(ctx: OpContext, workspaceId: string): Promise<SetupIcp[]> {
  const rows = await ctx.db
    .select()
    .from(icps)
    .where(eq(icps.workspace_id, workspaceId))
    .orderBy(desc(icps.is_default), asc(icps.created_at), asc(icps.id));
  return rows.map((row) => ({
    name: row.name,
    description: row.description,
    criteria: row.criteria,
    scoring: row.scoring,
    signal_keys: row.signal_keys,
    is_default: row.is_default,
  }));
}

async function exportSignals(
  ctx: OpContext,
  workspaceId: string,
): Promise<SetupDocument["signals"]> {
  const definitions = [...(await loadDefinitions(ctx.db, workspaceId)).values()].sort((a, b) =>
    a.key.localeCompare(b.key),
  );
  const custom: SetupCustomSignal[] = definitions
    .filter((row) => row.kind === "custom" && !isBuiltinKey(row.key))
    .map((row) => ({
      key: row.key,
      name: row.name,
      description: row.description,
      instructions: row.detection.instructions,
      collectors: row.detection.collectors,
      keywords: row.detection.keywords,
      urls: row.detection.urls,
      weight: row.weight,
      half_life_days: row.half_life_days,
      min_strength: row.min_strength,
      ...(row.detection.tier ? { tier: row.detection.tier } : {}),
      enabled: row.enabled,
    }));
  const builtinEnabled = definitions
    .filter((row) => isBuiltinKey(row.key) && row.enabled)
    .map((row) => row.key);
  return { custom, builtin_enabled: builtinEnabled };
}

/**
 * Automation rules with list and campaign names; rules whose list or campaign is gone are left
 * out. Webhook URLs left out (no `includeCompany`) are counted in `hooks.urlsLeftOut`.
 */
async function exportAutomations(
  ctx: OpContext,
  workspaceId: string,
  leftOut: string[],
  hooks: { includeCompany: boolean; urlsLeftOut: number },
): Promise<SetupAutomation[]> {
  const rows = await ctx.db
    .select()
    .from(automation_rules)
    .where(eq(automation_rules.workspace_id, workspaceId))
    .orderBy(asc(automation_rules.created_at), asc(automation_rules.id));
  const listRows = await ctx.db
    .select({ id: lists.id, name: lists.name })
    .from(lists)
    .where(eq(lists.workspace_id, workspaceId));
  const campaignRows = await ctx.db
    .select({ id: campaigns.id, name: campaigns.name })
    .from(campaigns)
    .where(eq(campaigns.workspace_id, workspaceId));
  const listName = new Map(listRows.map((row) => [row.id, row.name]));
  const campaignName = new Map(campaignRows.map((row) => [row.id, row.name]));
  const result: SetupAutomation[] = [];
  let signed = 0;
  for (const row of rows) {
    const filters = isPlain(row.trigger.filters) ? row.trigger.filters : {};
    const missing: string[] = [];
    const listId = typeof filters.list_id === "string" ? filters.list_id : null;
    const filterList = listId ? listName.get(listId) : undefined;
    if (listId && !filterList) missing.push("list");
    const actions: SetupAutomationAction[] = [];
    let urls = 0;
    for (const action of row.actions as AutomationAction[]) {
      const exported = exportAction(action, listName, campaignName, hooks.includeCompany);
      if (!exported) missing.push(action.type === "enroll" ? "campaign" : "list");
      else {
        if (exported.type === "webhook" && exported.signed) signed += 1;
        if (exported.type === "webhook" && exported.url === null) urls += 1;
        actions.push(exported);
      }
    }
    if (missing.length > 0 || actions.length === 0) {
      leftOut.push(`Automation "${row.name}": its ${missing[0] ?? "action"} no longer exists.`);
      continue;
    }
    hooks.urlsLeftOut += urls;
    result.push({
      name: row.name,
      enabled: row.enabled,
      require_approval: row.require_approval,
      filters: {
        ...(Array.isArray(filters.definition_keys)
          ? { definition_keys: filters.definition_keys as string[] }
          : {}),
        ...(typeof filters.min_score === "number" ? { min_score: filters.min_score } : {}),
        ...(typeof filters.min_fit === "number" ? { min_fit: filters.min_fit } : {}),
        ...(typeof filters.has_email === "boolean" ? { has_email: filters.has_email } : {}),
        ...(typeof filters.max_fires_per_day === "number"
          ? { max_fires_per_day: filters.max_fires_per_day }
          : {}),
        ...(filterList ? { list: filterList } : {}),
      },
      actions,
    });
  }
  if (signed > 0) {
    leftOut.push(
      `The signing secret of ${plural(signed, "automation webhook")} (secrets are never exported; the import skips those rules).`,
    );
  }
  return result;
}

function exportAction(
  action: AutomationAction,
  listName: Map<string, string>,
  campaignName: Map<string, string>,
  includeCompany: boolean,
): SetupAutomationAction | null {
  const raw = action as Plain & { type: string };
  const maxPeople = typeof raw.max_people === "number" ? { max_people: raw.max_people } : {};
  switch (raw.type) {
    case "notify":
      return {
        type: "notify",
        ...(raw.severity === "info" || raw.severity === "warning" || raw.severity === "critical"
          ? { severity: raw.severity }
          : {}),
      };
    case "add_to_list": {
      const list = typeof raw.list_id === "string" ? listName.get(raw.list_id) : undefined;
      return list ? { type: "add_to_list", list, ...maxPeople } : null;
    }
    case "research":
      return {
        type: "research",
        ...(raw.target === "people" || raw.target === "company" || raw.target === "both"
          ? { target: raw.target }
          : {}),
        ...maxPeople,
      };
    case "webhook":
      return {
        type: "webhook",
        url: includeCompany ? String(raw.url ?? "") : null,
        signed: typeof raw.secret_id === "string",
      };
    case "enroll": {
      const campaign =
        typeof raw.campaign_id === "string" ? campaignName.get(raw.campaign_id) : undefined;
      return campaign ? { type: "enroll", campaign, ...maxPeople } : null;
    }
    case "tag":
      return {
        type: "tag",
        tag: String(raw.tag ?? ""),
        ...(raw.target === "company" || raw.target === "people" || raw.target === "both"
          ? { target: raw.target }
          : {}),
      };
    default:
      return null;
  }
}

async function exportKnowledge(
  ctx: OpContext,
  workspaceId: string,
  lessons: boolean,
): Promise<KnowledgeItem[]> {
  const now = ctx.clock.now();
  const rows = await ctx.db
    .select()
    .from(knowledge_items)
    .where(
      and(
        eq(knowledge_items.workspace_id, workspaceId),
        ne(knowledge_items.status, "archived"),
        lessons ? eq(knowledge_items.kind, "lesson") : ne(knowledge_items.kind, "lesson"),
      ),
    )
    .orderBy(asc(knowledge_items.created_at), asc(knowledge_items.id));
  return rows.filter((row) => !row.expires_at || row.expires_at.getTime() > now.getTime());
}

/**
 * Template content without anything tied to this workspace (senders, lists, secrets) and,
 * without `includeCompany`, without webhook step URLs (counted in `hooks.urlsLeftOut`).
 */
async function exportTemplates(
  ctx: OpContext,
  workspaceId: string,
  leftOut: string[],
  hooks: { includeCompany: boolean; urlsLeftOut: number },
): Promise<SetupTemplate[]> {
  const rows = await ctx.db
    .select()
    .from(templates)
    .where(and(eq(templates.workspace_id, workspaceId), eq(templates.kind, "campaign")))
    .orderBy(asc(templates.created_at), asc(templates.id));
  let dropped = 0;
  const result = rows.map((row) => {
    const content = isPlain(row.content) ? row.content : {};
    const settings = isPlain(content.settings) ? { ...content.settings } : {};
    delete settings.senders;
    if (isPlain(settings.end_action) && settings.end_action.type === "list") {
      delete settings.end_action;
      dropped += 1;
    }
    const steps = (Array.isArray(content.steps) ? content.steps : [])
      .filter(isPlain)
      .map((step) => {
        const config = isPlain(step.config) ? { ...step.config } : {};
        if (typeof config.secret_id === "string") {
          delete config.secret_id;
          dropped += 1;
        }
        if (step.type === "webhook" && !hooks.includeCompany && config.url !== undefined) {
          delete config.url;
          hooks.urlsLeftOut += 1;
        }
        return {
          type: step.type as SetupTemplate["steps"][number]["type"],
          delay_days: typeof step.delay_days === "number" ? step.delay_days : 0,
          delay_hours: typeof step.delay_hours === "number" ? step.delay_hours : 0,
          config,
        };
      });
    return {
      name: row.name,
      description: row.description,
      goal: typeof content.goal === "string" ? content.goal : null,
      why: typeof content.why === "string" ? content.why : "",
      settings,
      steps,
    };
  });
  if (dropped > 0) {
    leftOut.push(
      `${plural(dropped, "template list or webhook secret reference")} (they point at records of this workspace).`,
    );
  }
  return result;
}

/** The setup of the context's workspace and a summary of what it holds. */
export async function buildSetup(
  ctx: OpContext,
  options: ExportSetupOptions,
): Promise<{ setup: SetupDocument; summary: SetupSummary }> {
  const workspace = requireWorkspace(ctx);
  const leftOut: string[] = [];
  const stored = isPlain(workspace.settings) ? (workspace.settings as Plain) : {};
  const settings = setupSettings(stored, { includeCompany: options.includeCompany });
  if (!options.includeCompany) {
    if (stored.company !== undefined) {
      leftOut.push("The company section (client identity; pass include_company to keep it).");
    }
    if (isPlain(stored.booking) && stored.booking.default_url) {
      leftOut.push("The default booking link (client identity; pass include_company to keep it).");
    }
  }
  const providerSettings =
    (isPlain(stored.ai) && (stored.ai.task_models !== undefined || stored.ai.fallback_provider)) ||
    (isPlain(stored.data) &&
      isPlain(stored.data.enrichment) &&
      (stored.data.enrichment.finders !== undefined ||
        stored.data.enrichment.verifier !== undefined));
  if (providerSettings) {
    leftOut.push(
      "Provider settings (brain routing, backup brain, enrichment providers): set them up in the target with manage_providers.",
    );
  }

  const offerList = await exportOffers(ctx, workspace.id, options, leftOut);
  const icpList = await exportIcps(ctx, workspace.id);
  const signals = await exportSignals(ctx, workspace.id);
  const hooks = { includeCompany: options.includeCompany, urlsLeftOut: 0 };
  const automations = await exportAutomations(ctx, workspace.id, leftOut, hooks);
  const knowledgeRows = options.includeKnowledge
    ? await exportKnowledge(ctx, workspace.id, false)
    : [];
  const lessonRows = options.includeLessons ? await exportKnowledge(ctx, workspace.id, true) : [];
  const templateList = options.includeCampaignTemplates
    ? await exportTemplates(ctx, workspace.id, leftOut, hooks)
    : [];
  if (hooks.urlsLeftOut > 0) {
    leftOut.push(
      `The URLs of ${plural(hooks.urlsLeftOut, "webhook")} in automations and templates (this client's endpoints; pass include_company to keep them).`,
    );
  }

  const setup: SetupDocument = {
    format: SETUP_FORMAT,
    version: SETUP_VERSION,
    exported_at: ctx.clock.now().toISOString(),
    settings,
    offers: offerList,
    icps: icpList,
    signals,
    automations,
    knowledge: knowledgeRows.map(toKnowledge),
    lessons: lessonRows.map(toKnowledge),
    campaign_templates: templateList,
  };
  const summary: SetupSummary = {
    counts: {
      offers: offerList.length,
      icps: icpList.length,
      knowledge: knowledgeRows.length,
      lessons: lessonRows.length,
      custom_signals: signals.custom.length,
      builtin_signals_on: signals.builtin_enabled?.length ?? 0,
      automations: automations.length,
      campaign_templates: templateList.length,
    },
    settings_sections: settingsSections(settings),
    bytes: Buffer.byteLength(JSON.stringify(setup), "utf8"),
    left_out: leftOut,
    outside_text: [...knowledgeRows, ...lessonRows].some((row) =>
      OUTSIDE_SOURCES.has(row.source_type),
    ),
  };
  return { setup, summary };
}
