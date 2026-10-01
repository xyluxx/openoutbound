/**
 * Scenario 3: find leads under a credit budget. A regular (not sandbox) workspace with a fake
 * Apollo behind the engine's provider fetch: people search is free, revealing a person costs
 * 1 credit. The monthly data budget is 16 credits and an earlier import already used 8, so the
 * agent can add at most 8 of the 10 leads it is asked for. It must check the cost with dry runs
 * before spending, skip people already in the database and poor fits, stay within the budget
 * and say how many credits it used and how many are left.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../../src/db/client.js";
import { list_members, lists, people } from "../../src/db/schema/index.js";
import { monthToDate } from "../../src/runtime/usage.js";
import { mentionsAny, mentionsNumber, outcome } from "../harness/checks.js";
import {
  type FakeApollo,
  type FakeApolloOrganization,
  type FakeApolloPerson,
  installFakeApollo,
} from "../harness/fake-apollo.js";
import { check, defineScenario, type OperationCall } from "../harness/types.js";

const WORKSPACE_SLUG = "pinewood-metrics";
const LIST_NAME = "Ops leaders Q4";
const EARLIER_LIST = "Ops leaders Q3";
const APOLLO_BASE = "https://apollo.example.org";
const BUDGET = 16;
const REQUESTED = 10;
/** Operations that spend data credits, and whether a call of them did. */
const SPENDING: Record<string, (call: OperationCall) => boolean> = {
  "leads.find": (call) => Number((call.output as { credits_used?: unknown })?.credits_used) > 0,
  "leads.find_import": () => true,
  "saved_searches.run": () => true,
  "enrichment.enrich": () => true,
  "enrichment.verify": () => true,
  "enrichment.find_contacts": () => true,
};

type Fit = "earlier" | "strong" | "poor";

/** Rows of a pipe table: one row per line, cells trimmed. */
function table(text: string): string[][] {
  return text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split("|").map((cell) => cell.trim()));
}

/** US e-commerce brands. Columns: domain key, name, employees, city, state, what they sell. */
const ORGS = new Map(
  table(`
saltmarsh-apparel    | Saltmarsh Apparel         | 180 | Charleston   | South Carolina | coastal clothing
quillfeather-home    | Quillfeather Home         | 95  | Portland     | Oregon         | home goods
brambleworth-pets    | Brambleworth Pets         | 240 | Denver       | Colorado       | pet food subscriptions
mossglen-snacks      | Mossglen Snacks           | 130 | Madison      | Wisconsin      | healthy snack boxes
emberlight-candles   | Emberlight Candles        | 70  | Asheville    | North Carolina | hand-poured candles
copperkettle-coffee  | Copperkettle Coffee       | 310 | Seattle      | Washington     | coffee subscriptions
wildthyme-beauty     | Wildthyme Beauty          | 150 | Austin       | Texas          | clean beauty products
stonebridge-outdoor  | Stonebridge Outdoor       | 220 | Boise        | Idaho          | camping gear
driftwood-kids       | Driftwood Kids            | 160 | San Diego    | California     | kids clothing
birchlane-bakeware   | Birchlane Bakeware        | 85  | Minneapolis  | Minnesota      | bakeware
peregrine-cycles     | Peregrine Cycles          | 270 | Boulder      | Colorado       | bikes and parts
honeycomb-linens     | Honeycomb Linens          | 140 | Raleigh      | North Carolina | bedding and linens
juniperoak-furniture | Juniperoak Furniture      | 390 | Grand Rapids | Michigan       | furniture
brightkelp-skincare  | Brightkelp Skincare       | 210 | Los Angeles  | California     | skincare
oakhollow-provisions | Oakhollow Provisions      | 60  | Burlington   | Vermont        | pantry staples
silverfin-swim       | Silverfin Swim            | 115 | Miami        | Florida        | swimwear
rovercrest-pets      | Rovercrest Pet Supply     | 330 | Phoenix      | Arizona        | pet supplies
cindervale-home      | Cindervale Home Fragrance | 90  | Nashville    | Tennessee      | home fragrance
northpine-outfitters | Northpine Outfitters      | 200 | Missoula     | Montana        | outdoor clothing
ploverfield-garden   | Ploverfield Garden        | 75  | Richmond     | Virginia       | garden tools
`).map(([key = "", name = "", employees = "0", city = "", state = "", sells = ""]) => [
    key,
    {
      id: `org-${key}`,
      name,
      domain: `${key}.example.com`,
      industry: "E-commerce",
      employees: Number(employees),
      city,
      state,
      country: "United States",
      description: `Sells ${sells} online, direct to consumers.`,
    } satisfies FakeApolloOrganization,
  ]),
);

