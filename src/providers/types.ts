/**
 * The provider plug-in API (spec section 10). Every external service sits behind one of these
 * slot interfaces. A provider = `defineProvider({ slot, id, ..., create })` returning an
 * instance of the slot's interface.
 *
 * Conventions:
 * - Data records (candidates, profiles, signals) use snake_case fields matching the database.
 *   Envelopes and options use camelCase.
 * - Throw classified failures for upstream errors: `providerFailure` from core/failures, or the
 *   request helpers in providers/http.ts that build it (a timeout on every request, statuses
 *   mapped with `classifyHttpStatus`, writes whose answer was lost marked `outcome_unknown`).
 *   Never put API keys in messages or details.
 * - No live network calls in tests: providers get `fetch` from their runtime, and contract
 *   tests replay recorded fixtures.
 */
import type { z } from "zod";
import type { Clock } from "../core/clock.js";
import type { SafeFetch } from "../core/context.js";
import type { EmailStatus, ModelTier } from "../core/enums.js";
import type { Logger } from "../core/logger.js";
import type { Db } from "../db/client.js";
import type { Company, Opportunity, Person } from "../db/schema/index.js";

export type { EmailStatus, ModelTier } from "../core/enums.js";

export const SLOTS = [
  "brain",
  "lead_source",
  "email_finder",
  "email_verifier",
  "research",
  "signals",
  "linkedin",
  "social",
  "crm",
] as const;
export type Slot = (typeof SLOTS)[number];

/** Slot -> instance interface. */
export interface SlotInterfaces {
  brain: BrainProvider;
  lead_source: LeadSourceProvider;
  email_finder: EmailFinderProvider;
  email_verifier: EmailVerifierProvider;
  research: ResearchProvider;
  signals: SignalProvider;
  linkedin: LinkedInProvider;
  social: SocialPublisher;
  crm: CrmProvider;
}

// --- Definition ------------------------------------------------------------------------------

/** A secret the provider needs (API key, token). Stored in the vault, or read from `env`. */
export interface SecretSpec {
  /** Key passed to `create({ secrets })`, e.g. "api_key". */
  key: string;
  label: string;
  /** Env var fallback, e.g. "APOLLO_API_KEY". */
  env?: string;
  required: boolean;
  description?: string;
}

/** Services the engine hands to a provider instance. */
export interface ProviderRuntime {
  /**
   * fetch for the provider's own API hosts (auth headers allowed). In tests this is a stub;
   * never import or call the global fetch directly.
   */
  fetch: typeof globalThis.fetch;
  /** fetch for URLs that come from data (company websites, feeds): SSRF-safe, size capped. */
  safeFetch: SafeFetch;
  log: Logger;
  clock: Clock;
  /** Public base URL of this instance (webhook and OAuth callback URLs). */
  baseUrl: string;
  /** Workspace the instance was created for; null for instance-level instances. */
  workspaceId: string | null;
  /** Database access for built-in providers only (sandbox world). Plug-ins should not use it. */
  db: Db;
}

export interface ProviderCreateArgs<C> {
  /** Parsed with `configSchema` (or `{}` when there is none). */
  config: C;
  /** Resolved secrets by SecretSpec.key (vault or env). Missing optional secrets are absent. */
  secrets: Record<string, string>;
  ctx: ProviderRuntime;
}

export interface ProviderTestResult {
  /** The provider works: its key is accepted and, where it can tell, it has credits left. */
  ok: boolean;
  /** One line shown by `providers test` and `doctor`, e.g. "Connected as dana@example.com". */
  message: string;
  /**
   * False when nothing was verified live (the provider has no free check, so only the settings
   * were looked at). Such a test never ends a pause of the provider. Default true.
   */
  checked?: boolean;
  details?: Record<string, unknown>;
}

export interface ProviderDefinition<S extends Slot = Slot, C = unknown> {
  slot: S;
  /** Unique within the slot, snake_case: "apollo", "openai_compatible", "sandbox". */
  id: string;
  /** Display name, e.g. "Apollo.io". */
  name: string;
  description: string;
  docsUrl?: string;
  /** Non-secret settings (model names, base URL, preset). */
  configSchema?: z.ZodType<C>;
  secrets: SecretSpec[];
  /** Sandbox providers only serve sandbox workspaces (and vice versa). */
  sandbox?: boolean;
  create(args: ProviderCreateArgs<C>): SlotInterfaces[S] | Promise<SlotInterfaces[S]>;
  /** Cheap live check used by `providers test` and `doctor` (never spends credits). */
  test?(instance: SlotInterfaces[S]): Promise<ProviderTestResult>;
  /**
   * Set false for providers that call no outside service of their own (the built-in research
   * reads public pages): the engine then never pauses them or opens `provider_down` for them.
   * Default true.
   */
  health?: boolean;
}

