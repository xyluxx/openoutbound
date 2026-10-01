import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { EngineConfig } from "../../core/config.js";
import type { OpContext } from "../../core/context.js";
import { OpenOutboundError } from "../../core/errors.js";
import { classifyHttpStatus, parseRetryAfter, providerFailure } from "../../core/failures.js";
import { type Mailbox, mailboxes } from "../../db/schema/index.js";
import { deriveKey, hmacBase64Url, safeEqual, sha256Base64Url } from "./signing.js";

/**
 * Google and Microsoft mailbox OAuth (XOAUTH2 for SMTP and IMAP): signed state bound to the
 * workspace and a mailbox draft, PKCE (S256) with a verifier derived from the state nonce, code
 * exchange, refresh with an in-memory access token cache. Refresh tokens live in the vault.
 */

export const OAUTH_PROVIDERS = ["google", "microsoft"] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

const STATE_KEY_INFO = "openoutbound/oauth-state/v1";
const PKCE_KEY_INFO = "openoutbound/oauth-pkce/v1";
const STATE_TTL_SECONDS = 30 * 60;

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_SCOPES = ["https://mail.google.com/", "openid", "email", "profile"];
export const MICROSOFT_SCOPES = [
  "offline_access",
  "https://outlook.office.com/IMAP.AccessAsUser.All",
  "https://outlook.office.com/SMTP.Send",
  "openid",
  "email",
  "profile",
];

