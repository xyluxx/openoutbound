import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fixedClock } from "../../core/clock.js";
import { OpenOutboundError } from "../../core/errors.js";
import { failureOf } from "../../core/failures.js";
import type { Company, Opportunity, Person } from "../../db/schema/index.js";
import { createFakeFetch, type FakeRequest, type FetchRoute } from "../../testing/fake-fetch.js";
import type { CrmActivity } from "../types.js";
import { activityHeadline, activityHtml, activityText } from "./activity.js";
import { createHubSpot, hubspotProvider } from "./hubspot.js";
import { providers } from "./index.js";
import { crmDealTitle } from "./labels.js";
import { createPipedrive, pipedriveProvider } from "./pipedrive.js";
import { createCrmWebhook, crmWebhookProvider } from "./webhook.js";

const clock = fixedClock("2026-09-19T12:00:00Z");

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
}

function runtime(routes: FetchRoute[]) {
  const calls: FakeRequest[] = [];
  const fake = createFakeFetch(routes, calls);
  return { rt: { fetch: fake as unknown as typeof globalThis.fetch }, calls, fake };
}

const bodyOf = (call: FakeRequest | undefined) =>
  JSON.parse(String(call?.init?.body ?? "null")) as Record<string, unknown>;
const headersOf = (call: FakeRequest | undefined) =>
  (call?.init?.headers ?? {}) as Record<string, string>;

const company = {
  id: "co_harbor",
  name: "Harbor Dental",
  domain: "harbor-dental.example.com",
  website: "https://harbor-dental.example.com",
  industry: "Dental practices",
  city: "Austin",
  country: "US",
  phone: null,
  employee_count: 40,
} as Company;

const person = {
  id: "pe_dana",
  company_id: "co_harbor",
  first_name: "Dana",
  last_name: "Reyes",
  full_name: "Dana Reyes",
  title: "Practice Manager",
  email: "dana@harbor-dental.example.com",
  phone: "",
  linkedin_url: null,
  city: null,
  country: "US",
  status: "interested",
} as Person;

function opportunity(overrides: Partial<Opportunity> = {}): Opportunity {
  return {
    id: "opp_one",
    workspace_id: "ws_test",
    person_id: "pe_dana",
    company_id: "co_harbor",
    campaign_id: null,
    thread_id: null,
    stage: "meeting_booked",
    value: 12000,
    currency: "EUR",
    meeting_at: new Date("2026-10-06T15:00:00Z"),
    lost_reason: null,
    notes: "Asked for a demo",
    source_signal_keys: ["new_location"],
    crm_refs: {},
    closed_at: null,
    created_at: new Date("2026-09-18T12:00:00Z"),
    updated_at: new Date("2026-09-19T12:00:00Z"),
    ...overrides,
  };
}

const HS = "https://api.hubapi.com";
const hubspotConfig = hubspotProvider.configSchema?.parse({}) as Parameters<
  typeof createHubSpot
>[0];

