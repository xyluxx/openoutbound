/**
 * Provider conformance (spec 3): every registered provider fails the same explicit way. Each
 * provider has an entry here with one or more probe calls and their kind (read or write, paid,
 * idempotent). A fake network answers every probe with each case below, and the test checks the
 * failure class, whether it is retryable, the wait a 429 asked for, that every request carried
 * an abort signal (a timeout), and that no secret (the fake keys, which the fake server echoes
 * in its error bodies) reaches the message, hint or details.
 *
 * A guard walks the provider registry: a provider without an entry fails the suite, naming
 * what to add. Providers that never call out over HTTP are listed with the reason they are
 * skipped; sandbox providers are skipped as a rule (fake data, no network).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixedClock } from "../../src/core/clock.js";
import type { SafeFetch } from "../../src/core/context.js";
import { isOpenOutboundError, type OpenOutboundError } from "../../src/core/errors.js";
import { type FailureClass, failureOf, retryAfterOf } from "../../src/core/failures.js";
import { silentLogger } from "../../src/core/logger.js";
import type { Db } from "../../src/db/client.js";
import type { Opportunity, Person } from "../../src/db/schema/index.js";
import { modules } from "../../src/modules/index.js";
import { capProviderTimeouts } from "../../src/providers/http.js";
import type { ProviderDefinition, ProviderRuntime } from "../../src/providers/types.js";
import { KERNEL_CONTRIBUTIONS } from "../../src/runtime/create-engine.js";
import { buildRegistry } from "../../src/runtime/registry.js";
import { createSafeFetch, type TransportResponse } from "../../src/runtime/safe-fetch.js";

const NOW = "2026-09-22T15:00:00.000Z";
const SECRET = "cnf7f3a9c2e5b1d4";

const CASES = [
  "timeout",
  "refused",
  "401",
  "402",
  "403",
  "404",
  "429",
  "500",
  "503",
  "html",
  "shape",
  "broken_200",
  "broken_502",
] as const;
type CaseName = (typeof CASES)[number];

interface Expectation {
  class: FailureClass;
  retryable: boolean;
}

/** A non-provider error the call throws for a case (a refusal before any request, say). */
interface CodeExpectation {
  code: string;
}

// biome-ignore lint/suspicious/noExplicitAny: probes call slot interfaces generically
type Instance = any;

interface Probe {
  name: string;
  kind: "read" | "write";
  /** Credits are spent once the provider receives the call. */
  paid?: boolean;
  /** A write that cannot happen twice (an upsert by key, a like, a delete). */
  idempotent?: boolean;
  call(instance: Instance, signal: AbortSignal): Promise<unknown>;
  /** Cases whose documented contract is a normal result, with why. */
  answers?: Partial<Record<CaseName, string>>;
  /** Documented provider-specific classes, replacing the defaults. */
  expect?: Partial<Record<CaseName, Expectation | CodeExpectation>>;
}

/** Providers get both a fetch and a safe fetch that answer every case the same way. */
interface Entry {
  probes: Probe[];
  /** Config for create(); the schema's defaults fill the rest. */
  config?: Record<string, unknown>;
}

interface Skip {
  skip: string;
}

const PERSON = {
  id: "per_conformance01",
  workspace_id: "ws_conformance01",
  first_name: "Dana",
  last_name: "Reyes",
  full_name: "Dana Reyes",
  email: "dana@harbor-dental.example.com",
  title: "Practice Manager",
  linkedin_url: "https://www.linkedin.com/in/dana-reyes-example",
} as unknown as Person;

const OPPORTUNITY: Opportunity = {
  id: "opp_conformance01",
  workspace_id: "ws_conformance01",
  person_id: "per_conformance01",
  company_id: null,
  campaign_id: null,
  thread_id: null,
  stage: "interested",
  value: null,
  currency: null,
  meeting_at: null,
  lost_reason: null,
  notes: null,
  source_signal_keys: [],
  crm_refs: {},
  closed_at: null,
  created_at: new Date(NOW),
  updated_at: new Date(NOW),
};

const TARGET = {
  profile_url: "https://www.linkedin.com/in/dana-reyes-example",
  provider_id: "ACoAAExampleDanaReyes0001",
};

const SIGNAL_TARGET = {
  company: { id: "cmp_conformance01", name: "Harbor Dental", domain: "harbor-dental.example.com" },
};