/** Declares a provider. Checks the id format at import time. */
export function defineProvider<S extends Slot, C = unknown>(
  definition: ProviderDefinition<S, C>,
): ProviderDefinition<S, C> {
  if (!/^[a-z][a-z0-9_]{1,40}$/.test(definition.id)) {
    throw new Error(`defineProvider: id "${definition.id}" must be snake_case, e.g. "apollo"`);
  }
  return definition;
}

// --- brain -----------------------------------------------------------------------------------

export interface BrainCapabilities {
  /**
   * native = provider enforces the JSON schema; json_mode = valid JSON but schema not enforced;
   * prompt = schema only described in the prompt. The brain service validates in every case.
   */
  structuredOutput: "native" | "json_mode" | "prompt";
  /** Max parallel generate() calls the service should run for this provider. */
  maxConcurrency: number;
  /** Supports prompt caching of the system prompt. */
  caching: boolean;
}

export interface BrainMessage {
  role: "user" | "assistant";
  content: string;
}

export interface BrainRequest {
  system: string;
  messages: BrainMessage[];
  /** JSON Schema (draft 2020-12) the output must match. */
  jsonSchema?: Record<string, unknown>;
  /** Schema name for providers that need one (letters, digits, underscores). */
  schemaName?: string;
  model: string;
  maxTokens: number;
  temperature?: number;
  signal?: AbortSignal;
  metadata?: { promptId: string; workspaceId?: string; taskKey?: string };
}

export interface BrainUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  /** Null or absent when the provider cannot price the call. */
  costUsd?: number | null;
}

export interface BrainResponse {
  /** Raw text output. */
  text: string;
  /** Parsed JSON when the provider returned structured output (still validated by the service). */
  json?: unknown;
  /** Model actually used. */
  model: string;
  usage: BrainUsage;
}

/**
 * An LLM. Stateless: one request, one response. The agent brain may throw `JobWaitError` to
 * park the calling job until the connected agent answers.
 */
export interface BrainProvider {
  id: string;
  capabilities: BrainCapabilities;
  /** Default model per tier; tiers without a default need configuration. */
  defaultModels: Partial<Record<ModelTier, string>>;
  generate(request: BrainRequest): Promise<BrainResponse>;
}

// --- lead_source -----------------------------------------------------------------------------

export interface GeoFilter {
  /** Free-text place, e.g. "Austin, TX" or "Munich". */
  text?: string;
  lat?: number;
  lng?: number;
  radius_m?: number;
}

export interface EmployeeRange {
  min?: number;
  max?: number;
}

export interface PeopleQuery {
  /** Free-text query. */
  query?: string;
  titles?: string[];
  seniorities?: string[];
  departments?: string[];
  location?: GeoFilter;
  /** ISO 3166-1 alpha-2. */
  countries?: string[];
  company_domains?: string[];
  company_names?: string[];
  industries?: string[];
  employee_range?: EmployeeRange;
  keywords?: string[];
  technologies?: string[];
}

export interface CompanyQuery {
  /** Free-text query, e.g. "dental clinics". */
  query?: string;
  location?: GeoFilter;
  countries?: string[];
  industries?: string[];
  employee_range?: EmployeeRange;
  keywords?: string[];
  technologies?: string[];
  domains?: string[];
  /** Provider categories, e.g. Google place types ("dentist"). */
  categories?: string[];
  min_rating?: number;
}

export interface PageRequest {
  /** Max items for this page. */
  limit: number;
  /**
   * nextCursor from the previous page. A search that makes several requests and fails part way
   * throws with `details.partial = { items, credits, resume }`: the items already paid for, the
   * credits of the requests made, and `resume`, a cursor (string) that restarts at the request
   * that failed; pass it here.
   */
  cursor?: string;
  /**
   * The most credits this call may spend (what is left of the data budget or a spend cap). A
   * provider that bills per request stops before going past it and returns a cursor for the
   * rest; one with a fixed price per page can ignore it, since that price is checked up front.
   */
  maxCredits?: number;
}

