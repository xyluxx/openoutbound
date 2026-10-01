import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Engine } from "../../core/engine.js";
import { OpenOutboundError } from "../../core/errors.js";
import { failureOf } from "../../core/failures.js";
import { mailboxes } from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { seedMailbox } from "../../testing/factories.js";
import type { FetchRoute } from "../../testing/fake-fetch.js";
import { isAuthFailure, storePasswords } from "./credentials.js";
import {
  authorizeUrl,
  clearAccessTokenCache,
  createState,
  GOOGLE_TOKEN_URL,
  getAccessToken,
  isStateExpired,
  microsoftTokenUrl,
  pkceVerifier,
  refreshSecretName,
  signState,
  verifyState,
} from "./oauth.js";
import { registerOAuthRoutes } from "./oauth-routes.js";
import { sha256Base64Url } from "./signing.js";

vi.mock("../../runtime/notify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/notify.js")>()),
  notify: vi.fn(async () => {}),
}));

const ENV = {
  GOOGLE_OAUTH_CLIENT_ID: "client-123.apps.example.com",
  GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
  MICROSOFT_OAUTH_CLIENT_ID: "ms-client-456",
  MICROSOFT_OAUTH_CLIENT_SECRET: "ms-client-secret",
};

let ctx: TestContext;
afterEach(async () => {
  clearAccessTokenCache();
  await ctx?.close();
});

function idToken(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256" })}.${part(claims)}.signature`;
}

async function setup(fetchRoutes: FetchRoute[] = []) {
  ctx = await createTestContext({
    now: "2026-09-21T15:00:00.000Z",
    config: { env: ENV, baseUrl: "https://engine.example.com" },
    fetchRoutes,
  });
  return ctx;
}

function app(): Hono {
  const engine = {
    config: ctx.config,
    log: ctx.log,
    systemContext: async (workspaceId: string | null) => {
      if (workspaceId !== ctx.workspace.id) throw new OpenOutboundError("not_found", "gone");
      return ctx.jobContext();
    },
  } as unknown as Engine;
  const hono = new Hono();
  registerOAuthRoutes(hono, { engine });
  return hono;
}

function state(provider: "google" | "microsoft", draft = {}, tenant?: string) {
  return createState(ctx.config, {
    workspaceId: ctx.workspace.id,
    provider,
    draft,
    now: ctx.clock.now(),
    ...(tenant ? { tenant } : {}),
  });
}

const googleToken = (claims: Record<string, unknown>): FetchRoute => ({
  match: GOOGLE_TOKEN_URL,
  method: "POST",
  response: {
    json: {
      access_token: "ya29.access",
      refresh_token: "1//refresh-google",
      expires_in: 3599,
      id_token: idToken(claims),
      token_type: "Bearer",
    },
  },
});

describe("OAuth state and URLs", () => {
  it("signs state, rejects tampering and expires after 30 minutes", async () => {
    await setup();
    const { state: payload, token } = state("google", { email: "sam@brand.example.com" });
    expect(verifyState(ctx.config, token, ctx.clock.now())).toEqual(payload);
    const forged = signState({ ...ctx.config, secretKey: Buffer.alloc(32, 1) }, payload);
    expect(verifyState(ctx.config, forged, null)).toBeNull();
    expect(verifyState(ctx.config, `${token}x`, null)).toBeNull();
    expect(verifyState(ctx.config, "garbage", null)).toBeNull();
    expect(isStateExpired(payload, new Date("2026-09-21T15:29:00Z"))).toBe(false);
    expect(verifyState(ctx.config, token, new Date("2026-09-21T15:31:00Z"))).toBeNull();
  });

  it("builds Google and Microsoft consent URLs with PKCE", async () => {
    await setup();
    const google = state("google", { email: "sam@brand.example.com" });
    const url = new URL(authorizeUrl(ctx.config, google.state, google.token));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: ENV.GOOGLE_OAUTH_CLIENT_ID,
      redirect_uri: "https://engine.example.com/oauth/google/callback",
      response_type: "code",
      code_challenge_method: "S256",
      code_challenge: sha256Base64Url(pkceVerifier(ctx.config, google.state.n)),
      access_type: "offline",
      prompt: "consent",
      login_hint: "sam@brand.example.com",
      state: google.token,
    });
    expect(url.searchParams.get("scope")).toContain("https://mail.google.com/");

    const microsoft = state("microsoft", {}, "brand.example.com");
    const msUrl = new URL(authorizeUrl(ctx.config, microsoft.state, microsoft.token));
    expect(msUrl.pathname).toBe("/brand.example.com/oauth2/v2.0/authorize");
    expect(msUrl.searchParams.get("scope")).toContain("https://outlook.office.com/SMTP.Send");
    expect(msUrl.searchParams.get("scope")).toContain("offline_access");
  });
});

