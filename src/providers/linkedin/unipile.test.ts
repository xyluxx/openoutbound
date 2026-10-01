import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fixedClock } from "../../core/clock.js";
import { OpenOutboundError } from "../../core/errors.js";
import { failureOf, partialOf } from "../../core/failures.js";
import { silentLogger } from "../../core/logger.js";
import { createFakeFetch, type FakeSafeFetch } from "../../testing/fake-fetch.js";
import type { ProviderRuntime } from "../types.js";
import { createUnipileLinkedIn, unipileConfigSchema, unipileLinkedInProvider } from "./unipile.js";
import { createUnipileClient, unipileBaseUrl } from "./unipile-client.js";
import { parseDate, publicIdentifier } from "./unipile-mapping.js";

const NOW = "2026-09-22T15:00:00.000Z";
const DSN = "api9.unipile.example.com:13111";
const API = "https://api9.unipile.example.com:13111/api/v1";
/** Invented placeholder, never a real key. */
const API_KEY = "unipile-test-key-placeholder";
const ACCOUNT = "uni_acc_Sam01Example";
const ROWAN_URL = "https://www.linkedin.com/in/rowan-vale-example";
const ROWAN_ID = "ACoAAExampleRowanVale0001";
const SAM_ID = "ACoAAExampleSamSender0001";
const POST_URN = "urn:li:activity:7370000000000000001";

type Json = Record<string, unknown>;

