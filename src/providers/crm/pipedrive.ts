/**
 * Pipedrive CRM (personal API token in the `x-api-token` header, v2 endpoints). Provider API
 * notes, section 12: persons and organizations are searched (exact match) before they are
 * created, deals are created or patched by id; won and lost use the deal `status`. Notes are
 * not in the v2 API, so they use v1 (`pipedriveNoteRequest`); persons are deleted with v2.
 * The universal `https://api.pipedrive.com` base is UNVERIFIED for personal tokens: set
 * `base_url` to `https://<company>.pipedrive.com` if it is rejected.
 * Each request and mapping is one small function, so it is easy to fix if the API changes.
 */
import { z } from "zod";
import type { Company, Opportunity, Person } from "../../db/schema/index.js";
import {
  type CrmActivity,
  type CrmProvider,
  defineProvider,
  type ProviderRuntime,
} from "../types.js";
import { activityHtml } from "./activity.js";
import {
  baseUrl,
  type CrmInfo,
  compact,
  displayName,
  idOf,
  isObject,
  malformed,
  ONE_TIME_WRITE,
  probeAuth,
  requestJson,
  requestJsonOrMissing,
  requireSecret,
  SAFE_WRITE,
} from "./http.js";
import { LabelCache } from "./labels.js";

const INFO: CrmInfo = {
  id: "pipedrive",
  name: "Pipedrive",
  secret: "api_token",
  env: "PIPEDRIVE_API_TOKEN",
};
const DEFAULT_BASE = "https://api.pipedrive.com";

const configSchema = z.object({
  base_url: z
    .url({ protocol: /^https?$/ })
    .optional()
    .describe("Default https://api.pipedrive.com (or https://<company>.pipedrive.com)"),
  pipeline_id: z.number().int().positive().optional().describe("Pipeline for new deals"),
  stage_map: z
    .object({
      interested: z.number().int().positive().optional(),
      meeting_booked: z.number().int().positive().optional(),
    })
    .prefault({})
    .describe("Opportunity stage -> Pipedrive stage_id for open deals (default: first stage)"),
});
export type PipedriveConfig = z.infer<typeof configSchema>;

type Entity = "persons" | "organizations" | "deals";

/** Pipedrive ids are integers; our links store them as strings. */
function numericId(value: string | null | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  return Number(value);
}

/** UTC time in the "YYYY-MM-DD HH:MM:SS" form the v1 API expects. */
function pipedriveTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

export function pipedriveOrganizationBody(company: Company): Record<string, unknown> {
  return compact({ name: company.name });
}

/** Person body; emails and phones only on create (a PATCH would replace the whole list). */
export function pipedrivePersonBody(
  person: Person,
  orgId: string | undefined,
  create: boolean,
): Record<string, unknown> {
  return compact({
    name: displayName(person),
    org_id: numericId(orgId),
    emails: create && person.email ? [{ value: person.email, primary: true, label: "work" }] : null,
    phones: create && person.phone ? [{ value: person.phone, primary: true, label: "work" }] : null,
  });
}

/**
 * Deal body; `title` only on create so a renamed deal keeps its name. With `keepStage` (an
 * existing deal under `crm.stage_owner: crm`) the status, stage and lost reason are left to
 * Pipedrive.
 */
export function pipedriveDealBody(
  opportunity: Opportunity,
  config: PipedriveConfig,
  links: { contactId?: string; companyId?: string },
  title: string | null,
  keepStage = false,
): Record<string, unknown> {
  const status =
    opportunity.stage === "won" ? "won" : opportunity.stage === "lost" ? "lost" : "open";
  const stageId =
    opportunity.stage === "interested" || opportunity.stage === "meeting_booked"
      ? config.stage_map[opportunity.stage]
      : undefined;
  return compact({
    title,
    value: opportunity.value,
    currency: opportunity.value === null ? null : opportunity.currency,
    person_id: numericId(links.contactId),
    org_id: numericId(links.companyId),
    status: keepStage ? null : status,
    stage_id: keepStage ? undefined : stageId,
    pipeline_id: title ? config.pipeline_id : undefined,
    lost_reason: !keepStage && status === "lost" ? opportunity.lost_reason : null,
  });
}

