/**
 * Generic CRM webhook: POSTs contact and deal upserts, notes (`crm.activity`) and contact
 * deletions (`crm.contact.delete`) as JSON to your endpoint (Zapier, Make, n8n or your own
 * service), signed like engine webhooks:
 * `OpenOutbound-Signature: t=<unix>,v1=<hex hmac-sha256(secret, t + "." + body)>`.
 * The endpoint may answer `{ contact_id?, company_id? }`, `{ deal_id? }` or `{ activity_id? }`
 * to store its own ids; otherwise the OpenOutbound ids are used, so later updates carry a stable
 * reference. It cannot be searched, so the finders return null. Requests go through safe fetch
 * (the URL is user data).
 */
import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import type { Company, Opportunity, Person } from "../../db/schema/index.js";
import { type CallKind, malformedFailure } from "../http.js";
import {
  type CrmActivity,
  type CrmProvider,
  defineProvider,
  type ProviderRuntime,
} from "../types.js";
import { activityBody } from "./activity.js";
import {
  type CrmInfo,
  crmStyle,
  httpError,
  idOf,
  isObject,
  ONE_TIME_WRITE,
  SAFE_WRITE,
  sendFailure,
} from "./http.js";

const INFO: CrmInfo = {
  id: "webhook",
  name: "CRM webhook",
  secret: "signing_secret",
  env: "CRM_WEBHOOK_SIGNING_SECRET",
};
export const CRM_SIGNATURE_HEADER = "OpenOutbound-Signature";
const TIMEOUT_MS = 10_000;

const configSchema = z.object({
  url: z.url({ protocol: /^https$/ }).describe("https:// endpoint that accepts POST"),
});
export type CrmWebhookConfig = z.infer<typeof configSchema>;

export type CrmWebhookEvent =
  | "crm.contact.upsert"
  | "crm.deal.upsert"
  | "crm.activity"
  | "crm.contact.delete"
  | "crm.test";

export function signCrmPayload(secret: string, body: string, timestampSeconds: number): string {
  const digest = createHmac("sha256", secret).update(`${timestampSeconds}.${body}`).digest("hex");
  return `t=${timestampSeconds},v1=${digest}`;
}

/** Person fields sent to the endpoint (no internal scoring or source data). */
export function webhookPerson(person: Person) {
  return {
    id: person.id,
    first_name: person.first_name,
    last_name: person.last_name,
    full_name: person.full_name,
    email: person.email,
    title: person.title,
    phone: person.phone,
    linkedin_url: person.linkedin_url,
    city: person.city,
    country: person.country,
    status: person.status,
  };
}

export function webhookCompany(company: Company) {
  return {
    id: company.id,
    name: company.name,
    domain: company.domain,
    website: company.website,
    industry: company.industry,
    employee_count: company.employee_count,
    city: company.city,
    country: company.country,
  };
}

export function webhookOpportunity(opportunity: Opportunity) {
  return {
    id: opportunity.id,
    stage: opportunity.stage,
    value: opportunity.value,
    currency: opportunity.currency,
    meeting_at: opportunity.meeting_at?.toISOString() ?? null,
    lost_reason: opportunity.lost_reason,
    notes: opportunity.notes,
    source_signal_keys: opportunity.source_signal_keys,
    person_id: opportunity.person_id,
    company_id: opportunity.company_id,
    campaign_id: opportunity.campaign_id,
    closed_at: opportunity.closed_at?.toISOString() ?? null,
    created_at: opportunity.created_at.toISOString(),
    updated_at: opportunity.updated_at.toISOString(),
  };
}

/** Note fields sent with `crm.activity` (the body is plain text, at most 2000 characters). */
export function webhookActivity(entry: CrmActivity) {
  return {
    kind: entry.kind,
    contact_id: entry.contactId,
    deal_id: entry.dealId ?? null,
    company_id: entry.companyId ?? null,
    subject: entry.subject?.trim() || null,
    body: activityBody(entry),
    occurred_at: entry.occurredAt.toISOString(),
  };
}

