/**
 * The strategy page: one compact document per workspace that every agent reads first. It
 * gathers what decides the outreach (company, offers, ICPs, signals, voice, reply rules, review,
 * booking, CRM preferences, compliance, budgets, the owner's goals and notes), the active
 * lessons and the last changes, with the workspace version. It never contains secrets.
 */
import { desc, eq, inArray } from "drizzle-orm";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import type { ChangeArea, PrincipalType, ProposalVerdict } from "../../core/enums.js";
import { parseWorkspaceSettings, type ReplyAction } from "../../core/settings.js";
import {
  type ChangeLogEntry,
  campaigns,
  change_log,
  change_proposals,
  icps,
  offers,
} from "../../db/schema/index.js";
import {
  countActiveItems,
  listActiveLessons,
  listActiveOffers,
  listRuleTitles,
} from "../knowledge/service.js";
import { listIcpSummaries } from "../leads/service.js";
import { loadDefinitions } from "../signals/service.js";
import { latestVersion, summarizeChange } from "./change-log.js";

/** Which instructions win when they disagree (strongest first). */
export const PRECEDENCE =
  "Engine protections, then workspace rules, then campaign settings, then person facts, then task instructions";

export interface RecentChange {
  version: number;
  change_id: string;
  area: ChangeArea;
  target_id: string | null;
  /** Name of the offer, ICP or campaign; null for workspace settings. */
  target_name: string | null;
  summary: string;
  actor: { type: PrincipalType; name: string } | null;
  at: Date;
  /** Verdict of the proposal behind the change, once its results are in. */
  verdict: ProposalVerdict | null;
  undone: boolean;
}

export interface StrategyPage {
  version: number;
  workspace: { id: string; name: string; timezone: string };
  company: { name: string; website: string };
  offers: Array<{
    id: string;
    name: string;
    summary: string;
    booking_url: string | null;
    is_default: boolean;
  }>;
  icps: Array<{ id: string; name: string; is_default: boolean; summary: string }>;
  signals: { enabled: string[]; custom: string[] };
  voice: {
    language: string;
    tone_notes: string;
    never_say: string[];
    voice_samples: number;
  };
  /** Reply category to action, e.g. "suppress (locked)". */
  replies: Record<string, string>;
  review: {
    default_review_level: string;
    agent_launch_requires_approval: boolean;
    agent_changes: "approve" | "auto";
    expire_days: number;
  };
  booking: Record<string, unknown>;
  crm: Record<string, unknown>;
  compliance: {
    excluded_countries: string[];
    consent_required_countries: string[];
    contact_cap_per_company: number;
    rest_days_after_campaign: number;
    privacy_response_days: number;
  };
  budgets: {
    ai: { budget_usd: number | null; used_usd: number; remaining_usd: number | null };
    data: {
      budget_credits: number | null;
      used_credits: number;
      remaining_credits: number | null;
    };
  };
  strategy: Record<string, unknown>;
  lessons: Array<{
    id: string;
    title: string;
    body: string;
    sample_size: number | null;
    expires_at: Date | null;
  }>;
  recent_changes: RecentChange[];
  precedence: string;
}

const LINE_MAX = 160;
const LESSON_BODY_MAX = 280;
const RECENT_CHANGES = 5;
const LESSONS = 10;

/** First line of a text, cut to `max` characters. */
export function oneLine(text: string | null | undefined, max = LINE_MAX): string {
  const line =
    (text ?? "")
      .split(/\r?\n/)
      .find((part) => part.trim())
      ?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 3).trimEnd()}...` : line;
}

function shorten(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3).trimEnd()}...` : flat;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function replyLabel(rule: { action: ReplyAction; locked: boolean }): string {
  return rule.locked ? `${rule.action} (locked)` : rule.action;
}

/** Names of the offers, ICPs and campaigns the changes point at. */
async function targetNames(
  ctx: OpContext,
  workspaceId: string,
  rows: ChangeLogEntry[],
): Promise<Map<string, string>> {
  const ids = (area: ChangeArea) =>
    [...new Set(rows.filter((row) => row.area === area).map((row) => row.target_id ?? ""))].filter(
      Boolean,
    );
  const names = new Map<string, string>();
  const offerIds = ids("offer");
  const icpIds = ids("icp");
  const campaignIds = ids("campaign");
  const found = await Promise.all([
    offerIds.length
      ? ctx.db
          .select({ id: offers.id, name: offers.name, workspace_id: offers.workspace_id })
          .from(offers)
          .where(inArray(offers.id, offerIds))
      : [],
    icpIds.length
      ? ctx.db
          .select({ id: icps.id, name: icps.name, workspace_id: icps.workspace_id })
          .from(icps)
          .where(inArray(icps.id, icpIds))
      : [],
    campaignIds.length
      ? ctx.db
          .select({ id: campaigns.id, name: campaigns.name, workspace_id: campaigns.workspace_id })
          .from(campaigns)
          .where(inArray(campaigns.id, campaignIds))
      : [],
  ]);
  for (const list of found) {
    for (const row of list) if (row.workspace_id === workspaceId) names.set(row.id, row.name);
  }
  return names;
}

