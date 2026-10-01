import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fixedClock } from "../../core/clock.js";
import { OpenOutboundError } from "../../core/errors.js";
import { silentLogger } from "../../core/logger.js";
import { createFakeFetch } from "../../testing/fake-fetch.js";
import { createUnipileClient } from "../linkedin/unipile-client.js";
import type { ProviderRuntime } from "../types.js";
import {
  createLinkedInOfficial,
  LINKEDIN_POST_MAX,
  type LinkedInOfficialConfig,
  linkedinOfficialConfigSchema,
  linkedinOfficialProvider,
  type OAuthExchange,
  type OAuthStart,
} from "./linkedin-official.js";
import { createUnipileSocial, unipileSocialProvider } from "./unipile.js";

const NOW = "2026-09-22T15:00:00.000Z";
const CLIENT_ID = "example-client-id";
/** Invented placeholder, never a real secret. */
const CLIENT_SECRET = "example-client-secret-placeholder";
const REDIRECT = "https://oo.example.com/oauth/linkedin/callback";
const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const USERINFO_URL = "https://api.linkedin.com/v2/userinfo";
const POSTS_URL = "https://api.linkedin.com/rest/posts";
const ACCESS_TOKEN = "example-linkedin-access-token";
const MEMBER = "urn:li:person:exampleSub01";
const UNIPILE_API = "https://api9.unipile.example.com:13111/api/v1";

type Json = Record<string, unknown>;