describe("hubspot", () => {
  it("creates the company, upserts the contact by email and associates them", async () => {
    const { rt, calls } = runtime([
      {
        match: `${HS}/crm/v3/objects/companies/search`,
        response: { json: fixture("hubspot-company-search-empty") },
      },
      {
        match: `${HS}/crm/v3/objects/companies`,
        method: "POST",
        response: { status: 201, json: fixture("hubspot-company-create") },
      },
      {
        match: `${HS}/crm/v3/objects/contacts/batch/upsert`,
        response: { json: fixture("hubspot-contacts-upsert") },
      },
      {
        match: /\/crm\/v4\/objects\/contacts\/33451\/associations\/default\/companies\/8462427880$/,
        method: "PUT",
        response: { json: { status: "COMPLETE" } },
      },
    ]);
    const crm = createHubSpot(hubspotConfig, { access_token: "hs-test-token" }, rt);
    expect(await crm.upsertContact(person, company, {})).toEqual({
      contactId: "33451",
      companyId: "8462427880",
    });
    expect(calls.map((call) => `${call.method} ${call.url.replace(HS, "")}`)).toEqual([
      "POST /crm/v3/objects/companies/search",
      "POST /crm/v3/objects/companies",
      "POST /crm/v3/objects/contacts/batch/upsert",
      "PUT /crm/v4/objects/contacts/33451/associations/default/companies/8462427880",
    ]);
    expect(headersOf(calls[0]).authorization).toBe("Bearer hs-test-token");
    expect(bodyOf(calls[0])).toMatchObject({
      filterGroups: [
        {
          filters: [{ propertyName: "domain", operator: "EQ", value: "harbor-dental.example.com" }],
        },
      ],
    });
    const companyProps = bodyOf(calls[1]).properties as Record<string, unknown>;
    expect(companyProps).toEqual({
      name: "Harbor Dental",
      domain: "harbor-dental.example.com",
      website: "https://harbor-dental.example.com",
      city: "Austin",
      country: "US",
    });
    expect(companyProps).not.toHaveProperty("industry");
    expect(bodyOf(calls[2])).toEqual({
      inputs: [
        {
          idProperty: "email",
          id: "dana@harbor-dental.example.com",
          properties: {
            email: "dana@harbor-dental.example.com",
            firstname: "Dana",
            lastname: "Reyes",
            jobtitle: "Practice Manager",
            country: "US",
            company: "Harbor Dental",
            website: "https://harbor-dental.example.com",
          },
        },
      ],
    });
  });

  it("updates known records in place and skips the association when nothing changed", async () => {
    const { rt, calls } = runtime([
      {
        match: `${HS}/crm/v3/objects/companies/8462427879`,
        method: "PATCH",
        response: { json: fixture("hubspot-company-create") },
      },
      {
        match: `${HS}/crm/v3/objects/contacts/batch/upsert`,
        response: { json: fixture("hubspot-contacts-upsert") },
      },
    ]);
    const crm = createHubSpot(hubspotConfig, { access_token: "hs-test-token" }, rt);
    expect(
      await crm.upsertContact(person, company, { contactId: "33451", companyId: "8462427879" }),
    ).toEqual({ contactId: "33451", companyId: "8462427879" });
    expect(calls).toHaveLength(2);
  });

  it("finds the company by domain when the linked one was deleted, and creates contacts without email", async () => {
    const { rt, calls } = runtime([
      {
        match: `${HS}/crm/v3/objects/companies/999`,
        method: "PATCH",
        response: { status: 404, json: { status: "error", message: "Object not found" } },
      },
      {
        match: `${HS}/crm/v3/objects/companies/search`,
        response: { json: fixture("hubspot-company-search") },
      },
      {
        match: `${HS}/crm/v3/objects/contacts`,
        method: "POST",
        response: { status: 201, json: fixture("hubspot-contact-create") },
      },
      { match: /associations\/default/, method: "PUT", response: { json: {} } },
    ]);
    const crm = createHubSpot(hubspotConfig, { access_token: "hs-test-token" }, rt);
    const noEmail = { ...person, email: null, first_name: "Sam", last_name: "Park" } as Person;
    expect(await crm.upsertContact(noEmail, company, { companyId: "999" })).toEqual({
      contactId: "33452",
      companyId: "8462427879",
    });
    expect(calls.map((call) => call.method)).toEqual(["PATCH", "POST", "POST", "PUT"]);
  });

  it("creates deals with a title, mapped stage and associations, then patches them", async () => {
    const { rt, calls, fake } = runtime([
      {
        match: `${HS}/crm/v3/objects/companies/search`,
        response: { json: fixture("hubspot-company-search") },
      },
      {
        match: `${HS}/crm/v3/objects/contacts/batch/upsert`,
        response: { json: fixture("hubspot-contacts-upsert") },
      },
      { match: /associations\/default/, method: "PUT", response: { json: {} } },
      {
        match: `${HS}/crm/v3/objects/deals`,
        method: "POST",
        response: { status: 201, json: fixture("hubspot-deal-create") },
      },
    ]);
    const crm = createHubSpot(hubspotConfig, { access_token: "hs-test-token" }, rt);
    const links = await crm.upsertContact(person, company, {});
    calls.length = 0;
    expect(await crm.upsertDeal(opportunity(), links)).toEqual({ dealId: "19621835902" });
    expect(bodyOf(calls[0])).toEqual({
      properties: {
        dealname: "Harbor Dental (OpenOutbound opp_one)",
        pipeline: "default",
        dealstage: "presentationscheduled",
        amount: "12000",
        description:
          "Asked for a demo\nMeeting: 2026-10-06T15:00:00.000Z\nSignals: new_location\nOpenOutbound opportunity opp_one",
      },
    });
    expect(calls.slice(1).map((call) => call.url.replace(HS, ""))).toEqual([
      "/crm/v4/objects/deals/19621835902/associations/default/contacts/33451",
      "/crm/v4/objects/deals/19621835902/associations/default/companies/8462427879",
    ]);

    calls.length = 0;
    fake.route(
      `${HS}/crm/v3/objects/deals/19621835902`,
      { json: fixture("hubspot-deal-create") },
      "PATCH",
    );
    const won = opportunity({ stage: "won", closed_at: new Date("2026-10-20T09:00:00Z") });
    expect(await crm.upsertDeal(won, { ...links, dealId: "19621835902" })).toEqual({
      dealId: "19621835902",
    });
    expect(calls).toHaveLength(1);
    const patch = bodyOf(calls[0]).properties as Record<string, unknown>;
    expect(patch).toMatchObject({ dealstage: "closedwon", closedate: "2026-10-20T09:00:00.000Z" });
    expect(patch).not.toHaveProperty("dealname");
  });

  it("recreates a deal that was deleted in HubSpot", async () => {
    const { rt, calls } = runtime([
      {
        match: `${HS}/crm/v3/objects/deals/404404`,
        method: "PATCH",
        response: { status: 404, body: "" },
      },
      {
        match: `${HS}/crm/v3/objects/deals`,
        method: "POST",
        response: { status: 201, json: fixture("hubspot-deal-create") },
      },
    ]);
    const crm = createHubSpot(hubspotConfig, { access_token: "hs-test-token" }, rt);
    expect(await crm.upsertDeal(opportunity(), { dealId: "404404" })).toEqual({
      dealId: "19621835902",
    });
    expect((bodyOf(calls[1]).properties as Record<string, unknown>).dealname).toBe(
      "Opportunity (OpenOutbound opp_one)",
    );
  });

  it("maps errors to actionable provider errors without the token", async () => {
    const { rt } = runtime([
      {
        match: `${HS}/crm/v3/objects/deals`,
        method: "POST",
        response: { status: 400, json: fixture("hubspot-error") },
      },
      {
        match: `${HS}/crm/v3/objects/companies/search`,
        response: {
          status: 429,
          headers: { "retry-after": "7" },
          json: { status: "error", message: "rate limited" },
        },
      },
      {
        match: /contacts\?limit=1$/,
        response: {
          status: 401,
          json: { status: "error", message: "Authentication credentials not found" },
        },
      },
    ]);
    const crm = createHubSpot(hubspotConfig, { access_token: "hs-secret-token" }, rt);
    const bad = await crm.upsertDeal(opportunity(), {}).catch((error: unknown) => error);
    expect(bad).toBeInstanceOf(OpenOutboundError);
    expect((bad as OpenOutboundError).message).toContain("dealstage is not a valid stage");
    expect(JSON.stringify(bad)).not.toContain("hs-secret-token");

    const limited = await crm.upsertContact(person, company, {}).catch((error: unknown) => error);
    expect(limited).toMatchObject({ code: "provider_error", retryAfterSeconds: 7 });
    expect(await crm.checkAuth()).toMatchObject({ ok: false });
    expect(() => createHubSpot(hubspotConfig, {}, rt)).toThrow(/missing the access_token secret/);
  });

  it("rejects malformed responses instead of storing empty ids", async () => {
    const { rt } = runtime([
      {
        match: `${HS}/crm/v3/objects/deals`,
        method: "POST",
        response: { json: { properties: {} } },
      },
      {
        match: `${HS}/crm/v3/objects/contacts/batch/upsert`,
        response: { body: "<html>maintenance</html>", headers: { "content-type": "text/html" } },
      },
    ]);
    const crm = createHubSpot(hubspotConfig, { access_token: "hs-test-token" }, rt);
    await expect(crm.upsertDeal(opportunity(), {})).rejects.toMatchObject({
      code: "provider_error",
      details: { failure: { class: "malformed" } },
    });
    await expect(crm.upsertContact(person, null, {})).rejects.toMatchObject({
      details: { failure: { class: "malformed" } },
    });
  });
});

