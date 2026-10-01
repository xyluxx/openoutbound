import { and, eq } from "drizzle-orm";
import type { OpContext } from "../../core/context.js";
import { isOpenOutboundError } from "../../core/errors.js";
import type { HttpRouteRegistrar } from "../../core/operation.js";
import { messages } from "../../db/schema/index.js";
import { maskEmail, renderPage, sendPage } from "./public-page.js";
import { processUnsubscribe, type UnsubscribeSource } from "./unsubscribe.js";
import { type UnsubscribeTarget, verifyUnsubscribeToken } from "./unsubscribe-token.js";

const INVALID = renderPage("Link not valid", [
  "This unsubscribe link is not valid or was changed.",
  'Reply to the email with the word "unsubscribe" and you will be removed.',
]);
const DONE = renderPage("You are unsubscribed", [
  "You will not receive more emails from us at this address.",
]);
const FAILED = renderPage("Something went wrong", [
  'We could not process the request right now. Please try again, or reply to the email with "unsubscribe".',
]);

/**
 * Unsubscribes the token's recipient. Uses the message (person link) when it still exists and
 * falls back to the address in the token when the message or campaign was deleted.
 */
export async function unsubscribeFromToken(
  ctx: OpContext,
  target: UnsubscribeTarget,
  source: UnsubscribeSource,
): Promise<{ alreadyUnsubscribed: boolean; personId: string | null }> {
  const [message] = await ctx.db
    .select({ id: messages.id, person_id: messages.person_id, to_address: messages.to_address })
    .from(messages)
    .where(and(eq(messages.id, target.messageId), eq(messages.workspace_id, target.workspaceId)));
  const email = target.email || message?.to_address || "";
  return processUnsubscribe(ctx, {
    email,
    personId: message?.person_id ?? null,
    messageId: message?.id ?? null,
    source,
  });
}

/**
 * `GET /u/:token` shows a confirmation page (never unsubscribes, since link scanners follow
 * GETs). `POST /u/:token` unsubscribes: RFC 8058 one-click (`List-Unsubscribe=One-Click` body)
 * or the page's button. Valid tokens always get 200, also when already used.
 */
export const registerUnsubscribeRoutes: HttpRouteRegistrar = (app, { engine }) => {
  app.get("/u/:token", (c) => {
    const target = verifyUnsubscribeToken(engine.config, c.req.param("token"));
    if (!target) return sendPage(c, 404, INVALID);
    return sendPage(
      c,
      200,
      renderPage(
        "Unsubscribe",
        [`Stop emails to ${maskEmail(target.email)}?`, "One click below and you are removed."],
        { button: "Unsubscribe" },
      ),
    );
  });

  app.post("/u/:token", async (c) => {
    const target = verifyUnsubscribeToken(engine.config, c.req.param("token"));
    if (!target) return sendPage(c, 404, INVALID);
    const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const source: UnsubscribeSource =
      body["List-Unsubscribe"] === "One-Click" ? "one_click" : "link";
    try {
      const ctx = await engine.systemContext(target.workspaceId);
      if (!ctx.workspace) return sendPage(c, 200, DONE);
      await unsubscribeFromToken(ctx, target, source);
    } catch (error) {
      // A deleted workspace has nothing left to send from: the request is fulfilled.
      if (isOpenOutboundError(error) && error.code === "not_found") return sendPage(c, 200, DONE);
      engine.log.error(
        { err: String(error), workspace_id: target.workspaceId },
        "email: unsubscribe failed",
      );
      return sendPage(c, 500, FAILED);
    }
    return sendPage(c, 200, DONE);
  });
};