export interface SourcePage<T> {
  items: T[];
  nextCursor?: string | null;
  total?: number | null;
  /** Credits consumed by this call (0 for free searches). */
  creditsUsed: number;
}

export interface CompanyCandidate {
  /** Provider's id (Apollo org id, Google place_id). Stored in source_refs. */
  external_id?: string;
  name: string;
  domain?: string | null;
  website?: string | null;
  linkedin_url?: string | null;
  industry?: string | null;
  description?: string | null;
  employee_count?: number | null;
  employee_range?: string | null;
  revenue_range?: string | null;
  founded_year?: number | null;
  country?: string | null;
  region?: string | null;
  city?: string | null;
  address?: string | null;
  postal_code?: string | null;
  phone?: string | null;
  timezone?: string | null;
  /** Coordinates: do not store longer than the provider's terms allow (Places: 30 days). */
  lat?: number | null;
  lng?: number | null;
  rating?: number | null;
  reviews_count?: number | null;
  categories?: string[];
  technologies?: string[];
  /** Provider id that produced the candidate. */
  source: string;
  /** Original payload, for debugging. Not stored by default. */
  raw?: unknown;
}

export interface PersonCandidate {
  external_id?: string;
  first_name?: string | null;
  last_name?: string | null;
  full_name?: string | null;
  title?: string | null;
  seniority?: string | null;
  department?: string | null;
  email?: string | null;
  email_status?: EmailStatus;
  linkedin_url?: string | null;
  phone?: string | null;
  country?: string | null;
  region?: string | null;
  city?: string | null;
  timezone?: string | null;
  company?: CompanyCandidate | null;
  source: string;
  raw?: unknown;
}

export interface CostEstimate {
  credits: number;
  usd?: number | null;
  note?: string;
  /**
   * The most the request can cost, set only when that is more than `credits`: `credits` is
   * then the least it takes to fill the page (a Google Maps search that splits a busy area
   * makes more requests).
   */
  maxCredits?: number;
  /**
   * Set by providers that bill per request and stop at `PageRequest.maxCredits`: the cost of
   * one request. Such a search can start with only this much left, and stops there.
   */
  minCredits?: number;
}

export interface LeadSourceProvider {
  id: string;
  capabilities: { people: boolean; companies: boolean; enrich: boolean };
  searchPeople?(query: PeopleQuery, page: PageRequest): Promise<SourcePage<PersonCandidate>>;
  searchCompanies?(query: CompanyQuery, page: PageRequest): Promise<SourcePage<CompanyCandidate>>;
  /**
   * Fills emails/phones/details for candidates (usually costs credits). `items[i]` answers
   * `candidates[i]`; null when there was no match. A call that fails part way throws with
   * `details.partial = { items, credits }`: `items` lines up index by index with the first
   * items.length candidates (whole chunks only; null: answered, no match) and `credits` is
   * what was spent. Enrich only the remaining candidates to go on.
   */
  enrichPeople?(
    candidates: PersonCandidate[],
  ): Promise<{ items: Array<PersonCandidate | null>; creditsUsed: number }>;
  /** Estimated cost of a search or enrichment, for dry runs. */
  estimate?(request: {
    kind: "people" | "companies" | "enrich";
    count: number;
    query?: PeopleQuery | CompanyQuery;
  }): Promise<CostEstimate>;
}

// --- email_finder / email_verifier -----------------------------------------------------------

export interface FindEmailInput {
  first_name?: string | null;
  last_name?: string | null;
  full_name?: string | null;
  domain?: string | null;
  company?: string | null;
  linkedin_url?: string | null;
}

export interface FindEmailResult {
  email: string | null;
  /** Status reported by the finder (verify again before sending unless `valid`). */
  status?: EmailStatus;
  /** 0-1 */
  confidence?: number;
  creditsUsed: number;
  raw?: unknown;
}

export interface EmailFinderProvider {
  id: string;
  findEmail(input: FindEmailInput): Promise<FindEmailResult>;
}