export function microsoftAuthorizeUrl(tenant: string): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize`;
}

export function microsoftTokenUrl(tenant: string): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;
}

/** Mailbox fields chosen before the OAuth redirect, carried inside the signed state. */
export interface MailboxDraft {
  email?: string;
  from_name?: string;
  daily_limit?: number;
  signature?: string;
}

/** Signed OAuth state payload (short keys keep the URL small). */
export interface OAuthState {
  v: 1;
  /** Workspace id. */
  ws: string;
  p: OAuthProvider;
  /** Random nonce; also seeds the PKCE verifier. */
  n: string;
  /** Expiry, unix seconds. */
  exp: number;
  /** Microsoft tenant. */
  t?: string;
  d: MailboxDraft;
}

interface OAuthClient {
  clientId: string;
  clientSecret: string | null;
  tenant: string;
}

/** OAuth app credentials from the environment; throws `provider_not_configured` when missing. */
export function oauthClient(config: EngineConfig, provider: OAuthProvider): OAuthClient {
  const env = config.env;
  const prefix = provider === "google" ? "GOOGLE_OAUTH" : "MICROSOFT_OAUTH";
  const clientId = env[`${prefix}_CLIENT_ID`]?.trim();
  const clientSecret = env[`${prefix}_CLIENT_SECRET`]?.trim() || null;
  if (!clientId || (provider === "google" && !clientSecret)) {
    throw new OpenOutboundError(
      "provider_not_configured",
      `${provider === "google" ? "Google" : "Microsoft"} OAuth is not configured for mailboxes.`,
      {
        hint: `Set ${prefix}_CLIENT_ID and ${prefix}_CLIENT_SECRET in .env (redirect URI ${config.baseUrl}/oauth/${provider}/callback), restart, then run manage_mailboxes action oauth_start again. Or add the mailbox with an app password (action add).`,
        details: { provider },
      },
    );
  }
  return {
    clientId,
    clientSecret,
    tenant: env.MICROSOFT_OAUTH_TENANT?.trim() || "common",
  };
}

export function callbackUrl(config: EngineConfig, provider: OAuthProvider): string {
  return `${config.baseUrl}/oauth/${provider}/callback`;
}

/** Creates a new signed state for a workspace and draft. */
export function createState(
  config: EngineConfig,
  input: {
    workspaceId: string;
    provider: OAuthProvider;
    draft: MailboxDraft;
    tenant?: string;
    now: Date;
  },
): { state: OAuthState; token: string } {
  const state: OAuthState = {
    v: 1,
    ws: input.workspaceId,
    p: input.provider,
    n: randomBytes(16).toString("base64url"),
    exp: Math.floor(input.now.getTime() / 1000) + STATE_TTL_SECONDS,
    d: input.draft,
  };
  if (input.tenant) state.t = input.tenant;
  return { state, token: signState(config, state) };
}

export function signState(config: EngineConfig, state: OAuthState): string {
  const payload = Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
  return `${payload}.${hmacBase64Url(deriveKey(config, STATE_KEY_INFO), payload)}`;
}

/**
 * The state when the signature is valid, the version known and (unless `now` is null) it has not
 * expired; else null. Routes pass null, then check `isStateExpired` with the workspace clock.
 */
export function verifyState(
  config: EngineConfig,
  token: string,
  now: Date | null,
): OAuthState | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const expected = hmacBase64Url(deriveKey(config, STATE_KEY_INFO), payload);
  if (!safeEqual(token.slice(dot + 1), expected)) return null;
  try {
    const state = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as OAuthState;
    if (state.v !== 1 || !OAUTH_PROVIDERS.includes(state.p) || typeof state.ws !== "string") {
      return null;
    }
    if (typeof state.exp !== "number") return null;
    if (now && isStateExpired(state, now)) return null;
    return state;
  } catch {
    return null;
  }
}

export function isStateExpired(state: OAuthState, now: Date): boolean {
  return state.exp * 1000 < now.getTime();
}

/** PKCE verifier derived from the nonce with a server key: nothing to store between requests. */
export function pkceVerifier(config: EngineConfig, nonce: string): string {
  return hmacBase64Url(deriveKey(config, PKCE_KEY_INFO), nonce);
}

/** Provider authorization URL for a verified state. */
export function authorizeUrl(config: EngineConfig, state: OAuthState, stateToken: string): string {
  const client = oauthClient(config, state.p);
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: callbackUrl(config, state.p),
    response_type: "code",
    state: stateToken,
    code_challenge: sha256Base64Url(pkceVerifier(config, state.n)),
    code_challenge_method: "S256",
  });
  if (state.d.email) params.set("login_hint", state.d.email);
  if (state.p === "google") {
    params.set("scope", GOOGLE_SCOPES.join(" "));
    params.set("access_type", "offline");
    params.set("prompt", "consent");
    return `${GOOGLE_AUTHORIZE_URL}?${params.toString()}`;
  }
  params.set("scope", MICROSOFT_SCOPES.join(" "));
  params.set("response_mode", "query");
  params.set("prompt", "select_account");
  return `${microsoftAuthorizeUrl(state.t ?? client.tenant)}?${params.toString()}`;
}

/** Token endpoint answer, reduced to what the engine uses. */
export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  idToken: string | null;
}

/** Maps a token endpoint JSON body; one place to fix if a provider changes its shape. */
export function parseTokenResponse(body: unknown, now: Date): TokenSet {
  const data = (body ?? {}) as Record<string, unknown>;
  const accessToken = typeof data.access_token === "string" ? data.access_token : "";
  if (!accessToken) {
    throw providerFailure({
      provider: "oauth",
      name: "The OAuth server",
      class: "malformed",
      message: "The OAuth token response had no access token.",
      hint: "Run manage_mailboxes action oauth_start again to reconnect the mailbox.",
      details: { reason: "oauth_bad_response" },
    });
  }
  const expiresIn = Number(data.expires_in);
  return {
    accessToken,
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : null,
    expiresAt: new Date(now.getTime() + (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000),
    idToken: typeof data.id_token === "string" ? data.id_token : null,
  };
}

async function tokenRequest(
  ctx: OpContext,
  provider: OAuthProvider,
  tenant: string | undefined,
  params: Record<string, string>,
): Promise<TokenSet> {
  const client = oauthClient(ctx.config, provider);
  const body = new URLSearchParams({ client_id: client.clientId, ...params });
  if (client.clientSecret) body.set("client_secret", client.clientSecret);
  const url = provider === "google" ? GOOGLE_TOKEN_URL : microsoftTokenUrl(tenant ?? client.tenant);
  const response = await ctx.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString(),
    timeoutMs: 20_000,
  });
  const json: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = (json as { error?: string }).error ?? `http_${response.status}`;
    // A revoked or expired grant (Google and Microsoft both answer invalid_grant).
    const invalidGrant = error === "invalid_grant" || error === "unauthorized_client";
    // The engine's OAuth client itself was rejected (id or secret).
    const badClient = error === "invalid_client";
    throw providerFailure({
      provider,
      class: invalidGrant || badClient ? "auth_invalid" : classifyHttpStatus(response.status),
      // A revoked grant concerns this mailbox only; a rejected client, every mailbox.
      ...(invalidGrant ? { scope: "call" as const } : {}),
      upstreamStatus: response.status,
      ...(response.status === 429
        ? { retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after")) ?? 60 }
        : {}),
      message: `The ${provider} token endpoint refused the request (${error}).`,
      hint: invalidGrant
        ? "The mailbox authorization was revoked or expired. Run manage_mailboxes action oauth_start to reconnect it."
        : "Check the OAuth client id, secret and redirect URI in .env, then try again.",
      details: {
        reason: invalidGrant ? "auth" : "oauth_error",
        oauth_error: error,
      },
    });
  }
  return parseTokenResponse(json, ctx.clock.now());
}

/** Exchanges an authorization code (with the PKCE verifier). */
export function exchangeCode(ctx: OpContext, state: OAuthState, code: string): Promise<TokenSet> {
  return tokenRequest(ctx, state.p, state.t, {
    grant_type: "authorization_code",
    code,
    redirect_uri: callbackUrl(ctx.config, state.p),
    code_verifier: pkceVerifier(ctx.config, state.n),
  });
}

/**
 * Identity claims of an ID token received directly from the token endpoint over TLS (OIDC Core
 * 3.1.3.7 allows TLS server validation in place of the signature check in that case).
 */
export function idTokenClaims(idToken: string | null): {
  email: string | null;
  name: string | null;
} {
  if (!idToken) return { email: null, name: null };
  try {
    const payload = JSON.parse(
      Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const email =
      (typeof payload.email === "string" && payload.email) ||
      (typeof payload.preferred_username === "string" && payload.preferred_username) ||
      null;
    return {
      email: email ? email.toLowerCase() : null,
      name: typeof payload.name === "string" ? payload.name : null,
    };
  } catch {
    return { email: null, name: null };
  }
}

export function refreshSecretName(email: string): string {
  return `mailbox:${email}:oauth_refresh`;
}

const accessTokens = new Map<string, { token: string; expiresAt: Date; refreshSecretId: string }>();

/** Forgets cached access tokens (tests, reconnects). */
export function clearAccessTokenCache(mailboxId?: string): void {
  if (mailboxId) accessTokens.delete(mailboxId);
  else accessTokens.clear();
}

/** Caches a fresh access token (right after the OAuth callback) so the first send skips a refresh. */
export function primeAccessToken(
  mailboxId: string,
  token: { accessToken: string; expiresAt: Date },
  refreshSecretId: string,
): void {
  accessTokens.set(mailboxId, {
    token: token.accessToken,
    expiresAt: token.expiresAt,
    refreshSecretId,
  });
}

/**
 * A valid access token for an OAuth mailbox, refreshed when it expires within 2 minutes.
 * Stores rotated refresh tokens (Microsoft issues a new one on every refresh).
 */
export async function getAccessToken(
  ctx: OpContext,
  mailbox: Mailbox,
): Promise<{ token: string; expiresAt: Date }> {
  const oauth = mailbox.oauth;
  const provider = oauth?.provider;
  if (!oauth || !provider || !oauth.refresh_token_secret_id) {
    throw providerFailure({
      provider: provider ?? "oauth",
      class: "auth_invalid",
      scope: "call",
      message: `Mailbox ${mailbox.email} has no OAuth token.`,
      hint: "Run manage_mailboxes action oauth_start to connect it.",
      details: { reason: "auth" },
    });
  }
  const now = ctx.clock.now();
  const cached = accessTokens.get(mailbox.id);
  if (
    cached &&
    cached.refreshSecretId === oauth.refresh_token_secret_id &&
    cached.expiresAt.getTime() - now.getTime() > 120_000
  ) {
    return { token: cached.token, expiresAt: cached.expiresAt };
  }
  const refreshToken = await ctx.vault.getSecret(
    oauth.refresh_token_secret_id,
    mailbox.workspace_id,
  );
  if (!refreshToken) {
    throw providerFailure({
      provider,
      class: "auth_invalid",
      scope: "call",
      message: `The OAuth token of ${mailbox.email} is missing.`,
      hint: "Run manage_mailboxes action oauth_start to reconnect the mailbox.",
      details: { reason: "auth" },
    });
  }
  const tokens = await tokenRequest(ctx, provider, oauth.tenant, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  if (tokens.refreshToken && tokens.refreshToken !== refreshToken) {
    await ctx.vault.putSecret(
      mailbox.workspace_id,
      refreshSecretName(mailbox.email),
      tokens.refreshToken,
    );
  }
  accessTokens.set(mailbox.id, {
    token: tokens.accessToken,
    expiresAt: tokens.expiresAt,
    refreshSecretId: oauth.refresh_token_secret_id,
  });
  await ctx.db
    .update(mailboxes)
    .set({ oauth: { ...oauth, access_token_expires_at: tokens.expiresAt.toISOString() } })
    .where(eq(mailboxes.id, mailbox.id));
  return { token: tokens.accessToken, expiresAt: tokens.expiresAt };
}
