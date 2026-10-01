import { type AddressObject, simpleParser } from "mailparser";
import { htmlToText } from "../../../lib/web/extract.js";
import type { InboundEmail } from "./types.js";

const MAX_RAW = 2_000_000;

function addresses(value: AddressObject | AddressObject[] | undefined): string[] {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list.flatMap((entry) =>
    entry.value.flatMap((address) => [
      ...(address.address ? [address.address.toLowerCase()] : []),
      ...(address.group ?? []).map((member) => member.address?.toLowerCase() ?? "").filter(Boolean),
    ]),
  );
}

/**
 * Parses an RFC 5322 message (IMAP source) into the inbound path's shape. Header names keep
 * their first occurrence; `raw` is kept (capped) so bounce parsing can read the report parts.
 */
export async function parseRawEmail(
  source: Buffer | string,
  mailboxId: string,
  receivedAt: Date,
): Promise<InboundEmail> {
  const buffer = typeof source === "string" ? Buffer.from(source, "utf8") : source;
  const parsed = await simpleParser(buffer, {
    skipImageLinks: true,
    skipTextToHtml: true,
    maxHtmlLengthToParse: 2_000_000,
  });
  const headers: Record<string, string> = {};
  for (const line of parsed.headerLines) {
    const key = line.key.toLowerCase();
    if (headers[key] !== undefined) continue;
    const colon = line.line.indexOf(":");
    headers[key] = (colon === -1 ? "" : line.line.slice(colon + 1))
      .replace(/\r?\n[ \t]+/g, " ")
      .trim();
  }
  const html = typeof parsed.html === "string" ? parsed.html : undefined;
  const text = parsed.text ?? (html ? htmlToText(html).text : "");
  const references = Array.isArray(parsed.references)
    ? parsed.references
    : parsed.references
      ? parsed.references.split(/\s+/).filter(Boolean)
      : [];
  const email: InboundEmail = {
    mailboxId,
    from: parsed.from?.text ?? headers.from ?? "",
    to: addresses(parsed.to),
    subject: parsed.subject ?? "",
    text,
    headers,
    references,
    receivedAt,
    raw: buffer.subarray(0, MAX_RAW).toString("utf8"),
  };
  const cc = addresses(parsed.cc);
  if (cc.length > 0) email.cc = cc;
  if (html) email.html = html;
  if (parsed.messageId) email.messageIdHeader = parsed.messageId;
  if (parsed.inReplyTo) email.inReplyTo = parsed.inReplyTo;
  return email;
}