export interface VerifyEmailResult {
  email: string;
  status: EmailStatus;
  /** Provider's reason code, e.g. "mailbox_not_found", "catch_all". */
  reason?: string;
  creditsUsed: number;
  raw?: unknown;
}

export interface EmailVerifierProvider {
  id: string;
  verify(email: string): Promise<VerifyEmailResult>;
}

// --- research --------------------------------------------------------------------------------

export interface SearchOptions {
  limit?: number;
  /** Only results published within this many days. */
  recencyDays?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
}

export interface SearchResult {
  url: string;
  title: string;
  snippet?: string;
  /** ISO date. */
  publishedAt?: string;
  /** Provider relevance score (not comparable across providers). */
  score?: number;
}

export interface FetchedPage {
  url: string;
  title?: string;
  /** Clean text (markdown allowed). */
  text: string;
  publishedAt?: string;
}

export interface AnswerResult {
  answer: string;
  citations: Array<{ url: string; title?: string }>;
}

export interface ResearchProvider {
  id: string;
  /** Credits per call by method name ("search", "fetch", "answer") for usage metering. Default 1. */
  creditsPerCall?: Partial<Record<"search" | "fetch" | "answer", number>>;
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
  fetch?(url: string): Promise<FetchedPage>;
  answer?(question: string, options?: SearchOptions): Promise<AnswerResult>;
}

// --- signals ---------------------------------------------------------------------------------

/** A signal as found by a provider or collector, before scoring and storage. */
export interface RawSignal {
  /** Signal definition key, e.g. "funding_round", "new_exec_hire". */
  definition_key: string;
  title: string;
  summary?: string | null;
  /** Evidence-first: the page proving it. Signals without evidence are dropped. */
  evidence_url: string;
  evidence_excerpt?: string | null;
  /** Provider id or collector name. */
  source: string;
  /** ISO 8601: when it happened (default: detection time). */
  occurred_at?: string | null;
  /** 0-1, default 1. */
  strength?: number;
  /** Stable key for dedupe; default derived from definition_key + evidence_url. */
  dedupe_key?: string;
  /** Who it is about, when known only by identifiers (webhooks). */
  company?: {
    id?: string;
    name?: string;
    domain?: string | null;
    linkedin_url?: string | null;
  } | null;
  person?: {
    id?: string;
    full_name?: string | null;
    email?: string | null;
    linkedin_url?: string | null;
  } | null;
  raw?: unknown;
}

export interface SignalTarget {
  company: { id: string; name: string; domain?: string | null; linkedin_url?: string | null };
  person?: {
    id: string;
    full_name?: string | null;
    email?: string | null;
    linkedin_url?: string | null;
  } | null;
}

export interface SignalProvider {
  id: string;
  /** Definition keys this provider can detect. */
  supportedSignals: string[];
  /** Credits per collect() call, for usage metering. Default 1. */
  creditsPerCall?: number;
  /**
   * A call that makes several paid requests and fails part way throws with `details.partial`
   * (the signals so far and their credits). Passing its `resume` back runs only the requests
   * that did not answer and returns only their signals.
   */
  collect(
    target: SignalTarget,
    options?: { since?: Date; signalKeys?: string[]; resume?: unknown },
  ): Promise<RawSignal[]>;
  /** Parses a verified inbound webhook into signals (signature checks happen before). */
  parseWebhook?(body: unknown, headers: Record<string, string>): Promise<RawSignal[]>;
}

// --- linkedin --------------------------------------------------------------------------------

/**
 * A LinkedIn member to act on: `profile_url` (normalized https://www.linkedin.com/in/<slug>)
 * and/or the provider's member id.
 */
export interface LinkedInTarget {
  profile_url?: string | null;
  provider_id?: string | null;
}

export interface LinkedInProfile {
  /** Provider's member id (URN or internal id). */
  provider_id: string;
  profile_url: string;
  public_identifier?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  full_name?: string | null;
  headline?: string | null;
  location?: string | null;
  company?: string | null;
  title?: string | null;
  /** 1 = connected. */
  connection_degree?: 1 | 2 | 3 | null;
  invitation_pending?: boolean;
  premium?: boolean;
  raw?: unknown;
}

export interface LinkedInPost {
  id: string;
  url?: string | null;
  text: string;
  /** ISO 8601. */
  published_at?: string | null;
  author_provider_id?: string | null;
  reactions_count?: number;
  comments_count?: number;
  raw?: unknown;
}

