/**
 * Built-in signal catalog (spec 11.7). Keys, weights and half-lives come from the signals
 * playbook table (skills/openoutbound/references/playbook-signals.md). Seeded per workspace on
 * first use; workspaces can disable definitions and tune weight, half-life and min_strength.
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import {
  type NewSignalDefinition,
  type SignalDefinition,
  type SignalDetection,
  signal_definitions,
} from "../../db/schema/index.js";

/** Collectors that need no API key (spec 10). */
export const BUILTIN_COLLECTORS = [
  "website_changes",
  "job_boards",
  "news_gdelt",
  "rss",
  "tech_detect",
  "first_party",
] as const;
export type BuiltinCollector = (typeof BUILTIN_COLLECTORS)[number];

export function isBuiltinCollector(value: string): value is BuiltinCollector {
  return (BUILTIN_COLLECTORS as readonly string[]).includes(value);
}

/** Signals below this strength are stored but not scored (playbook default). */
export const DEFAULT_MIN_STRENGTH = 0.3;
/** Custom signals start conservative (playbook rule 8). */
export const DEFAULT_CUSTOM_MIN_STRENGTH = 0.5;

export interface BuiltinDefinition {
  key: string;
  name: string;
  description: string;
  weight: number;
  half_life_days: number;
  detection: SignalDetection;
}

const detection = (collectors: string[], instructions: string): SignalDetection => ({
  collectors,
  keywords: [],
  instructions,
  urls: [],
});

export const BUILTIN_DEFINITIONS: readonly BuiltinDefinition[] = [
  {
    key: "job_change",
    name: "Known contact changed jobs",
    description:
      "A person you already know (past champion, customer user, engaged prospect) started at a new company or left their old one. Typical angle: continuity, what they used before applied to the new team's first 90 days.",
    weight: 80,
    half_life_days: 60,
    detection: detection(
      ["first_party", "crustdata"],
      "Counts: a bounce or auto-reply saying the person no longer works there, or a provider showing a new current employer. Does not count: temporary absence (out of office, parental leave).",
    ),
  },
  {
    key: "new_exec_hire",
    name: "New leader in the buying function",
    description:
      "The company hired or promoted a Director, VP or C-level leader in the function you sell to. Typical angle: a short benchmark or teardown for their first 90 days.",
    weight: 60,
    half_life_days: 45,
    detection: detection(
      ["website_changes", "rss", "news_gdelt", "predictleads", "crustdata"],
      "Counts: an announcement or leadership page change naming a new Director, VP or C-level person. Does not count: individual contributors, board seats, departures only.",
    ),
  },
  {
    key: "funding_round",
    name: "Funding announced",
    description:
      "A priced round, debt facility or grant was announced or filed. Typical angle: the stated use of funds and the bottleneck it creates, never a bare congratulation.",
    weight: 45,
    half_life_days: 60,
    detection: detection(
      ["news_gdelt", "rss", "predictleads", "crustdata"],
      "Counts: a press release, filing or article stating the company raised money. Does not count: rumors, the company's investors raising a fund, customer funding.",
    ),
  },
  {
    key: "hiring_relevant_roles",
    name: "Hiring for a role you support",
    description:
      "Open roles whose title or description names the problem, tool category or team you serve. Typical angle: cover the gap until the hire lands, or help the hire ramp faster.",
    weight: 55,
    half_life_days: 30,
    detection: detection(
      ["job_boards", "predictleads", "crustdata"],
      "Counts: an open job post whose title matches the keywords of this definition (or the ICP persona functions). Does not count: recruiter or agency posts, internships.",
    ),
  },
  {
    key: "headcount_growth",
    name: "Team growing fast",
    description:
      "Headcount or a key team grew 20% or more in 6 months. Typical angle: what breaks at their new size and how peers handled it.",
    weight: 30,
    half_life_days: 90,
    detection: detection(
      ["crustdata"],
      "Counts: headcount growth of 20% or more over 6 months from a data provider, or a team page that grew by that much.",
    ),
  },
  {
    key: "tech_adopted",
    name: "Adopted a relevant tool",
    description:
      "A tool you integrate with, complement or depend on appeared on their site, DNS or job posts. Typical angle: get more from the new tool, integration or setup help.",
    weight: 40,
    half_life_days: 60,
    detection: detection(
      ["tech_detect", "predictleads"],
      "Counts: a technology from this definition's keywords newly detected. Without keywords every newly detected business tool counts at low strength.",
    ),
  },
  {
    key: "tech_removed",
    name: "Dropped a tool",
    description:
      "A tool you replace or complement disappeared on 2 checks at least 7 days apart. Typical angle: the switching window, what to check when replacing it.",
    weight: 45,
    half_life_days: 45,
    detection: detection(
      ["tech_detect"],
      "Counts: a technology missing on two checks at least 7 days apart. Does not count: a single failed fetch.",
    ),
  },
  {
    key: "website_change",
    name: "Meaningful site change",
    description:
      "A classified change to pricing, product, careers, locations or leadership pages. Typical angle: specific to the change (new pricing, new product, new market).",
    weight: 25,
    half_life_days: 21,
    detection: detection(
      ["website_changes"],
      "Counts: new or changed pricing, a new product or market, new locations, leadership changes. Does not count: typo fixes, dates, cookie banners, reordering, blog teasers.",
    ),
  },
  {
    key: "expansion_new_location",
    name: "New location or market",
    description:
      "A new office, clinic, store, country or region opened or was announced. Typical angle: what a new site needs (staff, systems, local demand).",
    weight: 50,
    half_life_days: 60,
    detection: detection(
      ["website_changes", "news_gdelt", "rss", "predictleads"],
      "Counts: a locations page that added a site, or an announcement of an opening or a new market. Does not count: events or temporary pop-ups.",
    ),
  },
  {
    key: "news_mention",
    name: "Newsworthy event",
    description:
      "Press coverage that implies change (award, partnership, launch, restructuring). Typical angle: the implication for their priorities, never the headline itself.",
    weight: 20,
    half_life_days: 14,
    detection: detection(
      ["news_gdelt", "rss", "predictleads"],
      "Counts: an article or company post about a launch, partnership, award, acquisition or restructuring. Does not count: listicles, stock tickers, unrelated companies with a similar name.",
    ),
  },
  {
    key: "leadership_content",
    name: "Leader talked about a relevant problem",
    description:
      "A decision maker wrote, spoke or posted publicly about a priority or problem you address. Typical angle: add one specific, useful point to what they said.",
    weight: 45,
    half_life_days: 21,
    detection: detection(
      ["rss"],
      "Counts: a blog post, talk or podcast by a leader of the company about a problem our offer addresses. Does not count: generic company announcements, LinkedIn scraping.",
    ),
  },
  {
    key: "engagement_with_us",
    name: "Engaged with us",
    description:
      "The person or company knowingly interacted with us: reply, form, webinar, download, event booth. Typical angle: reference only what they knowingly did, never tracked visits.",
    weight: 70,
    half_life_days: 14,
    detection: detection(
      ["first_party"],
      "Counts: first-party records (forms, registrations, meetings) sent through the webhook or ingest. Does not count: anonymous website visits.",
    ),
  },
  {
    key: "competitor_mention",
    name: "Competitor in the picture",
    description:
      "Uses, evaluates or complains publicly about a competitor. Typical angle: complement or switching help, never disparage the competitor.",
    weight: 50,
    half_life_days: 30,
    detection: detection(
      ["job_boards", "news_gdelt", "tech_detect"],
      "Counts: a job post, article or detected tool that names a competitor from this definition's keywords.",
    ),
  },
  {
    key: "event_attendance",
    name: "At a relevant event",
    description:
      "Exhibiting, sponsoring, speaking or registered at an event you attend or care about. Typical angle: meet there before, or follow up on the session topic after.",
    weight: 35,
    half_life_days: 14,
    detection: detection(
      ["website_changes", "news_gdelt"],
      "Counts: the company appears on an exhibitor, sponsor or speaker list, or announces its participation. Add event page URLs to this definition.",
    ),
  },
  {
    key: "review_activity",
    name: "Review pattern",
    description:
      "A change in public reviews that points to a problem you solve (rating drop, complaint theme, unanswered negative reviews). Typical angle: the operational pattern, paraphrased, never a quote.",
    weight: 40,
    half_life_days: 30,
    detection: detection(
      [],
      "Counts: an aggregate review pattern from official data (paraphrased, never review text). Sent through the webhook or ingest.",
    ),
  },
];