const BRAIN_REQUEST = (signal: AbortSignal) => ({
  system: "Answer in one word.",
  messages: [{ role: "user" as const, content: "Ready?" }],
  model: "conformance-model",
  maxTokens: 32,
  signal,
});

/** A brain call stopped by its caller's signal: the brain service retries its own timeouts. */
const BRAIN_ABORT: Expectation = { class: "timeout", retryable: false };

const brainProbe: Probe = {
  name: "generate",
  kind: "read",
  call: (brain, signal) => brain.generate(BRAIN_REQUEST(signal)),
  expect: { timeout: BRAIN_ABORT },
};

const ENTRIES: Record<string, Entry | Skip> = {
  // --- brain ---------------------------------------------------------------------------------
  "brain:anthropic": { probes: [brainProbe] },
  "brain:openai": { probes: [brainProbe] },
  "brain:openrouter": { probes: [brainProbe] },
  "brain:gemini": { probes: [brainProbe] },
  "brain:openai_compatible": {
    config: { preset: "custom", base_url: "https://llm.example.com/v1" },
    probes: [brainProbe],
  },
  "brain:claude_cli": {
    skip: "Runs the local claude CLI, not HTTP: covered by its tests with a fake process runner.",
  },
  "brain:codex_cli": {
    skip: "Runs the local codex CLI, not HTTP: covered by its tests with a fake process runner.",
  },
  "brain:agent": {
    skip: "Hands prompts to the connected agent as agent tasks in the database, not HTTP.",
  },

  // --- lead sources --------------------------------------------------------------------------
  "lead_source:apollo": {
    probes: [
      {
        name: "searchPeople",
        kind: "read",
        call: (apollo) => apollo.searchPeople({ titles: ["Practice Manager"] }, { limit: 10 }),
      },
      {
        name: "searchCompanies",
        kind: "read",
        paid: true,
        call: (apollo) => apollo.searchCompanies({ query: "dental group" }, { limit: 10 }),
      },
      {
        name: "enrichPeople",
        kind: "read",
        paid: true,
        call: (apollo) => apollo.enrichPeople([{ external_id: "apollo-1", source: "apollo" }]),
      },
    ],
  },
  "lead_source:google_maps": {
    probes: [
      {
        name: "searchCompanies",
        kind: "read",
        paid: true,
        call: (maps) =>
          maps.searchCompanies({ query: "dentist", location: { text: "Austin" } }, { limit: 5 }),
        answers: { shape: "Places answers an empty object when nothing matches." },
      },
    ],
  },

  // --- email finders and verifiers -----------------------------------------------------------
  "email_finder:icypeas": {
    probes: [
      {
        name: "findEmail",
        kind: "read",
        paid: true,
        call: (finder) =>
          finder.findEmail({ first_name: "Dana", last_name: "Reyes", domain: "example.com" }),
      },
    ],
  },
  "email_finder:findymail": {
    probes: [
      {
        name: "findEmail",
        kind: "read",
        paid: true,
        call: (finder) =>
          finder.findEmail({ first_name: "Dana", last_name: "Reyes", domain: "example.com" }),
        answers: { "404": "Findymail answers 404 when it found no email: a miss." },
      },
    ],
  },
  "email_finder:hunter": {
    probes: [
      {
        name: "findEmail",
        kind: "read",
        paid: true,
        call: (finder) =>
          finder.findEmail({ first_name: "Dana", last_name: "Reyes", domain: "example.com" }),
        answers: { "404": "Hunter answers 404 when it found no email: a miss." },
        expect: {
          // Hunter documents 403 as its rate limit and 429 as a used-up plan.
          "403": { class: "rate_limited", retryable: true },
          "429": { class: "quota_exhausted", retryable: false },
        },
      },
    ],
  },
  "email_finder:prospeo": {
    probes: [
      {
        name: "findEmail",
        kind: "read",
        call: (finder) =>
          finder.findEmail({ first_name: "Dana", last_name: "Reyes", domain: "example.com" }),
      },
    ],
  },
  "email_verifier:millionverifier": {
    probes: [
      {
        name: "verify",
        kind: "read",
        paid: true,
        call: (verifier) => verifier.verify("dana@example.com"),
      },
    ],
  },
  "email_verifier:reoon": {
    probes: [
      {
        name: "verify",
        kind: "read",
        paid: true,
        call: (verifier) => verifier.verify("dana@example.com"),
      },
    ],
  },

  // --- research ------------------------------------------------------------------------------
  "research:parallel": {
    probes: [
      {
        name: "search",
        kind: "read",
        paid: true,
        call: (research) => research.search("dental groups in Austin"),
      },
    ],
  },
  "research:exa": {
    probes: [
      {
        name: "search",
        kind: "read",
        paid: true,
        call: (research) => research.search("dental groups in Austin"),
      },
    ],
  },
  "research:tavily": {
    probes: [
      {
        name: "search",
        kind: "read",
        paid: true,
        call: (research) => research.search("dental groups in Austin"),
      },
    ],
  },
  "research:firecrawl": {
    probes: [
      {
        name: "search",
        kind: "read",
        paid: true,
        call: (research) => research.search("dental groups in Austin"),
      },
    ],
  },
  "research:builtin": {
    probes: [
      {
        name: "fetch",
        kind: "read",
        call: (research) => research.fetch("https://www.example.com/about"),
        answers: { html: "A web page is the normal answer." },
        expect: {
          // A web page's status is about that page, not about a provider account.
          "401": { class: "refused", retryable: false },
          "402": { class: "refused", retryable: false },
          "403": { class: "refused", retryable: false },
          // JSON is not a page it can read.
          shape: { code: "unsupported" },
          // Safe fetch reads the whole body before it answers: one that breaks off is a lost
          // connection, whatever the status.
          broken_502: { class: "network", retryable: true },
        },
      },
    ],
  },

  // --- signals -------------------------------------------------------------------------------
  "signals:predictleads": {
    probes: [
      {
        name: "collect",
        kind: "read",
        paid: true,
        call: (source) => source.collect(SIGNAL_TARGET),
        answers: { "404": "PredictLeads answers 404 for a company it has no data on: no signals." },
      },
    ],
  },
  "signals:crustdata": {
    probes: [
      {
        name: "collect",
        kind: "read",
        paid: true,
        call: (source) => source.collect(SIGNAL_TARGET),
      },
    ],
  },
  "signals:webhook": {
    skip: "Only receives signals on the engine's own webhook; it never calls out.",
  },

  // --- LinkedIn and social -------------------------------------------------------------------
  "linkedin:unipile": {
    probes: [
      {
        name: "getProfile",
        kind: "read",
        call: (linkedin, signal) => linkedin.getProfile("acc_conformance", TARGET, { signal }),
        expect: {
          // Unipile sometimes answers a thin profile without provider_id; a later read works.
          shape: { class: "malformed", retryable: true },
        },
      },
      {
        name: "sendInvite",
        kind: "write",
        call: (linkedin, signal) =>
          linkedin.sendInvite("acc_conformance", TARGET, "Hi Dana", { signal }),
        answers: {
          shape: "The invitation was accepted (2xx); the answer carries nothing the engine needs.",
        },
        expect: {
          // A 2xx page that is not JSON may come from something in between: it may not have
          // reached LinkedIn, so it is checked, never assumed sent and never repeated blindly.
          html: { class: "outcome_unknown", retryable: false },
        },
      },
      {
        name: "reactToPost",
        kind: "write",
        idempotent: true,
        call: (linkedin, signal) =>
          linkedin.reactToPost("acc_conformance", "urn:li:activity:7000000000000000001", "like", {
            signal,
          }),
        answers: {
          html: "The like was accepted (2xx).",
          shape: "The like was accepted (2xx).",
        },
      },
      {
        name: "sendMessage",
        kind: "write",
        call: (linkedin, signal) =>
          linkedin.sendMessage("acc_conformance", TARGET, "Thanks, Dana.", {
            chatId: "chat_conformance",
            signal,
          }),
        answers: {
          shape: "LinkedIn took the message (2xx) without an id: it went out.",
        },
        expect: {
          html: { class: "outcome_unknown", retryable: false },
        },
      },
      {
        name: "commentOnPost",
        kind: "write",
        call: (linkedin, signal) =>
          linkedin.commentOnPost(
            "acc_conformance",
            "urn:li:activity:7000000000000000001",
            "Congratulations on the new practice.",
            { signal },
          ),
        answers: {
          shape: "LinkedIn took the comment (2xx) without an id: it went out.",
        },
        expect: {
          html: { class: "outcome_unknown", retryable: false },
        },
      },
      {
        name: "visitProfile",
        kind: "write",
        idempotent: true,
        call: (linkedin, signal) => linkedin.visitProfile("acc_conformance", TARGET, { signal }),
        answers: {
          html: "The visit was accepted (2xx); the answer carries nothing the engine needs.",
          shape: "The visit was accepted (2xx); the answer carries nothing the engine needs.",
        },
      },
      {
        name: "withdrawInvite",
        kind: "write",
        idempotent: true,
        call: (linkedin, signal) =>
          linkedin.withdrawInvite("acc_conformance", "inv_conformance01", { signal }),
        answers: {
          html: "The withdrawal was accepted (2xx); one still listed is withdrawn on the next run.",
          shape:
            "The withdrawal was accepted (2xx); one still listed is withdrawn on the next run.",
        },
      },
      {
        name: "listPendingInvites",
        kind: "read",
        call: (linkedin, signal) => linkedin.listPendingInvites("acc_conformance", { signal }),
      },
      {
        name: "syncMessages",
        kind: "read",
        call: (linkedin) =>
          linkedin.syncMessages("acc_conformance", { since: new Date(NOW), cursor: null }),
      },
      {
        name: "syncRelations",
        kind: "read",
        call: (linkedin) =>
          linkedin.syncRelations("acc_conformance", { since: new Date(NOW), cursor: null }),
      },
    ],
  },
  "social:linkedin_official": {
    probes: [
      {
        name: "publish",
        kind: "write",
        call: (social, signal) =>
          social.publish({
            accountRef: { provider: "linkedin_official", account_id: "conformance-member" },
            text: "Three ways dental groups keep the front desk calm.",
            credentials: { access_token: `${SECRET}-member-token` },
            signal,
          }),
        expect: {
          // A 2xx page that is not LinkedIn's answer: unknown whether it was published.
          html: { class: "outcome_unknown", retryable: false },
        },
      },
      {
        name: "exchangeCode",
        kind: "read",
        call: (social) =>
          social.exchangeCode({
            code: `${SECRET}-auth-code`,
            redirectUri: "http://localhost:7331/v1/social/linkedin_official/callback",
            codeVerifier: `${SECRET}-verifier`,
          }),
      },
    ],
  },
  "social:unipile": {
    probes: [
      {
        name: "publish",
        kind: "write",
        call: (social, signal) =>
          social.publish({
            accountRef: { provider: "unipile", account_id: "acc_conformance" },
            text: "Three ways dental groups keep the front desk calm.",
            signal,
          }),
        expect: {
          // A 2xx page that is not Unipile's answer: unknown whether it was published.
          html: { class: "outcome_unknown", retryable: false },
        },
      },
    ],
  },

  // --- CRM -----------------------------------------------------------------------------------
  "crm:hubspot": {
    probes: [
      {
        name: "upsertContact",
        kind: "write",
        idempotent: true,
        call: (crm) => crm.upsertContact(PERSON, null),
      },
      {
        name: "upsertDeal",
        kind: "write",
        idempotent: true,
        call: (crm) => crm.upsertDeal(OPPORTUNITY, { contactId: "1001" }, {}),
      },
      {
        name: "findContactByEmail",
        kind: "read",
        call: (crm) => crm.findContactByEmail("dana@harbor-dental.example.com"),
      },
      {
        name: "findDealForContact",
        kind: "read",
        call: (crm) => crm.findDealForContact("1001", "Harbor Dental: Dana Reyes"),
      },
      {
        name: "deleteContact",
        kind: "write",
        idempotent: true,
        call: (crm) => crm.deleteContact("1001"),
        answers: {
          404: "A contact that is not there any more is already deleted.",
          shape: "The delete was accepted (2xx); the answer carries nothing the engine needs.",
        },
      },
      {
        name: "logActivity",
        kind: "write",
        call: (crm) =>
          crm.logActivity({
            kind: "note",
            contactId: "1001",
            body: "Asked for pricing.",
            occurredAt: new Date(NOW),
          }),
      },
    ],
  },
  "crm:pipedrive": {
    probes: [
      {
        name: "upsertContact",
        kind: "write",
        idempotent: true,
        call: (crm) => crm.upsertContact(PERSON, null),
        // It looks the person up by email first: a lookup whose answer broke off is retried.
        expect: { broken_200: { class: "network", retryable: true } },
      },
      {
        name: "upsertDeal",
        kind: "write",
        idempotent: true,
        call: (crm) => crm.upsertDeal(OPPORTUNITY, { contactId: "1001" }, {}),
      },
      {
        name: "findContactByEmail",
        kind: "read",
        call: (crm) => crm.findContactByEmail("dana@harbor-dental.example.com"),
      },
      {
        name: "findDealForContact",
        kind: "read",
        call: (crm) => crm.findDealForContact("1001", "Harbor Dental: Dana Reyes"),
      },
      {
        name: "deleteContact",
        kind: "write",
        idempotent: true,
        call: (crm) => crm.deleteContact("1001"),
        answers: {
          404: "A contact that is not there any more is already deleted.",
          shape: "The delete was accepted (2xx); the answer carries nothing the engine needs.",
        },
      },
      {
        name: "logActivity",
        kind: "write",
        call: (crm) =>
          crm.logActivity({
            kind: "note",
            contactId: "1001",
            body: "Asked for pricing.",
            occurredAt: new Date(NOW),
          }),
      },
    ],
  },
  "crm:webhook": {
    config: { url: "https://crm-hooks.example.com/openoutbound" },
    probes: [
      {
        name: "logActivity",
        kind: "write",
        call: (crm) =>
          crm.logActivity({
            kind: "note",
            contactId: "1001",
            body: "Asked for pricing.",
            occurredAt: new Date(NOW),
          }),
        answers: {
          html: "Any 2xx from the receiver is an accepted delivery.",
          shape: "Any 2xx from the receiver is an accepted delivery.",
        },
      },
    ],
  },
};

