/**
 * LinkedIn official publishing (slot social): OAuth 2.0 authorization code flow with the
 * self-serve "Share on LinkedIn" product (`w_member_social`), member id from OIDC userinfo, and
 * text posts through the versioned Posts API (provider API notes, section 4). Access tokens last
 * 60 days and are stored by the caller in the vault; plain apps get no refresh token. Every
 * request has a timeout (and the publish job's signal); a post whose answer was lost is
 * `outcome_unknown`, and one accepted without an id is `malformed` with `details.accepted`. A post
 * whose answer broke off after its id came in the headers is published with that id.
 */
import { z } from "zod";
import { OpenOutboundError } from "../../core/errors.js";
import { parseRetryAfter } from "../../core/failures.js";
import {
  answerFailure,
  type CallKind,
  classFailure,
  type FailureStyle,
  malformedFailure,
  type ProviderIdentity,
  parseJsonText,
  requestText,
  upstreamMessage,
} from "../http.js";
import { defineProvider, type SocialPublisher } from "../types.js";

const AUTHORIZE_URL = "https://www.linkedin.com/oauth/v2/authorization";
const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const USERINFO_URL = "https://api.linkedin.com/v2/userinfo";
const POSTS_URL = "https://api.linkedin.com/rest/posts";
/** LinkedIn's documented limit for post commentary (legacy field limit, still enforced). */
export const LINKEDIN_POST_MAX = 3000;

export const linkedinOfficialConfigSchema = z.object({
  api_version: z
    .string()
    .regex(/^\d{6}$/)
    .default("202608")
    .describe("LinkedIn-Version header (YYYYMM); versions sunset after about a year"),
  scopes: z.array(z.string()).default(["openid", "profile", "w_member_social"]),
  pkce: z
    .boolean()
    .default(false)
    .describe("Send a PKCE challenge (only for LinkedIn apps enabled for PKCE)"),
});
export type LinkedInOfficialConfig = z.output<typeof linkedinOfficialConfigSchema>;

/** OAuth inputs with the optional PKCE fields the content module passes. */
export interface OAuthStart {
  state: string;
  redirectUri: string;
  codeChallenge?: string;
}
export interface OAuthExchange {
  code: string;
  redirectUri: string;
  codeVerifier?: string;
}

const LINKEDIN: ProviderIdentity = { id: "linkedin_official", name: "LinkedIn" };

/** OAuth errors that mean the app's credentials, not this one code, were rejected. */
const APP_AUTH_ERRORS = new Set(["invalid_client", "unauthorized_client"]);

/**
 * A failed LinkedIn answer, classified. A 401 means the member's token expired or was revoked
 * (`auth_invalid` for this account only, `details.expired`); OAuth `invalid_grant` is the same
 * for a code, while `invalid_client` / `unauthorized_client` mean the app's id or secret is
 * wrong (`auth_invalid`, scope account). In the token exchange there is no token yet: a refused
 * code means connecting again. A server error after a post is `outcome_unknown`.
 */
function linkedinError(
  status: number,
  headers: Headers,
  body: string,
  context: string,
  kind: CallKind = {},
): OpenOutboundError {
  const parsed = parseJsonText(body) as Record<string, unknown> | undefined;
  const detail = (upstreamMessage(parsed) ?? "").replace(/\.+$/, "");
  const oauthError = typeof parsed?.error === "string" ? parsed.error : "";
  const appAuth = APP_AUTH_ERRORS.has(oauthError);
  const memberAuth = status === 401 || oauthError === "invalid_grant";
  const exchange = context === "token exchange";
  return answerFailure(
    LINKEDIN,
    {
      status,
      headers,
      message: `LinkedIn ${context} failed (${status})${detail ? `: ${detail.slice(0, 200)}` : ""}.`,
      ...(appAuth
        ? {
            class: "auth_invalid" as const,
            scope: "account" as const,
            hint: "LinkedIn rejected the app's client id or secret: store the right ones with manage_providers (action set, slot social, provider linkedin_official); that resumes posting.",
          }
        : memberAuth && exchange
          ? {
              class: "auth_invalid" as const,
              scope: "call" as const,
              hint: "LinkedIn refused the sign-in code (it expired or was used already, or the app's client id or secret is wrong): connect the posting account again (manage_posts action connect_account). If it fails again, store the app's right client id and secret with manage_providers (action set, slot social, provider linkedin_official).",
            }
          : memberAuth
            ? {
                class: "auth_invalid" as const,
                scope: "call" as const,
                hint: "The LinkedIn token expired or was revoked: connect the posting account again (manage_posts action connect_account).",
                details: { expired: true },
              }
            : status === 429
              ? { retryAfterSeconds: parseRetryAfter(headers.get("retry-after")) ?? 3600 }
              : status === 403
                ? { scope: "call" as const }
                : {}),
      ...(!appAuth && !memberAuth && status < 500 && status !== 429
        ? {
            hint: "Check the post text and the LinkedIn app's products (Share on LinkedIn), then retry.",
          }
        : {}),
    },
    kind,
    LINKEDIN_STYLE,
  );
}

