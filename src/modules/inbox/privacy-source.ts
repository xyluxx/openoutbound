/**
 * Where a lead's data came from, in plain words, for privacy requests: the answer to "where
 * did you get my details?" (GDPR Art. 14 and 15 ask for the source). Built from the person's
 * `source`, `email_source` and creation date, and the import (file name and date) that created
 * the person when the `lead.created` event still names it.
 */
import { and, asc, eq } from "drizzle-orm";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import { events, imports, type Person } from "../../db/schema/index.js";
import { isoDateInZone } from "./dates.js";

export interface DataSourceInput {
  /** `people.source`: csv, apollo, google_maps, api, website, referral, ... */
  source: string | null;
  /** `people.email_source`: a provider label or the page URL a website crawl found. */
  emailSource: string | null;
  /** When the person was added. */
  addedAt: Date;
  /** File name of the import that created the person, when stored. */
  importFile?: string | null;
  /** When that import ran. */
  importedAt?: Date | null;
  /** Timezone for the dates (the workspace's). */
  timeZone: string;
}

export interface DataSource {
  /** One plain line for the owner, e.g. "Apollo, a business contact database, on 3 Sep 2026". */
  line: string;
  /** The line fits "we found your business email address through <line>"; false when it does not name a source. */
  quotable: boolean;
}

/** Sources that come from an imported list or rows. */
const IMPORT_SOURCES = new Set(["csv", "xlsx", "json", "rows", "url", "import"]);

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** "3 Sep 2026" in a timezone (fixed English month names, independent of the runtime's locale). */
export function plainDate(instant: Date, timeZone: string): string {
  const [year, month, day] = isoDateInZone(instant, timeZone).split("-");
  return `${Number(day)} ${MONTHS[Number(month) - 1] ?? month} ${year}`;
}

/** The website page (http or https URL) a crawl found the address on, or null. */
function crawledPage(emailSource: string | null): string | null {
  const value = emailSource?.trim() ?? "";
  if (!/^https?:\/\//i.test(value)) return null;
  try {
    return new URL(value).toString();
  } catch {
    return null;
  }
}

/**
 * The source line for a person. The address found on their website wins (it answers "where did
 * you get my email"), then the record's source; an unknown source says so and asks the owner to
 * check their records.
 */
export function describeDataSource(input: DataSourceInput): DataSource {
  const on = (date: Date) => plainDate(date, input.timeZone);
  const source = (input.source ?? "").trim().toLowerCase();
  const page = crawledPage(input.emailSource);
  if (page) return { line: `your company website (${page})`, quotable: true };
  if (input.emailSource?.trim().toLowerCase() === "website" || source === "website") {
    return { line: "your company website", quotable: true };
  }
  if (source === "apollo") {
    return { line: `Apollo, a business contact database, on ${on(input.addedAt)}`, quotable: true };
  }
  if (source === "google_maps") {
    return {
      line: `your company's public Google Maps listing and website, on ${on(input.addedAt)}`,
      quotable: true,
    };
  }
  if (IMPORT_SOURCES.has(source)) {
    const file = input.importFile?.trim();
    return {
      line: `a contact list${file ? ` (${file})` : ""} imported on ${on(input.importedAt ?? input.addedAt)}`,
      quotable: true,
    };
  }
  if (source === "linkedin") {
    return { line: `your public LinkedIn profile, on ${on(input.addedAt)}`, quotable: true };
  }
  if (source === "referral") {
    return { line: `a referral from a colleague, on ${on(input.addedAt)}`, quotable: true };
  }
  if (source === "api") {
    return { line: `added through our system on ${on(input.addedAt)}`, quotable: false };
  }
  return { line: "we could not find the source; check your records", quotable: false };
}

/** The source line for a stored person, with the import that created them when still known. */
export async function loadDataSource(
  ctx: OpContext,
  person: Pick<Person, "id" | "source" | "email_source" | "created_at">,
  timeZone: string,
): Promise<DataSource> {
  const workspace = requireWorkspace(ctx);
  let importFile: string | null = null;
  let importedAt: Date | null = null;
  if (IMPORT_SOURCES.has((person.source ?? "").toLowerCase())) {
    const [created] = await ctx.db
      .select({ data: events.data })
      .from(events)
      .where(
        and(
          eq(events.workspace_id, workspace.id),
          eq(events.type, "lead.created"),
          eq(events.subject_type, "person"),
          eq(events.subject_id, person.id),
        ),
      )
      .orderBy(asc(events.occurred_at))
      .limit(1);
    const importId = created?.data.import_id;
    if (typeof importId === "string" && importId) {
      const [row] = await ctx.db
        .select({ file_name: imports.file_name, created_at: imports.created_at })
        .from(imports)
        .where(and(eq(imports.workspace_id, workspace.id), eq(imports.id, importId)))
        .limit(1);
      importFile = row?.file_name ?? null;
      importedAt = row?.created_at ?? null;
    }
  }
  return describeDataSource({
    source: person.source,
    emailSource: person.email_source,
    addedAt: person.created_at,
    importFile,
    importedAt,
    timeZone,
  });
}