export function createCrmWebhook(
  config: CrmWebhookConfig,
  secrets: Record<string, string>,
  runtime: Pick<ProviderRuntime, "safeFetch" | "clock" | "workspaceId">,
): CrmProvider & { ping(): Promise<{ ok: boolean; message: string }> } {
  const secret = secrets[INFO.secret]?.trim() || null;

  /**
   * Upserts and deletes carry stable OpenOutbound ids, so a receiver can apply them twice
   * safely; an activity has no key to match, so a lost answer is never sent again.
   */
  const post = async (type: CrmWebhookEvent, data: Record<string, unknown>): Promise<unknown> => {
    const kind: CallKind = type === "crm.activity" ? ONE_TIME_WRITE : SAFE_WRITE;
    const now = runtime.clock.now();
    const body = JSON.stringify({
      id: `crmwh_${randomBytes(12).toString("base64url")}`,
      type,
      occurred_at: now.toISOString(),
      workspace_id: runtime.workspaceId,
      data,
    });
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "OpenOutbound",
      "OpenOutbound-Event": type,
    };
    if (secret) {
      headers[CRM_SIGNATURE_HEADER] = signCrmPayload(
        secret,
        body,
        Math.floor(now.getTime() / 1000),
      );
    }
    let response: Awaited<ReturnType<typeof runtime.safeFetch>>;
    let text: string;
    try {
      response = await runtime.safeFetch(config.url, {
        method: "POST",
        headers,
        body,
        timeoutMs: TIMEOUT_MS,
        maxRedirects: 0,
      });
    } catch (error) {
      throw sendFailure(INFO, error, kind);
    }
    try {
      text = await response.text();
    } catch (error) {
      if (response.ok) {
        throw malformedFailure(INFO, "the answer broke off", kind, crmStyle(INFO), error);
      }
      throw sendFailure(INFO, error, { ...kind, write: false });
    }
    if (!response.ok) throw httpError(INFO, response.status, response.headers, text, kind);
    try {
      return text.trim() ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  };

  const field = (json: unknown, key: string) => (isObject(json) ? idOf(json[key]) : null);

  return {
    id: INFO.id,
    async upsertContact(person, company, existing) {
      const json = await post("crm.contact.upsert", {
        person: webhookPerson(person),
        company: company ? webhookCompany(company) : null,
        existing: {
          contact_id: existing?.contactId ?? null,
          company_id: existing?.companyId ?? null,
        },
      });
      const contactId = field(json, "contact_id") ?? existing?.contactId ?? person.id;
      const companyId = company
        ? (field(json, "company_id") ?? existing?.companyId ?? company.id)
        : undefined;
      return companyId ? { contactId, companyId } : { contactId };
    },
    async upsertDeal(opportunity, links, options = {}) {
      const json = await post("crm.deal.upsert", {
        opportunity: webhookOpportunity(opportunity),
        links: {
          contact_id: links.contactId ?? null,
          company_id: links.companyId ?? null,
          deal_id: links.dealId ?? null,
        },
        title: options.title ?? null,
        // crm.stage_owner crm: an existing deal keeps the stage your CRM gave it.
        keep_stage: options.keepStage === true,
      });
      return { dealId: field(json, "deal_id") ?? links.dealId ?? opportunity.id };
    },
    findContactByEmail: async () => null,
    findDealForContact: async () => null,
    async logActivity(entry) {
      const json = await post("crm.activity", { activity: webhookActivity(entry) });
      return { activityId: field(json, "activity_id") };
    },
    async deleteContact(contactId) {
      const json = await post("crm.contact.delete", { contact_id: contactId });
      return { deleted: !(isObject(json) && json.deleted === false) };
    },
    async ping() {
      try {
        await post("crm.test", { message: "OpenOutbound CRM webhook test" });
        return { ok: true, message: "The endpoint accepted a signed test event." };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

export const crmWebhookProvider = defineProvider({
  slot: "crm",
  id: INFO.id,
  name: "CRM webhook",
  description:
    "Sends contact and deal upserts, notes and contact deletions as signed JSON POSTs to your endpoint (Zapier, Make, n8n or your own CRM bridge). Payloads include contact details; verify the OpenOutbound-Signature header with the signing secret.",
  configSchema,
  secrets: [
    {
      key: INFO.secret,
      label: "Signing secret",
      env: INFO.env,
      required: false,
      description: "Any long random string; the endpoint uses it to verify OpenOutbound-Signature",
    },
  ],
  create: ({ config, secrets, ctx }) => createCrmWebhook(config, secrets, ctx),
  test: (instance) => (instance as ReturnType<typeof createCrmWebhook>).ping(),
});
