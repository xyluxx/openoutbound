/**
 * `knowledge.bootstrap` job: crawl up to 8 pages of the user's own website, one brain call to
 * draft the knowledge base, then save items and offers as suggestions. Idempotent per website:
 * re-running updates the pending suggestions of that site and never duplicates them.
 */
import { and, arrayContains, eq, inArray } from "drizzle-orm";
import type { JobContext } from "../../core/context.js";
import type { KnowledgeKind } from "../../core/enums.js";
import { OpenOutboundError } from "../../core/errors.js";
import { parseWorkspaceSettings } from "../../core/settings.js";
import { type KnowledgeItem, knowledge_items, type Offer, offers } from "../../db/schema/index.js";
import { resolveSeniority, type Seniority } from "../leads/service.js";
import { BOOTSTRAP_PLAN, type CrawlResult, crawlSite, MAX_CRAWL_PAGES } from "./crawl.js";
import { dedupeTags } from "./items.js";
import { type BootstrapOutput, bootstrapPrompt } from "./prompts/bootstrap.js";
import { BUILTIN_SIGNALS, toSignalKey } from "./signal-catalog.js";
import { cleanTitle, normalizeKey, truncate } from "./text.js";

export interface BootstrapPayload {
  website: string;
  max_pages?: number;
}

/**
 * An ICP in the exact shape of manage_icp action create input (criteria field names, the
 * seniority vocabulary and every limit), so an agent can pass it as is.
 */
export interface IcpSuggestion {
  name: string;
  description: string;
  criteria: {
    industries: string[];
    keywords: string[];
    /** Left out when the site names no size. */
    employee_range?: { min?: number; max?: number };
    countries: string[];
    regions: string[];
    titles: string[];
    seniorities: Seniority[];
    departments: string[];
    technologies: string[];
    exclude: { industries: string[]; keywords: string[]; titles: string[] };
  };
  signal_keys: string[];
}

export interface SignalSuggestion {
  key: string;
  kind: "builtin" | "custom";
  name: string;
  why: string;
  /** Custom signals only: the rule in plain English, for manage_signals define_custom. */
  custom_rule: string | null;
}

export interface WriteCounts {
  created: number;
  updated: number;
  unchanged: number;
  already_known: number;
  archived: number;
  ids: string[];
}

export interface BootstrapSummary {
  website: string;
  domain: string;
  company_name: string | null;
  pages: Array<{ url: string; category: string; title: string | null }>;
  skipped: Array<{ url: string; reason: string; status?: number }>;
  items: WriteCounts;
  offers: WriteCounts;
  icp_suggestions: IcpSuggestion[];
  signal_suggestions: SignalSuggestion[];
  next_steps: string[];
}

const LIMITS = { products: 6, proof: 8, objections: 6, notes: 6, samples: 3, offers: 3, icps: 2 };
const MAX_SIGNALS = 10;

/** The tag that marks items suggested by a bootstrap of this domain. */
export function bootstrapTag(domain: string): string {
  return `bootstrap:${domain}`;
}

interface ItemSuggestion {
  kind: KnowledgeKind;
  title: string;
  body: string;
  sourceUrl: string;
}

