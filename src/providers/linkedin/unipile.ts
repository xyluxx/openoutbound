/**
 * Unipile LinkedIn provider (slot linkedin). Acts inside the user's own LinkedIn session
 * through Unipile's API: hosted-auth links, profile lookups, invitations, chats, posts,
 * reactions, comments, sent-invitation withdrawal, message/relation sync and webhooks.
 * Endpoints and payloads follow the provider API notes (section 3).
 */
import { z } from "zod";
import type { OpenOutboundError } from "../../core/errors.js";
import { malformedFailure, withPartial } from "../http.js";
import { defineProvider, type LinkedInProvider, type LinkedInTarget } from "../types.js";
import { createUnipileClient, UNIPILE, type UnipileClient } from "./unipile-client.js";
import {
  asRecord,
  cursorOf,
  identifierFor,
  items,
  mapAccount,
  mapMessage,
  mapPendingInvite,
  mapPost,
  mapProfile,
  mapRelation,
  parseUnipileWebhook,
  str,
} from "./unipile-mapping.js";

/** Pages fetched per sync call (100 items each). */
const MAX_SYNC_PAGES = 5;
const AUTH_LINK_TTL_MS = 24 * 60 * 60_000;

export const unipileSecrets = [
  {
    key: "dsn",
    label: "Unipile DSN (host:port)",
    env: "UNIPILE_DSN",
    required: true,
    description: "Your tenant's API host from the Unipile dashboard, e.g. api1.unipile.com:13111",
  },
  { key: "api_key", label: "Unipile API key", env: "UNIPILE_API_KEY", required: true },
];

export const unipileConfigSchema = z.object({
  timeout_ms: z.number().int().min(1_000).max(120_000).default(30_000),
});

