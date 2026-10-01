/**
 * job_boards collector: finds the company's Greenhouse, Lever or Ashby board from links and
 * embeds on its home and careers pages, reads the public board API (no key), and reports
 * hiring_relevant_roles when new open roles match the role keywords (definition keywords plus
 * ICP personas). Competitor names in job titles become competitor_mention.
 */
import type { RawSignal } from "../../../providers/types.js";
import { internalEvidenceUrl } from "../evidence.js";
import {
  companyDomain,
  companyHomeUrl,
  discoverKeyPages,
  type FetchedDoc,
  fetchFailureReason,
  matchingKeywords,
} from "./pages.js";
import { readSnapshot, snapshotState, writeSnapshot } from "./snapshots.js";
import { type Collector, type CollectorOutput, type CollectorRun, emptyOutput } from "./types.js";

export type Ats = "greenhouse" | "lever" | "ashby";

export interface BoardRef {
  ats: Ats;
  token: string;
  /** Lever EU accounts use api.eu.lever.co. */
  eu?: boolean;
}

export interface JobPosting {
  id: string;
  title: string;
  url: string;
  location: string | null;
  department: string | null;
  published_at: string | null;
}

const URL_IN_HTML = /https?:\/\/[^\s"'<>)\\]+/gi;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._%-]{0,99}$/;

function safeToken(value: string | null | undefined): string | null {
  if (!value) return null;
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // keep as is
  }
  return TOKEN.test(decoded) ? decoded : null;
}

/** Board references found in URLs inside the HTML (links, iframes, embed scripts). */
export function findBoards(html: string): BoardRef[] {
  const boards: BoardRef[] = [];
  const add = (board: BoardRef) => {
    if (
      !boards.some(
        (b) => b.ats === board.ats && b.token.toLowerCase() === board.token.toLowerCase(),
      )
    ) {
      boards.push(board);
    }
  };
  for (const match of html.replaceAll("&amp;", "&").matchAll(URL_IN_HTML)) {
    let url: URL;
    try {
      url = new URL(match[0]);
    } catch {
      continue;
    }
    const host = url.hostname.toLowerCase();
    const segments = url.pathname.split("/").filter(Boolean);
    if (/^(boards|job-boards)(\.eu)?\.greenhouse\.io$/.test(host)) {
      const token =
        segments[0] === "embed" ? safeToken(url.searchParams.get("for")) : safeToken(segments[0]);
      if (token) add({ ats: "greenhouse", token });
    } else if (host === "boards-api.greenhouse.io" && segments[1] === "boards") {
      const token = safeToken(segments[2]);
      if (token) add({ ats: "greenhouse", token });
    } else if (host === "jobs.lever.co" || host === "jobs.eu.lever.co") {
      const token = safeToken(segments[0]);
      if (token) add({ ats: "lever", token, eu: host === "jobs.eu.lever.co" });
    } else if (host === "jobs.ashbyhq.com") {
      const token = safeToken(segments[0]);
      if (token) add({ ats: "ashby", token });
    }
  }
  return boards;
}

