/**
 * website_changes collector: snapshots the home, pricing, careers, locations and team pages
 * (plus same-site URLs from definitions), diffs normalized text against the previous snapshot
 * and asks the brain, once per company, which changes match enabled built-in definitions.
 */
import { htmlToText } from "../../../lib/web/extract.js";
import { clip } from "../evidence.js";
import { classifyWebsiteChange } from "../prompts/classify-website-change.js";
import { builtinDefinitionsFor } from "./items.js";
import {
  companyDomain,
  companyHomeUrl,
  diffLines,
  discoverKeyPages,
  fetchFailureReason,
  isSameSite,
  normalizeForDiff,
  type PageKind,
  sha256,
} from "./pages.js";
import { readSnapshot, writeSnapshot } from "./snapshots.js";
import {
  type Collector,
  type CollectorOutput,
  type CollectorRun,
  definitionsFor,
  emptyOutput,
  promptDefinitions,
} from "./types.js";

const MAX_PAGES = 8;
const MAX_CHANGES_PER_CALL = 5;
const EVIDENCE_CHARS = 3000;

interface WatchedPage {
  kind: PageKind | "custom";
  url: string;
}

interface PageChange {
  index: number;
  url: string;
  kind: string;
  added: string[];
  removed: string[];
  previousHash: string;
  snapshot: Parameters<typeof writeSnapshot>[1];
}

/** Same-site URLs from definitions: "/path", "{domain}" templates or absolute same-site URLs. */
export function definitionPageUrls(
  urls: readonly string[],
  homeUrl: string,
  domain: string,
): string[] {
  const out: string[] = [];
  for (const raw of urls) {
    const value = raw.trim().replaceAll("{domain}", domain);
    if (!value) continue;
    try {
      const url = value.startsWith("/") ? new URL(value, homeUrl) : new URL(value);
      if ((url.protocol === "https:" || url.protocol === "http:") && isSameSite(url.href, domain)) {
        url.hash = "";
        if (!out.includes(url.href)) out.push(url.href);
      }
    } catch {
      // not a URL
    }
  }
  return out;
}

export function createWebsiteChangesCollector(): Collector {
  return {
    name: "website_changes",
    async collect(run: CollectorRun): Promise<CollectorOutput> {
      const { ctx, company } = run;
      const homeUrl = companyHomeUrl(company);
      const domain = companyDomain(company);
      if (!homeUrl || !domain) return emptyOutput(["website_changes: company has no website"]);
      const workspaceId = company.workspace_id;
      const output = emptyOutput();
      // Built-in definitions are classified here; custom definitions only add pages to watch
      // and are judged separately over this collector's evidence (never counted twice).
      const candidates = builtinDefinitionsFor(run.definitions, "website_changes");
      const watching = definitionsFor(run.definitions, "website_changes");

      let home: Awaited<ReturnType<typeof run.pages.page>>;
      try {
        home = await run.pages.page(homeUrl);
      } catch (error) {
        return emptyOutput([`website_changes: home page skipped (${fetchFailureReason(error)})`]);
      }
      if (!home.ok) return emptyOutput([`website_changes: home page returned ${home.status}`]);

      const pages: WatchedPage[] = [{ kind: "home", url: homeUrl }];
      for (const page of discoverKeyPages(home.body, homeUrl, domain)) pages.push(page);
      const extraUrls = definitionPageUrls(
        watching.flatMap((definition) => definition.detection.urls),
        homeUrl,
        domain,
      );
      for (const url of extraUrls) {
        if (!pages.some((page) => page.url === url)) pages.push({ kind: "custom", url });
      }

      const changes: PageChange[] = [];
      for (const page of pages.slice(0, MAX_PAGES)) {
        let doc: Awaited<ReturnType<typeof run.pages.page>>;
        try {
          doc = page.url === homeUrl ? home : await run.pages.page(page.url);
        } catch (error) {
          output.notes.push(`website_changes: ${page.url} skipped (${fetchFailureReason(error)})`);
          continue;
        }
        // Error pages are not content: keep the last good snapshot.
        if (!doc.ok) {
          output.notes.push(`website_changes: ${page.url} returned ${doc.status}`);
          continue;
        }
        const { title, text } = htmlToText(doc.body);
        const lines = normalizeForDiff(text);
        const current = lines.join("\n");
        output.evidence.push({
          url: page.url,
          title: title ?? `${page.kind} page`,
          text: current.slice(0, EVIDENCE_CHARS),
          collector: "website_changes",
        });
        const previous = await readSnapshot(ctx, workspaceId, page.url);
        const diff = previous
          ? diffLines(previous.text.split("\n"), lines)
          : { added: [], removed: [] };
        const snapshot = {
          workspaceId,
          companyId: company.id,
          url: page.url,
          text: current,
          previous,
        };
        if (!previous || sha256(current) === previous.content_hash) {
          await writeSnapshot(ctx, snapshot);
          continue;
        }
        if (diff.added.length === 0 && diff.removed.length === 0) {
          // Only the order changed: accept the new version silently.
          await writeSnapshot(ctx, snapshot);
          continue;
        }
        changes.push({
          index: changes.length,
          url: page.url,
          kind: page.kind,
          ...diff,
          previousHash: previous.content_hash,
          snapshot,
        });
        output.evidence.push({
          url: page.url,
          title: `Changes on the ${page.kind} page`,
          text: ["Added:", ...diff.added, "Removed:", ...diff.removed]
            .join("\n")
            .slice(0, EVIDENCE_CHARS),
          published_at: ctx.clock.now().toISOString(),
          collector: "website_changes",
        });
      }

      const allowed = new Set(candidates.map((definition) => definition.key));
      const now = ctx.clock.now().toISOString();
      for (let start = 0; start < changes.length; start += MAX_CHANGES_PER_CALL) {
        const batch = changes.slice(start, start + MAX_CHANGES_PER_CALL);
        if (candidates.length > 0) {
          // A failed call (budget, provider) throws before the snapshots move on, so the
          // change is classified again on the next run instead of being lost.
          const result = await ctx.brain.run(
            classifyWebsiteChange,
            {
              company: { name: company.name, domain, industry: company.industry },
              changes: batch.map((change) => ({
                index: change.index,
                url: change.url,
                kind: change.kind,
                added: change.added,
                removed: change.removed,
              })),
              definitions: promptDefinitions(candidates),
            },
            { workspaceId },
          );
          output.brainCalls += 1;
          for (const match of result.output.matches) {
            const change = batch.find((candidate) => candidate.index === match.change);
            if (!change || !allowed.has(match.definition_key) || match.strength <= 0) continue;
            output.signals.push({
              definition_key: match.definition_key,
              title: clip(match.title, 300) ?? `Change on the ${change.kind} page`,
              summary: clip(match.summary, 1000),
              evidence_url: change.url,
              evidence_excerpt: clip(match.evidence_excerpt, 300),
              source: "website_changes",
              occurred_at: now,
              strength: match.strength,
              // One signal per page version, even when the same page changes again later.
              dedupe_key: `website:${company.id}:${change.url}:${change.previousHash.slice(0, 16)}`,
              raw: {
                page_kind: change.kind,
                added: change.added.length,
                removed: change.removed.length,
              },
            });
          }
        }
        for (const change of batch) await writeSnapshot(ctx, change.snapshot);
      }
      return output;
    },
  };
}