/** The class and retryability a case means for a probe, unless the probe documents another. */
function expected(probe: Probe, name: CaseName): Expectation | CodeExpectation {
  const documented = probe.expect?.[name];
  if (documented) return documented;
  // A write whose answer was lost may have happened; one that cannot happen twice is retried.
  const lostWrite = probe.kind === "write" && !probe.idempotent;
  switch (name) {
    case "timeout":
      if (lostWrite) return { class: "outcome_unknown", retryable: false };
      // A paid call that may have been charged is not repeated automatically.
      return { class: "timeout", retryable: !probe.paid };
    case "refused":
      // The connection never opened: nothing was sent or charged.
      return { class: "network", retryable: true };
    case "401":
      return { class: "auth_invalid", retryable: false };
    case "402":
      return { class: "quota_exhausted", retryable: false };
    case "403":
      return { class: "forbidden", retryable: false };
    case "404":
      return { class: "not_found", retryable: false };
    case "429":
      return { class: "rate_limited", retryable: true };
    case "500":
    case "503":
      return lostWrite
        ? { class: "outcome_unknown", retryable: false }
        : { class: "unavailable", retryable: true };
    case "html":
    case "shape":
      return { class: "malformed", retryable: false };
    case "broken_200":
      // The body broke off after a 2xx: a one-time write may not have reached the provider (a
      // page in between answers 2xx too), a write that can be repeated counts as done, and a
      // read is retried like any connection that broke.
      if (lostWrite) return { class: "outcome_unknown", retryable: false };
      if (probe.kind === "write") return { class: "malformed", retryable: false };
      return { class: "network", retryable: !probe.paid };
    case "broken_502":
      // Read from its status, as if the body were empty: the write rules apply.
      return lostWrite
        ? { class: "outcome_unknown", retryable: false }
        : { class: "unavailable", retryable: true };
  }
}

