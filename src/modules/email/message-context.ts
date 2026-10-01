import { and, eq } from "drizzle-orm";
import type { OpContext } from "../../core/context.js";
import {
  type CampaignSettings,
  parseCampaignSettings,
  parseStepConfig,
  parseWorkspaceSettings,
  type WorkspaceSettings,
} from "../../core/settings.js";
import {
  type Campaign,
  type Company,
  campaign_steps,
  campaigns,
  companies,
  type Mailbox,
  type Message,
  offers,
  type Person,
  people,
  type Workspace,
} from "../../db/schema/index.js";
import { recipientTimeZone } from "../campaigns/timezones.js";
import { resolveBookingLink } from "../inbox/booking-links.js";
import { buildFooter } from "./footer.js";
import type { FooterContent, TemplateVars } from "./render.js";
import { unsubscribeUrl } from "./unsubscribe-token.js";

/** Always-open schedule for messages outside campaigns (inbox replies, manual sends). */
export function anytimeSchedule(timezone: string): CampaignSettings["schedule"] {
  return {
    days: [1, 2, 3, 4, 5, 6, 7],
    start_hour: 0,
    end_hour: 24,
    timezone_mode: "fixed",
    timezone,
  };
}

/** Everything needed to render and schedule one outbound message. */
export interface SendContext {
  workspace: Workspace;
  settings: WorkspaceSettings;
  message: Message;
  person: Person | null;
  company: Company | null;
  campaign: Campaign | null;
  campaignSettings: CampaignSettings | null;
  /** `reply` for email steps configured to continue the thread. */
  stepMode: "new_thread" | "reply" | null;
  offer: { name: string; booking_url: string | null } | null;
  /**
   * The value of `{{booking_url}}`: the offer's link, else `booking.default_url`, with the
   * person's hidden booking code on Calendly and Cal.com links (only resolved for messages
   * that use the variable).
   */
  bookingUrl: string | null;
}

const BOOKING_URL_VARIABLE = /\{\{\s*booking_url\s*(?:\|[^}]*)?\}\}/;

/** Whether the message text uses `{{booking_url}}`. */
function usesBookingUrl(message: Message): boolean {
  return [message.subject, message.body_text, message.body_html].some(
    (text) => typeof text === "string" && BOOKING_URL_VARIABLE.test(text),
  );
}

/** Rows of a message the caller already read (the send gate), so they are not read again. */
export interface SendContextRows {
  person: Person | null;
  company: Company | null;
  campaign: Campaign | null;
  stepMode: "new_thread" | "reply" | null;
}

/** The message's person, company, campaign and step mode, read as the send job needs them. */
async function loadRows(
  ctx: OpContext,
  workspace: Workspace,
  message: Message,
): Promise<SendContextRows> {
  const [person] = message.person_id
    ? await ctx.db
        .select()
        .from(people)
        .where(and(eq(people.id, message.person_id), eq(people.workspace_id, workspace.id)))
        .limit(1)
    : [];
  const companyId = message.company_id ?? person?.company_id ?? null;
  const [company] = companyId
    ? await ctx.db
        .select()
        .from(companies)
        .where(and(eq(companies.id, companyId), eq(companies.workspace_id, workspace.id)))
        .limit(1)
    : [];
  const [campaign] = message.campaign_id
    ? await ctx.db
        .select()
        .from(campaigns)
        .where(and(eq(campaigns.id, message.campaign_id), eq(campaigns.workspace_id, workspace.id)))
        .limit(1)
    : [];
  let stepMode: SendContext["stepMode"] = null;
  if (message.step_id) {
    const [step] = await ctx.db
      .select()
      .from(campaign_steps)
      .where(
        and(eq(campaign_steps.id, message.step_id), eq(campaign_steps.workspace_id, workspace.id)),
      )
      .limit(1);
    if (step?.type === "email") {
      try {
        stepMode = parseStepConfig("email", step.config).mode;
      } catch {
        stepMode = null;
      }
    }
  }
  return {
    person: person ?? null,
    company: company ?? null,
    campaign: campaign ?? null,
    stepMode,
  };
}

/**
 * Everything needed to render and schedule one outbound message. `rows` are the message's
 * person, company, campaign and step mode when the caller already read them.
 */
export async function loadSendContext(
  ctx: OpContext,
  workspace: Workspace,
  message: Message,
  rows?: SendContextRows,
): Promise<SendContext> {
  const settings = parseWorkspaceSettings(workspace.settings);
  const { person, company, campaign, stepMode } = rows ?? (await loadRows(ctx, workspace, message));
  const [offer] = campaign?.offer_id
    ? await ctx.db
        .select({ name: offers.name, booking_url: offers.booking_url })
        .from(offers)
        .where(and(eq(offers.id, campaign.offer_id), eq(offers.workspace_id, workspace.id)))
        .limit(1)
    : [];
  // Only a message that uses the variable gives the person a booking code.
  const bookingUrl = usesBookingUrl(message)
    ? await resolveBookingLink(ctx, workspace, {
        personId: person?.id ?? null,
        offerUrl: offer?.booking_url ?? null,
        purpose: "template",
      })
    : (offer?.booking_url ?? null);
  return {
    workspace,
    settings,
    message,
    person,
    company,
    campaign,
    campaignSettings: campaign ? parseCampaignSettings(campaign.settings) : null,
    stepMode,
    offer: offer ?? null,
    bookingUrl,
  };
}

/** Template variables for a message (person, company, sender, offer, custom fields). */
export function templateVars(context: SendContext, mailbox: Mailbox): TemplateVars {
  const { person, company, offer } = context;
  return {
    first_name: person?.first_name ?? null,
    last_name: person?.last_name ?? null,
    company: company?.name ?? null,
    title: person?.title ?? null,
    city: person?.city ?? company?.city ?? null,
    sender_name: mailbox.from_name ?? null,
    offer: offer?.name ?? null,
    booking_url: context.bookingUrl,
    custom: person?.custom ?? {},
  };
}

/**
 * Footer for the recipient: with a never-expiring unsubscribe link when `link` (a public https
 * base URL, or a sandbox send), else a line asking to reply "unsubscribe".
 */
export function footerFor(
  ctx: OpContext,
  context: SendContext,
  recipient: string,
  options: { link: boolean },
): FooterContent {
  const url = options.link
    ? unsubscribeUrl(ctx.config, {
        messageId: context.message.id,
        workspaceId: context.workspace.id,
        email: recipient,
      })
    : null;
  return buildFooter(context.settings, {
    country: context.person?.country ?? context.company?.country ?? null,
    email: recipient,
    source: context.person?.source ?? null,
    unsubscribeUrl: url,
  });
}

/** Campaign schedule for the message, or an always-open schedule outside campaigns. */
export function scheduleFor(context: SendContext): CampaignSettings["schedule"] {
  return context.campaignSettings?.schedule ?? anytimeSchedule(context.workspace.timezone || "UTC");
}

/**
 * The zone the recipient's send window is read in, with the campaigns rule: fixed schedules use
 * their zone; lead schedules try the person's zone, the company's, then their countries.
 */
export function recipientZone(
  context: SendContext,
  schedule: CampaignSettings["schedule"] = scheduleFor(context),
): string {
  return recipientTimeZone(
    schedule,
    context.person ?? { timezone: null, country: null },
    context.company,
  );
}
