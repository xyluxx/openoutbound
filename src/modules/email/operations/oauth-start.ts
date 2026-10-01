import { z } from "zod";
import { requireWorkspace } from "../../../core/context.js";
import { OpenOutboundError } from "../../../core/errors.js";
import { defineOperation } from "../../../core/operation.js";
import { assertSendableAddress } from "../mailbox-create.js";
import {
  callbackUrl,
  createState,
  type MailboxDraft,
  OAUTH_PROVIDERS,
  oauthClient,
} from "../oauth.js";

export const oauthStartOperation = defineOperation({
  id: "mailboxes.oauth_start",
  summary: "Get a link that connects a Google or Microsoft mailbox with OAuth",
  description:
    "Returns a one-time link (valid 30 minutes) that a person opens to sign in to Google or Microsoft 365; the callback stores the refresh token encrypted in the vault and creates the mailbox (or reconnects an existing one). Microsoft 365 mailboxes can only connect this way, and it is the recommended way for Google Workspace. The engine needs GOOGLE_OAUTH_CLIENT_ID/SECRET or MICROSOFT_OAUTH_CLIENT_ID/SECRET and must be reachable at its base URL. Addresses on onmicrosoft.com are refused: use a custom domain.",
  effect: "write",
  input: z.object({
    provider: z.enum(OAUTH_PROVIDERS),
    email: z
      .string()
      .max(320)
      .optional()
      .describe("Expected address; the sign-in must match it (also pre-fills the login)"),
    from_name: z.string().max(100).optional(),
    daily_limit: z.number().int().min(1).max(500).optional(),
    signature: z.string().max(2000).optional(),
    tenant: z
      .string()
      .max(100)
      .regex(/^[A-Za-z0-9.-]+$/)
      .optional()
      .describe("Microsoft tenant id or domain (default: common)"),
  }),
  output: z.object({
    provider: z.enum(OAUTH_PROVIDERS),
    connect_url: z.string(),
    expires_at: z.string(),
    redirect_uri: z.string(),
    next_steps: z.array(z.string()),
  }),
  http: { method: "POST", path: "/v1/mailboxes/oauth/start" },
  dryRun: "none",
  idempotent: false,
  workspace: "required",
  examples: [
    {
      title: "Connect a Microsoft 365 mailbox",
      input: { provider: "microsoft", email: "sam@brand.example.com", from_name: "Sam Carter" },
    },
  ],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    if (workspace.is_sandbox) {
      throw new OpenOutboundError("unsupported", "Sandbox workspaces use sandbox mailboxes.", {
        hint: "Add one with manage_mailboxes action add (no password needed), or connect real mailboxes in a non-sandbox workspace.",
      });
    }
    if (input.tenant && input.provider !== "microsoft") {
      throw new OpenOutboundError("validation_failed", "tenant only applies to Microsoft.", {
        hint: "Drop tenant, or use provider microsoft.",
      });
    }
    const email = input.email?.trim().toLowerCase();
    if (email) {
      if (!z.email().safeParse(email).success) {
        throw new OpenOutboundError(
          "validation_failed",
          `"${input.email}" is not an email address.`,
          {
            hint: "Pass the full address, e.g. sam@brand.example.com, or leave email out.",
          },
        );
      }
      assertSendableAddress(email);
    }
    oauthClient(ctx.config, input.provider);
    const draft: MailboxDraft = {};
    if (email) draft.email = email;
    if (input.from_name) draft.from_name = input.from_name;
    if (input.daily_limit) draft.daily_limit = input.daily_limit;
    if (input.signature) draft.signature = input.signature;
    const now = ctx.clock.now();
    const { state, token } = createState(ctx.config, {
      workspaceId: workspace.id,
      provider: input.provider,
      draft,
      ...(input.tenant ? { tenant: input.tenant } : {}),
      now,
    });
    const nextSteps = [
      "Open connect_url in a browser and sign in (a person must do this step).",
      "Then run manage_mailboxes action list to see the new mailbox, and action check_dns.",
    ];
    if (!ctx.config.baseUrl.startsWith("https://")) {
      nextSteps.push(
        `The base URL ${ctx.config.baseUrl} is not https: providers only accept http redirect URIs for localhost.`,
      );
    }
    return {
      provider: input.provider,
      connect_url: `${ctx.config.baseUrl}/oauth/${input.provider}/start?state=${encodeURIComponent(token)}`,
      expires_at: new Date(state.exp * 1000).toISOString(),
      redirect_uri: callbackUrl(ctx.config, input.provider),
      next_steps: nextSteps,
    };
  },
});