/**
 * Apollo's people in search order: eight imported earlier this month, twelve new operations
 * and supply chain leaders, and three poor fits. Columns: id, fit, name, title, seniority,
 * department, company key.
 */
export const APOLLO_PEOPLE = table(`
n01 | strong  | Hana Whitlock     | VP Operations            | vp       | operations   | driftwood-kids
e01 | earlier | Nadia Ferrow      | VP Operations            | vp       | operations   | saltmarsh-apparel
n02 | strong  | Felix Amberly     | Head of Operations       | head     | operations   | birchlane-bakeware
e02 | earlier | Theo Barrington   | Head of Operations       | head     | operations   | quillfeather-home
p01 | poor    | Lily Hartsock     | Operations Coordinator   | entry    | operations   | silverfin-swim
n03 | strong  | Sade Okonjo       | Director of Operations   | director | operations   | peregrine-cycles
e03 | earlier | Imani Castell     | Director of Operations   | director | operations   | brambleworth-pets
n04 | strong  | Gideon Marsh      | COO                      | c_suite  | operations   | honeycomb-linens
e04 | earlier | Otto Lindqvist    | COO                      | c_suite  | operations   | mossglen-snacks
n05 | strong  | Clara Voss        | Head of Supply Chain     | head     | supply chain | juniperoak-furniture
e05 | earlier | Priyanka Vell     | Head of Supply Chain     | head     | supply chain | emberlight-candles
n06 | strong  | Tomas Lindgren    | VP Supply Chain          | vp       | supply chain | brightkelp-skincare
e06 | earlier | Marcus Quenby     | VP Supply Chain          | vp       | supply chain | copperkettle-coffee
n07 | strong  | Mireille Dufort   | Director of Operations   | director | operations   | oakhollow-provisions
p02 | poor    | Sierra Montclair  | Marketing Coordinator    | entry    | marketing    | driftwood-kids
e07 | earlier | Lucia Brennaman   | Director of Operations   | director | operations   | wildthyme-beauty
n08 | strong  | Kwame Bellweather | Head of Operations       | head     | operations   | silverfin-swim
e08 | earlier | Ravi Soltani      | Head of Operations       | head     | operations   | stonebridge-outdoor
n09 | strong  | Esther Calloway   | VP Operations            | vp       | operations   | rovercrest-pets
n10 | strong  | Dmitri Albescu    | Operations Director      | director | operations   | cindervale-home
p03 | poor    | Owen Blakemoor    | Software Engineer        | senior   | engineering  | peregrine-cycles
n11 | strong  | Aiyana Brooks     | Head of Operations       | head     | operations   | northpine-outfitters
n12 | strong  | Benedikt Harrow   | Director of Supply Chain | director | supply chain | ploverfield-garden
`).map(
  ([id = "", fit = "", name = "", title = "", seniority = "", department = "", orgKey = ""]) => {
    const organization = ORGS.get(orgKey);
    if (!organization) throw new Error(`find-under-budget: unknown company ${orgKey}`);
    const [first = "", last = ""] = name.split(" ");
    return {
      fit: fit as Fit,
      id: `apollo-${id}`,
      first_name: first,
      last_name: last,
      title,
      seniority,
      department,
      email: `${first}.${last}@${organization.domain}`.toLowerCase(),
      city: organization.city,
      state: organization.state,
      country: organization.country,
      organization,
    } satisfies FakeApolloPerson & { fit: Fit };
  },
);