const PD = "https://api.pipedrive.com/api/v2";
const pipedriveConfig = pipedriveProvider.configSchema?.parse({
  pipeline_id: 2,
  stage_map: { interested: 3, meeting_booked: 4 },
}) as Parameters<typeof createPipedrive>[0];

describe("pipedrive", () => {
  it("creates the organization and the person when searches find nothing", async () => {
    const { rt, calls } = runtime([
      { match: /\/organizations\/search\?/, response: { json: fixture("pipedrive-search-empty") } },
      {
        match: `${PD}/organizations`,
        method: "POST",
        response: { json: fixture("pipedrive-organization-create") },
      },
      { match: /\/persons\/search\?/, response: { json: fixture("pipedrive-search-empty") } },
      {
        match: `${PD}/persons`,
        method: "POST",
        response: { json: fixture("pipedrive-person-create") },
      },
    ]);
    const crm = createPipedrive(pipedriveConfig, { api_token: "pd-test-token" }, rt);
    expect(await crm.upsertContact(person, company, {})).toEqual({
      contactId: "8",
      companyId: "13",
    });
    expect(headersOf(calls[0])["x-api-token"]).toBe("pd-test-token");
    const orgSearch = new URL(calls[0]?.url ?? "");
    expect(Object.fromEntries(orgSearch.searchParams)).toEqual({
      term: "Harbor Dental",
      fields: "name",
      exact_match: "true",
      limit: "1",
    });
    expect(new URL(calls[2]?.url ?? "").searchParams.get("term")).toBe(
      "dana@harbor-dental.example.com",
    );
    expect(bodyOf(calls[3])).toEqual({
      name: "Dana Reyes",
      org_id: 13,
      emails: [{ value: "dana@harbor-dental.example.com", primary: true, label: "work" }],
    });
  });

  it("reuses matches and known ids, patching without replacing emails", async () => {
    const { rt, calls } = runtime([
      {
        match: /\/organizations\/search\?/,
        response: { json: fixture("pipedrive-organizations-search") },
      },
      { match: /\/persons\/search\?/, response: { json: fixture("pipedrive-persons-search") } },
      {
        match: `${PD}/persons/7`,
        method: "PATCH",
        response: { json: fixture("pipedrive-person-update") },
      },
    ]);
    const crm = createPipedrive(pipedriveConfig, { api_token: "pd-test-token" }, rt);
    expect(await crm.upsertContact(person, company, {})).toEqual({
      contactId: "7",
      companyId: "12",
    });
    expect(bodyOf(calls[2])).toEqual({ name: "Dana Reyes", org_id: 12 });

    calls.length = 0;
    const known = await crm.upsertContact(person, null, { contactId: "7" });
    expect(known).toEqual({ contactId: "7" });
    expect(calls.map((call) => `${call.method} ${call.url.replace(PD, "")}`)).toEqual([
      "PATCH /persons/7",
    ]);
  });

  it("creates deals with stage, pipeline and numeric links, and closes them by status", async () => {
    const { rt, calls, fake } = runtime([
      {
        match: `${PD}/deals`,
        method: "POST",
        response: { json: fixture("pipedrive-deal-create") },
      },
    ]);
    const crm = createPipedrive(pipedriveConfig, { api_token: "pd-test-token" }, rt);
    expect(await crm.upsertDeal(opportunity(), { contactId: "8", companyId: "13" })).toEqual({
      dealId: "101",
    });
    expect(bodyOf(calls[0])).toEqual({
      title: "Opportunity (OpenOutbound opp_one)",
      value: 12000,
      currency: "EUR",
      person_id: 8,
      org_id: 13,
      status: "open",
      stage_id: 4,
      pipeline_id: 2,
    });

    fake.route(`${PD}/deals/101`, { json: fixture("pipedrive-deal-update") }, "PATCH");
    const lost = opportunity({ stage: "lost", lost_reason: "timing" });
    expect(await crm.upsertDeal(lost, { contactId: "8", dealId: "101" })).toEqual({
      dealId: "101",
    });
    expect(bodyOf(calls[1])).toEqual({
      value: 12000,
      currency: "EUR",
      person_id: 8,
      status: "lost",
      lost_reason: "timing",
    });
  });

  it("recreates deleted deals and reports bad tokens", async () => {
    const { rt } = runtime([
      {
        match: `${PD}/deals/55`,
        method: "PATCH",
        response: { status: 404, json: { success: false, error: "Deal not found" } },
      },
      {
        match: `${PD}/deals`,
        method: "POST",
        response: { json: fixture("pipedrive-deal-create") },
      },
      { match: /\/persons\?limit=1$/, response: { status: 401, json: fixture("pipedrive-error") } },
    ]);
    const crm = createPipedrive(pipedriveConfig, { api_token: "pd-test-token" }, rt);
    expect(await crm.upsertDeal(opportunity(), { dealId: "55" })).toEqual({ dealId: "101" });
    expect(await crm.checkAuth()).toEqual({
      ok: false,
      message: "Pipedrive rejected the credentials (401).",
    });
  });

  it("uses a company domain base url when configured", async () => {
    const { rt, calls } = runtime([
      {
        match: "https://harbor.pipedrive.com/api/v2/deals",
        method: "POST",
        response: { json: fixture("pipedrive-deal-create") },
      },
    ]);
    const config = pipedriveProvider.configSchema?.parse({
      base_url: "https://harbor.pipedrive.com/",
    }) as Parameters<typeof createPipedrive>[0];
    const crm = createPipedrive(config, { api_token: "pd-test-token" }, rt);
    await crm.upsertDeal(opportunity({ stage: "interested" }), {});
    expect(bodyOf(calls[0])).not.toHaveProperty("stage_id");
  });

  it("reads Pipedrive's empty answer as no match and rejects creates without an id", async () => {
    const { rt, calls } = runtime([
      { match: /\/persons\/search\?/, response: { json: { success: true, data: null } } },
      { match: `${PD}/persons`, method: "POST", response: { json: { success: true, data: null } } },
    ]);
    const crm = createPipedrive(pipedriveConfig, { api_token: "pd-test-token" }, rt);
    await expect(crm.upsertContact(person, null, {})).rejects.toMatchObject({
      code: "provider_error",
      details: { failure: { class: "malformed" } },
    });
    expect(calls.map((call) => call.method)).toEqual(["GET", "POST"]);
  });
});