const LINKEDIN_STYLE: FailureStyle = {
  details(failureClass) {
    return failureClass === "rate_limited" ? { rateLimited: true } : undefined;
  },
};

/** Headers in which LinkedIn names the post it made. */
const POST_ID_HEADERS = ["x-restli-id", "x-linkedin-id"];

/** One request with a timeout, the answer read in full and classified when it failed. */
async function call(
  fetchFn: typeof globalThis.fetch,
  url: string,
  init: { method?: string; headers: Record<string, string>; body?: string },
  context: string,
  kind: CallKind & { signal?: AbortSignal | undefined; idHeaders?: string[] } = {},
): Promise<{ text: string; headers: Headers }> {
  const answer = await requestText(
    fetchFn,
    LINKEDIN,
    {
      url,
      method: init.method ?? "GET",
      headers: init.headers,
      ...(init.body === undefined ? {} : { body: init.body }),
      ...(kind.signal ? { signal: kind.signal } : {}),
      ...(kind.write ? { write: true } : {}),
      ...(kind.idHeaders ? { idHeaders: kind.idHeaders } : {}),
    },
    LINKEDIN_STYLE,
  );
  if (!answer.ok) throw linkedinError(answer.status, answer.headers, answer.text, context, kind);
  return { text: answer.text, headers: answer.headers };
}

function readJson(text: string, context: string): Record<string, unknown> {
  const parsed = parseJsonText(text);
  if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>;
  throw malformedFailure(LINKEDIN, `${context} answered with malformed JSON`);
}