interface Sent {
  url: string;
  signal: AbortSignal | null | undefined;
}

function refusedError(): Error {
  const cause = Object.assign(new Error("connect ECONNREFUSED 203.0.113.10:443"), {
    code: "ECONNREFUSED",
    syscall: "connect",
  });
  return new TypeError("fetch failed", { cause });
}

/** The socket closing in the middle of a body, as undici reports it. */
function socketClosed(): Error {
  return Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
}

/** An answer with this status whose body breaks off after its first bytes. */
function brokenResponse(status: number): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"data":'));
      controller.error(new TypeError("terminated", { cause: socketClosed() }));
    },
  });
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

function hang(signal: AbortSignal | null | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (!signal) return; // never answers: the missing signal shows up as a test timeout
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

const HTML = "<!doctype html><html><head><title>Sign in</title></head><body>Sign in</body></html>";

/**
 * The fake server's answer for a status case. Like some real APIs, its error body echoes the
 * credentials it received (in the URL, the headers or the body) back to the caller.
 */
function statusAnswer(name: CaseName, received: string[]) {
  const status = Number(name);
  const echo = received.length > 0 ? received.join(" ") : "none";
  const body = JSON.stringify({
    error: { message: `Request refused for credentials ${echo}` },
    message: `Credentials ${echo} are not accepted here`,
  });
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (status === 429) headers["retry-after"] = "7";
  return { status, body, headers };
}

/** The secrets a request carries in its URL, headers or body. */
async function carried(
  secrets: string[],
  url: string,
  headers: Headers,
  body: unknown,
): Promise<string[]> {
  let text = `${url} ${[...headers.entries()].map(([key, value]) => `${key}:${value}`).join(" ")}`;
  if (typeof body === "string") text += body;
  else if (body instanceof URLSearchParams) text += body.toString();
  else if (body instanceof FormData) {
    for (const [, value] of body.entries()) if (typeof value === "string") text += value;
  }
  return secrets.filter((secret) => text.includes(secret));
}

function caseFetch(name: CaseName, secrets: string[], sent: Sent[]): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = request ? request.url : String(input);
    const signal = init?.signal ?? request?.signal;
    sent.push({ url, signal });
    const headers = new Headers(init?.headers ?? request?.headers);
    const body = init?.body ?? (request ? await request.clone().text() : undefined);
    const received = await carried(secrets, url, headers, body);
    switch (name) {
      case "timeout":
        return hang(signal);
      case "refused":
        throw refusedError();
      case "html":
        return new Response(HTML, { status: 200, headers: { "content-type": "text/html" } });
      case "shape":
        return Response.json({ unexpected: true });
      case "broken_200":
        return brokenResponse(200);
      case "broken_502":
        return brokenResponse(502);
      default: {
        const answer = statusAnswer(name, received);
        return new Response(answer.body, { status: answer.status, headers: answer.headers });
      }
    }
  }) as typeof globalThis.fetch;
}