export const BUILTIN_KEYS: readonly string[] = BUILTIN_DEFINITIONS.map((d) => d.key);

export function isBuiltinKey(key: string): boolean {
  return BUILTIN_KEYS.includes(key);
}

function builtinRow(workspaceId: string, definition: BuiltinDefinition): NewSignalDefinition {
  return {
    workspace_id: workspaceId,
    key: definition.key,
    name: definition.name,
    description: definition.description,
    kind: "builtin",
    detection: definition.detection,
    weight: definition.weight,
    half_life_days: definition.half_life_days,
    min_strength: DEFAULT_MIN_STRENGTH,
    enabled: true,
  };
}

/** Workspaces already seeded in this process, per database handle. */
const seeded = new WeakMap<Db, Set<string>>();

/**
 * Inserts missing built-in definitions for the workspace. Idempotent: existing rows, including
 * user tuning and disabled definitions, are never touched. Returns how many rows were added.
 */
export async function seedCatalog(db: Db, workspaceId: string): Promise<number> {
  const inserted = await db
    .insert(signal_definitions)
    .values(BUILTIN_DEFINITIONS.map((definition) => builtinRow(workspaceId, definition)))
    .onConflictDoNothing({ target: [signal_definitions.workspace_id, signal_definitions.key] })
    .returning({ id: signal_definitions.id });
  return inserted.length;
}

/** seedCatalog once per workspace and process (cheap to call before every read). */
export async function ensureCatalog(db: Db, workspaceId: string): Promise<void> {
  let done = seeded.get(db);
  if (done?.has(workspaceId)) return;
  await seedCatalog(db, workspaceId);
  if (!done) {
    done = new Set();
    seeded.set(db, done);
  }
  done.add(workspaceId);
}

/** Every definition of the workspace (seeding the catalog first), by key. */
export async function loadDefinitions(
  db: Db,
  workspaceId: string,
): Promise<Map<string, SignalDefinition>> {
  await ensureCatalog(db, workspaceId);
  const rows = await db
    .select()
    .from(signal_definitions)
    .where(eq(signal_definitions.workspace_id, workspaceId));
  return new Map(rows.map((row) => [row.key, row]));
}

/** One definition by key (seeding the catalog first), or null. */
export async function findDefinition(
  db: Db,
  workspaceId: string,
  key: string,
): Promise<SignalDefinition | null> {
  await ensureCatalog(db, workspaceId);
  const [row] = await db
    .select()
    .from(signal_definitions)
    .where(and(eq(signal_definitions.workspace_id, workspaceId), eq(signal_definitions.key, key)));
  return row ?? null;
}