/**
 * The request that writes one activity as a note: `POST /api/v1/notes` with HTML `content`, the
 * linked person, deal and organization, and `add_time`. Notes are only in the v1 API (v2 has
 * none yet). UNVERIFIED: that v1 accepts the `x-api-token` header like v2 does; the shape is
 * covered by the fixture `pipedrive-note-create.json`.
 */
export function pipedriveNoteRequest(
  root: string,
  entry: CrmActivity,
): { url: string; body: Record<string, unknown> } {
  return {
    url: `${root}/api/v1/notes`,
    body: compact({
      content: activityHtml(entry),
      person_id: numericId(entry.contactId),
      deal_id: numericId(entry.dealId),
      org_id: numericId(entry.companyId),
      add_time: pipedriveTime(entry.occurredAt),
    }),
  };
}

/** `data.id` of a create or update response. */
function dataId(json: unknown, what: string): string {
  const data = isObject(json) && isObject(json.data) ? json.data : null;
  const id = data ? idOf(data.id) : null;
  if (!id) throw malformed(INFO, `${what} id missing`);
  return id;
}

/** `success: true, data: null`: Pipedrive's answer when nothing matched. */
function emptyAnswer(json: unknown): boolean {
  return isObject(json) && json.success === true && json.data === null;
}

/**
 * First match of a search response (`data.items[].item`). Any other shape is malformed: read
 * as "no match", it would create a duplicate record.
 */
export function firstSearchId(json: unknown): string | null {
  if (emptyAnswer(json)) return null;
  const data = isObject(json) && isObject(json.data) ? json.data : null;
  if (!data || !Array.isArray(data.items)) throw malformed(INFO, "search results missing");
  const first = data.items[0];
  return isObject(first) && isObject(first.item) ? idOf(first.item.id) : null;
}

/** Id of the deal in a deals list (`data[]`) whose title is exactly `title`, or null. */
export function dealIdWithTitle(json: unknown, title: string): string | null {
  if (emptyAnswer(json)) return null;
  if (!isObject(json) || !Array.isArray(json.data)) throw malformed(INFO, "deals list missing");
  const deals = json.data;
  const wanted = title.trim();
  for (const deal of deals) {
    if (isObject(deal) && typeof deal.title === "string" && deal.title.trim() === wanted) {
      return idOf(deal.id);
    }
  }
  return null;
}