describe("crm webhook", () => {
  const URL_ = "https://crm-hook.example.org/openoutbound";

  function hook(
    routes: FetchRoute[],
    secrets: Record<string, string> = { signing_secret: "whsec_test" },
  ) {
    const calls: FakeRequest[] = [];
    const safeFetch = createFakeFetch(routes, calls);
    const crm = createCrmWebhook({ url: URL_ }, secrets, {
      safeFetch,
      clock,
      workspaceId: "ws_test",
    });
    return { crm, calls };
  }

  it("posts signed contact upserts and falls back to OpenOutbound ids", async () => {
    const { crm, calls } = hook([{ match: URL_, method: "POST", response: { status: 204 } }]);
    expect(await crm.upsertContact(person, company, {})).toEqual({
      contactId: "pe_dana",
      companyId: "co_harbor",
    });
    const call = calls[0];
    const raw = String(call?.init?.body);
    const payload = JSON.parse(raw);
    expect(payload).toMatchObject({
      type: "crm.contact.upsert",
      occurred_at: "2026-09-19T12:00:00.000Z",
      workspace_id: "ws_test",
      data: {
        person: { id: "pe_dana", email: "dana@harbor-dental.example.com" },
        company: { id: "co_harbor", domain: "harbor-dental.example.com" },
        existing: { contact_id: null, company_id: null },
      },
    });
    const headers = headersOf(call);
    const t = Math.floor(clock.now().getTime() / 1000);
    const expected = createHmac("sha256", "whsec_test").update(`${t}.${raw}`).digest("hex");
    expect(headers["OpenOutbound-Signature"]).toBe(`t=${t},v1=${expected}`);
    expect(headers["OpenOutbound-Event"]).toBe("crm.contact.upsert");
  });

  it("stores the endpoint's own ids when it returns them", async () => {
    const { crm } = hook([
      {
        match: URL_,
        method: "POST",
        response: (request) => {
          const type = JSON.parse(String(request.init?.body)).type;
          return {
            json:
              type === "crm.deal.upsert"
                ? { deal_id: "D-9" }
                : { contact_id: "C-1", company_id: "A-1" },
          };
        },
      },
    ]);
    expect(await crm.upsertContact(person, company, {})).toEqual({
      contactId: "C-1",
      companyId: "A-1",
    });
    expect(await crm.upsertDeal(opportunity(), { contactId: "C-1" })).toEqual({ dealId: "D-9" });
  });

  it("keeps known ids, sends no signature without a secret and reports failures", async () => {
    const { crm, calls } = hook(
      [{ match: URL_, method: "POST", response: { status: 200, body: "ok" } }],
      {},
    );
    expect(await crm.upsertDeal(opportunity(), { dealId: "D-1" })).toEqual({ dealId: "D-1" });
    expect(headersOf(calls[0])).not.toHaveProperty("OpenOutbound-Signature");
    expect(JSON.parse(String(calls[0]?.init?.body)).data.opportunity).toMatchObject({
      id: "opp_one",
      stage: "meeting_booked",
      meeting_at: "2026-10-06T15:00:00.000Z",
    });

    const failing = hook([
      { match: URL_, method: "POST", response: { status: 503, body: "down" } },
    ]);
    await expect(failing.crm.upsertDeal(opportunity(), {})).rejects.toMatchObject({
      code: "provider_error",
      details: { retryable: true },
    });
    expect(await failing.crm.ping()).toMatchObject({ ok: false });
  });

  it("never sends an activity twice after a lost answer, but retries upserts", async () => {
    const down = hook([
      { match: URL_, method: "POST", response: { status: 502, body: "bad gateway" } },
    ]);
    const note = await down.crm
      .logActivity?.({ kind: "note", contactId: "C-1", occurredAt: new Date(0) })
      .catch((error: unknown) => error);
    expect(failureOf(note)).toMatchObject({ class: "outcome_unknown", retryable: false });
    const deal = await down.crm.upsertDeal(opportunity(), {}).catch((error: unknown) => error);
    expect(failureOf(deal)).toMatchObject({ class: "unavailable", retryable: true });
  });

  it("requires an https url", () => {
    expect(
      crmWebhookProvider.configSchema?.safeParse({ url: "http://crm.example.org" }).success,
    ).toBe(false);
    expect(crmWebhookProvider.configSchema?.safeParse({ url: URL_ }).success).toBe(true);
  });
});