function transportReply(
  status: number,
  body: string,
  headers: Record<string, string>,
): TransportResponse {
  return {
    status,
    statusText: "",
    headers: new Headers(headers),
    body: (async function* () {
      yield Buffer.from(body);
    })(),
  };
}

/** The engine's real safe fetch on a fake transport, with its timeouts cut to 100 ms. */
function caseSafeFetch(name: CaseName, secrets: string[], sent: Sent[]): SafeFetch {
  const safeFetch = createSafeFetch({
    allowPrivateNetwork: false,
    userAgent: "OpenOutboundBot/1.0 (+https://example.com/bot)",
    clock: fixedClock(NOW),
    resolveHost: async () => ["93.184.215.14"],
    transport: async (request) => {
      sent.push({ url: request.url.toString(), signal: request.signal });
      const body = request.body ? Buffer.from(request.body).toString("utf8") : undefined;
      const received = await carried(
        secrets,
        request.url.toString(),
        new Headers(request.headers),
        body,
      );
      // robots.txt is allowed, so every case reaches the page itself.
      if (request.url.pathname === "/robots.txt") return transportReply(404, "", {});
      switch (name) {
        case "timeout":
          return hang(request.signal);
        case "refused":
          throw refusedError().cause;
        case "html":
          return transportReply(200, HTML, { "content-type": "text/html" });
        case "shape":
          return transportReply(200, JSON.stringify({ unexpected: true }), {
            "content-type": "application/json",
          });
        case "broken_200":
        case "broken_502":
          return {
            status: name === "broken_200" ? 200 : 502,
            statusText: "",
            headers: new Headers({ "content-type": "application/json" }),
            body: (async function* () {
              yield Buffer.from('{"data":');
              throw socketClosed();
            })(),
          };
        default: {
          const answer = statusAnswer(name, received);
          return transportReply(answer.status, answer.body, answer.headers);
        }
      }
    },
  });
  return ((url, init) =>
    safeFetch(url, { ...init, timeoutMs: Math.min(init?.timeoutMs ?? 15_000, 100) })) as SafeFetch;
}