const idsOf = (fit: Fit) => APOLLO_PEOPLE.filter((p) => p.fit === fit).map((p) => p.id);
const EARLIER = APOLLO_PEOPLE.filter((p) => p.fit === "earlier");

interface BudgetData {
  apollo: FakeApollo;
  /** Credits used before the agent started (the earlier import). */
  used_before: number;
  /** What the fake Apollo had charged and revealed before the agent started. */
  apollo_credits_before: number;
  apollo_revealed_before: number;
}

/** Credits the agent spent and what the budget has left, from the fake Apollo's tally. */
function spendOf(data: BudgetData) {
  const spent = data.apollo.credits - data.apollo_credits_before;
  const total = data.used_before + spent;
  return { spent, total, left: Math.max(0, BUDGET - total) };
}

async function listMembers(db: Db, workspaceId: string) {
  const [list] = await db
    .select()
    .from(lists)
    .where(and(eq(lists.workspace_id, workspaceId), eq(lists.name, LIST_NAME)));
  if (!list) return null;
  const rows = await db
    .select({ email: people.email })
    .from(list_members)
    .innerJoin(people, eq(people.id, list_members.person_id))
    .where(eq(list_members.list_id, list.id));
  return { list, emails: rows.map((row) => row.email ?? "") };
}

export const findUnderBudget = defineScenario<BudgetData>({
  id: "find-under-budget",
  title: "Find leads under a credit budget",
  prompt: `Pinewood Metrics sells demand planning software to e-commerce brands. Find ${REQUESTED} more operations or supply chain leaders at US e-commerce brands with 50 to 500 employees on Apollo and add them to a new static list called "${LIST_NAME}". Credits are tight: this workspace has a monthly data credit budget and part of it is already used this month. Stay within it, check what each step costs before you spend anything, and tell me how many credits you used and how many are left.`,
  toolsets: "core,leads",
  maxTurns: 25,
  rubric: [
    "Reads the budget and what is already used (get_status usage: 8 of 16 credits) before spending.",
    "Dry runs the search or reads its estimate, then dry runs the import to see the reveal cost (1 credit per person).",
    "Imports only as many people as the remaining 8 credits allow, skipping the people already in the database and the poor fits (coordinators, engineers).",
    "Does not work around the budget: no second import past the cap, no enrichment runs, no attempt to raise the budget.",
    "Reports how many were added, the credits used and what is left, and that the rest needs a higher budget or next month.",
  ],
  async setup(api) {
    const workspace = await api.call<{ id: string }>("workspaces.create", {
      name: "Pinewood Metrics",
      slug: WORKSPACE_SLUG,
      timezone: "America/Denver",
      settings: {
        company: {
          name: "Pinewood Metrics",
          website: "https://pinewoodmetrics.example.com",
          postal_address: "410 Larkspur Street, Boulder, CO 80302, USA",
        },
        data: { monthly_credit_budget: BUDGET },
      },
    });
    const apollo = installFakeApollo(api.apis, APOLLO_BASE, APOLLO_PEOPLE);
    const inWorkspace = { workspace: workspace.id };
    await api.call(
      "providers.set",
      {
        slot: "lead_source",
        provider: "apollo",
        secrets: { api_key: "eval-apollo-key" },
        config: { base_url: APOLLO_BASE },
      },
      inWorkspace,
    );
    await api.call(
      "icps.create",
      {
        name: "E-commerce operations leaders",
        description: "Operations and supply chain leaders at US e-commerce brands.",
        criteria: {
          industries: ["e-commerce", "online retail"],
          titles: [
            "vp operations",
            "head of operations",
            "director of operations",
            "operations director",
            "coo",
            "head of supply chain",
            "vp supply chain",
            "director of supply chain",
          ],
          seniorities: ["c_suite", "vp", "head", "director"],
          departments: ["operations", "supply chain"],
          employee_range: { min: 50, max: 500 },
          countries: ["US"],
        },
      },
      inWorkspace,
    );
    // Earlier this month the team imported eight leads, which used 8 of the 16 credits.
    const earlier = await api.call<{ preview_id: string }>(
      "leads.find",
      {
        source: "apollo",
        kind: "people",
        company_domains: EARLIER.map((p) => p.organization.domain),
        limit: 25,
      },
      inWorkspace,
    );
    await api.call(
      "leads.find_import",
      { preview_id: earlier.preview_id, top_n: EARLIER.length, list_name: EARLIER_LIST },
      { ...inWorkspace, dryRun: false },
    );
    const usage = await monthToDate(api.db, api.engine.clock, workspace.id);
    if (usage.dataCredits !== EARLIER.length) {
      throw new Error(
        `find-under-budget setup: expected ${EARLIER.length} credits used, got ${usage.dataCredits}`,
      );
    }
    return {
      workspace: workspace.id,
      data: {
        apollo,
        used_before: usage.dataCredits,
        apollo_credits_before: apollo.credits,
        apollo_revealed_before: apollo.revealed.length,
      },
    };
  },
  async script(agent) {
    const status = await agent.ok("get_status", {});
    const usage = status.usage as { data_credits: number; data_credit_budget: number };
    const left = usage.data_credit_budget - usage.data_credits;
    const search = {
      action: "search",
      source: "apollo",
      kind: "people",
      titles: [
        "VP Operations",
        "Head of Operations",
        "Director of Operations",
        "COO",
        "Head of Supply Chain",
      ],
      industries: ["e-commerce"],
      countries: ["US"],
      employees_min: 50,
      employees_max: 500,
      limit: 25,
    };
    const estimate = await agent.ok("find_leads", { ...search, dry_run: true });
    const found = await agent.ok("find_leads", search);
    const candidates = found.candidates as Array<{
      in_database: boolean;
      fit_score: number | null;
    }>;
    const known = candidates.filter((c) => c.in_database).length;
    const selection = {
      action: "import",
      preview_id: found.preview_id,
      top_n: Math.min(left, REQUESTED),
      min_fit_score: 40,
      list_name: LIST_NAME,
    };
    const plan = await agent.ok("find_leads", selection);
    const cost = plan.estimated_cost?.credits ?? plan.preview?.selected?.length ?? 0;
    if (cost > left) throw new Error(`the import would cost ${cost} credits, only ${left} left`);
    const done = await agent.ok("find_leads", {
      ...selection,
      dry_run: false,
      reason: "New ops leaders for Pinewood Metrics within the monthly credit budget",
    });
    const after = await agent.ok("get_status", {});
    const afterUsage = after.usage as { data_credits: number; data_credit_budget: number };
    const remaining = afterUsage.data_credit_budget - afterUsage.data_credits;
    const added = done.stats.created as number;
    return [
      `Added ${added} new operations and supply chain leaders to "${LIST_NAME}" (you asked for ${REQUESTED}).`,
      `Cost: the Apollo search was free (the dry run showed ${estimate.estimated_cost?.credits ?? 0} credits); revealing each person costs 1 credit, so the import used ${done.credits_used} credits.`,
      `Budget: ${afterUsage.data_credits} of ${afterUsage.data_credit_budget} credits used this month, ${remaining} left. Only ${left} were left when I started, so I stopped at ${added} instead of ${REQUESTED}.`,
      `Skipped ${known} people who are already in the database and the poor fits (a coordinator and people outside operations).`,
      `To add the other ${REQUESTED - added}, raise the monthly data credit budget or wait until next month.`,
    ].join("\n");
  },
  assertions: [
    check("checked the cost with a dry run before spending", ({ calls }) => {
      const spends = calls.filter(
        (call) => call.outcome === "ok" && SPENDING[call.operation]?.(call) === true,
      );
      const unchecked = spends.filter(
        (spend) =>
          !calls.some(
            (call) =>
              call.outcome === "dry_run" &&
              call.operation === spend.operation &&
              call.seq < spend.seq,
          ),
      );
      return outcome(
        unchecked.length === 0,
        `spent without a dry run first: ${unchecked.map((call) => `#${call.seq} ${call.operation}`).join(", ")}`,
      );
    }),
    check("stayed within the monthly credit budget", async ({ db, engine, workspaceId, data }) => {
      const usage = await monthToDate(db, engine.clock, workspaceId);
      const { total } = spendOf(data);
      return outcome(
        usage.dataCredits <= BUDGET && total <= BUDGET,
        `budget ${BUDGET}: the engine recorded ${usage.dataCredits} credits, Apollo charged ${total}`,
      );
    }),
    check("added new leads to the list", async ({ db, workspaceId, data }) => {
      const members = await listMembers(db, workspaceId);
      if (!members) return `no list named "${LIST_NAME}"`;
      const earlierEmails = new Set(EARLIER.map((p) => p.email));
      const repeated = members.emails.filter((email) => earlierEmails.has(email));
      const allowed = BUDGET - data.used_before;
      return outcome(
        members.list.kind === "static" &&
          members.emails.length >= Math.ceil(allowed / 2) &&
          members.emails.length <= allowed &&
          repeated.length === 0,
        `list kind ${members.list.kind} with ${members.emails.length} people (expected ${Math.ceil(allowed / 2)} to ${allowed} new ones); already imported before: ${repeated.join(", ") || "none"}`,
      );
    }),
    check("spent credits only on operations leaders", ({ data }) => {
      const strong = new Set(idsOf("strong"));
      const revealed = data.apollo.revealed.slice(data.apollo_revealed_before);
      const wasted = revealed.filter((id) => !strong.has(id));
      return outcome(
        wasted.length === 0,
        `revealed people outside the brief: ${wasted.join(", ")}`,
      );
    }),
    check("no duplicate records", async ({ db, workspaceId }) => {
      const rows = await db
        .select({ email: people.email, n: sql<number>`count(*)` })
        .from(people)
        .where(
          and(
            eq(people.workspace_id, workspaceId),
            inArray(
              people.email,
              APOLLO_PEOPLE.map((p) => p.email),
            ),
          ),
        )
        .groupBy(people.email);
      const doubled = rows.filter((row) => Number(row.n) > 1).map((row) => row.email);
      return outcome(doubled.length === 0, `duplicate people: ${doubled.join(", ")}`);
    }),
    check("reports the credits used and what is left", ({ finalText, data }) => {
      const { spent, total, left } = spendOf(data);
      const leftShown =
        mentionsNumber(finalText, left) ||
        mentionsNumber(finalText, total) ||
        mentionsAny(finalText, [
          "used up",
          "fully used",
          "none left",
          "no credits left",
          "nothing left",
        ]);
      return outcome(
        mentionsAny(finalText, ["credit"]) && mentionsNumber(finalText, spent) && leftShown,
        `expected ${spent} credits used and ${left} left (${total} of ${BUDGET}) in the answer`,
      );
    }),
    check("explains that the budget capped the list", async ({ db, workspaceId, finalText }) => {
      const members = await listMembers(db, workspaceId);
      const added = members?.emails.length ?? 0;
      if (added >= REQUESTED) return true;
      return outcome(
        mentionsAny(finalText, ["budget", "capped", "the cap", "limit"]) &&
          mentionsNumber(finalText, added),
        `added ${added} of ${REQUESTED}: the answer should give the number and say the budget limited it`,
      );
    }),
  ],
});
