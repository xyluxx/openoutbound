import { enhancedStatus, type SenderRejectionKind, senderRejection } from "../send-errors.js";
import { type HeaderMap, localPart, normalizeMessageId, parseAddress } from "./headers.js";

/** A parsed delivery status notification (RFC 3464) or a legacy bounce. */
export interface BounceReport {
  /** failed, delayed, delivered, relayed, expanded (lowercase), or null when not stated. */
  action: string | null;
  /** Enhanced status code, e.g. "5.1.1". */
  status: string | null;
  /** SMTP reply code of the remote server's answer, e.g. 550. */
  responseCode: number | null;
  bounceType: "hard" | "soft";
  /**
   * Set when the server refused our sender (authentication, reputation, policy, rate limits)
   * rather than the address: the bounce then goes to the mailbox's health, never to the
   * recipient's record (see `senderRejection`).
   */
  senderRejection: SenderRejectionKind | null;
  /** The address that failed. */
  recipient: string | null;
  diagnostic: string | null;
  /** Message-ID of the message that bounced, with angle brackets. */
  originalMessageId: string | null;
}

const BOUNCE_SENDERS = new Set(["mailer-daemon", "postmaster", "mail-daemon", "mailerdaemon"]);
const BOUNCE_SUBJECT =
  /undeliver(able|ed)|delivery status notification|mail delivery (failed|failure|subsystem)|returned mail|delivery (has )?fail|failure notice|non[- ]?delivery|could not be delivered|nicht zustellbar|unzustellbar|non remis|non distribuable|no se (pudo|puede) entregar|no entregado/i;
/**
 * 5.x.x codes that do not mean "this address is bad": mailbox full (5.2.2) and message too big
 * (5.2.3 for the recipient's mailbox, 5.3.4 for the server).
 */
const SOFT_PERMANENT = new Set(["5.2.2", "5.2.3", "5.3.4"]);

interface DsnSource {
  from: string;
  subject: string;
  headers: HeaderMap;
  text: string;
  raw?: string | undefined;
}

/** True when the message is a DSN or looks like a bounce from a mailer daemon. */
export function isBounce(input: DsnSource): boolean {
  const contentType = input.headers["content-type"] ?? "";
  if (
    /multipart\/report/i.test(contentType) &&
    /report-type\s*=\s*"?delivery-status/i.test(contentType)
  ) {
    return true;
  }
  const sender = localPart(parseAddress(input.from) || parseAddress(input.headers["return-path"]));
  const fromDaemon = BOUNCE_SENDERS.has(sender) || /mailer-daemon|postmaster/i.test(input.from);
  if (!fromDaemon) return false;
  return (
    BOUNCE_SUBJECT.test(input.subject) ||
    /^\s*status:\s*[45]\.\d+\.\d+/im.test(input.text) ||
    /^\s*action:\s*failed/im.test(input.text)
  );
}

/** Unfolds header-style continuation lines ("Diagnostic-Code: ...\n    more"). */
function unfold(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\n[ \t]+/g, " ");
}

function field(text: string, name: string): string | null {
  const match = text.match(new RegExp(`^\\s*${name}\\s*:\\s*(.+)$`, "im"));
  return match?.[1]?.trim() ?? null;
}

/** Body part of a raw message (everything after the top-level header block). */
function bodyOf(raw: string): string {
  const normalized = raw.replace(/\r\n/g, "\n");
  const split = normalized.indexOf("\n\n");
  return split === -1 ? "" : normalized.slice(split + 2);
}

/** The line of `text` around `index`, at most 300 characters. */
function lineAt(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end === -1 ? undefined : end).slice(0, 300);
}

/**
 * Parses a bounce: delivery-status fields (from the raw source when available, else the text
 * mailparser produced, which includes the delivery-status part), the failed recipient and the
 * Message-ID of the original message. Hard = 5.x.x (except mailbox full and message too big),
 * soft = 4.x.x or unknown.
 * `senderRejection` reads only the remote server's answer (the Diagnostic-Code, or the line with
 * the reply code in legacy bounces), never the quoted original message.
 */
export function parseBounce(input: DsnSource): BounceReport {
  const source = unfold(input.raw ? bodyOf(input.raw) : input.text);
  const action = field(source, "Action")?.toLowerCase().split(/\s/)[0] ?? null;
  const statusField = field(source, "Status");
  const diagnostic = field(source, "Diagnostic-Code")?.replace(/^smtp\s*;\s*/i, "") ?? null;
  const recipientField = field(source, "Final-Recipient") ?? field(source, "Original-Recipient");
  let status = enhancedStatus(statusField) ?? enhancedStatus(diagnostic);
  let answer = diagnostic;
  if (!status) {
    // Legacy bounces (qmail "failure notice", Exchange text): an SMTP reply code in the text.
    const legacy = source.match(/\b([45])\d\d[ -]((\d)\.\d{1,3}\.\d{1,3})?/);
    if (legacy) {
      status = legacy[2] ?? `${legacy[1]}.0.0`;
      answer ??= lineAt(source, legacy.index ?? 0);
    }
  }
  const code = answer?.match(/\b([245]\d\d)[ -]/)?.[1];
  const responseCode = code ? Number(code) : null;
  const recipient =
    parseAddress(recipientField?.replace(/^rfc822\s*;/i, "")) ||
    parseAddress(input.headers["x-failed-recipients"]) ||
    null;

  let originalMessageId: string | null = null;
  const originalIdMatch =
    source.match(/^\s*(?:X-)?Original-Message-ID\s*:\s*(<[^>\s]+>)/im) ??
    source.match(/^\s*Message-ID\s*:\s*(<[^>\s]+>)/im);
  if (originalIdMatch?.[1]) originalMessageId = normalizeMessageId(originalIdMatch[1]);
  const ownId = normalizeMessageId(input.headers["message-id"]);
  if (originalMessageId && originalMessageId === ownId) originalMessageId = null;

  let bounceType: "hard" | "soft" = "soft";
  if (status?.startsWith("5.") && !SOFT_PERMANENT.has(status)) bounceType = "hard";
  if (action === "delayed") bounceType = "soft";

  return {
    action,
    status,
    responseCode,
    bounceType,
    senderRejection: senderRejection(responseCode, status, answer),
    recipient,
    diagnostic,
    originalMessageId,
  };
}
