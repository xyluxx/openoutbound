/**
 * How CRM notes read: one headline per activity kind ("Email sent: <subject>") and the plain
 * text body. Plain text goes to webhooks and older note hooks; HubSpot and Pipedrive notes are
 * HTML, so every piece of text is escaped first (text from emails never becomes markup).
 */
import type { CrmActivity } from "../types.js";

/** Longest note body the engine sends; longer text is cut. */
export const ACTIVITY_BODY_MAX = 2000;
const SUBJECT_MAX = 200;

const PREFIX: Record<CrmActivity["kind"], string> = {
  email_sent: "Email sent",
  email_received: "Email received",
  reply: "Reply",
  meeting: "Meeting",
  note: "Note",
};

/** Cuts text to `max` characters, ending with "..." when something was cut. */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

/** "Email sent: Quick question", or "(no subject)" when there is none. */
export function activityHeadline(entry: Pick<CrmActivity, "kind" | "subject">): string {
  const subject = entry.subject?.replace(/\s+/g, " ").trim();
  return `${PREFIX[entry.kind]}: ${subject ? truncateText(subject, SUBJECT_MAX) : "(no subject)"}`;
}

/** The body with normalized line breaks, cut to 2000 characters; null when blank. */
export function activityBody(entry: Pick<CrmActivity, "body">): string | null {
  const body = entry.body
    ?.replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return body ? truncateText(body, ACTIVITY_BODY_MAX) : null;
}

/** Plain text: the headline, a blank line, then the body. */
export function activityText(entry: Pick<CrmActivity, "kind" | "subject" | "body">): string {
  const body = activityBody(entry);
  return body ? `${activityHeadline(entry)}\n\n${body}` : activityHeadline(entry);
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Note HTML: the escaped headline in bold, then the escaped body with `<br>` line breaks. */
export function activityHtml(entry: Pick<CrmActivity, "kind" | "subject" | "body">): string {
  const head = `<p><strong>${escapeHtml(activityHeadline(entry))}</strong></p>`;
  const body = activityBody(entry);
  return body ? `${head}<p>${body.split("\n").map(escapeHtml).join("<br>")}</p>` : head;
}