export async function runBootstrap(
  ctx: JobContext,
  payload: BootstrapPayload,
): Promise<BootstrapSummary> {
  const workspace = ctx.workspace;
  if (!workspace) throw new Error("knowledge.bootstrap: job has no workspace");
  const settings = parseWorkspaceSettings(workspace.settings);

  await ctx.setProgress({ stage: "crawling", message: `Reading ${payload.website}` });
  const crawl = await crawlSite(ctx, payload.website, {
    maxPages: Math.min(payload.max_pages ?? MAX_CRAWL_PAGES, MAX_CRAWL_PAGES),
    plan: BOOTSTRAP_PLAN,
    maxCharsPerPage: 6_000,
  });
  if (crawl.pages.length === 0) {
    const reason = crawl.skipped[0]?.reason ?? "fetch_failed";
    throw new OpenOutboundError(
      reason === "robots_disallowed" ? "forbidden" : "provider_error",
      `Could not read ${crawl.homeUrl} (${reason}).`,
      {
        hint:
          reason === "robots_disallowed"
            ? "The site's robots.txt blocks crawlers. Add knowledge with manage_knowledge action ingest (markdown or text) instead."
            : "Check the address and that the site is public, or ingest content with manage_knowledge action ingest.",
        details: { reason },
      },
    );
  }

  await ctx.setProgress({
    stage: "drafting",
    message: `Drafting from ${crawl.pages.length} pages`,
    done: crawl.pages.length,
    total: crawl.pages.length,
  });
  const { output } = await ctx.brain.run(
    bootstrapPrompt,
    {
      domain: crawl.domain,
      language: settings.ai.language,
      pages: crawl.pages.map((page) => ({
        url: page.url,
        category: page.category,
        title: page.title,
        text: page.text,
      })),
    },
    // One agent task per run (retries of this job resume it; a later run drafts afresh).
    { jobId: ctx.job.id, taskKey: `knowledge.bootstrap:${ctx.job.id}` },
  );

  await ctx.setProgress({ stage: "saving", message: "Saving suggestions" });
  const suggestions = itemSuggestions(output, crawl);
  const tag = bootstrapTag(crawl.domain);
  const items = await saveItemSuggestions(ctx, workspace.id, tag, suggestions);
  const offerCounts = await saveOfferSuggestions(ctx, workspace.id, output, items.byTitle);

  const icpSuggestions = output.icp_suggestions.slice(0, LIMITS.icps).map(cleanIcp);
  const signalSuggestions = cleanSignals(output.signal_suggestions);
  return {
    website: crawl.homeUrl,
    domain: crawl.domain,
    company_name: output.company_name?.trim() || null,
    pages: crawl.pages.map((page) => ({
      url: page.url,
      category: page.category,
      title: page.title,
    })),
    skipped: crawl.skipped,
    items: items.counts,
    offers: offerCounts,
    icp_suggestions: icpSuggestions,
    signal_suggestions: signalSuggestions,
    next_steps: [
      "Review the suggestions: manage_knowledge action list with status suggested, and list_offers with status suggested.",
      "Approve the good ones: manage_knowledge action approve_suggestions with item_ids and offer_ids; remove the rest.",
      "Create the ICP by passing an icp_suggestions entry as is to manage_icp action create, and enable signal_suggestions with manage_signals.",
      "Set the company name and website in workspace settings (settings.company) if they are empty.",
    ],
  };
}

function itemSuggestions(output: BootstrapOutput, crawl: CrawlResult): ItemSuggestion[] {
  const pageUrls = new Map(crawl.pages.map((page) => [urlKey(page.url), page.url]));
  const source = (url: string | null | undefined) =>
    (url && pageUrls.get(urlKey(url))) ?? crawl.homeUrl;
  const out: ItemSuggestion[] = [];
  const push = (kind: KnowledgeKind, title: string, body: string, url: string | null) => {
    const cleanBody = body.trim();
    if (!cleanBody || !title.trim()) return;
    out.push({ kind, title: cleanTitle(title), body: cleanBody, sourceUrl: source(url) });
  };
  if (output.about) push("about", output.about.title, output.about.body, output.about.source_url);
  for (const item of output.products.slice(0, LIMITS.products)) {
    push("product", item.title, item.body, item.source_url);
  }
  for (const item of output.proof.slice(0, LIMITS.proof)) {
    push(item.kind, item.title, item.body, item.source_url);
  }
  for (const objection of output.objections.slice(0, LIMITS.objections)) {
    push("objection", objection.objection, objection.answer, objection.source_url);
  }
  const notes = output.voice.notes.map((note) => note.trim()).filter(Boolean);
  if (notes.length > 0) {
    push(
      "voice_sample",
      "Tone notes (website)",
      notes
        .slice(0, LIMITS.notes)
        .map((note) => `- ${note}`)
        .join("\n"),
      null,
    );
  }
  output.voice.samples
    .map((sample) => sample.trim())
    .filter(Boolean)
    .slice(0, LIMITS.samples)
    .forEach((sample, index) => {
      push("voice_sample", `Website voice sample ${index + 1}`, truncate(sample, 600), null);
    });
  return out;
}

/**
 * Saves item suggestions: an active item with the same kind and title means the fact is
 * already known (skipped); a pending suggestion of this site with the same kind and title is
 * updated; anything else is inserted as suggested. Pending suggestions of this site that the
 * new run did not produce are archived.
 */