const activity = (overrides: Partial<CrmActivity> = {}): CrmActivity => ({
  kind: "reply",
  contactId: "33451",
  subject: "Interested",
  body: "Wants a demo next week.",
  occurredAt: new Date("2026-09-19T12:00:00Z"),
  ...overrides,
});

describe("activity text", () => {
  it("prefixes each kind, cuts long bodies and escapes html", () => {
    expect(activityHeadline({ kind: "email_sent", subject: "  Quick\n question " })).toBe(
      "Email sent: Quick question",
    );
    expect(activityHeadline({ kind: "meeting", subject: null })).toBe("Meeting: (no subject)");
    expect(activityText(activity({ body: null }))).toBe("Reply: Interested");
    const long = activityText(activity({ kind: "email_received", body: "x".repeat(5000) }));
    expect(long.length).toBeLessThanOrEqual("Email received: Interested\n\n".length + 2000);
    expect(long.endsWith("...")).toBe(true);
    expect(
      activityHtml(activity({ subject: "<b>Hi</b>", body: "line one\r\nline <two> & 'three'" })),
    ).toBe(
      "<p><strong>Reply: &lt;b&gt;Hi&lt;/b&gt;</strong></p><p>line one<br>line &lt;two&gt; &amp; &#39;three&#39;</p>",
    );
    expect(crmDealTitle(" Harbor Dental ", "opp_one")).toBe("Harbor Dental (OpenOutbound opp_one)");
    expect(crmDealTitle(null, "opp_one")).toBe("Opportunity (OpenOutbound opp_one)");
    // The end of the id names the opportunity, so two deals of one person never share a title.
    expect(crmDealTitle("Harbor Dental", "opp_01k6a3v0q8x3m2n4p5r6s7t8v9")).toBe(
      "Harbor Dental (OpenOutbound r6s7t8v9)",
    );
  });
});