const registry = buildRegistry(modules, KERNEL_CONTRIBUTIONS);
const definitions = registry.providers().all() as ProviderDefinition[];
const keyOf = (definition: ProviderDefinition) => `${definition.slot}:${definition.id}`;

function secretsOf(definition: ProviderDefinition): Record<string, string> {
  return Object.fromEntries(
    definition.secrets.map((spec) => [spec.key, `${SECRET}-${spec.key.replace(/_/g, "-")}`]),
  );
}

async function build(definition: ProviderDefinition, entry: Entry, name: CaseName, sent: Sent[]) {
  const secrets = secretsOf(definition);
  const values = Object.values(secrets);
  const runtime: ProviderRuntime = {
    fetch: caseFetch(name, values, sent),
    safeFetch: caseSafeFetch(name, values, sent),
    log: silentLogger(),
    clock: fixedClock(NOW),
    baseUrl: "http://localhost:7331",
    workspaceId: "ws_conformance01",
    db: undefined as unknown as Db,
  };
  const config = definition.configSchema
    ? definition.configSchema.parse(entry.config ?? {})
    : (entry.config ?? {});
  const instance = await definition.create({ config, secrets, ctx: runtime });
  return {
    instance,
    secrets: [...values, `${SECRET}-member-token`, `${SECRET}-auth-code`, `${SECRET}-verifier`],
  };
}