async function saveItemSuggestions(
  ctx: JobContext,
  workspaceId: string,
  tag: string,
  suggestions: ItemSuggestion[],
): Promise<{ counts: WriteCounts; byTitle: Map<string, string> }> {
  const counts: WriteCounts = {
    created: 0,
    updated: 0,
    unchanged: 0,
    already_known: 0,
    archived: 0,
    ids: [],
  };
  const byTitle = new Map<string, string>();
  const kinds = [...new Set(suggestions.map((s) => s.kind))];
  const existing =
    kinds.length === 0
      ? []
      : await ctx.db
          .select()
          .from(knowledge_items)
          .where(
            and(
              eq(knowledge_items.workspace_id, workspaceId),
              inArray(knowledge_items.status, ["active", "suggested"]),
            ),
          );
  const activeByKey = new Map<string, KnowledgeItem>();
  const pendingByKey = new Map<string, KnowledgeItem>();
  for (const item of existing) {
    const itemKey = `${item.kind}|${normalizeKey(item.title)}`;
    if (item.status === "active") activeByKey.set(itemKey, item);
    else if (item.tags.includes(tag)) pendingByKey.set(itemKey, item);
  }

  const touched = new Set<string>();
  for (const suggestion of suggestions) {
    const itemKey = `${suggestion.kind}|${normalizeKey(suggestion.title)}`;
    if (touched.has(itemKey)) continue;
    touched.add(itemKey);
    const active = activeByKey.get(itemKey);
    if (active) {
      counts.already_known++;
      byTitle.set(normalizeKey(suggestion.title), active.id);
      continue;
    }
    const pending = pendingByKey.get(itemKey);
    if (pending) {
      byTitle.set(normalizeKey(suggestion.title), pending.id);
      counts.ids.push(pending.id);
      if (pending.body === suggestion.body && pending.source_ref === suggestion.sourceUrl) {
        counts.unchanged++;
        continue;
      }
      await ctx.db
        .update(knowledge_items)
        .set({ title: suggestion.title, body: suggestion.body, source_ref: suggestion.sourceUrl })
        .where(eq(knowledge_items.id, pending.id));
      counts.updated++;
      continue;
    }
    const [created] = await ctx.db
      .insert(knowledge_items)
      .values({
        workspace_id: workspaceId,
        kind: suggestion.kind,
        title: suggestion.title,
        body: suggestion.body,
        status: "suggested",
        source_type: "ai",
        source_ref: suggestion.sourceUrl,
        tags: dedupeTags(["bootstrap", tag]),
      })
      .returning({ id: knowledge_items.id });
    if (created) {
      counts.created++;
      counts.ids.push(created.id);
      byTitle.set(normalizeKey(suggestion.title), created.id);
    }
  }

  const stale = [...pendingByKey.entries()]
    .filter(([itemKey]) => !touched.has(itemKey))
    .map(([, item]) => item.id);
  if (stale.length > 0) {
    await ctx.db
      .update(knowledge_items)
      .set({ status: "archived" })
      .where(
        and(
          eq(knowledge_items.workspace_id, workspaceId),
          inArray(knowledge_items.id, stale),
          arrayContains(knowledge_items.tags, [tag]),
        ),
      );
    counts.archived = stale.length;
  }
  return { counts, byTitle };
}

/** Same rules as items, matching offers by normalized name. */
async function saveOfferSuggestions(
  ctx: JobContext,
  workspaceId: string,
  output: BootstrapOutput,
  proofByTitle: Map<string, string>,
): Promise<WriteCounts> {
  const counts: WriteCounts = {
    created: 0,
    updated: 0,
    unchanged: 0,
    already_known: 0,
    archived: 0,
    ids: [],
  };
  const existing: Offer[] = await ctx.db
    .select()
    .from(offers)
    .where(eq(offers.workspace_id, workspaceId));
  const activeByName = new Map<string, Offer>();
  const pendingByName = new Map<string, Offer>();
  for (const offer of existing) {
    const nameKey = normalizeKey(offer.name);
    if (offer.suggested) pendingByName.set(nameKey, offer);
    else if (offer.status === "active") activeByName.set(nameKey, offer);
  }

  const touched = new Set<string>();
  for (const draft of output.offers.slice(0, LIMITS.offers)) {
    const name = cleanTitle(draft.name);
    const nameKey = normalizeKey(name);
    if (!nameKey || touched.has(nameKey)) continue;
    touched.add(nameKey);
    if (activeByName.has(nameKey)) {
      counts.already_known++;
      continue;
    }
    const proofIds = [
      ...new Set(
        draft.proof_titles
          .map((title) => proofByTitle.get(normalizeKey(title)))
          .filter((id): id is string => id !== undefined),
      ),
    ];
    const values = {
      name,
      summary: draft.summary.trim(),
      details: draft.details.trim(),
      value_props: draft.value_props
        .map((prop) => prop.trim())
        .filter(Boolean)
        .slice(0, 6),
      proof_item_ids: proofIds,
      cta: draft.cta?.trim() || null,
    };
    const pending = pendingByName.get(nameKey);
    if (pending) {
      counts.ids.push(pending.id);
      const same =
        pending.summary === values.summary &&
        pending.details === values.details &&
        pending.cta === values.cta &&
        JSON.stringify(pending.value_props) === JSON.stringify(values.value_props) &&
        JSON.stringify(pending.proof_item_ids) === JSON.stringify(values.proof_item_ids);
      if (same) {
        counts.unchanged++;
        continue;
      }
      await ctx.db.update(offers).set(values).where(eq(offers.id, pending.id));
      counts.updated++;
      continue;
    }
    const [created] = await ctx.db
      .insert(offers)
      .values({
        workspace_id: workspaceId,
        ...values,
        status: "archived",
        suggested: true,
        is_default: false,
      })
      .returning({ id: offers.id });
    if (created) {
      counts.created++;
      counts.ids.push(created.id);
    }
  }

  const stale = [...pendingByName.entries()]
    .filter(([nameKey]) => !touched.has(nameKey))
    .map(([, offer]) => offer.id);
  if (stale.length > 0) {
    await ctx.db
      .update(offers)
      .set({ suggested: false, status: "archived" })
      .where(and(eq(offers.workspace_id, workspaceId), inArray(offers.id, stale)));
    counts.archived = stale.length;
  }
  return counts;
}