/** Verdicts of the proposals behind the changes. */
async function verdicts(
  ctx: OpContext,
  workspaceId: string,
  rows: ChangeLogEntry[],
): Promise<Map<string, ProposalVerdict>> {
  const ids = [...new Set(rows.map((row) => row.proposal_id ?? ""))].filter(Boolean);
  if (ids.length === 0) return new Map();
  const found = await ctx.db
    .select({
      id: change_proposals.id,
      workspace_id: change_proposals.workspace_id,
      outcome: change_proposals.outcome,
    })
    .from(change_proposals)
    .where(inArray(change_proposals.id, ids));
  const out = new Map<string, ProposalVerdict>();
  for (const row of found) {
    if (row.workspace_id === workspaceId && row.outcome) out.set(row.id, row.outcome.verdict);
  }
  return out;
}

/** The last changes with target names and verdicts, newest first. */
export async function describeChanges(
  ctx: OpContext,
  workspaceId: string,
  rows: ChangeLogEntry[],
): Promise<RecentChange[]> {
  const [names, results] = await Promise.all([
    targetNames(ctx, workspaceId, rows),
    verdicts(ctx, workspaceId, rows),
  ]);
  return rows.map((row) => ({
    version: row.version,
    change_id: row.id,
    area: row.area,
    target_id: row.target_id,
    target_name: row.area === "settings" ? null : (names.get(row.target_id ?? "") ?? null),
    summary: summarizeChange(row),
    actor: row.actor ? { type: row.actor.type, name: row.actor.name } : null,
    at: row.created_at,
    verdict: row.proposal_id ? (results.get(row.proposal_id) ?? null) : null,
    undone: row.undone_at !== null,
  }));
}

/** Builds the strategy page of the context workspace. */
export async function buildStrategy(ctx: OpContext): Promise<StrategyPage> {
  const workspace = requireWorkspace(ctx);
  const settings = parseWorkspaceSettings(workspace.settings);
  const [
    version,
    activeOffers,
    icpList,
    definitions,
    neverSay,
    voiceSamples,
    lessons,
    ai,
    data,
    changes,
  ] = await Promise.all([
    latestVersion(ctx, workspace.id),
    listActiveOffers(ctx),
    listIcpSummaries(ctx),
    loadDefinitions(ctx.db, workspace.id),
    listRuleTitles(ctx),
    countActiveItems(ctx, "voice_sample"),
    listActiveLessons(ctx, { limit: LESSONS }),
    ctx.usage.budgetStatus(workspace.id, "ai"),
    ctx.usage.budgetStatus(workspace.id, "data"),
    ctx.db
      .select()
      .from(change_log)
      .where(eq(change_log.workspace_id, workspace.id))
      .orderBy(desc(change_log.version))
      .limit(RECENT_CHANGES),
  ]);
  const signalRows = [...definitions.values()].sort((a, b) => a.name.localeCompare(b.name));
  return {
    version,
    workspace: { id: workspace.id, name: workspace.name, timezone: workspace.timezone },
    company: {
      name: settings.company.name || workspace.name,
      website: settings.company.website,
    },
    offers: activeOffers.map((offer) => ({
      id: offer.id,
      name: offer.name,
      summary: oneLine(offer.summary),
      booking_url: offer.booking_url ?? settings.booking.default_url ?? null,
      is_default: offer.is_default,
    })),
    icps: icpList,
    signals: {
      enabled: signalRows
        .filter((row) => row.kind === "builtin" && row.enabled)
        .map((row) => row.name),
      custom: signalRows
        .filter((row) => row.kind === "custom")
        .map((row) => (row.enabled ? row.name : `${row.name} (off)`)),
    },
    voice: {
      language: settings.ai.language,
      tone_notes: settings.ai.tone_notes,
      never_say: neverSay,
      voice_samples: voiceSamples,
    },
    replies: Object.fromEntries(
      Object.entries(settings.replies).map(([category, rule]) => [category, replyLabel(rule)]),
    ),
    review: {
      default_review_level: settings.approvals.default_review_level,
      agent_launch_requires_approval: settings.approvals.agent_launch_requires_approval,
      agent_changes: settings.approvals.agent_changes,
      expire_days: settings.approvals.expire_days,
    },
    booking: { ...settings.booking },
    crm: { ...settings.crm },
    compliance: {
      excluded_countries: settings.compliance.excluded_countries,
      consent_required_countries: settings.compliance.consent_required_countries,
      contact_cap_per_company: settings.compliance.contact_cap_per_company,
      rest_days_after_campaign: settings.compliance.rest_days_after_campaign,
      privacy_response_days: settings.compliance.privacy_response_days,
    },
    budgets: {
      ai: {
        budget_usd: ai.budget,
        used_usd: round(ai.used),
        remaining_usd: ai.remaining === null ? null : round(ai.remaining),
      },
      data: {
        budget_credits: data.budget,
        used_credits: round(data.used),
        remaining_credits: data.remaining === null ? null : round(data.remaining),
      },
    },
    strategy: { ...settings.strategy },
    lessons: lessons.map((lesson) => ({
      id: lesson.id,
      title: lesson.title,
      body: shorten(lesson.body, LESSON_BODY_MAX),
      sample_size: lesson.sample_size ?? null,
      expires_at: lesson.expires_at ?? null,
    })),
    recent_changes: await describeChanges(ctx, workspace.id, changes),
    precedence: PRECEDENCE,
  };
}
