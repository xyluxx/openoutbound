import { randomBytes } from "node:crypto";
import { domainToASCII } from "node:url";
import type { SendMailOptions } from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";

/** A fully rendered outgoing email, ready for a transport. */
export interface OutgoingEmail {
  from: { name: string | null; address: string };
  to: string[];
  subject: string;
  text: string;
  html?: string | null;
  /** RFC 5322 Message-ID with angle brackets, on the sending mailbox domain. */
  messageId: string;
  date: Date;
  inReplyTo?: string | null;
  references?: string[];
  /** Extra headers (List-Unsubscribe, List-Unsubscribe-Post). */
  headers: Record<string, string>;
}

/** Characters that turn one address into a list, a display name, a comment or a quoted part. */
const NOT_A_PLAIN_ADDRESS = /[\s,;<>()"[\]\\:]/;

/**
 * The recipient as exactly one plain address (lowercase), or null. Lists ("a@x, b@y"),
 * semicolons, display names ("Name <a@x>"), comments and quoted parts are refused: nodemailer
 * would turn them into several recipients, and the extra ones would skip the suppression and
 * contactability checks.
 */
export function singleRecipient(value: string | null | undefined): string | null {
  const address = (value ?? "").trim().toLowerCase();
  if (!address || address.length > 254 || NOT_A_PLAIN_ADDRESS.test(address)) return null;
  const at = address.indexOf("@");
  if (at <= 0 || at !== address.lastIndexOf("@")) return null;
  const domain = address.slice(at + 1);
  if (!domain.includes(".") || domain.startsWith(".") || domain.endsWith(".")) return null;
  if (domain.includes("..")) return null;
  return address;
}

/**
 * An address in the form two addresses are compared in: trimmed, lowercase, with the domain in
 * its ASCII (IDNA, punycode) form. A server can report the recipient it took in another case,
 * or with a Unicode domain in punycode; it is still the same address.
 */
export function comparableAddress(value: string | null | undefined): string {
  const address = (value ?? "").trim().toLowerCase();
  const at = address.lastIndexOf("@");
  if (at <= 0) return address;
  const domain = address.slice(at + 1);
  return `${address.slice(0, at)}@${domainToASCII(domain) || domain}`;
}

/** Whether two addresses are the same mailbox (see `comparableAddress`). */
export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = comparableAddress(a);
  return left !== "" && left === comparableAddress(b);
}

/** New Message-ID on the mailbox's domain: `<time.random@domain>`. */
export function newMessageIdHeader(fromAddress: string, now: Date): string {
  const domain = fromAddress.slice(fromAddress.lastIndexOf("@") + 1).toLowerCase() || "localhost";
  return `<${now.getTime().toString(36)}.${randomBytes(10).toString("hex")}@${domain}>`;
}

/**
 * List-Unsubscribe headers (RFC 2369 + RFC 8058): the HTTPS link and a mailto back to the
 * mailbox. `List-Unsubscribe-Post` is only added for https links, as RFC 8058 requires.
 */
export function unsubscribeHeaders(
  url: string | null,
  mailbox: string | null,
): Record<string, string> {
  const values: string[] = [];
  if (url) values.push(`<${url}>`);
  if (mailbox) values.push(`<mailto:${mailbox}?subject=unsubscribe>`);
  if (values.length === 0) return {};
  const headers: Record<string, string> = { "List-Unsubscribe": values.join(", ") };
  if (url?.startsWith("https://")) headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  return headers;
}

const REPLY_PREFIX = /^\s*((re|aw|sv|antw|r|rif|res|fw|fwd|wg)\s*(\[\d+\])?\s*:\s*)+/i;

/** `Re: <subject>` without stacking prefixes (`Re: Re:` or localized `AW:`). */
export function replySubject(subject: string | null | undefined): string {
  const base = (subject ?? "").replace(REPLY_PREFIX, "").trim();
  return base ? `Re: ${base}` : "Re:";
}

/** References chain: the root and the most recent ids, at most `max` entries, no duplicates. */
export function buildReferences(chain: readonly string[], max = 10): string[] {
  const unique = [...new Set(chain.filter(Boolean))];
  if (unique.length <= max) return unique;
  return [unique[0] as string, ...unique.slice(unique.length - (max - 1))];
}

/** nodemailer message options for an outgoing email (no X-Mailer, no Precedence header). */
export function toMailOptions(email: OutgoingEmail): SendMailOptions {
  const options: SendMailOptions = {
    from: email.from.name
      ? { name: email.from.name, address: email.from.address }
      : email.from.address,
    to: email.to,
    subject: email.subject,
    text: email.text,
    messageId: email.messageId,
    date: email.date,
    headers: email.headers,
  };
  if (email.html) options.html = email.html;
  if (email.inReplyTo) options.inReplyTo = email.inReplyTo;
  if (email.references && email.references.length > 0) options.references = email.references;
  return options;
}

/** The RFC 5322 source nodemailer would send (sandbox outbox, golden tests). */
export async function buildRawMessage(
  email: OutgoingEmail,
  options: { baseBoundary?: string } = {},
): Promise<string> {
  const composer = new MailComposer({
    ...toMailOptions(email),
    ...(options.baseBoundary ? { baseBoundary: options.baseBoundary } : {}),
  });
  const raw = await composer.compile().build();
  return raw.toString("utf8");
}
