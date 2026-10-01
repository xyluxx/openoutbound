/**
 * HubSpot CRM (private app token, `Authorization: Bearer`). Provider API notes, section 12:
 * contacts upsert by email through `POST /crm/v3/objects/contacts/batch/upsert`, companies
 * are found by domain (search) or created, deals are created or patched by id, and records are
 * linked with the v4 default associations (`PUT /crm/v4/objects/.../associations/default/...`),
 * which avoids hardcoding association type ids. Notes are `POST /crm/v3/objects/notes`
 * (`hs_note_body`, `hs_timestamp`) linked the same way; `deleteContact` is the GDPR delete.
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
  dealDescription,
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
  id: "hubspot",
  name: "HubSpot",
  secret: "access_token",
  env: "HUBSPOT_ACCESS_TOKEN",
};
const DEFAULT_BASE = "https://api.hubapi.com";

const configSchema = z.object({
  base_url: z
    .url({ protocol: /^https?$/ })
    .optional()
    .describe("Default https://api.hubapi.com"),
  pipeline: z.string().min(1).default("default").describe("Deal pipeline id"),
  stage_map: z
    .object({
      interested: z.string().min(1).default("qualifiedtobuy"),
      meeting_booked: z.string().min(1).default("presentationscheduled"),
      won: z.string().min(1).default("closedwon"),
      lost: z.string().min(1).default("closedlost"),
    })
    .prefault({})
    .describe("Opportunity stage -> HubSpot dealstage internal id (defaults: sales pipeline)"),
  send_currency: z
    .boolean()
    .default(false)
    .describe("Set deal_currency_code (only for portals with multiple currencies)"),
});
export type HubSpotConfig = z.infer<typeof configSchema>;

type ObjectType = "contacts" | "companies" | "deals" | "notes";

interface SearchFilter {
  propertyName: string;
  operator: "EQ";
  value: string;
}

/** Contact properties; blanks are left out so HubSpot keeps its own values. */
export function hubspotContactProperties(
  person: Person,
  company: Company | null | undefined,
): Record<string, unknown> {
  return compact({
    email: person.email,
    firstname: person.first_name,
    lastname: person.last_name ?? (person.first_name ? null : person.full_name),
    jobtitle: person.title,
    phone: person.phone,
    city: person.city,
    country: person.country,
    company: company?.name,
    website: company?.website,
  });
}

/** Company properties. `industry` is left out: HubSpot only accepts its own enumeration values. */
export function hubspotCompanyProperties(company: Company): Record<string, unknown> {
  return compact({
    name: company.name,
    domain: company.domain,
    website: company.website,
    city: company.city,
    country: company.country,
    phone: company.phone,
  });
}

/**
 * Deal properties; `dealname` is only sent on create so a renamed deal keeps its name. With
 * `keepStage` (an existing deal under `crm.stage_owner: crm`) the pipeline, stage and close
 * date are left to HubSpot.
 */
export function hubspotDealProperties(
  opportunity: Opportunity,
  config: HubSpotConfig,
  dealname: string | null,
  keepStage = false,
): Record<string, unknown> {
  const closed = opportunity.stage === "won" || opportunity.stage === "lost";
  return compact({
    dealname,
    pipeline: keepStage ? null : config.pipeline,
    dealstage: keepStage ? null : config.stage_map[opportunity.stage],
    amount: opportunity.value === null ? null : String(opportunity.value),
    deal_currency_code: config.send_currency ? opportunity.currency : null,
    closedate:
      !keepStage && closed ? (opportunity.closed_at ?? opportunity.updated_at).toISOString() : null,
    description: dealDescription(opportunity),
  });
}

/** Note properties: when it happened and the formatted text (HubSpot note bodies are HTML). */
export function hubspotNoteProperties(entry: CrmActivity): Record<string, unknown> {
  return { hs_timestamp: entry.occurredAt.toISOString(), hs_note_body: activityHtml(entry) };
}