export function createUnipileLinkedIn(
  client: UnipileClient,
  clock: { now(): Date },
): LinkedInProvider {
  const profile = async (
    account: string,
    target: LinkedInTarget,
    signal: AbortSignal | undefined,
  ) => {
    const body = await client.request(
      "GET",
      `/users/${encodeURIComponent(identifierFor(target))}`,
      { query: { account_id: account }, signal },
    );
    return mapProfile(body, target.profile_url ?? null);
  };
  const providerIdOf = async (
    account: string,
    target: LinkedInTarget,
    signal: AbortSignal | undefined,
  ) => target.provider_id?.trim() || (await profile(account, target, signal)).provider_id;

  /**
   * Reads up to MAX_SYNC_PAGES pages from `first` (null: the start). `next` is the cursor of
   * the page after the last one read when the listing goes on (stopped at MAX_SYNC_PAGES), null
   * when it is finished. A page that fails after others were read throws with
   * `details.partial`: the items so far and the cursor of the failed page as `resume`.
   */
  const pages = async <T>(
    path: string,
    query: Record<string, string | number | boolean | null | undefined>,
    first: string | null,
    take: (body: unknown) => { items: T[]; stop: boolean },
  ): Promise<{ items: T[]; next: string | null }> => {
    const out: T[] = [];
    let cursor = first;
    for (let page = 0; page < MAX_SYNC_PAGES; page++) {
      let body: unknown;
      try {
        body = await client.request("GET", path, { query: { ...query, limit: 100, cursor } });
      } catch (error) {
        if (page === 0) throw error;
        throw withPartial(error, UNIPILE, { items: out, credits: 0, resume: cursor });
      }
      // A page without a list is not an empty page: read as "nothing new", the sync would move
      // past messages and acceptances it never saw.
      if (!Array.isArray(asRecord(body).items)) {
        const error = malformed("items");
        if (page === 0) throw error;
        throw withPartial(error, UNIPILE, { items: out, credits: 0, resume: cursor });
      }
      const { items: found, stop } = take(body);
      out.push(...found);
      cursor = cursorOf(body);
      if (!cursor || stop) return { items: out, next: null };
    }
    return { items: out, next: cursor };
  };

  return {
    id: "unipile",
    async createAuthLink(options) {
      const expiresOn = new Date(clock.now().getTime() + AUTH_LINK_TTL_MS).toISOString();
      const body = await client.request("POST", "/hosted/accounts/link", {
        json: {
          type: "create",
          providers: ["LINKEDIN"],
          // Unipile's hosted page calls the tenant API: api_url is the DSN base, not a callback.
          api_url: client.baseUrl.replace(/\/api\/v1$/, ""),
          expiresOn,
          name: options.state,
          ...(options.notifyUrl ? { notify_url: options.notifyUrl } : {}),
          ...(options.successUrl ? { success_redirect_url: options.successUrl } : {}),
          ...(options.failureUrl ? { failure_redirect_url: options.failureUrl } : {}),
        },
      });
      const url = str(asRecord(body).url);
      if (!url) throw malformed("url");
      return { url, expiresAt: expiresOn };
    },
    async listAccounts() {
      const body = await client.request("GET", "/accounts", { query: { limit: 100 } });
      return items(body)
        .map(mapAccount)
        .filter((item) => item !== null);
    },
    getProfile: (account, target, options) => profile(account, target, options?.signal),
    async visitProfile(account, target, options) {
      // The visit is the request (notify = true); a second one changes nothing. Its answer is
      // not needed, so an odd body never turns a visit that happened into a failure.
      await client.request("GET", `/users/${encodeURIComponent(identifierFor(target))}`, {
        query: { account_id: account, notify: true },
        write: true,
        idempotent: true,
        signal: options?.signal,
      });
    },
    async sendInvite(account, target, note, options) {
      const providerId = await providerIdOf(account, target, options?.signal);
      await client.request("POST", "/users/invite", {
        json: { account_id: account, provider_id: providerId, ...(note ? { message: note } : {}) },
        write: true,
        signal: options?.signal,
      });
      return { providerRef: providerId };
    },
    async sendMessage(account, target, text, options) {
      if (options?.chatId) {
        const body = await client.request(
          "POST",
          `/chats/${encodeURIComponent(options.chatId)}/messages`,
          { form: { account_id: account, text }, write: true, signal: options.signal },
        );
        // A 2xx answer means the message went out, even when it carries no id.
        const messageId = str(asRecord(body).message_id);
        return { ...(messageId ? { messageId } : {}), chatId: options.chatId };
      }
      const providerId = await providerIdOf(account, target, options?.signal);
      const body = await client.request("POST", "/chats", {
        form: { account_id: account, attendees_ids: [providerId], text },
        write: true,
        signal: options?.signal,
      });
      const record = asRecord(body);
      const messageId = str(record.message_id);
      return { ...(messageId ? { messageId } : {}), chatId: str(record.chat_id) ?? undefined };
    },
    async listRecentPosts(account, target, options) {
      const body = await client.request(
        "GET",
        `/users/${encodeURIComponent(identifierFor(target))}/posts`,
        {
          query: { account_id: account, limit: Math.min(100, Math.max(1, options?.limit ?? 10)) },
          signal: options?.signal,
        },
      );
      const now = clock.now();
      return items(body)
        .map((item) => mapPost(item, now))
        .filter((post) => post !== null);
    },
    async reactToPost(account, postId, reaction = "like", options) {
      // One reaction per member and post: sending it again changes nothing.
      await client.request("POST", "/posts/reaction", {
        json: { account_id: account, post_id: postId, reaction_type: reaction },
        write: true,
        idempotent: true,
        signal: options?.signal,
      });
    },
    async commentOnPost(account, postId, text, options) {
      const body = await client.request("POST", `/posts/${encodeURIComponent(postId)}/comments`, {
        json: { account_id: account, text },
        write: true,
        signal: options?.signal,
      });
      const record = asRecord(body);
      const commentId = str(record.comment_id) ?? str(record.id);
      return commentId ? { commentId } : {};
    },
    async listPendingInvites(account, options) {
      const now = clock.now();
      const first = typeof options?.resume === "string" ? options.resume : null;
      const listed = await pages("/users/invite/sent", { account_id: account }, first, (body) => ({
        items: items(body)
          .map((item) => mapPendingInvite(item, now))
          .filter((invite) => invite !== null),
        stop: false,
      }));
      return listed.items;
    },
    async withdrawInvite(account, invitationId, options) {
      // Withdrawing twice leaves it withdrawn.
      await client.request("DELETE", `/users/invite/sent/${encodeURIComponent(invitationId)}`, {
        query: { account_id: account },
        write: true,
        idempotent: true,
        signal: options?.signal,
      });
    },
    async syncMessages(account, options) {
      const now = clock.now();
      const cursor = options.cursor ?? null;
      const listed = await pages(
        "/messages",
        {
          account_id: account,
          ...(options.since && !cursor ? { after: options.since.toISOString() } : {}),
        },
        cursor,
        (body) => ({
          items: items(body)
            .map((item) => mapMessage(item, now))
            .filter((message) => message !== null),
          stop: false,
        }),
      );
      // A listing that goes on past MAX_SYNC_PAGES says where to continue.
      return { messages: listed.items, cursor: listed.next };
    },
    async syncRelations(account, options) {
      const now = clock.now();
      const since = options.since?.getTime() ?? 0;
      const listed = await pages(
        "/users/relations",
        { account_id: account },
        options.cursor ?? null,
        (body) => {
          let reachedOld = false;
          const found = [];
          for (const item of items(body)) {
            const relation = mapRelation(item, now);
            if (!relation) continue;
            const at = relation.connected_at ? Date.parse(relation.connected_at) : Number.NaN;
            if (!Number.isNaN(at) && at < since) {
              reachedOld = true;
              continue;
            }
            found.push(relation);
          }
          return { items: found, stop: reachedOld };
        },
      );
      return { connections: listed.items, cursor: listed.next };
    },
    async parseWebhook(body) {
      return parseUnipileWebhook(body, clock.now());
    },
  };
}

/** A 2xx response without the field we need (retrying will not help). */
function malformed(field: string): OpenOutboundError {
  return malformedFailure(UNIPILE, `missing ${field}`);
}

export const unipileLinkedInProvider = defineProvider({
  slot: "linkedin",
  id: "unipile",
  name: "Unipile (LinkedIn)",
  description:
    "Runs LinkedIn visits, invitations, messages, likes and comments inside the user's own account through Unipile, with hosted login and webhooks.",
  docsUrl: "https://developer.unipile.com/docs/linkedin",
  configSchema: unipileConfigSchema,
  secrets: unipileSecrets,
  create: ({ config, secrets, ctx }) =>
    createUnipileLinkedIn(
      createUnipileClient({
        dsn: secrets.dsn ?? "",
        apiKey: secrets.api_key ?? "",
        fetch: ctx.fetch,
        timeoutMs: config.timeout_ms,
      }),
      ctx.clock,
    ),
  test: async (instance) => {
    const accounts = (await instance.listAccounts?.()) ?? [];
    return {
      ok: true,
      message: `Connected to Unipile: ${accounts.length} LinkedIn account(s) visible.`,
      details: { accounts: accounts.length },
    };
  },
});