describe("hubspot finders, notes and deletes", () => {
  it("finds contacts by email and deals by contact and exact name", async () => {
    const { rt, calls, fake } = runtime([
      {
        match: `${HS}/crm/v3/objects/contacts/search`,
        response: { json: fixture("hubspot-contacts-search") },
      },
      {
        match: `${HS}/crm/v3/objects/deals/search`,
        response: { json: fixture("hubspot-deals-search") },
      },
    ]);
    const crm = createHubSpot(hubspotConfig, { access_token: "hs-test-token" }, rt);
    expect(await crm.findContactByEmail?.("dana@harbor-dental.example.com")).toBe("33451");
    expect(bodyOf(calls[0])).toEqual({
      filterGroups: [
        {
          filters: [
            { propertyName: "email", operator: "EQ", value: "dana@harbor-dental.example.com" },
          ],
        },
      ],
      properties: ["email"],
      limit: 1,
    });
    expect(await crm.findDealForContact?.("33451", "Harbor Dental (OpenOutbound)")).toBe(
      "19621835902",
    );
    expect(bodyOf(calls[1])).toEqual({
      filterGroups: [
        {
          filters: [
            { propertyName: "associations.contact", operator: "EQ", value: "33451" },
            { propertyName: "dealname", operator: "EQ", value: "Harbor Dental (OpenOutbound)" },
          ],
        },
      ],
      properties: ["dealname"],
      limit: 1,
    });

    fake.route(`${HS}/crm/v3/objects/contacts/search`, {
      json: fixture("hubspot-company-search-empty"),
    });
    expect(await crm.findContactByEmail?.("nobody@example.org")).toBeNull();
  });

  it("fails a search answer without results instead of creating a duplicate", async () => {
    const { rt, calls } = runtime([
      { match: `${HS}/crm/v3/objects/contacts/search`, response: { json: { total: 1 } } },
      { match: `${HS}/crm/v3/objects/companies/search`, response: { json: { status: "ok" } } },
    ]);
    const crm = createHubSpot(hubspotConfig, { access_token: "hs-test-token" }, rt);
    await expect(crm.findContactByEmail?.("dana@harbor-dental.example.com")).rejects.toMatchObject({
      code: "provider_error",
      details: { failure: { class: "malformed", retryable: false } },
    });
    // The company is matched by domain before a create: a broken search creates nothing.
    await expect(crm.upsertContact(person, company, {})).rejects.toMatchObject({
      details: { failure: { class: "malformed" } },
    });
    expect(calls.filter((call) => call.method === "POST" && !call.url.endsWith("/search"))).toEqual(
      [],
    );
  });

  it("logs notes with escaped text and default associations to contact, deal and company", async () => {
    const { rt, calls } = runtime([
      {
        match: `${HS}/crm/v3/objects/notes`,
        method: "POST",
        response: { status: 201, json: fixture("hubspot-note-create") },
      },
      { match: /associations\/default/, method: "PUT", response: { json: {} } },
    ]);
    const crm = createHubSpot(hubspotConfig, { access_token: "hs-test-token" }, rt);
    const result = await crm.logActivity?.(
      activity({ dealId: "19621835902", companyId: "8462427879", body: "Ask <Sam> first" }),
    );
    expect(result).toEqual({ activityId: "71203344556" });
    expect(bodyOf(calls[0])).toEqual({
      properties: {
        hs_timestamp: "2026-09-19T12:00:00.000Z",
        hs_note_body: "<p><strong>Reply: Interested</strong></p><p>Ask &lt;Sam&gt; first</p>",
      },
    });
    expect(calls.slice(1).map((call) => `${call.method} ${call.url.replace(HS, "")}`)).toEqual([
      "PUT /crm/v4/objects/notes/71203344556/associations/default/contacts/33451",
      "PUT /crm/v4/objects/notes/71203344556/associations/default/deals/19621835902",
      "PUT /crm/v4/objects/notes/71203344556/associations/default/companies/8462427879",
    ]);
  });

  it("GDPR-deletes contacts and reports ones that are already gone", async () => {
    const { rt, calls, fake } = runtime([
      {
        match: `${HS}/crm/v3/objects/contacts/gdpr-delete`,
        method: "POST",
        response: { status: 204 },
      },
    ]);
    const crm = createHubSpot(hubspotConfig, { access_token: "hs-test-token" }, rt);
    expect(await crm.deleteContact?.("33451")).toEqual({ deleted: true });
    expect(bodyOf(calls[0])).toEqual({ objectId: "33451" });
    fake.route(
      `${HS}/crm/v3/objects/contacts/gdpr-delete`,
      { status: 404, json: { status: "error", message: "resource not found" } },
      "POST",
    );
    expect(await crm.deleteContact?.("404")).toEqual({ deleted: false });
  });

  it("leaves the stage of existing deals to HubSpot and uses the given title for new ones", async () => {
    const { rt, calls } = runtime([
      {
        match: `${HS}/crm/v3/objects/deals/19621835902`,
        method: "PATCH",
        response: { json: fixture("hubspot-deal-create") },
      },
      {
        match: `${HS}/crm/v3/objects/deals`,
        method: "POST",
        response: { status: 201, json: fixture("hubspot-deal-create") },
      },
    ]);
    const crm = createHubSpot(hubspotConfig, { access_token: "hs-test-token" }, rt);
    const won = opportunity({ stage: "won", closed_at: new Date("2026-10-20T09:00:00Z") });
    await crm.upsertDeal(won, { dealId: "19621835902" }, { keepStage: true });
    const patch = bodyOf(calls[0]).properties as Record<string, unknown>;
    expect(patch).not.toHaveProperty("dealstage");
    expect(patch).not.toHaveProperty("pipeline");
    expect(patch).not.toHaveProperty("closedate");
    expect(patch).toMatchObject({ amount: "12000" });

    await crm.upsertDeal(
      opportunity(),
      {},
      { title: "Harbor Dental (OpenOutbound)", keepStage: true },
    );
    // A new deal always gets its stage, whoever owns it afterwards.
    expect(bodyOf(calls[1]).properties).toMatchObject({
      dealname: "Harbor Dental (OpenOutbound)",
      dealstage: "presentationscheduled",
      pipeline: "default",
    });
  });
});