export function createPipedrive(
  config: PipedriveConfig,
  secrets: Record<string, string>,
  runtime: Pick<ProviderRuntime, "fetch">,
): CrmProvider & { checkAuth(): ReturnType<typeof probeAuth> } {
  const token = requireSecret(INFO, secrets);
  const root = baseUrl(config.base_url, DEFAULT_BASE);
  const base = `${root}/api/v2`;
  const headers = { "x-api-token": token };
  const labels = new LabelCache();

  /** Persons, organizations and deals are looked up before a create. */
  const create = async (entity: Entity, body: Record<string, unknown>) =>
    dataId(
      await requestJson(runtime, INFO, {
        method: "POST",
        url: `${base}/${entity}`,
        headers,
        body,
        ...SAFE_WRITE,
      }),
      entity,
    );

  /** PATCH by id; false when the record was deleted in Pipedrive. */
  const update = async (entity: Entity, id: string, body: Record<string, unknown>) =>
    (await requestJsonOrMissing(runtime, INFO, {
      method: "PATCH",
      url: `${base}/${entity}/${encodeURIComponent(id)}`,
      headers,
      body,
      ...SAFE_WRITE,
    })) !== undefined;

  /** Exact-match search on one field; Pipedrive needs at least 2 characters. */
  const search = async (entity: "persons" | "organizations", field: string, term: string) => {
    if (term.trim().length < 2) return null;
    const query = new URLSearchParams({
      term: term.trim(),
      fields: field,
      exact_match: "true",
      limit: "1",
    });
    return firstSearchId(
      await requestJson(runtime, INFO, { url: `${base}/${entity}/search?${query}`, headers }),
    );
  };

  return {
    id: INFO.id,
    async upsertContact(person, company, existing) {
      let companyId: string | undefined;
      if (company) {
        const body = pipedriveOrganizationBody(company);
        if (existing?.companyId && (await update("organizations", existing.companyId, body))) {
          companyId = existing.companyId;
        }
        companyId ??=
          (await search("organizations", "name", company.name)) ??
          (await create("organizations", body));
        labels.remember(companyId, company.name);
      }

      let contactId: string | undefined;
      if (existing?.contactId) {
        const body = pipedrivePersonBody(person, companyId, false);
        if (await update("persons", existing.contactId, body)) contactId = existing.contactId;
      }
      if (!contactId && person.email) {
        const found = await search("persons", "email", person.email);
        if (
          found &&
          (await update("persons", found, pipedrivePersonBody(person, companyId, false)))
        ) {
          contactId = found;
        }
      }
      contactId ??= await create("persons", pipedrivePersonBody(person, companyId, true));
      labels.remember(contactId, displayName(person));
      return companyId ? { contactId, companyId } : { contactId };
    },

    async upsertDeal(opportunity, links, options = {}) {
      if (links.dealId) {
        const body = pipedriveDealBody(opportunity, config, links, null, options.keepStage);
        if (await update("deals", links.dealId, body)) return { dealId: links.dealId };
      }
      // A new deal (or one deleted in Pipedrive) always gets the status and stage.
      const title = options.title ?? labels.dealTitle(links, opportunity.id);
      const dealId = await create("deals", pipedriveDealBody(opportunity, config, links, title));
      return { dealId };
    },

    findContactByEmail: (email) => search("persons", "email", email),

    /**
     * The person's deals through `GET /api/v2/deals?person_id=` (UNVERIFIED filter name; the
     * fixture `pipedrive-deals-list.json` covers the shape), matched by exact title.
     */
    async findDealForContact(contactId, title) {
      const personId = numericId(contactId);
      if (personId === undefined || !title.trim()) return null;
      const query = new URLSearchParams({ person_id: String(personId), limit: "100" });
      return dealIdWithTitle(
        await requestJson(runtime, INFO, { url: `${base}/deals?${query}`, headers }),
        title,
      );
    },

    async logActivity(entry) {
      const request = pipedriveNoteRequest(root, entry);
      const json = await requestJson(runtime, INFO, {
        method: "POST",
        url: request.url,
        headers,
        body: request.body,
        // A note cannot be looked up again: never written twice after a lost answer.
        ...ONE_TIME_WRITE,
      });
      return { activityId: dataId(json, "note") };
    },

    async deleteContact(contactId) {
      // Pipedrive marks the person deleted and removes it for good after 30 days.
      const personId = numericId(contactId);
      if (personId === undefined) return { deleted: false };
      const json = await requestJsonOrMissing(runtime, INFO, {
        method: "DELETE",
        url: `${base}/persons/${personId}`,
        headers,
        ...SAFE_WRITE,
      });
      return { deleted: json !== undefined };
    },

    checkAuth: () => probeAuth(runtime, INFO, { url: `${base}/persons?limit=1`, headers }),
  };
}

export const pipedriveProvider = defineProvider({
  slot: "crm",
  id: INFO.id,
  name: "Pipedrive",
  description:
    "Syncs leads and opportunities to Pipedrive: persons (matched by email), organizations (matched by name), deals with won and lost statuses, and notes for replies, meetings and emails when crm.log asks for them. Needs a personal API token (Settings > Personal preferences > API).",
  docsUrl: "https://pipedrive.readme.io/docs/pipedrive-api-v2",
  configSchema,
  secrets: [{ key: INFO.secret, label: "API token", env: INFO.env, required: true }],
  create: ({ config, secrets, ctx }) => createPipedrive(config, secrets, ctx),
  test: (instance) => (instance as ReturnType<typeof createPipedrive>).checkAuth(),
});