export function createLinkedInOfficial(input: {
  clientId: string;
  clientSecret: string;
  config: LinkedInOfficialConfig;
  fetch: typeof globalThis.fetch;
  clock: { now(): Date };
}): SocialPublisher {
  const { config } = input;
  return {
    id: "linkedin_official",
    authUrl(start: OAuthStart) {
      const url = new URL(AUTHORIZE_URL);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", input.clientId);
      url.searchParams.set("redirect_uri", start.redirectUri);
      url.searchParams.set("state", start.state);
      url.searchParams.set("scope", config.scopes.join(" "));
      if (config.pkce && start.codeChallenge) {
        url.searchParams.set("code_challenge", start.codeChallenge);
        url.searchParams.set("code_challenge_method", "S256");
      }
      return url.toString();
    },
    async exchangeCode(exchange: OAuthExchange) {
      const form = new URLSearchParams({
        grant_type: "authorization_code",
        code: exchange.code,
        client_id: input.clientId,
        client_secret: input.clientSecret,
        redirect_uri: exchange.redirectUri,
      });
      if (config.pkce && exchange.codeVerifier) form.set("code_verifier", exchange.codeVerifier);
      const exchanged = await call(
        input.fetch,
        TOKEN_URL,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: form.toString(),
        },
        "token exchange",
      );
      const token = readJson(exchanged.text, "token exchange");
      const accessToken = typeof token.access_token === "string" ? token.access_token : "";
      if (!accessToken) throw malformedFailure(LINKEDIN, "no access token");
      const userinfo = await call(
        input.fetch,
        USERINFO_URL,
        { headers: { authorization: `Bearer ${accessToken}` } },
        "userinfo",
      );
      const user = readJson(userinfo.text, "userinfo");
      const sub = typeof user.sub === "string" ? user.sub : "";
      if (!sub) {
        throw classFailure(LINKEDIN, "malformed", {
          message: "LinkedIn userinfo has no member id (sub).",
          hint: "Make sure the app requests the openid and profile scopes.",
        });
      }
      const expiresIn = typeof token.expires_in === "number" ? token.expires_in : 60 * 86_400;
      const expiresAt = new Date(input.clock.now().getTime() + expiresIn * 1000).toISOString();
      const credentials: Record<string, string> = { access_token: accessToken };
      if (typeof token.refresh_token === "string") credentials.refresh_token = token.refresh_token;
      return {
        account: {
          provider: "linkedin_official",
          account_id: `urn:li:person:${sub}`,
          name: typeof user.name === "string" ? user.name : sub,
        },
        credentials,
        expiresAt,
      };
    },
    async publish(post) {
      const token = post.credentials?.access_token;
      if (!token) {
        throw new OpenOutboundError(
          "provider_not_configured",
          "No LinkedIn access token for this account.",
          {
            hint: "Connect the posting account with manage_posts action connect_account.",
            details: { provider: "linkedin_official", expired: true },
          },
        );
      }
      if (post.text.length > LINKEDIN_POST_MAX) {
        throw new OpenOutboundError(
          "validation_failed",
          `Post is longer than ${LINKEDIN_POST_MAX} characters.`,
          {
            hint: "Shorten the post with manage_posts action update.",
            details: { provider: "linkedin_official", retryable: false },
          },
        );
      }
      const response = await call(
        input.fetch,
        POSTS_URL,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "X-Restli-Protocol-Version": "2.0.0",
            "LinkedIn-Version": config.api_version,
          },
          body: JSON.stringify({
            author: post.accountRef.account_id,
            commentary: post.text,
            visibility: "PUBLIC",
            distribution: {
              feedDistribution: "MAIN_FEED",
              targetEntities: [],
              thirdPartyDistributionChannels: [],
            },
            lifecycleState: "PUBLISHED",
            isReshareDisabledByAuthor: false,
          }),
        },
        "post",
        { write: true, signal: post.signal, idHeaders: POST_ID_HEADERS },
      );
      const urn = response.headers.get("x-restli-id") ?? response.headers.get("x-linkedin-id");
      if (!urn) {
        // A 2xx page that is not LinkedIn's answer (not empty, not JSON) may come from something
        // in between: it may not have reached LinkedIn, so it is checked, never assumed.
        if (response.text.trim() && parseJsonText(response.text) === undefined) {
          throw classFailure(LINKEDIN, "outcome_unknown", {
            message:
              "LinkedIn answered the post with a page that is not its own answer, so it is unknown whether it was published.",
            hint: "Check the profile's recent activity, then settle it with manage_posts action resolve_unknown.",
          });
        }
        // Accepted without an id: it was published, so it is never sent again.
        throw malformedFailure(LINKEDIN, "no post id", { write: true });
      }
      return { externalId: urn, url: `https://www.linkedin.com/feed/update/${urn}/` };
    },
  };
}

export const linkedinOfficialProvider = defineProvider({
  slot: "social",
  id: "linkedin_official",
  name: "LinkedIn (official API)",
  description:
    "Publishes posts to the member's own LinkedIn feed through LinkedIn's official Posts API (OAuth, Share on LinkedIn product).",
  docsUrl:
    "https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin",
  configSchema: linkedinOfficialConfigSchema,
  secrets: [
    {
      key: "client_id",
      label: "LinkedIn app client id",
      env: "LINKEDIN_CLIENT_ID",
      required: true,
    },
    {
      key: "client_secret",
      label: "LinkedIn app client secret",
      env: "LINKEDIN_CLIENT_SECRET",
      required: true,
    },
  ],
  create: ({ config, secrets, ctx }) =>
    createLinkedInOfficial({
      clientId: secrets.client_id ?? "",
      clientSecret: secrets.client_secret ?? "",
      config,
      fetch: ctx.fetch,
      clock: ctx.clock,
    }),
});