function fixture(name: string): Json {
  const file = new URL(`./fixtures/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(file, "utf8")) as Json;
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

function runtime(fetch: ReturnType<typeof createFakeFetch>): ProviderRuntime {
  return {
    fetch: fetch as unknown as typeof globalThis.fetch,
    safeFetch: fetch,
    clock: fixedClock(NOW),
    log: silentLogger(),
    baseUrl: "https://oo.example.com",
    workspaceId: null,
  } as unknown as ProviderRuntime;
}

function official(config: Partial<LinkedInOfficialConfig> = {}) {
  const fetch = createFakeFetch();
  const publisher = createLinkedInOfficial({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    config: linkedinOfficialConfigSchema.parse(config),
    fetch: fetch as unknown as typeof globalThis.fetch,
    clock: fixedClock(NOW),
  });
  return { fetch, publisher };
}

const post = {
  accountRef: { provider: "linkedin_official", account_id: MEMBER, name: "Sam Sender" },
  text: "Three lessons from rebuilding our onboarding flow.",
  credentials: { access_token: ACCESS_TOKEN },
};

describe("linkedin_official social provider", () => {
  it("builds the authorization URL, with PKCE only when enabled", async () => {
    const { publisher } = official();
    const url = new URL(
      String(await publisher.authUrl?.({ state: "state-1", redirectUri: REDIRECT })),
    );
    expect(`${url.origin}${url.pathname}`).toBe("https://www.linkedin.com/oauth/v2/authorization");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      state: "state-1",
      scope: "openid profile w_member_social",
    });

    const start: OAuthStart = {
      state: "state-2",
      redirectUri: REDIRECT,
      codeChallenge: "challenge",
    };
    const plain = new URL(String(await publisher.authUrl?.(start)));
    expect(plain.searchParams.has("code_challenge")).toBe(false);

    const pkce = official({ pkce: true });
    const withPkce = new URL(String(await pkce.publisher.authUrl?.(start)));
    expect(withPkce.searchParams.get("code_challenge")).toBe("challenge");
    expect(withPkce.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("exchanges the code and derives the member URN from userinfo", async () => {
    const { fetch, publisher } = official();
    fetch.route(TOKEN_URL, { json: fixture("linkedin-token") }, "POST");
    fetch.route(USERINFO_URL, { json: fixture("linkedin-userinfo") }, "GET");
    const result = await publisher.exchangeCode?.({ code: "auth-code-1", redirectUri: REDIRECT });
    expect(result).toEqual({
      account: { provider: "linkedin_official", account_id: MEMBER, name: "Sam Sender" },
      credentials: { access_token: ACCESS_TOKEN },
      // expires_in 5184000 seconds = 60 days.
      expiresAt: "2026-11-21T15:00:00.000Z",
    });
    const [token, userinfo] = fetch.calls;
    expect(new Headers(token?.init?.headers).get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(Object.fromEntries(new URLSearchParams(String(token?.init?.body)))).toEqual({
      grant_type: "authorization_code",
      code: "auth-code-1",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT,
    });
    expect(new Headers(userinfo?.init?.headers).get("authorization")).toBe(
      `Bearer ${ACCESS_TOKEN}`,
    );
  });

  it("sends the PKCE verifier when enabled", async () => {
    const { fetch, publisher } = official({ pkce: true });
    fetch.route(TOKEN_URL, { json: fixture("linkedin-token") }, "POST");
    fetch.route(USERINFO_URL, { json: fixture("linkedin-userinfo") }, "GET");
    const exchange: OAuthExchange = { code: "c", redirectUri: REDIRECT, codeVerifier: "verifier" };
    await publisher.exchangeCode?.(exchange);
    const body = new URLSearchParams(String(fetch.calls[0]?.init?.body));
    expect(body.get("code_verifier")).toBe("verifier");
  });

  it("reports token and userinfo failures without leaking the client secret", async () => {
    const { fetch, publisher } = official();
    fetch.route(TOKEN_URL, { status: 400, json: fixture("linkedin-token-error") }, "POST");
    const rejected = await failure(
      publisher.exchangeCode?.({ code: "bad", redirectUri: REDIRECT }),
    );
    expect(rejected).toMatchObject({
      code: "provider_error",
      details: { provider: "linkedin_official", status: 400, retryable: false },
    });
    expect(rejected.message).toContain("authorization code not found");
    expect(`${rejected.message} ${JSON.stringify(rejected.details)}`).not.toContain(CLIENT_SECRET);

    fetch.route(TOKEN_URL, { json: { expires_in: 100 } }, "POST");
    const noToken = await failure(publisher.exchangeCode?.({ code: "c", redirectUri: REDIRECT }));
    expect(noToken.details).toMatchObject({ failure: { class: "malformed" }, retryable: false });

    fetch.route(TOKEN_URL, { json: fixture("linkedin-token") }, "POST");
    fetch.route(USERINFO_URL, { json: { name: "No Subject" } }, "GET");
    const noSub = await failure(publisher.exchangeCode?.({ code: "c", redirectUri: REDIRECT }));
    expect(noSub.hint).toContain("openid");

    fetch.route(USERINFO_URL, { status: 200, body: "<html>" }, "GET");
    const malformed = await failure(publisher.exchangeCode?.({ code: "c", redirectUri: REDIRECT }));
    expect(malformed.details).toMatchObject({ failure: { class: "malformed" } });

    // A revoked code is the member's problem; a wrong client secret is the app's.
    fetch.route(TOKEN_URL, { status: 400, json: { error: "invalid_grant" } }, "POST");
    const grant = await failure(publisher.exchangeCode?.({ code: "c", redirectUri: REDIRECT }));
    expect(grant.details).toMatchObject({ failure: { class: "auth_invalid", scope: "call" } });
    // There is no token yet: the hint is about the code, not an expired token.
    expect(grant.hint).toContain("sign-in code");
    expect(grant.details).not.toHaveProperty("expired");
    fetch.route(TOKEN_URL, { status: 401, json: { error: "invalid_client" } }, "POST");
    const client = await failure(publisher.exchangeCode?.({ code: "c", redirectUri: REDIRECT }));
    expect(client.details).toMatchObject({ failure: { class: "auth_invalid", scope: "account" } });
  });

  it("publishes a text post with the versioned Posts API headers", async () => {
    const { fetch, publisher } = official({ api_version: "202607" });
    fetch.route(
      POSTS_URL,
      { status: 201, headers: { "x-restli-id": "urn:li:share:7374000000000000001" } },
      "POST",
    );
    expect(await publisher.publish(post)).toEqual({
      externalId: "urn:li:share:7374000000000000001",
      url: "https://www.linkedin.com/feed/update/urn:li:share:7374000000000000001/",
    });
    const sent = fetch.calls[0];
    const headers = new Headers(sent?.init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(headers.get("x-restli-protocol-version")).toBe("2.0.0");
    expect(headers.get("linkedin-version")).toBe("202607");
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(sent?.init?.body))).toEqual({
      author: MEMBER,
      commentary: post.text,
      visibility: "PUBLIC",
      distribution: {
        feedDistribution: "MAIN_FEED",
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    });
  });

  it("flags expired tokens and rate limits, and refuses a post without an id", async () => {
    const { fetch, publisher } = official();
    fetch.route(POSTS_URL, { status: 401, json: fixture("linkedin-error-401") }, "POST");
    const expired = await failure(publisher.publish(post));
    expect(expired).toMatchObject({
      code: "provider_error",
      details: { expired: true, retryable: false, status: 401 },
    });
    expect(expired.hint).toContain("connect_account");
    expect(`${expired.message} ${JSON.stringify(expired.details)}`).not.toContain(ACCESS_TOKEN);

    fetch.route(POSTS_URL, { status: 429, json: fixture("linkedin-error-429") }, "POST");
    const limited = await failure(publisher.publish(post));
    expect(limited).toMatchObject({
      retryAfterSeconds: 3600,
      details: { rateLimited: true, retryable: true },
    });

    fetch.route(POSTS_URL, { status: 201 }, "POST");
    const noId = await failure(publisher.publish(post));
    expect(noId.details).toMatchObject({
      accepted: true,
      retryable: false,
      failure: { class: "malformed" },
    });
    expect(noId.hint).toContain("duplicate");

    // A server error after the post was sent: it may be live, so it is never sent again.
    fetch.route(POSTS_URL, { status: 502, body: "" }, "POST");
    const unknown = await failure(publisher.publish(post));
    expect(unknown.details).toMatchObject({ failure: { class: "outcome_unknown" } });
  });

  it("checks the token and length before calling LinkedIn", async () => {
    const { fetch, publisher } = official();
    const noToken = await failure(publisher.publish({ ...post, credentials: {} }));
    expect(noToken).toMatchObject({ code: "provider_not_configured", details: { expired: true } });
    const tooLong = await failure(
      publisher.publish({ ...post, text: "x".repeat(LINKEDIN_POST_MAX + 1) }),
    );
    expect(tooLong.code).toBe("validation_failed");
    expect(fetch.calls).toHaveLength(0);
  });

  it("is created from its secrets", async () => {
    const fetch = createFakeFetch();
    const instance = await linkedinOfficialProvider.create({
      config: linkedinOfficialConfigSchema.parse({}),
      secrets: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET },
      ctx: runtime(fetch),
    });
    expect(instance.id).toBe("linkedin_official");
    const url = String(await instance.authUrl?.({ state: "s", redirectUri: REDIRECT }));
    expect(new URL(url).searchParams.get("client_id")).toBe(CLIENT_ID);
  });
});

describe("unipile social provider", () => {
  function unipile() {
    const fetch = createFakeFetch();
    const client = createUnipileClient({
      dsn: "api9.unipile.example.com:13111",
      apiKey: "unipile-test-key-placeholder",
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    return { fetch, publisher: createUnipileSocial(client) };
  }
  const unipilePost = {
    accountRef: { provider: "unipile", account_id: "uni_acc_Sam01Example" },
    text: "Three lessons from rebuilding our onboarding flow.",
  };

  it("publishes through the connected account", async () => {
    const { fetch, publisher } = unipile();
    fetch.route(
      `${UNIPILE_API}/posts`,
      { status: 201, json: fixture("unipile-post-created") },
      "POST",
    );
    expect(await publisher.publish(unipilePost)).toEqual({
      externalId: "urn:li:activity:7373000000000000001",
      url: "https://www.linkedin.com/feed/update/urn:li:activity:7373000000000000001/",
    });
    const body = fetch.calls[0]?.init?.body;
    if (!(body instanceof FormData)) throw new Error("expected a multipart form body");
    expect(body.get("account_id")).toBe("uni_acc_Sam01Example");
    expect(body.get("text")).toBe(unipilePost.text);

    fetch.route(`${UNIPILE_API}/posts`, { json: { object: "PostCreated", id: "7373" } }, "POST");
    expect(await publisher.publish(unipilePost)).toEqual({ externalId: "7373" });
  });

  it("fails clearly on a missing id or a restricted account", async () => {
    const { fetch, publisher } = unipile();
    fetch.route(`${UNIPILE_API}/posts`, { json: { object: "PostCreated" } }, "POST");
    const missing = await failure(publisher.publish(unipilePost));
    // Accepted without an id: it was published, so it is never sent again.
    expect(missing.details).toMatchObject({
      accepted: true,
      retryable: false,
      failure: { class: "malformed" },
    });

    const checkpoint = JSON.parse(
      readFileSync(new URL("../linkedin/fixtures/error-checkpoint.json", import.meta.url), "utf8"),
    ) as Json;
    fetch.route(`${UNIPILE_API}/posts`, { status: 400, json: checkpoint }, "POST");
    const restricted = await failure(publisher.publish(unipilePost));
    expect(restricted.details).toMatchObject({ restricted: true, retryable: false });
  });

  it("is created from the shared Unipile secrets", async () => {
    const fetch = createFakeFetch();
    const instance = await unipileSocialProvider.create({
      config: { timeout_ms: 30_000 },
      secrets: { dsn: "api9.unipile.example.com:13111", api_key: "unipile-test-key-placeholder" },
      ctx: runtime(fetch),
    });
    expect(instance.id).toBe("unipile");
  });
});