/** Recorded Unipile responses (invented people, example domains). */
function fixture(name: string): Json {
  const file = new URL(`./fixtures/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(file, "utf8")) as Json;
}

const escapeRe = (value: string) => value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
/** Matches `${API}${path}` with or without a query string. */
const at = (path: string) => new RegExp(`^${escapeRe(`${API}${path}`)}(?:\\?|$)`);

function setup() {
  const fetch = createFakeFetch();
  const clock = fixedClock(NOW);
  const client = createUnipileClient({
    dsn: DSN,
    apiKey: API_KEY,
    fetch: fetch as unknown as typeof globalThis.fetch,
  });
  return { fetch, clock, provider: createUnipileLinkedIn(client, clock) };
}

function request(fetch: FakeSafeFetch, index = -1) {
  const call = fetch.calls.at(index);
  if (!call) throw new Error("no request recorded");
  return {
    url: new URL(call.url),
    method: call.method,
    headers: new Headers(call.init?.headers),
    body: call.init?.body,
  };
}

const jsonBody = (body: unknown) => JSON.parse(String(body)) as Json;

function formBody(body: unknown): FormData {
  if (!(body instanceof FormData)) throw new Error("expected a multipart form body");
  return body;
}

async function failure(promise: Promise<unknown> | undefined): Promise<OpenOutboundError> {
  const error = await Promise.resolve(promise).then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!(error instanceof OpenOutboundError)) {
    throw new Error(`expected an OpenOutboundError, got ${String(error)}`);
  }
  return error;
}

describe("unipile client", () => {
  it("builds the REST root from the tenant DSN", () => {
    expect(unipileBaseUrl(DSN)).toBe(API);
    expect(unipileBaseUrl(`https://${DSN}/`)).toBe(API);
    expect(unipileBaseUrl(`https://${DSN}/api/v1`)).toBe(API);
  });

  it("sends the API key header and keeps it and member ids out of errors", async () => {
    const { fetch, provider } = setup();
    fetch.route(at("/users/rowan-vale-example"), { status: 500, json: fixture("error-server") });
    const error = await failure(provider.getProfile(ACCOUNT, { profile_url: ROWAN_URL }));
    expect(error).toMatchObject({
      code: "provider_error",
      details: { provider: "unipile", status: 500, type: "unexpected_error", retryable: true },
    });
    expect(error.message).toContain("GET /users/:id");
    const text = `${error.message} ${JSON.stringify(error.details)} ${error.hint ?? ""}`;
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain("rowan-vale-example");
    const sent = request(fetch);
    expect(sent.headers.get("x-api-key")).toBe(API_KEY);
    expect(sent.url.searchParams.get("account_id")).toBe(ACCOUNT);
  });

  it("maps recorded provider errors to the LinkedIn slot flags", async () => {
    const cases: Array<{
      fixture: string;
      status: number;
      headers?: Record<string, string>;
      expected: Json;
    }> = [
      {
        fixture: "error-rate-limit",
        status: 429,
        headers: { "retry-after": "120" },
        expected: { details: { rateLimited: true }, retryAfterSeconds: 120 },
      },
      {
        fixture: "error-rate-limit",
        status: 429,
        expected: { details: { rateLimited: true }, retryAfterSeconds: 3600 },
      },
      {
        fixture: "error-cannot-resend-yet",
        status: 422,
        expected: {
          details: { rateLimited: true, type: "cannot_resend_yet" },
          retryAfterSeconds: 86_400,
        },
      },
      {
        fixture: "error-disconnected",
        status: 401,
        expected: { details: { disconnected: true, retryable: false } },
      },
      {
        fixture: "error-checkpoint",
        status: 400,
        expected: { details: { restricted: true, retryable: false } },
      },
      {
        fixture: "error-restricted-text",
        status: 403,
        expected: { details: { restricted: true, retryable: false } },
      },
      { fixture: "error-not-found", status: 404, expected: { details: { retryable: false } } },
      // A server error after an invitation was sent: it may have gone out, so never repeated.
      {
        fixture: "error-server",
        status: 500,
        expected: { details: { retryable: false, failure: { class: "outcome_unknown" } } },
      },
    ];
    for (const item of cases) {
      const { fetch, provider } = setup();
      fetch.route(
        at("/users/invite"),
        {
          status: item.status,
          json: fixture(item.fixture),
          ...(item.headers ? { headers: item.headers } : {}),
        },
        "POST",
      );
      const error = await failure(provider.sendInvite(ACCOUNT, { provider_id: ROWAN_ID }));
      expect(error.code, item.fixture).toBe("provider_error");
      expect(error, item.fixture).toMatchObject(item.expected);
    }
  });

  it("marks a write whose answer was lost outcome_unknown, unless it never connected", async () => {
    const { fetch, provider } = setup();
    const target = { provider_id: ROWAN_ID };
    fetch.route(at("/users/invite"), () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const lost = await failure(provider.sendInvite(ACCOUNT, target, "Hello"));
    expect(failureOf(lost)).toMatchObject({ class: "outcome_unknown", retryable: false });
    const refusedCause = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
      syscall: "connect",
    });
    fetch.route(at("/users/invite"), () => {
      throw new TypeError("fetch failed", { cause: refusedCause });
    });
    const neverSent = await failure(provider.sendInvite(ACCOUNT, target, "Hello"));
    expect(failureOf(neverSent)).toMatchObject({ class: "network", retryable: true });
    // A like changes nothing when repeated: a server error stays retryable.
    fetch.route(at("/posts/reaction"), { status: 503, json: fixture("error-server") }, "POST");
    const like = await failure(provider.reactToPost(ACCOUNT, POST_URN));
    expect(failureOf(like)).toMatchObject({ class: "unavailable", retryable: true });
  });

  it("reads a server error by its status, whatever its text or type says", async () => {
    const { fetch, provider } = setup();
    const target = { provider_id: ROWAN_ID };
    fetch.route(
      at("/chats"),
      {
        status: 500,
        json: {
          status: 500,
          type: "errors/unexpected_error",
          title: "Internal error",
          detail: "Upstream verification step timed out",
        },
      },
      "POST",
    );
    const verification = await failure(provider.sendMessage(ACCOUNT, target, "Hi Rowan"));
    expect(failureOf(verification)).toMatchObject({ class: "outcome_unknown", retryable: false });
    expect(verification.details?.restricted).toBeUndefined();
    fetch.route(
      at("/chats"),
      { status: 503, json: { status: 503, type: "errors/too_many_requests" } },
      "POST",
    );
    const busy = await failure(provider.sendMessage(ACCOUNT, target, "Hi Rowan"));
    expect(failureOf(busy)).toMatchObject({ class: "outcome_unknown", retryable: false });
    expect(busy.details?.rateLimited).toBeUndefined();
  });

  it("tells a rejected API key from a disconnected LinkedIn account", async () => {
    const { fetch, provider } = setup();
    fetch.route(
      at("/users/invite"),
      { status: 401, json: { status: 401, type: "errors/missing_credentials" } },
      "POST",
    );
    const key = await failure(provider.sendInvite(ACCOUNT, { provider_id: ROWAN_ID }));
    expect(failureOf(key)).toMatchObject({ class: "auth_invalid", scope: "account" });
    expect(key.details?.disconnected).toBeUndefined();
    fetch.route(at("/users/invite"), { status: 401, json: fixture("error-disconnected") }, "POST");
    const account = await failure(provider.sendInvite(ACCOUNT, { provider_id: ROWAN_ID }));
    expect(failureOf(account)).toMatchObject({ class: "auth_invalid", scope: "call" });
    expect(account.details).toMatchObject({ disconnected: true });
  });

  it("passes the caller's signal on, and a visit never fails on an odd answer", async () => {
    const { fetch, provider } = setup();
    fetch.route(at("/users/rowan-vale-example"), { status: 200, body: "{not json" });
    const controller = new AbortController();
    await provider.visitProfile(ACCOUNT, { profile_url: ROWAN_URL }, { signal: controller.signal });
    const signal = fetch.calls.at(-1)?.init?.signal as AbortSignal | undefined;
    expect(signal).toBeInstanceOf(AbortSignal);
    controller.abort();
    expect(signal?.aborted).toBe(true);
  });

  it("returns the pages already read when a later page fails, with the cursor to go on", async () => {
    const { fetch, provider } = setup();
    let page = 0;
    fetch.route(at("/users/invite/sent"), () => {
      page += 1;
      return page === 1
        ? { json: fixture("sent-invitations-page1") }
        : { status: 503, json: fixture("error-server") };
    });
    const error = await failure(provider.listPendingInvites?.(ACCOUNT));
    const partial = partialOf(error);
    expect(partial?.items.length).toBeGreaterThan(0);
    expect(typeof partial?.resume).toBe("string");
    fetch.route(at("/users/invite/sent"), { json: fixture("sent-invitations-page2") });
    await provider.listPendingInvites?.(ACCOUNT, { resume: partial?.resume });
    expect(request(fetch).url.searchParams.get("cursor")).toBe(partial?.resume);
  });

  it("retries network failures and malformed responses", async () => {
    const { fetch, provider } = setup();
    const target = { profile_url: ROWAN_URL };
    fetch.route(at("/users/rowan-vale-example"), () => {
      throw new TypeError("fetch failed");
    });
    const network = await failure(provider.getProfile(ACCOUNT, target));
    expect(network.details).toMatchObject({ reason: "network", retryable: true });

    fetch.route(at("/users/rowan-vale-example"), () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const timeout = await failure(provider.getProfile(ACCOUNT, target));
    expect(timeout.details).toMatchObject({ reason: "timeout", retryable: true });

    fetch.route(at("/users/rowan-vale-example"), { status: 200, body: "{not json" });
    const malformed = await failure(provider.getProfile(ACCOUNT, target));
    expect(malformed.details).toMatchObject({ failure: { class: "malformed" } });

    fetch.route(at("/users/rowan-vale-example"), { json: { object: "UserProfile" } });
    const missingId = await failure(provider.getProfile(ACCOUNT, target));
    expect(missingId.details).toMatchObject({ failure: { class: "malformed" } });

    fetch.route(at("/users/rowan-vale-example"), { status: 503, body: "" });
    const empty = await failure(provider.getProfile(ACCOUNT, target));
    expect(empty.details).toMatchObject({ status: 503, retryable: true });
  });
});

