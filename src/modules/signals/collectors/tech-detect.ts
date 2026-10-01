/**
 * tech_detect collector: fingerprints the home page (HTML, script src, meta generator,
 * headers, cookies) and DNS (MX, TXT), keeps the detected set in a snapshot and reports the
 * difference: tech_adopted right away, tech_removed only after the tool was missing on two
 * checks at least 7 days apart. Competitors that appear become competitor_mention. DNS goes
 * through ctx.dns (faked in tests), like pages go through ctx.fetch.
 */
import type { DnsResolver } from "../../../core/context.js";
import type { RawSignal } from "../../../providers/types.js";
import { internalEvidenceUrl } from "../evidence.js";
import {
  BUSINESS_CATEGORIES,
  type DetectedTech,
  detectTechnologies,
  FINGERPRINTS,
  type TechCategory,
} from "./fingerprints.js";
import { companyDomain, companyHomeUrl, fetchFailureReason, matchingKeywords } from "./pages.js";
import { readSnapshot, snapshotState, writeSnapshot } from "./snapshots.js";
import { type Collector, type CollectorOutput, type CollectorRun, emptyOutput } from "./types.js";

const REMOVAL_CONFIRM_MS = 7 * 86_400_000;
const CATEGORY_BY_NAME = new Map<string, TechCategory>(
  FINGERPRINTS.map((fingerprint) => [fingerprint.name, fingerprint.category]),
);

/** MX hosts (lowercase) and TXT records of a domain; a failed lookup counts as no records. */
export async function dnsRecords(
  dns: DnsResolver,
  domain: string,
): Promise<{ mx: string[]; txt: string[] }> {
  const [mx, txt] = await Promise.all([
    dns.resolveMx(domain).then(
      (records) => records.map((record) => record.exchange.toLowerCase()),
      () => [],
    ),
    dns.resolveTxt(domain).then(
      (records) => records.map((parts) => parts.join("")),
      () => [],
    ),
  ]);
  return { mx, txt };
}

interface TechState {
  present: string[];
  /** Tech name -> ISO time it was first missing (removal pending confirmation). */
  missing_since: Record<string, string>;
}

export interface TechDiff {
  adopted: string[];
  removed: string[];
  state: TechState;
}

/** Applies one detection to the stored state (pure; exported for tests). */
export function diffTechnologies(
  previous: TechState | null,
  detected: readonly string[],
  now: Date,
): TechDiff {
  if (!previous)
    return { adopted: [], removed: [], state: { present: [...detected], missing_since: {} } };
  const current = new Set(detected);
  const present = new Set(previous.present);
  const missingSince = { ...previous.missing_since };
  const adopted = detected.filter((name) => !present.has(name));
  const removed: string[] = [];
  for (const name of previous.present) {
    if (current.has(name)) {
      delete missingSince[name];
      continue;
    }
    const since = missingSince[name];
    if (!since) {
      missingSince[name] = now.toISOString();
    } else if (now.getTime() - new Date(since).getTime() >= REMOVAL_CONFIRM_MS) {
      removed.push(name);
      present.delete(name);
      delete missingSince[name];
    }
  }
  for (const name of adopted) present.add(name);
  return {
    adopted,
    removed,
    state: { present: [...present].sort(), missing_since: missingSince },
  };
}

function relevance(tech: DetectedTech, keywords: readonly string[]): number {
  if (keywords.length > 0) return matchingKeywords(tech.name, keywords).length > 0 ? 1 : 0;
  return BUSINESS_CATEGORIES.has(tech.category) ? 0.3 : 0;
}

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

export function createTechDetectCollector(): Collector {
  return {
    name: "tech_detect",
    async collect(run: CollectorRun): Promise<CollectorOutput> {
      const { ctx, company } = run;
      const homeUrl = companyHomeUrl(company);
      const domain = companyDomain(company);
      if (!homeUrl || !domain) return emptyOutput(["tech_detect: company has no website"]);
      let page: Awaited<ReturnType<typeof run.pages.page>>;
      try {
        page = await run.pages.page(homeUrl);
      } catch (error) {
        return emptyOutput([`tech_detect: home page skipped (${fetchFailureReason(error)})`]);
      }
      // A failed fetch would look like every tool disappeared: skip the check instead.
      if (!page.ok) return emptyOutput([`tech_detect: home page returned ${page.status}`]);
      const { mx, txt } = await dnsRecords(ctx.dns, domain);
      const detected = detectTechnologies({ html: page.body, headers: page.headers, mx, txt });
      const byName = new Map(detected.map((tech) => [tech.name, tech]));

      const stateUrl = internalEvidenceUrl("tech", company.id);
      const previous = await readSnapshot(ctx, company.workspace_id, stateUrl);
      const now = ctx.clock.now();
      const diff = diffTechnologies(
        snapshotState<TechState>(previous),
        detected.map((tech) => tech.name),
        now,
      );
      await writeSnapshot(ctx, {
        workspaceId: company.workspace_id,
        companyId: company.id,
        url: stateUrl,
        text: JSON.stringify(diff.state),
        previous,
      });

      const output = emptyOutput();
      output.evidence.push({
        url: homeUrl,
        title: "Technologies detected on the website and DNS",
        text: [
          `Detected: ${detected.map((tech) => `${tech.name} (${tech.category})`).join(", ") || "none"}`,
          `MX: ${mx.join(", ") || "none"}`,
          `SPF: ${txt.filter((record) => record.toLowerCase().startsWith("v=spf1")).join(" | ") || "none"}`,
          diff.adopted.length > 0 ? `Newly detected: ${diff.adopted.join(", ")}` : null,
          diff.removed.length > 0 ? `No longer detected: ${diff.removed.join(", ")}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
        published_at: now.toISOString(),
        collector: "tech_detect",
      });

      const wants = (key: string) => run.definitions.some((definition) => definition.key === key);
      const day = now.toISOString().slice(0, 10);
      const signal = (
        key: string,
        name: string,
        change: "adopted" | "removed",
        strength: number,
      ): RawSignal => ({
        definition_key: key,
        title:
          change === "adopted"
            ? key === "competitor_mention"
              ? `Started using ${name} (a competitor)`
              : `Started using ${name}`
            : `Stopped using ${name}`,
        summary:
          change === "adopted"
            ? `${name} was detected on ${domain} for the first time.`
            : `${name} was missing from ${domain} on two checks at least 7 days apart.`,
        evidence_url: homeUrl,
        evidence_excerpt: `${change === "adopted" ? "Detected" : "No longer detected"}: ${name} (${byName.get(name)?.category ?? "tool"})`,
        source: "tech_detect",
        occurred_at: now.toISOString(),
        strength,
        dedupe_key: `tech:${company.id}:${slug(name)}:${change}:${day}`,
      });

      for (const name of diff.adopted) {
        const tech = byName.get(name);
        if (!tech) continue;
        const strength = relevance(tech, run.keywords.tech);
        if (strength > 0 && wants("tech_adopted"))
          output.signals.push(signal("tech_adopted", name, "adopted", strength));
        if (
          wants("competitor_mention") &&
          matchingKeywords(name, run.keywords.competitors).length > 0
        ) {
          output.signals.push(signal("competitor_mention", name, "adopted", 0.8));
        }
      }
      for (const name of diff.removed) {
        const tech: DetectedTech = { name, category: CATEGORY_BY_NAME.get(name) ?? "framework" };
        const strength = relevance(tech, run.keywords.tech);
        if (strength > 0 && wants("tech_removed"))
          output.signals.push(signal("tech_removed", name, "removed", strength));
      }
      return output;
    },
  };
}