/** Public board API URL. */
export function boardApiUrl(board: BoardRef): string {
  const token = encodeURIComponent(board.token);
  switch (board.ats) {
    case "greenhouse":
      return `https://boards-api.greenhouse.io/v1/boards/${token}/jobs`;
    case "lever":
      return `https://${board.eu ? "api.eu.lever.co" : "api.lever.co"}/v0/postings/${token}?mode=json`;
    case "ashby":
      return `https://api.ashbyhq.com/posting-api/job-board/${token}`;
  }
}

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const isoOrNull = (value: unknown): string | null => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/** Maps a board API response to postings. Unknown shapes yield no postings. */
export function parseBoardJobs(ats: Ats, body: unknown): JobPosting[] {
  const jobs: JobPosting[] = [];
  if (ats === "greenhouse") {
    for (const item of (record(body).jobs as unknown[] | undefined) ?? []) {
      const job = record(item);
      const title = str(job.title);
      const url = str(job.absolute_url);
      if (!title || !url || job.id === undefined) continue;
      jobs.push({
        id: String(job.id),
        title,
        url,
        location: str(record(job.location).name),
        department: str(record(((job.departments as unknown[]) ?? [])[0]).name),
        published_at: isoOrNull(job.first_published ?? job.updated_at),
      });
    }
  } else if (ats === "lever") {
    for (const item of Array.isArray(body) ? body : []) {
      const job = record(item);
      const categories = record(job.categories);
      const title = str(job.text);
      const url = str(job.hostedUrl);
      const id = str(job.id);
      if (!title || !url || !id) continue;
      jobs.push({
        id,
        title,
        url,
        location: str(categories.location),
        department: str(categories.department) ?? str(categories.team),
        published_at: isoOrNull(job.createdAt),
      });
    }
  } else {
    for (const item of (record(body).jobs as unknown[] | undefined) ?? []) {
      const job = record(item);
      if (job.isListed === false) continue;
      const title = str(job.title);
      const url = str(job.jobUrl);
      const id = str(job.id);
      if (!title || !url || !id) continue;
      jobs.push({
        id,
        title,
        url,
        location: str(job.location),
        department: str(job.department) ?? str(job.team),
        published_at: isoOrNull(job.publishedAt),
      });
    }
  }
  return jobs;
}

interface SeenState {
  job_ids: string[];
}

/** Strength grows with the number of relevant open roles: 1 -> 0.6, 3 -> 0.8, 5+ -> 1.0. */
export function hiringStrength(relevantCount: number): number {
  return Math.min(1, Math.round((0.5 + 0.1 * Math.max(1, relevantCount)) * 100) / 100);
}