describe("unipile linkedin provider", () => {
  it("creates a hosted auth link that expires in 24 hours", async () => {
    const { fetch, provider } = setup();
    fetch.route(at("/hosted/accounts/link"), { json: fixture("hosted-link") }, "POST");
    const link = await provider.createAuthLink?.({
      workspaceId: "wsp_example",
      state: "state-token",
      notifyUrl: "https://oo.example.com/hooks/unipile/auth?state=state-token",
      successUrl: "https://oo.example.com/connected",
    });
    expect(link).toEqual({
      url: "https://account.unipile.example.com/hosted/link-example-001",
      expiresAt: "2026-09-23T15:00:00.000Z",
    });
    const sent = request(fetch);
    expect(sent.headers.get("content-type")).toBe("application/json");
    expect(jsonBody(sent.body)).toEqual({
      type: "create",
      providers: ["LINKEDIN"],
      api_url: "https://api9.unipile.example.com:13111",
      expiresOn: "2026-09-23T15:00:00.000Z",
      name: "state-token",
      notify_url: "https://oo.example.com/hooks/unipile/auth?state=state-token",
      success_redirect_url: "https://oo.example.com/connected",
    });

    fetch.route(at("/hosted/accounts/link"), { json: { object: "HostedAuthUrl" } }, "POST");
    const missing = await failure(
      provider.createAuthLink?.({ workspaceId: "wsp_example", state: "state-token" }),
    );
    expect(missing.details).toMatchObject({ failure: { class: "malformed" }, retryable: false });
  });

  it("lists LinkedIn accounts with their status and premium flag", async () => {
    const { fetch, provider } = setup();
    fetch.route(at("/accounts"), { json: fixture("accounts") }, "GET");
    expect(await provider.listAccounts?.()).toEqual([
      {
        external_account_id: "uni_acc_Sam01Example",
        name: "Sam Sender",
        profile_url: "https://www.linkedin.com/in/sam-sender-example",
        status: "active",
        premium: false,
      },
      {
        external_account_id: "uni_acc_Pat02Example",
        name: "Pat Premium",
        profile_url: "https://www.linkedin.com/in/pat-premium-example",
        status: "credentials_needed",
        premium: true,
      },
    ]);
    expect(request(fetch).url.searchParams.get("limit")).toBe("100");
  });

  it("reads profiles by vanity URL or member id", async () => {
    const { fetch, provider } = setup();
    fetch.route(at("/users/rowan-vale-example"), { json: fixture("profile") }, "GET");
    const profile = await provider.getProfile(ACCOUNT, { profile_url: `${ROWAN_URL}/?trk=x` });
    expect(profile).toEqual({
      provider_id: ROWAN_ID,
      profile_url: ROWAN_URL,
      public_identifier: "rowan-vale-example",
      first_name: "Rowan",
      last_name: "Vale",
      full_name: "Rowan Vale",
      headline: "Head of Operations at Brightpath Example Co",
      location: "Austin, Texas, United States",
      connection_degree: 2,
      invitation_pending: false,
      premium: false,
    });
    expect(request(fetch).url.searchParams.has("notify")).toBe(false);

    fetch.route(
      at(`/users/${ROWAN_ID}`),
      { json: { ...fixture("profile"), network_distance: "FIRST_DEGREE" } },
      "GET",
    );
    const connected = await provider.getProfile(ACCOUNT, {
      provider_id: ROWAN_ID,
      profile_url: ROWAN_URL,
    });
    expect(connected.connection_degree).toBe(1);

    fetch.route(
      at(`/users/${ROWAN_ID}`),
      { json: { ...fixture("profile"), invitation: { type: "SENT", status: "PENDING" } } },
      "GET",
    );
    const pending = await provider.getProfile(ACCOUNT, { provider_id: ROWAN_ID });
    expect(pending.invitation_pending).toBe(true);
  });

  it("rejects targets without a usable LinkedIn profile before calling out", async () => {
    const { fetch, provider } = setup();
    const error = await failure(
      provider.getProfile(ACCOUNT, { profile_url: "https://www.example.com/rowan" }),
    );
    expect(error.code).toBe("validation_failed");
    expect(fetch.calls).toHaveLength(0);
  });

  it("visits a profile with notify so it counts as a view", async () => {
    const { fetch, provider } = setup();
    fetch.route(at("/users/rowan-vale-example"), { json: fixture("profile") }, "GET");
    await provider.visitProfile(ACCOUNT, { profile_url: ROWAN_URL });
    expect(request(fetch).url.searchParams.get("notify")).toBe("true");
  });

  it("sends invitations with a note, or looks up the member id first", async () => {
    const { fetch, provider } = setup();
    fetch.route(at("/users/invite"), { status: 201, json: fixture("invite-sent") }, "POST");
    const note = "Hi Rowan, enjoyed your post on onboarding.";
    expect(await provider.sendInvite(ACCOUNT, { provider_id: ROWAN_ID }, note)).toEqual({
      providerRef: ROWAN_ID,
    });
    expect(fetch.calls).toHaveLength(1);
    expect(jsonBody(request(fetch).body)).toEqual({
      account_id: ACCOUNT,
      provider_id: ROWAN_ID,
      message: note,
    });

    fetch.route(at("/users/rowan-vale-example"), { json: fixture("profile") }, "GET");
    await provider.sendInvite(ACCOUNT, { profile_url: ROWAN_URL });
    expect(fetch.calls.map((call) => call.method)).toEqual(["POST", "GET", "POST"]);
    expect(jsonBody(request(fetch).body)).toEqual({ account_id: ACCOUNT, provider_id: ROWAN_ID });
  });

  it("starts a chat or replies in an existing one", async () => {
    const { fetch, provider } = setup();
    fetch.route(at("/chats"), { status: 201, json: fixture("chat-started") }, "POST");
    const started = await provider.sendMessage(
      ACCOUNT,
      { provider_id: ROWAN_ID },
      "Thanks for connecting, Rowan.",
    );
    expect(started).toEqual({ messageId: "msgExampleRowan0001", chatId: "chatExampleRowan0001" });
    const first = request(fetch);
    // Multipart: fetch sets the boundary, so the client must not set content-type itself.
    expect(first.headers.get("content-type")).toBeNull();
    const form = formBody(first.body);
    expect(form.get("account_id")).toBe(ACCOUNT);
    expect(form.getAll("attendees_ids")).toEqual([ROWAN_ID]);
    expect(form.get("text")).toBe("Thanks for connecting, Rowan.");

    fetch.route(
      at("/chats/chatExampleRowan0001/messages"),
      { status: 201, json: fixture("message-sent") },
      "POST",
    );
    const reply = await provider.sendMessage(ACCOUNT, { provider_id: ROWAN_ID }, "Following up.", {
      chatId: "chatExampleRowan0001",
    });
    expect(reply).toEqual({ messageId: "msgExampleRowan0002", chatId: "chatExampleRowan0001" });
    expect(formBody(request(fetch).body).get("text")).toBe("Following up.");

    // LinkedIn took the message: an answer without ids still counts as sent, never as a failure.
    fetch.route(at("/chats"), { status: 201, json: { object: "ChatStarted" } }, "POST");
    expect(await provider.sendMessage(ACCOUNT, { provider_id: ROWAN_ID }, "Hi")).toEqual({
      chatId: undefined,
    });
    fetch.route(
      at("/chats/chatExampleRowan0001/messages"),
      { status: 201, json: { object: "MessageSent" } },
      "POST",
    );
    expect(
      await provider.sendMessage(ACCOUNT, { provider_id: ROWAN_ID }, "Hi", {
        chatId: "chatExampleRowan0001",
      }),
    ).toEqual({ chatId: "chatExampleRowan0001" });
  });

  it("lists recent posts, skipping reposts and reading relative dates", async () => {
    const { fetch, provider } = setup();
    fetch.route(at("/users/rowan-vale-example/posts"), { json: fixture("posts") }, "GET");
    const posts = await provider.listRecentPosts(
      ACCOUNT,
      { profile_url: ROWAN_URL },
      { limit: 500 },
    );
    expect(posts).toEqual([
      {
        id: POST_URN,
        url: "https://www.linkedin.com/posts/rowan-vale-example_activity-7370000000000000001",
        text: "We cut onboarding time in half this quarter. Here is what changed.",
        published_at: "2026-09-20T08:00:00.000Z",
        author_provider_id: ROWAN_ID,
        reactions_count: 42,
        comments_count: 7,
      },
      {
        id: "7370000000000000003",
        url: null,
        text: "We are hiring two operations analysts in Austin.",
        published_at: "2026-09-19T15:00:00.000Z",
        author_provider_id: null,
        reactions_count: 11,
        comments_count: 1,
      },
    ]);
    expect(request(fetch).url.searchParams.get("limit")).toBe("100");
  });

  it("reacts to and comments on posts", async () => {
    const { fetch, provider } = setup();
    fetch.route(at("/posts/reaction"), { json: { object: "ReactionAdded" } }, "POST");
    await provider.reactToPost(ACCOUNT, POST_URN);
    expect(jsonBody(request(fetch).body)).toEqual({
      account_id: ACCOUNT,
      post_id: POST_URN,
      reaction_type: "like",
    });
    await provider.reactToPost(ACCOUNT, POST_URN, "insightful");
    expect(jsonBody(request(fetch).body)).toMatchObject({ reaction_type: "insightful" });

    fetch.route(/\/posts\/[^/]+\/comments(?:\?|$)/, { json: fixture("comment-sent") }, "POST");
    const comment = await provider.commentOnPost(ACCOUNT, POST_URN, "Great result, congrats.");
    expect(comment).toEqual({ commentId: "7372000000000000001" });
    const sent = request(fetch);
    expect(sent.url.pathname).toBe(
      "/api/v1/posts/urn%3Ali%3Aactivity%3A7370000000000000001/comments",
    );
    expect(jsonBody(sent.body)).toEqual({ account_id: ACCOUNT, text: "Great result, congrats." });

    fetch.route(/\/posts\/[^/]+\/comments(?:\?|$)/, { json: { object: "CommentSent" } }, "POST");
    expect(await provider.commentOnPost(ACCOUNT, POST_URN, "Nice.")).toEqual({});
  });

  it("pages through sent invitations and withdraws one", async () => {
    const { fetch, provider } = setup();
    fetch.route(
      at("/users/invite/sent"),
      (sent) => ({
        json:
          new URL(sent.url).searchParams.get("cursor") === "cursor-invitations-2"
            ? fixture("sent-invitations-page2")
            : fixture("sent-invitations-page1"),
      }),
      "GET",
    );
    expect(await provider.listPendingInvites?.(ACCOUNT)).toEqual([
      {
        invitation_id: "7371000000000000011",
        provider_id: ROWAN_ID,
        profile_url: ROWAN_URL,
        sent_at: "2026-08-25T09:00:00.000Z",
      },
      {
        invitation_id: "7371000000000000012",
        provider_id: "ACoAAExampleJuneOkafor002",
        profile_url: "https://www.linkedin.com/in/june-okafor-example",
        sent_at: "2026-09-01T15:00:00.000Z",
      },
      {
        invitation_id: "7371000000000000013",
        provider_id: "ACoAAExampleLeeMarsh00003",
        profile_url: "https://www.linkedin.com/in/lee-marsh-example",
        sent_at: "2026-09-10T09:00:00.000Z",
      },
    ]);
    expect(fetch.calls).toHaveLength(2);

    fetch.route(at("/users/invite/sent/7371000000000000011"), { json: {} }, "DELETE");
    await provider.withdrawInvite?.(ACCOUNT, "7371000000000000011");
    const withdrawn = request(fetch);
    expect(withdrawn.method).toBe("DELETE");
    expect(withdrawn.url.searchParams.get("account_id")).toBe(ACCOUNT);
  });

  it("syncs messages since a date and flags the account's own messages", async () => {
    const { fetch, provider } = setup();
    fetch.route(at("/messages"), { json: fixture("messages") }, "GET");
    const since = new Date("2026-09-21T00:00:00.000Z");
    const result = await provider.syncMessages?.(ACCOUNT, { since });
    expect(result?.messages).toEqual([
      {
        id: "msgInboundExample01",
        chat_id: "chatExampleRowan0001",
        sender_provider_id: ROWAN_ID,
        sender_profile_url: null,
        text: "Thanks for reaching out. Happy to talk next week.",
        sent_at: "2026-09-21T16:30:00.000Z",
        is_outbound: false,
      },
      {
        id: "msgOutboundExample02",
        chat_id: "chatExampleRowan0001",
        sender_provider_id: SAM_ID,
        sender_profile_url: null,
        text: "Great, does Tuesday work?",
        sent_at: "2026-09-21T17:00:00.000Z",
        is_outbound: true,
      },
    ]);
    expect(request(fetch).url.searchParams.get("after")).toBe("2026-09-21T00:00:00.000Z");
  });

  it("syncs new relations and stops paging once they are older than since", async () => {
    const { fetch, provider } = setup();
    fetch.route(at("/users/relations"), { json: fixture("relations") }, "GET");
    const result = await provider.syncRelations?.(ACCOUNT, {
      since: new Date("2026-09-01T00:00:00.000Z"),
    });
    expect(result?.connections).toEqual([
      { provider_id: ROWAN_ID, profile_url: ROWAN_URL, connected_at: "2026-09-21T15:00:00.000Z" },
    ]);
    // The fixture returns a next cursor, but the older relation ends the walk.
    expect(fetch.calls).toHaveLength(1);
  });

  it("says where to continue when a sync stops at the page limit, and continues from there", async () => {
    const { fetch, provider } = setup();
    let page = 0;
    fetch.route(
      at("/messages"),
      () => {
        page += 1;
        return {
          json: { object: "MessageList", items: [], cursor: `cursor-messages-${page + 1}` },
        };
      },
      "GET",
    );
    const messages = await provider.syncMessages?.(ACCOUNT, {});
    expect(fetch.calls).toHaveLength(5);
    expect(messages?.cursor).toBe("cursor-messages-6");

    fetch.route(
      at("/users/relations"),
      { json: { object: "UserRelationsList", items: [], cursor: null } },
      "GET",
    );
    const relations = await provider.syncRelations?.(ACCOUNT, { cursor: "cursor-relations-9" });
    expect(request(fetch).url.searchParams.get("cursor")).toBe("cursor-relations-9");
    // The listing is finished: nothing left to continue.
    expect(relations?.cursor).toBeNull();
  });

  it("fails a listing page without a list instead of reading it as nothing new", async () => {
    const { fetch, provider } = setup();
    // Read as an empty last page, the sync would move past messages it never saw.
    fetch.route(at("/messages"), { json: { object: "MessageList", cursor: null } }, "GET");
    const first = await failure(provider.syncMessages?.(ACCOUNT, {}));
    expect(first.details).toMatchObject({ failure: { class: "malformed", retryable: false } });

    let page = 0;
    fetch.route(at("/users/invite/sent"), () => {
      page += 1;
      return page === 1
        ? { json: fixture("sent-invitations-page1") }
        : { json: { object: "UserInvitationList", cursor: null } };
    });
    const later = await failure(provider.listPendingInvites?.(ACCOUNT));
    expect(later.details).toMatchObject({ failure: { class: "malformed" } });
    expect(partialOf(later)?.items.length).toBeGreaterThan(0);
  });

  it("parses the recorded webhook payloads", async () => {
    const { provider } = setup();
    expect(await provider.parseWebhook?.(fixture("webhook-new-relation"), {})).toEqual([
      {
        type: "invite_accepted",
        account_id: ACCOUNT,
        provider_id: ROWAN_ID,
        profile_url: ROWAN_URL,
        occurred_at: NOW,
      },
    ]);
    expect(await provider.parseWebhook?.(fixture("webhook-message-received"), {})).toEqual([
      {
        type: "message_received",
        account_id: ACCOUNT,
        message: {
          id: "msgInboundExample04",
          chat_id: "chatExampleRowan0001",
          sender_provider_id: ROWAN_ID,
          sender_profile_url: ROWAN_URL,
          text: "Sounds good, send me a calendar link.",
          sent_at: "2026-09-22T14:10:00.000Z",
          is_outbound: false,
        },
      },
    ]);
    const own = {
      ...fixture("webhook-message-received"),
      sender: { attendee_provider_id: SAM_ID },
    };
    const [outbound] = (await provider.parseWebhook?.(own, {})) ?? [];
    expect(outbound).toMatchObject({ message: { is_outbound: true } });

    expect(await provider.parseWebhook?.(fixture("webhook-account-status"), {})).toEqual([
      {
        type: "account_status",
        account_id: ACCOUNT,
        status: "credentials_needed",
        reason: "CREDENTIALS",
      },
    ]);
    const statuses: Record<string, string> = {
      OK: "active",
      RECONNECTED: "active",
      ERROR: "restricted",
      STOPPED: "restricted",
      DELETED: "disconnected",
    };
    for (const [message, status] of Object.entries(statuses)) {
      const body = { AccountStatus: { account_id: ACCOUNT, account_type: "LINKEDIN", message } };
      const [event] = (await provider.parseWebhook?.(body, {})) ?? [];
      expect(event, message).toMatchObject({ type: "account_status", status });
    }

    const whatsapp = { ...fixture("webhook-new-relation"), account_type: "WHATSAPP" };
    expect(await provider.parseWebhook?.(whatsapp, {})).toEqual([]);
    expect(
      await provider.parseWebhook?.({ event: "message_read", account_id: ACCOUNT }, {}),
    ).toEqual([]);
    expect(await provider.parseWebhook?.("not an object", {})).toEqual([]);
  });

  it("parses LinkedIn dates and vanity slugs", () => {
    const now = new Date(NOW);
    expect(parseDate("2026-09-20T08:00:00Z", now)).toBe("2026-09-20T08:00:00.000Z");
    expect(parseDate(1_790_002_800, now)).toBe("2026-09-21T15:00:00.000Z");
    expect(parseDate(1_790_002_800_000, now)).toBe("2026-09-21T15:00:00.000Z");
    expect(parseDate("2h", now)).toBe("2026-09-22T13:00:00.000Z");
    expect(parseDate("1mo", now)).toBe("2026-08-23T15:00:00.000Z");
    expect(parseDate("soon", now)).toBeNull();
    expect(publicIdentifier("https://www.linkedin.com/in/rowan%2Dvale/")).toBe("rowan-vale");
    expect(publicIdentifier("https://www.example.com/in/rowan")).toBeNull();
  });

  it("builds from secrets and reports the visible accounts in its live check", async () => {
    const fetch = createFakeFetch();
    fetch.route(at("/accounts"), { json: fixture("accounts") }, "GET");
    const runtime = {
      fetch: fetch as unknown as typeof globalThis.fetch,
      safeFetch: fetch,
      clock: fixedClock(NOW),
      log: silentLogger(),
      baseUrl: "https://oo.example.com",
      workspaceId: null,
    } as unknown as ProviderRuntime;
    const instance = await unipileLinkedInProvider.create({
      config: unipileConfigSchema.parse({}),
      secrets: { dsn: DSN, api_key: API_KEY },
      ctx: runtime,
    });
    expect(instance.id).toBe("unipile");
    expect(await unipileLinkedInProvider.test?.(instance)).toMatchObject({
      ok: true,
      details: { accounts: 2 },
    });
    expect(request(fetch).headers.get("x-api-key")).toBe(API_KEY);
  });
});
