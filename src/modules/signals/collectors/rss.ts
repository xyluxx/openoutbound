/**
 * rss collector: discovers the company's feeds from `<link rel="alternate">` on its home page
 * (RSS 2.0, Atom, JSON Feed), finds items not seen before, and lets the brain map them to
 * built-in definitions (news_mention, leadership_content, funding_round, ...).
 */
import { load } from "cheerio";
import { and, eq } from "drizzle-orm";
import { people } from "../../../db/schema/index.js";
import { extractMeta, htmlToText } from "../../../lib/web/extract.js";
import { canonicalEvidenceUrl, clip, internalEvidenceUrl } from "../evidence.js";
import { builtinDefinitionsFor, type CandidateItem, classifyItemsToSignals } from "./items.js";
import { companyHomeUrl, fetchFailureReason } from "./pages.js";
import { readSnapshot, snapshotState, writeSnapshot } from "./snapshots.js";
import { type Collector, type CollectorOutput, type CollectorRun, emptyOutput } from "./types.js";

const MAX_FEEDS = 3;
const NEW_ITEM_MAX_AGE_DAYS = 60;
const DAY_MS = 86_400_000;

export interface FeedItem extends CandidateItem {
  id: string;
}

const text = (value: string | undefined | null) => (value ?? "").replace(/\s+/g, " ").trim();