describe("pipedrive finders, notes and deletes", () => {
  it("finds persons by email and the person's deal by exact title", async () => {
    const { rt, calls } = runtime([
      { match: /\/persons\/search\?/, response: { json: fixture("pipedrive-persons-search") } },
      { match: /\/api\/v2\/deals\?/, response: { json: fixture("pipedrive-deals-list") } },
    ]);
    const crm = createPipedrive(pipedriveConfig, { api_token: "pd-test-token" }, rt);
    expect(await crm.findContactByEmail?.("dana@harbor-dental.example.com")).toBe("7");
    expect(await crm.findDealForContact?.("8", "Harbor Dental (OpenOutbound)")).toBe("101");
    expect(Object.fromEntries(new URL(calls[1]?.url ?? "").searchParams)).toEqual({
      person_id: "8",
      limit: "100",
    });
    expect(await crm.findDealForContact?.("8", "Some other deal")).toBeNull();
    // Ids that cannot be Pipedrive ids are never sent.
    expect(await crm.findDealForContact?.("C-1", "Harbor Dental (OpenOutbound)")).toBeNull();
    expect(calls).toHaveLength(3);
  });

  it("fails search and deal list answers of the wrong shape instead of creating duplicates", async () => {
    const { rt, calls } = runtime([
      {
        match: /\/organizations\/search\?/,
        response: { json: { success: true, data: { unexpected: true } } },
      },
      { match: /\/persons\/search\?/, response: { json: { success: true } } },
      { match: /\/api\/v2\/deals\?/, response: { json: { success: true, data: { items: [] } } } },
    ]);
    const crm = createPipedrive(pipedriveConfig, { api_token: "pd-test-token" }, rt);
    const malformedRead = { details: { failure: { class: "malformed", retryable: false } } };
    await expect(crm.upsertContact(person, company, {})).rejects.toMatchObject(malformedRead);
    await expect(crm.findContactByEmail?.("dana@harbor-dental.example.com")).rejects.toMatchObject(
      malformedRead,
    );
    await expect(
      crm.findDealForContact?.("8", "Harbor Dental (OpenOutbound)"),
    ).rejects.toMatchObject(malformedRead);
    // Nothing was created.
    expect(calls.map((call) => call.method)).toEqual(["GET", "GET", "GET"]);
  });

  it("logs notes through the v1 notes endpoint with html, links and the time", async () => {
    const { rt, calls } = runtime([
      {
        match: "https://api.pipedrive.com/api/v1/notes",
        method: "POST",
        response: { status: 201, json: fixture("pipedrive-note-create") },
      },
    ]);
    const crm = createPipedrive(pipedriveConfig, { api_token: "pd-test-token" }, rt);
    const result = await crm.logActivity?.(
      activity({
        kind: "meeting",
        contactId: "8",
        dealId: "101",
        companyId: "13",
        subject: "booked for 2026-10-08 13:00 UTC",
        body: null,
      }),
    );
    expect(result).toEqual({ activityId: "501" });
    expect(headersOf(calls[0])["x-api-token"]).toBe("pd-test-token");
    expect(bodyOf(calls[0])).toEqual({
      content: "<p><strong>Meeting: booked for 2026-10-08 13:00 UTC</strong></p>",
      person_id: 8,
      deal_id: 101,
      org_id: 13,
      add_time: "2026-09-19 12:00:00",
    });
  });

  it("deletes persons and reports ones that are already gone", async () => {
    const { rt, calls, fake } = runtime([
      {
        match: `${PD}/persons/8`,
        method: "DELETE",
        response: { json: fixture("pipedrive-person-delete") },
      },
    ]);
    const crm = createPipedrive(pipedriveConfig, { api_token: "pd-test-token" }, rt);
    expect(await crm.deleteContact?.("8")).toEqual({ deleted: true });
    expect(calls[0]?.method).toBe("DELETE");
    fake.route(
      `${PD}/persons/9`,
      { status: 404, json: { success: false, error: "Person not found" } },
      "DELETE",
    );
    expect(await crm.deleteContact?.("9")).toEqual({ deleted: false });
    expect(await crm.deleteContact?.("not-a-pipedrive-id")).toEqual({ deleted: false });
    expect(calls).toHaveLength(2);
  });

  it("leaves status, stage and lost reason of existing deals to Pipedrive when asked", async () => {
    const { rt, calls } = runtime([
      {
        match: `${PD}/deals/101`,
        method: "PATCH",
        response: { json: fixture("pipedrive-deal-update") },
      },
      {
        match: `${PD}/deals`,
        method: "POST",
        response: { json: fixture("pipedrive-deal-create") },
      },
    ]);
    const crm = createPipedrive(pipedriveConfig, { api_token: "pd-test-token" }, rt);
    const lost = opportunity({ stage: "lost", lost_reason: "timing" });
    await crm.upsertDeal(lost, { contactId: "8", dealId: "101" }, { keepStage: true });
    expect(bodyOf(calls[0])).toEqual({ value: 12000, currency: "EUR", person_id: 8 });
    await crm.upsertDeal(
      opportunity(),
      { contactId: "8" },
      { title: "Harbor Dental (OpenOutbound)" },
    );
    expect(bodyOf(calls[1])).toMatchObject({
      title: "Harbor Dental (OpenOutbound)",
      status: "open",
      stage_id: 4,
    });
  });
});

