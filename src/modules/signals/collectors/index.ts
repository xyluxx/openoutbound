import type { BuiltinCollector } from "../catalog.js";
import { createFirstPartyCollector } from "./first-party.js";
import { createJobBoardsCollector } from "./job-boards.js";
import { createNewsGdeltCollector, type GdeltOptions } from "./news-gdelt.js";
import { createRssCollector } from "./rss.js";
import { createTechDetectCollector } from "./tech-detect.js";
import type { Collector } from "./types.js";
import { createWebsiteChangesCollector } from "./website-changes.js";

export type CollectorSet = Record<BuiltinCollector, Collector>;

/** A fresh set of the built-in collectors (tests pass GDELT spacing). */
export function builtinCollectors(options: { gdelt?: GdeltOptions } = {}): CollectorSet {
  return {
    website_changes: createWebsiteChangesCollector(),
    job_boards: createJobBoardsCollector(),
    news_gdelt: createNewsGdeltCollector(options.gdelt),
    rss: createRssCollector(),
    tech_detect: createTechDetectCollector(),
    first_party: createFirstPartyCollector(),
  };
}

let shared: CollectorSet | undefined;

/** The process-wide set (one GDELT rate gate per process). */
export function defaultCollectors(): CollectorSet {
  shared ??= builtinCollectors();
  return shared;
}
