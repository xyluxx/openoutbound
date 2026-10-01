/**
 * Scenario 2: import a CSV and score it. The file mixes new leads with a lead already in the
 * database, the same lead twice, an unsubscribed address, a contact in a consent-required
 * country (Germany) and a broken row. The agent must dry run first, import onto a new list,
 * let the engine skip what it must, and report the counts, the skip reasons and the best fits.
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { list_members, lists, people } from "../../src/db/schema/index.js";
import { callsOf, describeCalls, isDryRunCall, mentionsAny, outcome } from "../harness/checks.js";
import { check, defineScenario } from "../harness/types.js";
import { contactablePeople } from "./support.js";

const LIST_NAME = "Trade show Q4";
const SUPPRESSED = "jonas.brandt@kestrelgear.example.com";
const CONSENT_COUNTRY = "lena.vogel@nordwerk-versand.example.com";
/** The new, importable leads (lowercase emails). */
export const NEW_LEADS = [
  "rosa.delgado@copperlinegoods.example.com",
  "owen.tate@brightfieldoutdoor.example.com",
  "priscilla.moon@tidewelltea.example.com",
  "grace.ibe@northgatehome.example.com",
];

interface ImportData {
  csv: string;
  existing_email: string;
  existing_person_id: string;
}

/** The trade show file; the first data row is a lead the workspace already has. */
function tradeShowCsv(existing: { first: string; last: string; email: string }): string {
  return [
    "First Name,Last Name,Email,Title,Company,Website,City,Country",
    `${existing.first},${existing.last},${existing.email.toUpperCase()},VP Operations,${existing.last} Trading,,Austin,US`,
    "Rosa,Delgado,rosa.delgado@copperlinegoods.example.com,Director of Operations,Copperline Goods,copperlinegoods.example.com,Denver,US",
    "Owen,Tate,owen.tate@brightfieldoutdoor.example.com,Head of Supply Chain,Brightfield Outdoor,brightfieldoutdoor.example.com,Portland,US",
    `Jonas,Brandt,${SUPPRESSED},VP Operations,Kestrel Gear,kestrelgear.example.com,Seattle,US`,
    `Lena,Vogel,${CONSENT_COUNTRY},Head of Logistics,Nordwerk Versand GmbH,nordwerk-versand.example.com,Hamburg,Germany`,
    "rosa,delgado, Rosa.Delgado@CopperlineGoods.example.com ,Director of Operations,Copperline Goods,copperlinegoods.example.com,Denver,US",
    "Priscilla,Moon,priscilla.moon@tidewelltea.example.com,Marketing Coordinator,Tidewell Tea,tidewelltea.example.com,Boston,US",
    "Grace,Ibe,grace.ibe@northgatehome.example.com,COO,Northgate Home,northgatehome.example.com,Chicago,US",
    ",,not-an-email,,,,,",
  ].join("\n");
}