beforeAll(() => {
  capProviderTimeouts(100);
});
afterAll(() => {
  capProviderTimeouts(null);
});

describe("provider conformance", () => {
  it("has an entry for every registered provider", () => {
    const missing = definitions
      .filter((definition) => !definition.sandbox && !(keyOf(definition) in ENTRIES))
      .map(keyOf);
    expect(
      missing,
      `Add a conformance entry to tests/providers/conformance.test.ts for ${missing.join(", ")}: its probe calls with their kind (read or write, paid, idempotent), or a skip with the reason.`,
    ).toEqual([]);
    const known = new Set(definitions.map(keyOf));
    const stale = Object.keys(ENTRIES).filter((key) => !known.has(key));
    expect(stale, `Remove conformance entries for providers that no longer exist`).toEqual([]);
  });

  for (const definition of definitions) {
    const entry = ENTRIES[keyOf(definition)];
    if (definition.sandbox || !entry) continue;
    if ("skip" in entry) {
      it.skip(`${keyOf(definition)}: ${entry.skip}`, () => {});
      continue;
    }
    for (const probe of entry.probes) {
      it(`${keyOf(definition)} ${probe.name} (${probe.kind}${probe.paid ? ", paid" : ""}${probe.idempotent ? ", idempotent" : ""})`, async () => {
        for (const name of CASES) {
          const label = `${keyOf(definition)} ${probe.name}, case ${name}`;
          const sent: Sent[] = [];
          const { instance, secrets } = await build(definition, entry, name, sent);
          const outcome = await probe.call(instance, AbortSignal.timeout(300)).then(
            () => null,
            (error: unknown) => error,
          );
          expect(sent.length, `${label}: made no request`).toBeGreaterThan(0);
          for (const request of sent) {
            expect(request.signal, `${label}: a request without an abort signal`).toBeInstanceOf(
              AbortSignal,
            );
          }
          if (probe.answers?.[name]) {
            expect(outcome, `${label}: ${probe.answers[name]}`).toBeNull();
            continue;
          }
          expect(isOpenOutboundError(outcome), `${label}: ${String(outcome)}`).toBe(true);
          const error = outcome as OpenOutboundError;
          const want = expected(probe, name);
          if ("code" in want) {
            expect(error.code, label).toBe(want.code);
          } else {
            const failure = failureOf(error);
            expect(
              { class: failure?.class, retryable: failure?.retryable },
              `${label}: ${error.message}`,
            ).toEqual({ class: want.class, retryable: want.retryable });
            if (name === "429") {
              expect(failure?.retry_after_s, `${label}: Retry-After`).toBe(7);
              expect(retryAfterOf(error), label).toBe(7);
            }
          }
          const shown = JSON.stringify({
            message: error.message,
            hint: error.hint,
            details: error.details,
          });
          for (const secret of secrets) {
            expect(shown.includes(secret), `${label}: a secret reached the error: ${shown}`).toBe(
              false,
            );
          }
        }
      });
    }
  }
});