function toIso(value: string | undefined | null): string | null {
  if (!value) return null;
  const date = new Date(value.trim());
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function resolveUrl(href: string, base: string): string | null {
  try {
    const url = canonicalEvidenceUrl(new URL(href.trim(), base).toString());
    return url && !url.startsWith("openoutbound:") ? url : null;
  } catch {
    return null;
  }
}

function snippet(value: string | undefined | null): string | null {
  const raw = value ?? "";
  const plain = raw.includes("<") ? htmlToText(raw).text : raw;
  return clip(plain, 500);
}

/** Items of an RSS 2.0, Atom or JSON Feed document. Unknown formats yield no items. */
export function parseFeed(body: string, feedUrl: string): FeedItem[] {
  const trimmed = body.trim();
  const items: FeedItem[] = [];
  if (trimmed.startsWith("{")) {
    try {
      const feed = JSON.parse(trimmed) as { items?: unknown };
      for (const raw of Array.isArray(feed.items) ? feed.items : []) {
        const item = raw as Record<string, unknown>;
        const url = typeof item.url === "string" ? resolveUrl(item.url, feedUrl) : null;
        const title = text(typeof item.title === "string" ? item.title : "");
        if (!url || !title) continue;
        const author = (item.authors as Array<{ name?: string }> | undefined)?.[0]?.name;
        items.push({
          id: typeof item.id === "string" ? item.id : url,
          url,
          title,
          date: toIso(typeof item.date_published === "string" ? item.date_published : null),
          snippet: snippet(
            typeof item.summary === "string"
              ? item.summary
              : typeof item.content_text === "string"
                ? item.content_text
                : null,
          ),
          author: author ? text(author) : null,
        });
      }
    } catch {
      return [];
    }
    return items;
  }
  if (!trimmed.startsWith("<")) return [];
  const $ = load(trimmed, { xml: true });
  $("item").each((_, element) => {
    const node = $(element);
    const url = resolveUrl(text(node.children("link").first().text()), feedUrl);
    const title = text(node.children("title").first().text());
    if (!url || !title) return;
    const guid = text(node.children("guid").first().text());
    items.push({
      id: guid || url,
      url,
      title,
      date: toIso(node.children("pubDate").first().text() || node.find("dc\\:date").first().text()),
      snippet: snippet(node.children("description").first().text()),
      author:
        text(node.find("dc\\:creator").first().text() || node.children("author").first().text()) ||
        null,
    });
  });
  $("entry").each((_, element) => {
    const node = $(element);
    const link =
      node.children('link[rel="alternate"]').first().attr("href") ??
      node.children("link").first().attr("href") ??
      "";
    const url = resolveUrl(link, feedUrl);
    const title = text(node.children("title").first().text());
    if (!url || !title) return;
    items.push({
      id: text(node.children("id").first().text()) || url,
      url,
      title,
      date: toIso(
        node.children("published").first().text() || node.children("updated").first().text(),
      ),
      snippet: snippet(
        node.children("summary").first().text() || node.children("content").first().text(),
      ),
      author: text(node.children("author").first().children("name").first().text()) || null,
    });
  });
  return items;
}

interface FeedState {
  item_ids: string[];
}

export function createRssCollector(): Collector {
  return {
    name: "rss",
    async collect(run: CollectorRun): Promise<CollectorOutput> {
      const { ctx, company } = run;
      const homeUrl = companyHomeUrl(company);
      if (!homeUrl) return emptyOutput(["rss: company has no website"]);
      let feeds: string[];
      try {
        const home = await run.pages.page(homeUrl);
        if (!home.ok) return emptyOutput([`rss: home page returned ${home.status}`]);
        feeds = extractMeta(home.body, homeUrl).feeds.slice(0, MAX_FEEDS);
      } catch (error) {
        return emptyOutput([`rss: home page skipped (${fetchFailureReason(error)})`]);
      }
      if (feeds.length === 0) return emptyOutput(["rss: no feed linked from the home page"]);

      const output = emptyOutput();
      const now = ctx.clock.now();
      const fresh: FeedItem[] = [];
      const pendingState: Array<Parameters<typeof writeSnapshot>[1]> = [];
      for (const feedUrl of feeds) {
        let items: FeedItem[];
        try {
          const doc = await run.pages.page(feedUrl);
          if (!doc.ok) {
            output.notes.push(`rss: ${feedUrl} returned ${doc.status}`);
            continue;
          }
          items = parseFeed(doc.body, feedUrl);
        } catch (error) {
          output.notes.push(`rss: ${feedUrl} skipped (${fetchFailureReason(error)})`);
          continue;
        }
        const stateUrl = internalEvidenceUrl("rss", feedUrl);
        const previous = await readSnapshot(ctx, company.workspace_id, stateUrl);
        const state = snapshotState<FeedState>(previous);
        const seen = new Set(state?.item_ids ?? []);
        for (const item of items.slice(0, 30)) {
          output.evidence.push({
            url: item.url,
            title: item.title,
            text: [item.title, item.snippet].filter(Boolean).join("\n"),
            published_at: item.date,
            collector: "rss",
          });
          const time = item.date ? new Date(item.date).getTime() : null;
          const isNew = state
            ? !seen.has(item.id) &&
              (time === null || time >= now.getTime() - NEW_ITEM_MAX_AGE_DAYS * DAY_MS)
            : time !== null && time >= run.since.getTime();
          if (isNew && !fresh.some((other) => other.url === item.url)) fresh.push(item);
        }
        pendingState.push({
          workspaceId: company.workspace_id,
          companyId: company.id,
          url: stateUrl,
          text: JSON.stringify({
            item_ids: [...new Set([...items.map((item) => item.id), ...seen])].slice(0, 500),
          } satisfies FeedState),
          previous,
        });
      }

      const team = await ctx.db
        .select({ full_name: people.full_name, title: people.title })
        .from(people)
        .where(
          and(eq(people.workspace_id, company.workspace_id), eq(people.company_id, company.id)),
        )
        .limit(20);
      const classified = await classifyItemsToSignals(run, {
        collector: "rss",
        source: "feed",
        items: fresh,
        candidates: builtinDefinitionsFor(run.definitions, "rss"),
        people: team
          .filter((person) => person.full_name)
          .map((person) => ({ name: person.full_name ?? "", title: person.title })),
      });
      output.signals.push(...classified.signals);
      output.brainCalls += classified.brainCalls;
      // Items become "seen" only after classification succeeded (a failed call retries them).
      for (const state of pendingState) await writeSnapshot(ctx, state);
      return output;
    },
  };
}