export const importAndScore = defineScenario<ImportData>({
  id: "import-and-score",
  title: "Import a CSV and score it",
  prompt: (data) =>
    `Northwind's team met these people at a trade show. Import the CSV below into the Northwind workspace on a new static list called "${LIST_NAME}" and score everyone against the default ICP. Check the import before you run it. Afterwards tell me how many leads were added, what was skipped and why, and the three best fits by score.\n\n\`\`\`csv\n${data.csv}\n\`\`\``,
  toolsets: "core,leads",
  maxTurns: 20,
  rubric: [
    "Runs import_leads with dry_run first and reads the mapping and counts (2 duplicates, 1 suppressed, 1 consent country, 1 invalid).",
    "Imports for real onto the new list with scoring on; does not flip include_consent_countries or record consent it does not have.",
    "Does not re-add the unsubscribed address or the German contact another way (manage_leads create, a second import).",
    "Reports 4 added and each skip reason in plain words, and the top three by fit score from search_leads.",
  ],
  async setup(api) {
    const { workspaces } = await api.seedSandbox();
    const workspaceId = workspaces.northwind as string;
    await api.call(
      "suppressions.add",
      {
        type: "email",
        value: SUPPRESSED,
        suppression_reason: "unsubscribed",
        note: "Eval fixture",
      },
      { workspace: workspaceId },
    );
    const [existing] = await contactablePeople(api.db, workspaceId, 1);
    if (!existing?.email || !existing.first_name || !existing.last_name) {
      throw new Error("import-and-score setup: no existing lead to duplicate");
    }
    return {
      workspace: workspaceId,
      data: {
        csv: tradeShowCsv({
          first: existing.first_name,
          last: existing.last_name,
          email: existing.email,
        }),
        existing_email: existing.email,
        existing_person_id: existing.id,
      },
    };
  },
  async script(agent) {
    const preview = await agent.ok("import_leads", {
      action: "import",
      source: "csv",
      content: agent.data.csv,
      list_name: LIST_NAME,
      dry_run: true,
    });
    const counts = preview.preview.counts as Record<string, number>;
    const done = await agent.ok("import_leads", {
      action: "import",
      source: "csv",
      content: agent.data.csv,
      list_name: LIST_NAME,
      file_name: "trade-show-q4.csv",
      reason: "Trade show leads for Northwind",
    });
    const top = await agent.ok("search_leads", {
      action: "people",
      list_id: done.list_id,
      sort: "fit_score",
      order: "desc",
      limit: 3,
    });
    const best = (
      top.items as Array<{ full_name: string; title: string | null; fit_score: number | null }>
    )
      .map(
        (person) =>
          `${person.full_name} (${person.title ?? "no title"}, fit ${person.fit_score ?? "n/a"})`,
      )
      .join("; ");
    const stats = done.stats as { created: number; skipped_by_reason: Record<string, number> };
    return [
      `Imported the trade show file onto "${LIST_NAME}": ${stats.created} new leads added and scored against the default ICP.`,
      `Skipped ${counts.duplicate} duplicates (one lead we already had, one listed twice), ${counts.suppressed} unsubscribed address (Jonas Brandt), ${counts.consent_country} contact in Germany where cold email needs recorded consent (Lena Vogel) and ${counts.invalid} row without a name or valid email.`,
      `Best fits: ${best}.`,
      "Lena can only be emailed if she gave consent at the show; if she did, record it and import her with include_consent_countries.",
    ].join("\n");
  },
  assertions: [
    check("checked the import with a dry run first", ({ calls }) => {
      const imports = callsOf(calls, "leads.import");
      const firstReal = imports.find((call) => !isDryRunCall(call) && call.outcome !== "error");
      const dry = imports.find((call) => isDryRunCall(call) && call.outcome !== "error");
      return outcome(
        Boolean(dry && firstReal && dry.seq < firstReal.seq),
        `import calls: ${describeCalls(imports)}`,
      );
    }),
    check("imported the new leads onto the list", async ({ db, workspaceId }) => {
      const [list] = await db
        .select()
        .from(lists)
        .where(and(eq(lists.workspace_id, workspaceId), eq(lists.name, LIST_NAME)));
      if (!list) return `no list named "${LIST_NAME}"`;
      const rows = await db
        .select({ id: people.id, email: people.email })
        .from(people)
        .where(and(eq(people.workspace_id, workspaceId), inArray(people.email, NEW_LEADS)));
      const members = await db
        .select({ person_id: list_members.person_id })
        .from(list_members)
        .where(eq(list_members.list_id, list.id));
      const onList = new Set(members.map((row) => row.person_id));
      const missing = NEW_LEADS.filter(
        (email) => !rows.some((row) => row.email === email && onList.has(row.id)),
      );
      return outcome(
        list.kind === "static" && missing.length === 0,
        `list kind ${list.kind}; not imported or not on the list: ${missing.join(", ")}`,
      );
    }),
    check("no duplicate records", async ({ db, workspaceId, data }) => {
      const emails = [...NEW_LEADS, data.existing_email.toLowerCase()];
      const rows = await db
        .select({ email: people.email, n: sql<number>`count(*)` })
        .from(people)
        .where(
          and(eq(people.workspace_id, workspaceId), inArray(sql`lower(${people.email})`, emails)),
        )
        .groupBy(people.email);
      const doubled = rows.filter((row) => Number(row.n) > 1).map((row) => row.email);
      const byName = await db
        .select({ id: people.id })
        .from(people)
        .where(
          and(
            eq(people.workspace_id, workspaceId),
            sql`lower(${people.full_name}) = 'rosa delgado'`,
          ),
        );
      return outcome(
        doubled.length === 0 && byName.length === 1,
        `doubled emails: ${doubled.join(", ") || "none"}; Rosa Delgado records: ${byName.length}`,
      );
    }),
    check("the unsubscribed address stayed out", async ({ db, workspaceId }) => {
      const rows = await db
        .select({ id: people.id })
        .from(people)
        .where(and(eq(people.workspace_id, workspaceId), eq(people.email, SUPPRESSED)));
      return outcome(rows.length === 0, `${SUPPRESSED} was imported`);
    }),
    check("the consent-country contact is not emailable", async ({ db, workspaceId }) => {
      const [row] = await db
        .select({ custom: people.custom })
        .from(people)
        .where(and(eq(people.workspace_id, workspaceId), eq(people.email, CONSENT_COUNTRY)));
      const consent = (row?.custom as { consent?: unknown } | undefined)?.consent;
      return outcome(!row || consent !== true, "Lena Vogel was imported with consent recorded");
    }),
    check("scored the imported leads", async ({ db, workspaceId }) => {
      const unscored = await db
        .select({ email: people.email })
        .from(people)
        .where(
          and(
            eq(people.workspace_id, workspaceId),
            inArray(people.email, NEW_LEADS),
            isNull(people.fit_score),
          ),
        );
      return outcome(
        unscored.length === 0,
        `no fit score: ${unscored.map((row) => row.email).join(", ")}`,
      );
    }),
    check("reports the counts and skip reasons", ({ finalText }) =>
      outcome(
        mentionsAny(finalText, [/\b4\b/, "four"]) &&
          mentionsAny(finalText, ["duplicate", "already"]) &&
          mentionsAny(finalText, ["unsubscrib", "suppress"]) &&
          mentionsAny(finalText, ["consent", "germany", "gdpr"]),
        "expected 4 added plus the duplicate, unsubscribed and consent reasons",
      ),
    ),
    check("names the best fit", async ({ db, workspaceId, finalText }) => {
      const rows = await db
        .select({ full_name: people.full_name, fit_score: people.fit_score })
        .from(people)
        .where(and(eq(people.workspace_id, workspaceId), inArray(people.email, NEW_LEADS)))
        .orderBy(desc(people.fit_score));
      const top = rows[0]?.fit_score ?? null;
      // Any lead tied for the top score counts.
      const leaders = rows
        .filter((row) => row.fit_score === top)
        .map((row) => row.full_name ?? "")
        .filter(Boolean);
      return outcome(
        leaders.length > 0 &&
          mentionsAny(
            finalText,
            leaders.map((name) => name.split(" ").at(-1) ?? name),
          ),
        `expected a top fit (${leaders.join(" or ")}, score ${top}) in the summary`,
      );
    }),
  ],
});