describe("crm webhook notes and deletes", () => {
  const URL_ = "https://crm-hook.example.org/openoutbound";

  it("posts crm.activity and crm.contact.delete, and cannot search", async () => {
    const calls: FakeRequest[] = [];
    const safeFetch = createFakeFetch(
      [
        {
          match: URL_,
          method: "POST",
          response: (request) => {
            const type = JSON.parse(String(request.init?.body)).type;
            return { json: type === "crm.activity" ? { activity_id: "N-1" } : {} };
          },
        },
      ],
      calls,
    );
    const crm = createCrmWebhook(
      { url: URL_ },
      { signing_secret: "whsec_test" },
      {
        safeFetch,
        clock,
        workspaceId: "ws_test",
      },
    );
    expect(await crm.findContactByEmail?.("dana@harbor-dental.example.com")).toBeNull();
    expect(await crm.findDealForContact?.("C-1", "Harbor Dental (OpenOutbound)")).toBeNull();
    expect(await crm.logActivity?.(activity({ kind: "email_sent", subject: "Hello" }))).toEqual({
      activityId: "N-1",
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      type: "crm.activity",
      data: {
        activity: {
          kind: "email_sent",
          contact_id: "33451",
          deal_id: null,
          subject: "Hello",
          body: "Wants a demo next week.",
          occurred_at: "2026-09-19T12:00:00.000Z",
        },
      },
    });
    expect(await crm.deleteContact?.("C-1")).toEqual({ deleted: true });
    expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({
      type: "crm.contact.delete",
      data: { contact_id: "C-1" },
    });
    await crm.upsertDeal(opportunity(), { dealId: "D-1" }, { keepStage: true, title: "T" });
    expect(JSON.parse(String(calls[2]?.init?.body)).data).toMatchObject({
      title: "T",
      keep_stage: true,
    });
    expect(calls).toHaveLength(3);
  });
});

describe("crm provider list", () => {
  it("registers hubspot, pipedrive and webhook in the crm slot", () => {
    expect(providers.map((provider) => `${provider.slot}:${provider.id}`)).toEqual([
      "crm:hubspot",
      "crm:pipedrive",
      "crm:webhook",
    ]);
    for (const provider of providers) {
      expect(provider.description.length).toBeGreaterThan(40);
      expect(provider.test).toBeTypeOf("function");
    }
    expect(hubspotConfig.stage_map).toEqual({
      interested: "qualifiedtobuy",
      meeting_booked: "presentationscheduled",
      won: "closedwon",
      lost: "closedlost",
    });
  });
});