export function createJobBoardsCollector(): Collector {
  return {
    name: "job_boards",
    async collect(run: CollectorRun): Promise<CollectorOutput> {
      const { ctx, company } = run;
      const homeUrl = companyHomeUrl(company);
      const domain = companyDomain(company);
      if (!homeUrl || !domain) return emptyOutput(["job_boards: company has no website"]);
      const output = emptyOutput();

      // Board discovery: the home page, then the careers page it links to.
      const docs: FetchedDoc[] = [];
      try {
        const home = await run.pages.page(homeUrl);
        if (home.ok) docs.push(home);
        const careers = home.ok
          ? discoverKeyPages(home.body, homeUrl, domain).find((page) => page.kind === "careers")
          : undefined;
        if (careers) {
          const page = await run.pages.page(careers.url).catch((error: unknown) => {
            output.notes.push(`job_boards: careers page skipped (${fetchFailureReason(error)})`);
            return null;
          });
          if (page?.ok) docs.push(page);
        }
      } catch (error) {
        return emptyOutput([`job_boards: home page skipped (${fetchFailureReason(error)})`]);
      }
      const boards = docs.flatMap((doc) => findBoards(doc.body));
      const unique = boards.filter(
        (board, index) =>
          boards.findIndex((b) => b.ats === board.ats && b.token === board.token) === index,
      );
      if (unique.length === 0) {
        output.notes.push("job_boards: no Greenhouse, Lever or Ashby board found");
        return output;
      }

      const postings: Array<JobPosting & { ats: Ats }> = [];
      let boardsRead = 0;
      for (const board of unique.slice(0, 3)) {
        try {
          const doc = await run.pages.api(boardApiUrl(board));
          if (!doc.ok) {
            output.notes.push(
              `job_boards: ${board.ats} board ${board.token} returned ${doc.status}`,
            );
            continue;
          }
          const parsed = parseBoardJobs(board.ats, JSON.parse(doc.body));
          for (const job of parsed) postings.push({ ...job, ats: board.ats });
          boardsRead += 1;
        } catch (error) {
          output.notes.push(
            `job_boards: ${board.ats} board ${board.token} unreadable (${error instanceof SyntaxError ? "invalid_json" : fetchFailureReason(error)})`,
          );
        }
      }

      // Without one readable board there is nothing to compare: keep the last state.
      if (boardsRead === 0) return output;

      for (const job of postings.slice(0, 40)) {
        output.evidence.push({
          url: job.url,
          title: job.title,
          text: [job.title, job.department, job.location].filter(Boolean).join(" | "),
          published_at: job.published_at,
          collector: "job_boards",
        });
      }

      // New postings since the last run (first run: every open posting is new).
      const stateUrl = internalEvidenceUrl("job-boards", company.id);
      const previous = await readSnapshot(ctx, company.workspace_id, stateUrl);
      const seen = new Set(snapshotState<SeenState>(previous)?.job_ids ?? []);
      const fresh = postings.filter((job) => !seen.has(`${job.ats}:${job.id}`));

      const hiring = run.definitions.find((d) => d.key === "hiring_relevant_roles");
      if (hiring) {
        if (run.keywords.hiring.length === 0) {
          output.notes.push(
            "job_boards: no role keywords; set keywords on hiring_relevant_roles or ICP personas",
          );
        } else {
          const relevant = postings.filter(
            (job) => matchingKeywords(job.title, run.keywords.hiring).length > 0,
          );
          const newRelevant = fresh.filter((job) => relevant.includes(job));
          const first = newRelevant[0];
          if (first) {
            const titles = [...newRelevant, ...relevant.filter((job) => !newRelevant.includes(job))]
              .map((job) => job.title)
              .filter((title, index, all) => all.indexOf(title) === index);
            const keywords = [
              ...new Set(
                relevant.flatMap((job) => matchingKeywords(job.title, run.keywords.hiring)),
              ),
            ];
            const newest = newRelevant
              .map((job) => job.published_at)
              .filter((date): date is string => Boolean(date))
              .sort()
              .at(-1);
            const signal: RawSignal = {
              definition_key: "hiring_relevant_roles",
              title: `Hiring ${relevant.length} relevant role${relevant.length === 1 ? "" : "s"}: ${titles.slice(0, 3).join(", ")}${titles.length > 3 ? ", ..." : ""}`,
              summary: `${newRelevant.length} new open role${newRelevant.length === 1 ? "" : "s"} matching ${keywords.join(", ")} on their ${first.ats} job board (${relevant.length} relevant of ${postings.length} open).`,
              evidence_url: first.url,
              evidence_excerpt: [first.title, first.location].filter(Boolean).join(" - "),
              source: "job_boards",
              occurred_at: newest ?? ctx.clock.now().toISOString(),
              strength: hiringStrength(relevant.length),
              raw: {
                ats: first.ats,
                relevant_count: relevant.length,
                open_count: postings.length,
                titles: titles.slice(0, 20),
                new_job_ids: newRelevant.map((job) => job.id).slice(0, 50),
              },
            };
            output.signals.push(signal);
          }
        }
      }

      const competitor = run.definitions.find((d) => d.key === "competitor_mention");
      if (competitor && run.keywords.competitors.length > 0) {
        for (const job of fresh) {
          const names = matchingKeywords(job.title, run.keywords.competitors);
          if (names.length === 0) continue;
          output.signals.push({
            definition_key: "competitor_mention",
            title: `Job post names ${names.join(", ")}: ${job.title}`,
            summary: `An open role mentions ${names.join(", ")}, so the tool is in use or under evaluation.`,
            evidence_url: job.url,
            evidence_excerpt: job.title,
            source: "job_boards",
            occurred_at: job.published_at ?? ctx.clock.now().toISOString(),
            strength: 0.6,
          });
        }
      }

      await writeSnapshot(ctx, {
        workspaceId: company.workspace_id,
        companyId: company.id,
        url: stateUrl,
        text: JSON.stringify({
          job_ids: [...new Set([...postings.map((job) => `${job.ats}:${job.id}`)])].sort(),
        } satisfies SeenState),
        previous,
      });
      return output;
    },
  };
}
