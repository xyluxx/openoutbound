/**
 * Helpers for this module's tests (no test-framework imports, so it compiles with the module).
 */
import type { OpContext } from "../../core/context.js";
import { OpenOutboundError } from "../../core/errors.js";
import type { Company, SignalDefinition } from "../../db/schema/index.js";
import { loadDefinitions } from "./catalog.js";
import { PageCache } from "./collectors/pages.js";
import type { CollectorRun, RunKeywords } from "./collectors/types.js";

/** A collector run over one company with the workspace's enabled definitions. */
export async function collectorRun(
  ctx: OpContext,
  company: Company,
  options: {
    since?: Date;
    keywords?: Partial<RunKeywords>;
    definitions?: SignalDefinition[];
  } = {},
): Promise<CollectorRun> {
  const definitions =
    options.definitions ??
    [...(await loadDefinitions(ctx.db, company.workspace_id)).values()].filter((d) => d.enabled);
  return {
    ctx,
    company,
    definitions,
    since: options.since ?? new Date(ctx.clock.now().getTime() - 30 * 86_400_000),
    keywords: { hiring: [], tech: [], competitors: [], ...options.keywords },
    pages: new PageCache(ctx.fetch),
  };
}

/** What SafeFetch throws when robots.txt disallows a URL. */
export function robotsDisallowed(url: string): OpenOutboundError {
  return new OpenOutboundError("forbidden", `robots.txt disallows ${url}`, {
    details: { reason: "robots_disallowed", url },
  });
}

/** Minimal HTML page. */
export function html(body: string, head = ""): string {
  return `<!doctype html><html lang="en"><head><title>Page</title>${head}</head><body>${body}</body></html>`;
}