describe("OAuth routes", () => {
  it("redirects to the consent screen and rejects bad or expired links", async () => {
    await setup();
    const { token } = state("google");
    const start = await app().request(`/oauth/google/start?state=${encodeURIComponent(token)}`);
    expect(start.status).toBe(302);
    expect(start.headers.get("location")).toMatch(/^https:\/\/accounts\.google\.com\//);
    expect((await app().request("/oauth/google/start?state=nope")).status).toBe(400);
    // A Google state cannot be used on the Microsoft route.
    expect(
      (await app().request(`/oauth/microsoft/start?state=${encodeURIComponent(token)}`)).status,
    ).toBe(400);
    ctx.clock.advance(31 * 60_000);
    const expired = await app().request(`/oauth/google/start?state=${encodeURIComponent(token)}`);
    expect(expired.status).toBe(400);
    expect(await expired.text()).toContain("expired");
  });

  it("creates the mailbox from the callback and stores the refresh token in the vault", async () => {
    await setup([googleToken({ email: "Sam@Brand.example.com", name: "Sam Carter" })]);
    const { state: payload, token } = state("google", { daily_limit: 25 });
    const response = await app().request(
      `/oauth/google/callback?code=auth-code-1&state=${encodeURIComponent(token)}`,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("sam@brand.example.com is connected");
    const [row] = await ctx.db.select().from(mailboxes);
    expect(row).toMatchObject({
      email: "sam@brand.example.com",
      from_name: "Sam Carter",
      provider_label: "google",
      auth_type: "oauth_google",
      daily_limit: 25,
      secret_id: null,
      smtp: { host: "smtp.gmail.com", port: 465, secure: true, user: "sam@brand.example.com" },
      oauth: { provider: "google", access_token_expires_at: "2026-09-21T15:59:59.000Z" },
    });
    expect(
      await ctx.vault.getSecret(row?.oauth?.refresh_token_secret_id ?? "", ctx.workspace.id),
    ).toBe("1//refresh-google");
    const body = new URLSearchParams(String(ctx.fetch.calls[0]?.init?.body));
    expect(Object.fromEntries(body)).toMatchObject({
      grant_type: "authorization_code",
      code: "auth-code-1",
      code_verifier: pkceVerifier(ctx.config, payload.n),
      client_secret: ENV.GOOGLE_OAUTH_CLIENT_SECRET,
      redirect_uri: "https://engine.example.com/oauth/google/callback",
    });
    expect(JSON.stringify(row)).not.toContain("refresh-google");
    // The fresh access token is cached: no refresh call before the first send.
    if (!row) throw new Error("mailbox missing");
    expect(await getAccessToken(ctx, row)).toMatchObject({ token: "ya29.access" });
    expect(ctx.fetch.calls).toHaveLength(1);
  });

  it("refuses a different account than the one requested", async () => {
    await setup([googleToken({ email: "other@brand.example.com" })]);
    const { token } = state("google", { email: "sam@brand.example.com" });
    const response = await app().request(
      `/oauth/google/callback?code=c&state=${encodeURIComponent(token)}`,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("You signed in as other@brand.example.com");
    expect(await ctx.db.select().from(mailboxes)).toHaveLength(0);
  });

  it("refuses onmicrosoft.com accounts and cancelled sign-ins", async () => {
    await setup([
      {
        match: microsoftTokenUrl("common"),
        method: "POST",
        response: {
          json: {
            access_token: "eyJ.access",
            refresh_token: "ms-refresh",
            expires_in: 3600,
            id_token: idToken({ preferred_username: "lee@brandco.onmicrosoft.com" }),
          },
        },
      },
    ]);
    const { token } = state("microsoft");
    const refused = await app().request(
      `/oauth/microsoft/callback?code=c&state=${encodeURIComponent(token)}`,
    );
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("custom domain");
    const cancelled = await app().request(
      `/oauth/microsoft/callback?error=access_denied&state=${encodeURIComponent(token)}`,
    );
    expect(cancelled.status).toBe(400);
    expect(await cancelled.text()).toContain("cancelled or refused");
    expect(await ctx.db.select().from(mailboxes)).toHaveLength(0);
  });

  it("reconnects an existing Microsoft mailbox and drops its old password", async () => {
    await setup([
      {
        match: microsoftTokenUrl("brand.example.com"),
        method: "POST",
        response: {
          json: {
            access_token: "eyJ.access",
            refresh_token: "ms-refresh",
            expires_in: 3600,
            id_token: idToken({ preferred_username: "Lee@Brand.example.com" }),
          },
        },
      },
    ]);
    const oldSecret = await storePasswords(ctx, ctx.workspace.id, "lee@brand.example.com", "old");
    const existing = await seedMailbox(ctx, {
      email: "lee@brand.example.com",
      provider_label: "custom",
      auth_type: "password",
      secret_id: oldSecret,
      status: "error",
      status_reason: "Login failed",
    });
    const { token } = state("microsoft", {}, "brand.example.com");
    const response = await app().request(
      `/oauth/microsoft/callback?code=c&state=${encodeURIComponent(token)}`,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Mailbox reconnected");
    const [row] = await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, existing.id));
    expect(row).toMatchObject({
      status: "active",
      status_reason: null,
      auth_type: "oauth_microsoft",
      provider_label: "microsoft",
      secret_id: null,
      smtp: { host: "smtp.office365.com", port: 587, secure: false },
      imap: { host: "outlook.office365.com", port: 993, secure: true },
      oauth: { provider: "microsoft", tenant: "brand.example.com" },
    });
    expect(await ctx.vault.getSecret(oldSecret)).toBeNull();
    // Emails held on it while it could not send go out now.
    expect(ctx.recorded.wakes).toContain(`mailbox_active:${existing.id}`);
  });
});

describe("access token refresh", () => {
  it("refreshes, caches and stores rotated refresh tokens", async () => {
    await setup([
      {
        match: GOOGLE_TOKEN_URL,
        method: "POST",
        response: {
          json: { access_token: "ya29.new", refresh_token: "1//rotated", expires_in: 3600 },
        },
      },
    ]);
    const secretId = await ctx.vault.putSecret(
      ctx.workspace.id,
      refreshSecretName("sam@brand.example.com"),
      "1//original",
    );
    const mailbox = await seedMailbox(ctx, {
      email: "sam@brand.example.com",
      provider_label: "google",
      auth_type: "oauth_google",
      oauth: { provider: "google", refresh_token_secret_id: secretId },
    });
    const first = await getAccessToken(ctx, mailbox);
    expect(first.token).toBe("ya29.new");
    expect(first.expiresAt.toISOString()).toBe("2026-09-21T16:00:00.000Z");
    expect(new URLSearchParams(String(ctx.fetch.calls[0]?.init?.body)).get("refresh_token")).toBe(
      "1//original",
    );
    expect(await ctx.vault.getSecret(secretId)).toBe("1//rotated");
    await getAccessToken(ctx, mailbox);
    expect(ctx.fetch.calls).toHaveLength(1);
    // Close to expiry the token is refreshed again.
    ctx.clock.advance(59 * 60_000);
    await getAccessToken(ctx, mailbox);
    expect(ctx.fetch.calls).toHaveLength(2);
  });

  it("turns a revoked grant into an auth failure", async () => {
    await setup([
      {
        match: GOOGLE_TOKEN_URL,
        method: "POST",
        response: { status: 400, json: { error: "invalid_grant" } },
      },
    ]);
    const secretId = await ctx.vault.putSecret(ctx.workspace.id, "mailbox:x:oauth_refresh", "r");
    const mailbox = await seedMailbox(ctx, {
      auth_type: "oauth_google",
      oauth: { provider: "google", refresh_token_secret_id: secretId },
    });
    const error = await getAccessToken(ctx, mailbox).catch((e: unknown) => e);
    expect(isAuthFailure(error)).toBe(true);
    expect((error as OpenOutboundError).hint).toContain("oauth_start");
    expect(failureOf(error)).toMatchObject({
      class: "auth_invalid",
      retryable: false,
      scope: "call",
      provider: "google",
    });
    expect((error as OpenOutboundError).details).toMatchObject({ reason: "auth" });
  });

  it("tells a token endpoint outage from a revoked grant", async () => {
    await setup([
      {
        match: GOOGLE_TOKEN_URL,
        method: "POST",
        response: { status: 503, json: { error: "temporarily_unavailable" } },
      },
    ]);
    const secretId = await ctx.vault.putSecret(ctx.workspace.id, "mailbox:y:oauth_refresh", "r");
    const mailbox = await seedMailbox(ctx, {
      auth_type: "oauth_google",
      oauth: { provider: "google", refresh_token_secret_id: secretId },
    });
    const error = await getAccessToken(ctx, mailbox).catch((e: unknown) => e);
    expect(isAuthFailure(error)).toBe(false);
    expect(failureOf(error)).toMatchObject({ class: "unavailable", retryable: true });
  });
});