/**
 * Filters for "the deal of this contact with exactly this name". `associations.contact` is the
 * search pseudo-property for associated records. UNVERIFIED against a live portal; the shape is
 * covered by the fixture `hubspot-deals-search.json`.
 */
export function hubspotDealSearchFilters(contactId: string, title: string): SearchFilter[] {
  return [
    { propertyName: "associations.contact", operator: "EQ", value: contactId },
    { propertyName: "dealname", operator: "EQ", value: title },
  ];
}

function recordId(json: unknown, what: string): string {
  const id = isObject(json) ? idOf(json.id) : null;
  if (!id) throw malformed(INFO, `${what} id missing`);
  return id;
}

export function createHubSpot(
  config: HubSpotConfig,
  secrets: Record<string, string>,
  runtime: Pick<ProviderRuntime, "fetch">,
): CrmProvider & { checkAuth(): ReturnType<typeof probeAuth> } {
  const token = requireSecret(INFO, secrets);
  const base = baseUrl(config.base_url, DEFAULT_BASE);
  const headers = { authorization: `Bearer ${token}` };
  const labels = new LabelCache();

  /** Contacts, companies and deals are looked up before a create; notes cannot be. */
  const createObject = async (type: ObjectType, properties: Record<string, unknown>) =>
    recordId(
      await requestJson(runtime, INFO, {
        method: "POST",
        url: `${base}/crm/v3/objects/${type}`,
        headers,
        body: { properties },
        ...(type === "notes" ? ONE_TIME_WRITE : SAFE_WRITE),
      }),
      type,
    );

  /** PATCH by id; false when the record no longer exists in HubSpot. */
  const updateObject = async (type: ObjectType, id: string, properties: Record<string, unknown>) =>
    (await requestJsonOrMissing(runtime, INFO, {
      method: "PATCH",
      url: `${base}/crm/v3/objects/${type}/${encodeURIComponent(id)}`,
      headers,
      body: { properties },
      ...SAFE_WRITE,
    })) !== undefined;

  /** Id of the first record matching every filter, or null. */
  const searchFirst = async (
    type: ObjectType,
    filters: SearchFilter[],
    properties: string[],
  ): Promise<string | null> => {
    const json = await requestJson(runtime, INFO, {
      method: "POST",
      url: `${base}/crm/v3/objects/${type}/search`,
      headers,
      body: { filterGroups: [{ filters }], properties, limit: 1 },
    });
    // Read as "no match", an answer without results would create a duplicate record.
    if (!isObject(json) || !Array.isArray(json.results)) {
      throw malformed(INFO, `${type} search results missing`);
    }
    const first = json.results[0];
    return isObject(first) ? idOf(first.id) : null;
  };

  const findCompanyByDomain = (domain: string) =>
    searchFirst(
      "companies",
      [{ propertyName: "domain", operator: "EQ", value: domain }],
      ["domain", "name"],
    );

  const upsertContactByEmail = async (email: string, properties: Record<string, unknown>) => {
    const json = await requestJson(runtime, INFO, {
      method: "POST",
      url: `${base}/crm/v3/objects/contacts/batch/upsert`,
      headers,
      body: { inputs: [{ idProperty: "email", id: email, properties }] },
      ...SAFE_WRITE,
    });
    const results = isObject(json) && Array.isArray(json.results) ? json.results : [];
    return recordId(results[0], "contact");
  };

  const associate = async (from: ObjectType, fromId: string, to: ObjectType, toId: string) => {
    await requestJson(runtime, INFO, {
      method: "PUT",
      url: `${base}/crm/v4/objects/${from}/${encodeURIComponent(fromId)}/associations/default/${to}/${encodeURIComponent(toId)}`,
      headers,
      ...SAFE_WRITE,
    });
  };

  return {
    id: INFO.id,
    async upsertContact(person, company, existing) {
      let companyId: string | undefined;
      if (company) {
        const properties = hubspotCompanyProperties(company);
        if (
          existing?.companyId &&
          (await updateObject("companies", existing.companyId, properties))
        ) {
          companyId = existing.companyId;
        }
        if (!companyId && company.domain) {
          companyId = (await findCompanyByDomain(company.domain)) ?? undefined;
        }
        companyId ??= await createObject("companies", properties);
        labels.remember(companyId, company.name);
      }

      const properties = hubspotContactProperties(person, company);
      let contactId: string | undefined;
      if (person.email) {
        contactId = await upsertContactByEmail(person.email, properties);
      } else if (
        existing?.contactId &&
        (await updateObject("contacts", existing.contactId, properties))
      ) {
        contactId = existing.contactId;
      } else {
        contactId = await createObject("contacts", properties);
      }
      labels.remember(contactId, displayName(person));

      if (companyId && (contactId !== existing?.contactId || companyId !== existing?.companyId)) {
        await associate("contacts", contactId, "companies", companyId);
      }
      return companyId ? { contactId, companyId } : { contactId };
    },

    async upsertDeal(opportunity, links, options = {}) {
      if (links.dealId) {
        const properties = hubspotDealProperties(opportunity, config, null, options.keepStage);
        if (await updateObject("deals", links.dealId, properties)) return { dealId: links.dealId };
      }
      // A new deal (or one deleted in HubSpot) always gets the stage: it has none yet.
      const dealname = options.title ?? labels.dealTitle(links, opportunity.id);
      const dealId = await createObject(
        "deals",
        hubspotDealProperties(opportunity, config, dealname),
      );
      if (links.contactId) await associate("deals", dealId, "contacts", links.contactId);
      if (links.companyId) await associate("deals", dealId, "companies", links.companyId);
      return { dealId };
    },

    findContactByEmail: (email) =>
      searchFirst(
        "contacts",
        [{ propertyName: "email", operator: "EQ", value: email.trim() }],
        ["email"],
      ),

    findDealForContact: (contactId, title) =>
      searchFirst("deals", hubspotDealSearchFilters(contactId, title), ["dealname"]),

    async logActivity(entry) {
      const noteId = await createObject("notes", hubspotNoteProperties(entry));
      await associate("notes", noteId, "contacts", entry.contactId);
      if (entry.dealId) await associate("notes", noteId, "deals", entry.dealId);
      if (entry.companyId) await associate("notes", noteId, "companies", entry.companyId);
      return { activityId: noteId };
    },

    async deleteContact(contactId) {
      // GDPR delete: permanent, unlike an archive. A 404 means it is already gone.
      const json = await requestJsonOrMissing(runtime, INFO, {
        method: "POST",
        url: `${base}/crm/v3/objects/contacts/gdpr-delete`,
        headers,
        body: { objectId: contactId },
        ...SAFE_WRITE,
      });
      return { deleted: json !== undefined };
    },

    checkAuth: () =>
      probeAuth(runtime, INFO, { url: `${base}/crm/v3/objects/contacts?limit=1`, headers }),
  };
}

export const hubspotProvider = defineProvider({
  slot: "crm",
  id: INFO.id,
  name: "HubSpot",
  description:
    "Syncs leads and opportunities to HubSpot: contacts (upsert by email), companies (matched by domain), deals in your pipeline with mapped stages, and notes for replies, meetings and emails when crm.log asks for them. Needs a private app token with crm.objects.contacts, companies and deals read/write scopes.",
  docsUrl: "https://developers.hubspot.com/docs/api-reference/crm-contacts-v3/guide",
  configSchema,
  secrets: [
    {
      key: INFO.secret,
      label: "Private app access token",
      env: INFO.env,
      required: true,
      description: "HubSpot > Settings > Integrations > Private apps",
    },
  ],
  create: ({ config, secrets, ctx }) => createHubSpot(config, secrets, ctx),
  test: (instance) => (instance as ReturnType<typeof createHubSpot>).checkAuth(),
});
