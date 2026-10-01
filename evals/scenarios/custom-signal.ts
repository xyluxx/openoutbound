/**
 * Scenario 7: a custom signal, a monitor and acting on what it finds. A client workspace (not a
 * sandbox, so the monitor reads the routed company websites) has four accounts: two are opening
 * a warehouse or fulfillment center, one is closing a warehouse (a keyword trap) and one has
 * nothing. The agent defines the signal in plain English, creates a weekly monitor, runs it,
 * reviews the evidence and puts the operations leaders of the real matches on a list.
 */
import { and, eq, inArray } from "drizzle-orm";
import {
  companies,
  list_members,
  lists,
  monitors,
  people,
  signal_definitions,
  signals,
} from "../../src/db/schema/index.js";
import { callsOf, describeCalls, mentionsAny, outcome } from "../harness/checks.js";
import { check, defineScenario } from "../harness/types.js";

const LIST_NAME = "New warehouse openings";

interface Account {
  key: "harlow" | "marlow" | "pinecrest" | "seabright";
  name: string;
  domain: string;
  industry: string;
  employees: number;
  opening: boolean;
  pages: Record<string, string>;
  people: Array<{ first: string; last: string; title: string; operations: boolean }>;
}

const page = (title: string, body: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body><nav><a href="/">Home</a> <a href="/news">News</a> <a href="/careers">Careers</a></nav><main>${body}</main></body></html>`;

export const ACCOUNTS: Account[] = [
  {
    key: "harlow",
    name: "Harlow Home Goods",
    domain: "harlowhome.example.com",
    industry: "home goods e-commerce",
    employees: 140,
    opening: true,
    pages: {
      "/": page("Harlow Home Goods", "<p>Furniture and decor, shipped to your door.</p>"),
      "/news": page(
        "News",
        "<h1>News</h1><p>September 2026. Harlow Home Goods opens a new 120,000 square foot fulfillment center in Reno, Nevada, to cut delivery times on the West Coast.</p>",
      ),
      "/careers": page("Careers", "<p>We are hiring customer care agents.</p>"),
    },
    people: [
      { first: "Dana", last: "Okoro", title: "VP Operations", operations: true },
      { first: "Leo", last: "Park", title: "Marketing Manager", operations: false },
    ],
  },
  {
    key: "marlow",
    name: "Marlow Kitchen",
    domain: "marlowkitchen.example.com",
    industry: "kitchenware e-commerce",
    employees: 85,
    opening: true,
    pages: {
      "/": page("Marlow Kitchen", "<p>Cookware for people who cook every day.</p>"),
      "/news": page("News", "<p>Marlow Kitchen wins a design award for its cast iron line.</p>"),
      "/careers": page(
        "Careers",
        "<h1>Warehouse Operations Manager</h1><p>Our new warehouse in Columbus, Ohio opens in March. You will set up receiving and storage from day one.</p>",
      ),
    },
    people: [
      { first: "Priya", last: "Nandakumar", title: "Head of Supply Chain", operations: true },
      { first: "Tom", last: "Reyes", title: "Brand Manager", operations: false },
    ],
  },
  {
    key: "pinecrest",
    name: "Pinecrest Apparel",
    domain: "pinecrestapparel.example.com",
    industry: "apparel e-commerce",
    employees: 210,
    opening: false,
    pages: {
      "/": page("Pinecrest Apparel", "<p>Outdoor clothing made to last.</p>"),
      "/news": page(
        "News",
        "<p>Pinecrest Apparel closes its Dallas warehouse and moves fulfillment to a third-party logistics partner.</p>",
      ),
      "/careers": page("Careers", "<p>Senior graphic designer, remote.</p>"),
    },
    people: [
      { first: "Ava", last: "Lindqvist", title: "Director of Operations", operations: true },
      { first: "Sam", last: "Idris", title: "Head of Growth", operations: false },
    ],
  },
  {
    key: "seabright",
    name: "Seabright Candles",
    domain: "seabrightcandles.example.com",
    industry: "home fragrance e-commerce",
    employees: 30,
    opening: false,
    pages: {
      "/": page("Seabright Candles", "<p>Hand-poured candles from the coast of Maine.</p>"),
    },
    people: [
      { first: "Nora", last: "Quill", title: "Founder", operations: false },
      { first: "Eli", last: "Stone", title: "Operations Manager", operations: true },
    ],
  },
];

interface SignalData {
  companies: Record<Account["key"], string>;
  /** Operations leaders at the accounts that really open a site. */
  expected_people: string[];
  /** People who must not be on the list. */
  other_people: string[];
}

export const customSignal = defineScenario<SignalData>({
  id: "custom-signal",
  title: "Custom signal, monitor, run and act",
  prompt: `Our client Quayside Forecasting sells demand planning to e-commerce brands. A brand that is opening a new warehouse or fulfillment center is a great moment to reach out. Set up a custom signal for that (use each company's news and careers pages as sources), create a monitor that checks all their accounts weekly, run it now and review what it finds. Put the operations leaders of the companies that really are opening a new site on a static list called "${LIST_NAME}" so the team can reach out, and dismiss anything the monitor got wrong. Tell me which companies matched and on what evidence.`,
  toolsets: "core,leads",
  maxTurns: 30,
  rubric: [
    "Defines one custom signal with a clear rule, keywords and the /news and /careers pages as URLs.",
    "Creates a weekly monitor over the accounts for that signal (web collectors only, no paid providers) and runs it.",
    "Waits for the run and reads the feed with the evidence of each signal.",
    "Dismisses a match that is not an opening (the warehouse closure), if the monitor produced one.",
    "Creates the static list and adds exactly the operations leaders of Harlow Home Goods and Marlow Kitchen.",
    "The summary names both companies with their evidence (fulfillment center in Reno, new warehouse in Columbus).",
  ],
  async setup(api) {
    const workspace = await api.call<{ id: string }>("workspaces.create", {
      name: "Quayside Forecasting",
      slug: "quayside",
      timezone: "America/New_York",
    });
    const companyIds = {} as SignalData["companies"];
    const expected: string[] = [];
    const others: string[] = [];
    for (const account of ACCOUNTS) {
      const [company] = await api.db
        .insert(companies)
        .values({
          workspace_id: workspace.id,
          name: account.name,
          domain: account.domain,
          website: `https://${account.domain}`,
          industry: account.industry,
          employee_count: account.employees,
          country: "US",
          fit_score: 80,
          source: "csv",
        })
        .returning({ id: companies.id });
      if (!company) throw new Error("custom-signal setup: company insert failed");
      companyIds[account.key] = company.id;
      api.web.site(`https://${account.domain}`, account.pages);
      for (const person of account.people) {
        const [row] = await api.db
          .insert(people)
          .values({
            workspace_id: workspace.id,
            company_id: company.id,
            first_name: person.first,
            last_name: person.last,
            full_name: `${person.first} ${person.last}`,
            title: person.title,
            email: `${person.first}.${person.last}@${account.domain}`.toLowerCase(),
            email_status: "valid",
            country: "US",
            source: "csv",
          })
          .returning({ id: people.id });
        if (!row) throw new Error("custom-signal setup: person insert failed");
        (account.opening && person.operations ? expected : others).push(row.id);
      }
    }
    return {
      workspace: workspace.id,
      data: { companies: companyIds, expected_people: expected, other_people: others },
    };
  },
  async script(agent) {
    const definition = await agent.ok("manage_signals", {
      action: "define_custom",
      key: "new_warehouse_opening",
      name: "New warehouse or fulfillment center",
      description:
        "The company announces or hires for a new warehouse, fulfillment center or distribution center it is opening. Closures or moves to a third-party logistics partner do not count.",
      keywords: ["new warehouse", "fulfillment center", "distribution center"],
      urls: ["/news", "/careers"],
      reason: "Client wants to reach brands opening new sites",
    });
    const key = definition.key as string;
    const monitor = await agent.ok("manage_signals", {
      action: "create_monitor",
      name: "Weekly new site check",
      target: { kind: "all_active" },
      signal_keys: [key],
      collectors: ["website_changes"],
      schedule: "0 7 * * 1",
      reason: "Watch every account weekly",
    });
    const run = await agent.ok("manage_signals", {
      action: "run_monitor",
      monitor_id: monitor.id,
      reason: "First run",
    });
    if (run.job_id) await agent.waitForJob(run.job_id, { timeoutMs: 30_000 });

    const feed = await agent.ok("manage_signals", {
      action: "feed",
      definition_keys: [key],
      min_score: 0,
      response_format: "detailed",
    });
    type FeedItem = {
      id: string;
      company_id: string | null;
      company_name?: string | null;
      evidence_excerpt: string | null;
      evidence_url: string | null;
    };
    const items = feed.items as FeedItem[];
    const wrong = items.filter((item) => /close|third-party/i.test(item.evidence_excerpt ?? ""));
    if (wrong.length > 0) {
      await agent.ok("manage_signals", {
        action: "dismiss",
        signal_ids: wrong.map((item) => item.id),
        reason: "A warehouse closure, not an opening",
      });
    }
    const real = items.filter((item) => !wrong.includes(item));
    const companyIds = [
      ...new Set(real.flatMap((item) => (item.company_id ? [item.company_id] : []))),
    ];
    if (companyIds.length === 0) throw new Error("the monitor found no company to act on");
    const found = await agent.ok("search_leads", {
      action: "people",
      company_ids: companyIds,
      limit: 50,
    });
    const leaders = (found.items as Array<{ id: string; title: string | null }>).filter((person) =>
      /operations|supply chain/i.test(person.title ?? ""),
    );
    const list = await agent.ok("manage_lists", {
      action: "create",
      name: LIST_NAME,
      kind: "static",
      reason: "Leaders at companies opening a new site",
    });
    await agent.ok("manage_lists", {
      action: "add_members",
      list_id: list.id,
      person_ids: leaders.map((person) => person.id),
    });
    return [
      `Custom signal "${key}" and a weekly monitor (Mondays 07:00) are set up; the first run matched ${real.length} companies:`,
      ...real.map(
        (item) => `- ${item.company_name}: "${item.evidence_excerpt}" (${item.evidence_url})`,
      ),
      wrong.length > 0
        ? `Dismissed ${wrong.length} wrong match (a warehouse closure, not an opening).`
        : "No wrong matches to dismiss.",
      `Added ${leaders.length} operations leaders to the static list "${LIST_NAME}".`,
    ].join("\n");
  },
  assertions: [
    check("defined the custom signal", async ({ db, workspaceId }) => {
      const rows = await db
        .select()
        .from(signal_definitions)
        .where(
          and(
            eq(signal_definitions.workspace_id, workspaceId),
            eq(signal_definitions.kind, "custom"),
          ),
        );
      const relevant = rows.filter((row) =>
        /warehouse|fulfil/i.test(`${row.name} ${row.description ?? ""}`),
      );
      return outcome(
        relevant.length >= 1 && relevant.every((row) => row.enabled),
        `custom definitions: ${rows.map((row) => `${row.key} enabled=${row.enabled}`).join(", ") || "none"}`,
      );
    }),
    check("created a weekly monitor for it", async ({ db, workspaceId }) => {
      const custom = await db
        .select({ key: signal_definitions.key })
        .from(signal_definitions)
        .where(
          and(
            eq(signal_definitions.workspace_id, workspaceId),
            eq(signal_definitions.kind, "custom"),
          ),
        );
      const keys = new Set(custom.map((row) => row.key));
      const rows = await db.select().from(monitors).where(eq(monitors.workspace_id, workspaceId));
      const weekly = rows.filter((row) => {
        const fields = row.schedule.trim().split(/\s+/);
        const watchesKey =
          row.signal_keys.length === 0 || row.signal_keys.some((key) => keys.has(key));
        return fields.length === 5 && fields[4] !== "*" && fields[2] === "*" && watchesKey;
      });
      return outcome(
        weekly.length >= 1,
        `monitors: ${rows.map((row) => `${row.name} "${row.schedule}" keys=${row.signal_keys.join("|")}`).join(", ") || "none"}`,
      );
    }),
    check("ran the monitor", ({ calls }) => {
      const runs = callsOf(
        calls,
        "signals.monitors.run",
        (call) => call.outcome !== "error" && call.dry_run !== true,
      );
      return outcome(
        runs.length >= 1,
        `monitor runs: ${describeCalls(callsOf(calls, "signals.monitors.run"))}`,
      );
    }),
    check("the feed matches the evidence", async ({ db, workspaceId, data }) => {
      const custom = await db
        .select({ key: signal_definitions.key })
        .from(signal_definitions)
        .where(
          and(
            eq(signal_definitions.workspace_id, workspaceId),
            eq(signal_definitions.kind, "custom"),
          ),
        );
      const keys = custom.map((row) => row.key);
      if (keys.length === 0) return "no custom definition";
      const rows = await db
        .select({ company_id: signals.company_id, status: signals.status })
        .from(signals)
        .where(and(eq(signals.workspace_id, workspaceId), inArray(signals.definition_key, keys)));
      const active = rows.filter((row) => row.status !== "dismissed");
      const activeCompanies = new Set(active.map((row) => row.company_id));
      const problems = [
        activeCompanies.has(data.companies.harlow) ? null : "Harlow has no active signal",
        activeCompanies.has(data.companies.marlow) ? null : "Marlow has no active signal",
        activeCompanies.has(data.companies.pinecrest)
          ? "Pinecrest (a closure) is still active"
          : null,
        activeCompanies.has(data.companies.seabright)
          ? "Seabright has a signal without evidence"
          : null,
      ].filter(Boolean);
      return outcome(problems.length === 0, problems.join("; "));
    }),
    check("listed exactly the right people", async ({ db, workspaceId, data }) => {
      const [list] = await db
        .select()
        .from(lists)
        .where(and(eq(lists.workspace_id, workspaceId), eq(lists.name, LIST_NAME)));
      if (!list) return `no list named "${LIST_NAME}"`;
      const members = await db
        .select({ person_id: list_members.person_id })
        .from(list_members)
        .where(eq(list_members.list_id, list.id));
      const ids = new Set(members.map((row) => row.person_id));
      const missing = data.expected_people.filter((id) => !ids.has(id));
      const extra = data.other_people.filter((id) => ids.has(id));
      return outcome(
        list.kind === "static" && missing.length === 0 && extra.length === 0,
        `kind ${list.kind}, missing ${missing.length}, extra ${extra.length}`,
      );
    }),
    check("summary names the matches and evidence", ({ finalText }) =>
      outcome(
        mentionsAny(finalText, ["harlow"]) &&
          mentionsAny(finalText, ["marlow"]) &&
          mentionsAny(finalText, ["reno", "fulfillment center"]) &&
          mentionsAny(finalText, ["columbus", "new warehouse"]),
        "expected Harlow (Reno fulfillment center) and Marlow (Columbus warehouse) in the summary",
      ),
    ),
  ],
});
