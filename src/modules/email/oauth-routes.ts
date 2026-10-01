import type { Context } from "hono";
import type { OpContext } from "../../core/context.js";
import type { Engine } from "../../core/engine.js";
import { isOpenOutboundError } from "../../core/errors.js";
import type { HttpRouteRegistrar } from "../../core/operation.js";
import {
  authorizeUrl,
  isStateExpired,
  OAUTH_PROVIDERS,
  type OAuthProvider,
  type OAuthState,
  verifyState,
} from "./oauth.js";
import { completeOAuth } from "./oauth-connect.js";
import { renderPage, sendPage } from "./public-page.js";

const RESTART = "Run manage_mailboxes action oauth_start again to get a new link.";

function problem(c: Context, status: 400 | 500, title: string, lines: string[]): Response {
  return sendPage(c, status, renderPage(title, lines));
}

/** Verifies the signed state and loads the workspace context it names (expiry on its clock). */
async function stateContext(
  engine: Engine,
  provider: OAuthProvider,
  token: string,
): Promise<{ state: OAuthState; ctx: OpContext } | { error: string }> {
  const state = verifyState(engine.config, token, null);
  if (!state || state.p !== provider) return { error: "This connection link is not valid." };
  const ctx = await engine.systemContext(state.ws).catch(() => null);
  if (!ctx?.workspace) return { error: "The workspace of this link no longer exists." };
  if (isStateExpired(state, ctx.clock.now())) return { error: "This connection link expired." };
  return { state, ctx };
}

/**
 * `GET /oauth/<provider>/start?state=...` redirects to the provider consent screen (PKCE S256);
 * `GET /oauth/<provider>/callback` exchanges the code, stores the refresh token in the vault
 * and creates or reconnects the mailbox. Both check the signed state (workspace + draft).
 */
export const registerOAuthRoutes: HttpRouteRegistrar = (app, { engine }) => {
  for (const provider of OAUTH_PROVIDERS) {
    app.get(`/oauth/${provider}/start`, async (c) => {
      const token = c.req.query("state") ?? "";
      const checked = await stateContext(engine, provider, token);
      if ("error" in checked) return problem(c, 400, "Link not valid", [checked.error, RESTART]);
      try {
        return c.redirect(authorizeUrl(engine.config, checked.state, token), 302);
      } catch (error) {
        if (isOpenOutboundError(error)) {
          return problem(c, 500, "Not configured", [error.message, error.hint ?? RESTART]);
        }
        throw error;
      }
    });

    app.get(`/oauth/${provider}/callback`, async (c) => {
      const token = c.req.query("state") ?? "";
      const checked = await stateContext(engine, provider, token);
      if ("error" in checked) return problem(c, 400, "Link not valid", [checked.error, RESTART]);
      const refused = c.req.query("error");
      if (refused) {
        return problem(c, 400, "Not connected", [
          `The sign-in was cancelled or refused (${refused.slice(0, 80)}).`,
          RESTART,
        ]);
      }
      const code = c.req.query("code");
      if (!code) return problem(c, 400, "Not connected", ["The provider sent no code.", RESTART]);
      try {
        const { mailbox, created } = await completeOAuth(checked.ctx, checked.state, code);
        return sendPage(
          c,
          200,
          renderPage(created ? "Mailbox connected" : "Mailbox reconnected", [
            `${mailbox.email} is connected with ${provider === "google" ? "Google" : "Microsoft"} OAuth.`,
            "You can close this tab. Check the domain setup with manage_mailboxes action check_dns.",
          ]),
        );
      } catch (error) {
        if (isOpenOutboundError(error)) {
          return problem(c, 400, "Not connected", [error.message, error.hint ?? RESTART]);
        }
        engine.log.error({ err: String(error), provider }, "email: oauth callback failed");
        return problem(c, 500, "Something went wrong", [RESTART]);
      }
    });
  }
};