export interface LinkedInInboundMessage {
  id: string;
  chat_id: string;
  sender_provider_id: string;
  sender_profile_url?: string | null;
  /** Untrusted prospect text. */
  text: string;
  /** ISO 8601. */
  sent_at: string;
  /** True for messages the account itself sent (from any device). */
  is_outbound: boolean;
  raw?: unknown;
}

export interface LinkedInAccountInfo {
  external_account_id: string;
  name: string;
  profile_url?: string | null;
  status: "active" | "restricted" | "disconnected" | "credentials_needed";
  premium?: boolean;
}

export type LinkedInEvent =
  | {
      type: "invite_accepted";
      account_id: string;
      provider_id: string;
      profile_url?: string | null;
      occurred_at: string;
    }
  | { type: "message_received"; account_id: string; message: LinkedInInboundMessage }
  | {
      type: "account_status";
      account_id: string;
      status: LinkedInAccountInfo["status"];
      reason?: string;
    };

export type LinkedInReaction = "like" | "celebrate" | "support" | "love" | "insightful" | "funny";

/**
 * Per-call options a caller may pass to a provider. `signal` aborts the request when the job is
 * cancelled or runs out of time; providers pass it on to their HTTP requests (joined with their
 * own timeout, see `providerSignal` in core/failures). Providers that ignore it still work.
 */
export interface ProviderCallOptions {
  signal?: AbortSignal;
}

/**
 * LinkedIn actions through a provider (Unipile). `account` is the provider's account id
 * (linkedin_accounts.external_account_id).
 *
 * Restrictions and rate limits must throw
 * `OpenOutboundError("provider_error", message, { details: { restricted: true } })` or
 * `{ details: { rateLimited: true } }` (+ retryAfterSeconds): the linkedin module pauses the
 * account on `restricted` and backs off on `rateLimited`.
 */
export interface LinkedInProvider {
  id: string;
  /** Hosted-auth link where the user connects their account. */
  createAuthLink?(options: {
    workspaceId: string;
    /** Returned in the provider's callback so we can match the account. */
    state: string;
    successUrl?: string;
    failureUrl?: string;
    notifyUrl?: string;
  }): Promise<{ url: string; expiresAt?: string }>;
  listAccounts?(): Promise<LinkedInAccountInfo[]>;
  getProfile(
    account: string,
    target: LinkedInTarget,
    options?: ProviderCallOptions,
  ): Promise<LinkedInProfile>;
  visitProfile(
    account: string,
    target: LinkedInTarget,
    options?: ProviderCallOptions,
  ): Promise<void>;
  /** `note` is already length-checked (200 free / 300 premium). */
  sendInvite(
    account: string,
    target: LinkedInTarget,
    note?: string,
    options?: ProviderCallOptions,
  ): Promise<{ providerRef?: string }>;
  /**
   * Only for 1st-degree connections. `messageId` is missing when LinkedIn took the message but
   * the answer carried no id: the message still went out.
   */
  sendMessage(
    account: string,
    target: LinkedInTarget,
    text: string,
    options?: { chatId?: string } & ProviderCallOptions,
  ): Promise<{ messageId?: string; chatId?: string }>;
  listRecentPosts(
    account: string,
    target: LinkedInTarget,
    options?: { limit?: number } & ProviderCallOptions,
  ): Promise<LinkedInPost[]>;
  reactToPost(
    account: string,
    postId: string,
    reaction?: LinkedInReaction,
    options?: ProviderCallOptions,
  ): Promise<void>;
  commentOnPost(
    account: string,
    postId: string,
    text: string,
    options?: ProviderCallOptions,
  ): Promise<{ commentId?: string }>;
  /**
   * Paging calls (pending invitations, message and relation sync) that fail after some pages
   * throw with `details.partial`: the items so far and, as `resume`, the cursor of the page
   * that failed (pass it back as `resume` here, or as `cursor` to the sync calls).
   */
  listPendingInvites?(
    account: string,
    options?: { resume?: unknown } & ProviderCallOptions,
  ): Promise<
    Array<{
      invitation_id: string;
      provider_id: string;
      profile_url?: string | null;
      sent_at?: string | null;
    }>
  >;
  withdrawInvite?(
    account: string,
    invitationId: string,
    options?: ProviderCallOptions,
  ): Promise<void>;
  syncMessages?(
    account: string,
    options: { since?: Date; cursor?: string | null },
  ): Promise<{ messages: LinkedInInboundMessage[]; cursor?: string | null }>;
  syncRelations?(
    account: string,
    options: { since?: Date; cursor?: string | null },
  ): Promise<{
    connections: Array<{
      provider_id: string;
      profile_url?: string | null;
      connected_at?: string | null;
    }>;
    cursor?: string | null;
  }>;
  /** Parses a verified inbound webhook (signature checks happen before). */
  parseWebhook?(body: unknown, headers: Record<string, string>): Promise<LinkedInEvent[]>;
}

