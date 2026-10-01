/**
 * LinkedIn official OAuth for posting accounts:
 * - GET /oauth/linkedin/start?state=... redirects to LinkedIn's consent page.
 * - GET /oauth/linkedin/callback exchanges the code, stores the token in the vault and adds a
 *   social account. The state is encrypted with the vault key, expires after 15 minutes and
 *   carries the PKCE verifier, so no server-side session is needed.
 */
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { OpContext, Vault } from "../../core/context.js";
import type { HttpRouteRegistrar } from "../../core/operation.js";
import { social_accounts } from "../../db/schema/index.js";
import type { OAuthExchange, OAuthStart } from "../../providers/social/linkedin-official.js";
import type { SocialPublisher } from "../../providers/types.js";

const STATE_AAD = "content:linkedin_oauth";
export const OAUTH_STATE_TTL_MS = 15 * 60_000;

export interface OAuthState {
  ws: string;
  /** PKCE code verifier. */
  v: string;
  exp: number;
}

export function encodeOAuthState(vault: Vault, state: OAuthState): string {
  return Buffer.from(
    JSON.stringify(vault.encrypt(JSON.stringify(state), STATE_AAD)),
    "utf8",
  ).toString("base64url");
}

export function decodeOAuthState(vault: Vault, token: string, now: Date): OAuthState | null {
  try {
    const sealed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    const state = JSON.parse(vault.decrypt(sealed, STATE_AAD)) as OAuthState;
    if (typeof state.ws !== "string" || typeof state.v !== "string") return null;
    if (typeof state.exp !== "number" || state.exp < now.getTime()) return null;
    return state;
  } catch {
    return null;
  }
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function page(title: string, message: string): string {
  const escapeHtml = (text: string) =>
    text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`;
}

async function officialPublisher(ctx: OpContext): Promise<SocialPublisher> {
  return ctx.providers.get("social", { id: "linkedin_official" });
}

/** Stores the token and upserts the social account. Returns the account id and name. */
export async function completeLinkedInOAuth(
  ctx: OpContext,
  input: { workspaceId: string; code: string; redirectUri: string; verifier: string },
): Promise<{ id: string; name: string | null }> {
  const publisher = await officialPublisher(ctx);
  if (!publisher.exchangeCode) throw new Error("linkedin_official cannot exchange codes");
  const exchange: OAuthExchange = {
    code: input.code,
    redirectUri: input.redirectUri,
    codeVerifier: input.verifier,
  };
  const result = await publisher.exchangeCode(exchange);
  const secretId = await ctx.vault.putSecret(
    input.workspaceId,
    `social:${result.account.provider}:${result.account.account_id}`,
    JSON.stringify(result.credentials),
  );
  const values = {
    name: result.account.name ?? null,
    secret_id: secretId,
    status: "active" as const,
    status_reason: null,
    expires_at: result.expiresAt ? new Date(result.expiresAt) : null,
  };
  const [existing] = await ctx.db
    .select({ id: social_accounts.id })
    .from(social_accounts)
    .where(
      and(
        eq(social_accounts.workspace_id, input.workspaceId),
        eq(social_accounts.provider, result.account.provider),
        eq(social_accounts.external_id, result.account.account_id),
      ),
    );
  if (existing) {
    await ctx.db.update(social_accounts).set(values).where(eq(social_accounts.id, existing.id));
    return { id: existing.id, name: values.name };
  }
  const [created] = await ctx.db
    .insert(social_accounts)
    .values({
      workspace_id: input.workspaceId,
      provider: result.account.provider,
      external_id: result.account.account_id,
      ...values,
    })
    .returning({ id: social_accounts.id });
  if (!created) throw new Error("content: social account insert returned no row");
  return { id: created.id, name: values.name };
}

export const linkedinOAuthRoutes: HttpRouteRegistrar = (app, { engine }) => {
  const redirectUri = `${engine.config.baseUrl}/oauth/linkedin/callback`;

  app.get("/oauth/linkedin/start", async (c) => {
    const token = c.req.query("state") ?? "";
    const system = await engine.systemContext(null);
    const state = decodeOAuthState(system.vault, token, system.clock.now());
    if (!state) {
      return c.html(
        page("Link expired", "This link is invalid or expired. Ask for a new one."),
        400,
      );
    }
    const ctx = await engine.systemContext(state.ws);
    const publisher = await officialPublisher(ctx);
    if (!publisher.authUrl)
      return c.html(page("Not available", "LinkedIn posting is not configured."), 400);
    const start: OAuthStart = { state: token, redirectUri, codeChallenge: pkceChallenge(state.v) };
    return c.redirect(await publisher.authUrl(start), 302);
  });

  app.get("/oauth/linkedin/callback", async (c) => {
    const error = c.req.query("error");
    if (error) {
      return c.html(
        page("Not connected", `LinkedIn returned: ${c.req.query("error_description") ?? error}`),
        400,
      );
    }
    const system = await engine.systemContext(null);
    const state = decodeOAuthState(system.vault, c.req.query("state") ?? "", system.clock.now());
    const code = c.req.query("code");
    if (!state || !code) {
      return c.html(
        page("Link expired", "This login link is invalid or expired. Ask for a new one."),
        400,
      );
    }
    const ctx = await engine.systemContext(state.ws);
    try {
      const account = await completeLinkedInOAuth(ctx, {
        workspaceId: state.ws,
        code,
        redirectUri,
        verifier: state.v,
      });
      await ctx.audit.record({
        operation: "posts.accounts.oauth_callback",
        effect: "write",
        status: "ok",
        target: { type: "social_account", id: account.id },
        summary: `Connected ${account.name ?? "a LinkedIn account"} for posting with LinkedIn OAuth`,
      });
      return c.html(
        page(
          "LinkedIn connected",
          `${account.name ?? "The account"} can now publish posts (account id ${account.id}). You can close this tab.`,
        ),
      );
    } catch (failure) {
      ctx.log.warn({ err: String(failure) }, "content: LinkedIn OAuth callback failed");
      return c.html(
        page(
          "Not connected",
          "LinkedIn did not accept the login. Ask for a new link and try again.",
        ),
        502,
      );
    }
  });
};