/** Limits of manage_icp action create (icps.create input). */
const ICP_LIMITS = { name: 120, description: 1000, term: 100 };

/** Trimmed, deduplicated (case-insensitive) values of at most `ICP_LIMITS.term` characters. */
function cleanList(values: string[], max = 20): string[] {
  const out: string[] = [];
  for (const value of values) {
    const clean = value.replace(/\s+/g, " ").trim();
    if (clean.length > ICP_LIMITS.term) continue;
    if (clean && !out.some((existing) => existing.toLowerCase() === clean.toLowerCase())) {
      out.push(clean);
    }
    if (out.length >= max) break;
  }
  return out;
}

/** Free-form decision levels ("VP", "C-level", "Head") in manage_icp's vocabulary; others dropped. */
function cleanSeniorities(values: string[]): Seniority[] {
  const out: Seniority[] = [];
  for (const value of values) {
    const level = resolveSeniority(value, value);
    if (level && !out.includes(level)) out.push(level);
  }
  return out;
}

function cleanIcp(icp: BootstrapOutput["icp_suggestions"][number]): IcpSuggestion {
  const criteria = icp.criteria;
  const range: { min?: number; max?: number } = {};
  if (criteria.employee_range.min !== null && criteria.employee_range.min >= 0) {
    range.min = criteria.employee_range.min;
  }
  if (criteria.employee_range.max !== null && criteria.employee_range.max > 0) {
    range.max = criteria.employee_range.max;
  }
  if (range.min !== undefined && range.max !== undefined && range.min > range.max) {
    delete range.max;
  }
  const description = icp.description.trim();
  return {
    name: truncate(cleanTitle(icp.name, "Suggested ICP"), ICP_LIMITS.name),
    description:
      description.length > ICP_LIMITS.description
        ? truncate(description, ICP_LIMITS.description)
        : description,
    criteria: {
      industries: cleanList(criteria.industries),
      keywords: cleanList(criteria.keywords),
      // An empty range would still count toward the score, so it is left out.
      ...(range.min !== undefined || range.max !== undefined ? { employee_range: range } : {}),
      countries: cleanList(criteria.countries.map((code) => code.trim().toUpperCase())).filter(
        (code) => /^[A-Z]{2}$/.test(code),
      ),
      regions: cleanList(criteria.regions),
      titles: cleanList(criteria.titles),
      seniorities: cleanSeniorities(criteria.seniorities),
      departments: cleanList(criteria.departments),
      technologies: cleanList(criteria.technologies),
      exclude: {
        industries: cleanList(criteria.exclusions.industries),
        keywords: cleanList(criteria.exclusions.keywords),
        titles: cleanList(criteria.exclusions.titles),
      },
    },
    signal_keys: cleanList(icp.signal_keys.map(toSignalKey)).filter(Boolean),
  };
}

function cleanSignals(signals: BootstrapOutput["signal_suggestions"]): SignalSuggestion[] {
  const out: SignalSuggestion[] = [];
  for (const signal of signals) {
    const key = toSignalKey(signal.key || signal.name);
    if (!key || out.some((existing) => existing.key === key)) continue;
    const builtin = key in BUILTIN_SIGNALS;
    out.push({
      key,
      kind: builtin ? "builtin" : "custom",
      name: signal.name.trim() || key,
      why: signal.why.trim(),
      custom_rule: builtin ? null : signal.custom_rule?.trim() || signal.why.trim() || null,
    });
    if (out.length >= MAX_SIGNALS) break;
  }
  return out;
}

function urlKey(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.replace(/^www\./, "")}${parsed.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}