// --- social ----------------------------------------------------------------------------------

export interface SocialAccount {
  provider: string;
  account_id: string;
  name?: string;
}

/** Publishes posts (LinkedIn official API, Unipile, sandbox). */
export interface SocialPublisher {
  id: string;
  publish(input: {
    accountRef: SocialAccount;
    text: string;
    media?: Array<{ type: "image" | "video" | "document"; url: string; alt?: string }>;
    /** Decrypted per-account credentials (e.g. `{ access_token }`), when the provider needs them. */
    credentials?: Record<string, string>;
    /** Aborts the request when the job is cancelled or runs out of time. */
    signal?: AbortSignal;
  }): Promise<{ externalId: string; url?: string }>;
  /** OAuth authorize URL for connecting a posting account. */
  authUrl?(input: { state: string; redirectUri: string }): string | Promise<string>;
  /** Exchanges the OAuth code; the caller stores `credentials` in the vault. */
  exchangeCode?(input: { code: string; redirectUri: string }): Promise<{
    account: SocialAccount;
    credentials: Record<string, string>;
    expiresAt?: string;
  }>;
}

// --- crm -------------------------------------------------------------------------------------

/**
 * One moment written to a CRM as a note (`crm.log` key_moments or everything). The engine
 * builds it; providers only format it ("Email sent: <subject>") and attach it to the records.
 */
export interface CrmActivity {
  kind: "email_sent" | "email_received" | "reply" | "meeting" | "note";
  /** The CRM's contact id (from crm_links). */
  contactId: string;
  dealId?: string | null;
  companyId?: string | null;
  /** Short headline: an email subject, a reply category, a meeting change. */
  subject?: string | null;
  /** Plain text, at most 2000 characters (the engine cuts longer text). */
  body?: string | null;
  occurredAt: Date;
}

/** Options for `upsertDeal`; older providers may ignore them. */
export interface CrmDealOptions {
  /** Title for a new deal. The engine looks for a deal with this title before creating one. */
  title?: string;
  /** `crm.stage_owner: crm`: when the deal exists, leave its stage and won or lost status alone. */
  keepStage?: boolean;
}

/**
 * Pushes contacts, deals and notes to a CRM. Pass known external ids (crm_links) to update in
 * place. Every method after `upsertDeal` is optional, so custom providers keep working; the
 * engine skips what a provider cannot do.
 */
export interface CrmProvider {
  id: string;
  upsertContact(
    person: Person,
    company?: Company | null,
    existing?: { contactId?: string; companyId?: string },
  ): Promise<{ contactId: string; companyId?: string }>;
  upsertDeal(
    opportunity: Opportunity,
    links: { contactId?: string; companyId?: string; dealId?: string },
    options?: CrmDealOptions,
  ): Promise<{ dealId: string }>;
  /** Older note hook; used only when the provider has no `logActivity`. */
  logNote?(input: {
    contactId?: string;
    dealId?: string;
    text: string;
    occurredAt?: Date;
  }): Promise<void>;
  /** The contact with exactly this email, or null (reconciliation before creating one). */
  findContactByEmail?(email: string): Promise<string | null>;
  /** The contact's deal with exactly this title, or null (so a retry never creates a second deal). */
  findDealForContact?(contactId: string, title: string): Promise<string | null>;
  /** Writes a note on the contact (and deal and company when given); returns the CRM's id if any. */
  logActivity?(entry: CrmActivity): Promise<{ activityId: string | null }>;
  /** Deletes a contact (privacy erasure with `crm.on_forget: delete`); false when it was already gone. */
  deleteContact?(contactId: string): Promise<{ deleted: boolean }>;
}
