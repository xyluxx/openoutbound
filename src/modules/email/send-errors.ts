import { isOpenOutboundError } from "../../core/errors.js";
import { failureOf } from "../../core/failures.js";

/**
 * What a failed send means for the message and the mailbox:
 * - auth: the mailbox cannot log in (bad password, revoked OAuth) -> mailbox `error`
 * - config: wrong server settings or TLS failure -> mailbox `error`
 * - temporary: 4xx or network trouble -> retry with backoff
 * - recipient: the address does not exist (5.1.x, 5.2.1) -> hard bounce
 * - blocked: the provider rejects the sender (authentication or spam-rate codes) -> pause mailbox
 * - throttled: the provider rate-limits the sender -> no more sends from it until tomorrow
 * - permanent: other 5xx for this message -> message `failed`
 */
export type SendFailureKind =
  | "auth"
  | "config"
  | "temporary"
  | "recipient"
  | "blocked"
  | "throttled"
  | "permanent";

export interface SendFailure {
  kind: SendFailureKind;
  /** Short text for messages.error and events (no secrets). */
  message: string;
  responseCode: number | null;
  /** Enhanced status code, e.g. "5.1.1". */
  status: string | null;
}

interface ErrorLike {
  code?: unknown;
  responseCode?: unknown;
  response?: unknown;
  message?: unknown;
  command?: unknown;
  syscall?: unknown;
}

const ENHANCED_STATUS = /\b([245])\.(\d{1,3})\.(\d{1,3})\b/;
/** Gmail and Microsoft sender-authentication and unsolicited-rate rejections (playbook 8). */
export const SENDER_BLOCK_STATUSES = new Set([
  "5.7.26",
  "5.7.27",
  "5.7.30",
  "5.7.32",
  "5.7.515",
  "4.7.28",
  "5.7.28",
]);
const NETWORK_CODES = new Set([
  "ECONNECTION",
  "ETIMEDOUT",
  "ESOCKET",
  "EDNS",
  "ECONNRESET",
  "ECONNREFUSED",
  "EPROTOCOL",
  "EMAXLIMIT",
]);

const THROTTLE_TEXT =
  /rate.?limit|too many (messages|emails|mails|connections|recipients)|sending limit|sending quota|daily (user )?sending|quota exceeded|limit exceeded|exceeded the (configured )?limit|submission rate|throttl|slow down/i;

/**
 * Provider throttling: 421 4.7.0, 451 4.7.x, 452, or a rate/quota text on a 4xx or policy 5xx
 * (e.g. 550 5.7.1 "rate limited", 550 5.4.5 "daily sending limit exceeded").
 */
function isThrottle(responseCode: number | null, status: string | null, text: string): boolean {
  // A full recipient mailbox ("over quota") is about that address, not about our sender.
  if (status === "4.2.2" || status === "5.2.2") return false;
  if (responseCode === 421 && status === "4.7.0") return true;
  if (responseCode === 451 && status?.startsWith("4.7.")) return true;
  if (responseCode === 452) return true;
  if (!THROTTLE_TEXT.test(text)) return false;
  return (
    (responseCode !== null && responseCode >= 400 && responseCode < 500) ||
    status === "5.7.1" ||
    status === "5.4.5" ||
    status === "5.2.0" ||
    responseCode === 550 ||
    responseCode === 554
  );
}

export function enhancedStatus(text: string | null | undefined): string | null {
  const match = text?.match(ENHANCED_STATUS);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

/**
 * How a rejection of our sender (not of the address) lands on the sending mailbox:
 * - blocked: authentication or unsolicited-rate codes (SENDER_BLOCK_STATUSES) -> domain pause
 * - throttled: the provider rate-limits the sender -> no sends from it until tomorrow
 * - rejected: reputation, blocklists, policy, other authentication results -> a send failure
 */
export type SenderRejectionKind = "blocked" | "throttled" | "rejected";

/** Our own address or domain was refused (x.1.7 bad sender address, x.1.8 bad sender domain). */
const SENDER_ADDRESS_STATUSES = new Set(["4.1.7", "4.1.8", "5.1.7", "5.1.8"]);
const SENDER_ADDRESS_TEXT =
  /sender address rejected|sender (address|domain) (unknown|not found|invalid)|from address .{0,20}(rejected|invalid)/i;
/** Microsoft's recipient codes (RESOLVER.ADR: unknown address, RESOLVER.RST: restricted mailbox). */
const RECIPIENT_RESOLVER = /resolver\.(adr|rst)\./i;
/** The mailbox or domain changed owner (RFC 7293): about the recipient. */
const RECIPIENT_POLICY_STATUSES = new Set(["5.7.17", "5.7.18", "5.7.19"]);
/** Server answers that blame our sender: authentication, blocklists, reputation, spam. */
const SENDER_TEXT =
  /\b(spf|dkim|dmarc|ptr|rdns|rbl|dnsbl)\b|unauthenticated|not authenticated|authentication (fail|check|level)|reverse dns|block ?list|black ?list|blocked using|listed (at|in|on|by)|spamhaus|spamcop|barracuda|reputation|unsolicited|\bspam\b|banned (sender|sending)|sending ip|\byour ip\b|client host .{0,80}(blocked|rejected)/i;
/** Server answers about the address or the mailbox itself. */
const RECIPIENT_TEXT =
  /\b(user|mailbox|recipient|address|account)\b[^.;]{0,40}\b(unknown|not exist|does not exist|doesn't exist|not found|invalid|unavailable|disabled|inactive|deactivated|suspended|no longer|rejected)|no such (user|mailbox|recipient|address|account|domain)|unknown (user|recipient|mailbox|address)|user (unknown|not found)|(host|domain)( or domain name)? not found|unrouteable/i;

/**
 * Whether a rejection (a DSN or an SMTP answer) is about our sender rather than the recipient's
 * address, and how the mailbox takes it (see SenderRejectionKind). Null means the address or
 * mailbox itself failed (unknown user, disabled or full mailbox, no such domain): that counts
 * against the recipient. Security and policy codes (x.7.x) blame the sender unless the answer
 * names the recipient (an address rejected, a restricted mailbox).
 */
export function senderRejection(
  responseCode: number | null,
  status: string | null,
  text: string | null,
): SenderRejectionKind | null {
  const answer = (text ?? "").replace(/\s+/g, " ");
  if (status && SENDER_BLOCK_STATUSES.has(status)) return "blocked";
  if (isThrottle(responseCode, status, answer)) return "throttled";
  if ((status && SENDER_ADDRESS_STATUSES.has(status)) || SENDER_ADDRESS_TEXT.test(answer)) {
    return "rejected";
  }
  const [, subject, detail] = status?.split(".") ?? [];
  // Address (x.1.x) and mailbox (x.2.x) status, no route to the recipient's domain (x.4.4).
  if (subject === "1" || subject === "2" || (subject === "4" && detail === "4")) return null;
  if (RECIPIENT_RESOLVER.test(answer)) return null;
  if (SENDER_TEXT.test(answer)) return "rejected";
  if (RECIPIENT_TEXT.test(answer) || (status && RECIPIENT_POLICY_STATUSES.has(status))) {
    return null;
  }
  return subject === "7" ? "rejected" : null;
}

/**
 * Classifies an SMTP (nodemailer) error or a per-recipient rejection. Engine errors come from
 * before the SMTP session (settings, the vault, an OAuth token refresh): `details.reason` "auth"
 * or "config" from the email module, else the provider failure (`failureOf`): rejected or
 * revoked credentials and missing permissions are login problems, the rest passes.
 */
export function classifySendError(error: unknown): SendFailure {
  if (isOpenOutboundError(error)) {
    const reason = (error.details as { reason?: unknown } | undefined)?.reason;
    const failure = failureOf(error);
    const kind: SendFailureKind =
      reason === "auth" || failure?.class === "auth_invalid" || failure?.class === "forbidden"
        ? "auth"
        : reason === "config"
          ? "config"
          : "temporary";
    return { kind, message: error.message, responseCode: null, status: null };
  }
  const e = (error ?? {}) as ErrorLike;
  const code = typeof e.code === "string" ? e.code : "";
  const responseCode = typeof e.responseCode === "number" ? e.responseCode : null;
  const response = typeof e.response === "string" ? e.response : "";
  const text = (
    response ||
    (typeof e.message === "string" ? e.message : "") ||
    "Unknown SMTP error"
  )
    .replace(/\s+/g, " ")
    .slice(0, 300);
  const status = enhancedStatus(response || text);
  const failure = (kind: SendFailureKind): SendFailure => ({
    kind,
    message: text,
    responseCode,
    status,
  });

  if (code === "EAUTH" || code === "ENOAUTH" || code === "EOAUTH2") return failure("auth");
  if (
    responseCode === 535 ||
    responseCode === 534 ||
    (responseCode === 530 && status === "5.7.0")
  ) {
    return failure("auth");
  }
  if (code === "ETLS" || code === "ECONFIG" || code === "EREQUIRETLS") return failure("config");
  if (status && SENDER_BLOCK_STATUSES.has(status)) return failure("blocked");
  if (isThrottle(responseCode, status, text)) return failure("throttled");
  if (responseCode !== null && responseCode >= 400 && responseCode < 500)
    return failure("temporary");
  if (status?.startsWith("4.")) return failure("temporary");
  if (responseCode !== null && responseCode >= 500) {
    if (status && (status.startsWith("5.1.") || status === "5.2.1")) return failure("recipient");
    if (
      !status &&
      (responseCode === 550 || responseCode === 551 || responseCode === 553) &&
      /(user|mailbox|recipient|address).{0,40}(unknown|not exist|not found|invalid|unavailable)/i.test(
        text,
      )
    ) {
      return failure("recipient");
    }
    return failure("permanent");
  }
  if (NETWORK_CODES.has(code)) return failure("temporary");
  return failure("temporary");
}

/**
 * A send the engine stopped itself (smtp-transport.ts): its deadline ran out or its job ended,
 * and its connection was closed. `dataStarted` says whether the DATA command had gone out: from
 * then on the message may have been delivered.
 */
export class StoppedSendError extends Error {
  readonly code = "ETIMEDOUT";
  readonly dataStarted: boolean;

  constructor(message: string, dataStarted: boolean) {
    super(message);
    this.name = "StoppedSendError";
    this.dataStarted = dataStarted;
  }
}

/**
 * Where a failed send stopped in the SMTP conversation, read from nodemailer's `err.command`
 * and error codes (or from a send the engine stopped itself):
 * - before_data: nothing was handed over yet (DNS, connect, TLS, greeting, login, MAIL FROM,
 *   RCPT TO, or a check in the client before anything was sent)
 * - data: the message data was being sent, or was sent and the answer never came
 * - unknown: a timeout, reset or socket error that can happen at any step
 */
export type SendPhase = "before_data" | "data" | "unknown";

/** Commands nodemailer names for steps before the message data (`CONN` is any socket step). */
const BEFORE_DATA_COMMAND = /^(API|EHLO|HELO|LHLO|STARTTLS|AUTH( .*)?|MAIL FROM|RCPT TO|RSET)$/;
/** Socket errors that can only happen while connecting. */
const CONNECT_ERROR =
  /\b(ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EHOSTDOWN|ENOTFOUND|EAI_AGAIN|EADDRNOTAVAIL)\b|getaddrinfo/i;

export function sendPhase(error: unknown): SendPhase {
  if (error instanceof StoppedSendError) return error.dataStarted ? "data" : "before_data";
  if (isOpenOutboundError(error)) return "before_data";
  const e = (error ?? {}) as ErrorLike;
  const command = typeof e.command === "string" ? e.command.trim().toUpperCase() : "";
  const code = typeof e.code === "string" ? e.code : "";
  const message = typeof e.message === "string" ? e.message : "";
  if (command === "DATA") return "data";
  if (BEFORE_DATA_COMMAND.test(command)) return "before_data";
  // Socket trouble is reported as "CONN" at every step, so only failures that can only happen
  // while connecting count as before the data.
  if (code === "EDNS" || code === "ETLS") return "before_data";
  if (e.syscall === "connect" || CONNECT_ERROR.test(message)) return "before_data";
  if (code === "ETIMEDOUT" && /greeting never received|connection timeout/i.test(message)) {
    return "before_data";
  }
  if (code === "EPROTOCOL" && /invalid greeting/i.test(message)) return "before_data";
  return "unknown";
}

/**
 * True when a failed send may still have been delivered, so a retry could send it twice: no
 * server answer refused it, and it did not provably stop before the message data. A 4xx or 5xx
 * answer always means the server did not take the message, and a message stream that broke
 * before its end is discarded by the server.
 */
export function isDeliveryUncertain(error: unknown): boolean {
  if (isOpenOutboundError(error)) return false;
  const e = (error ?? {}) as ErrorLike;
  if (typeof e.responseCode === "number" && e.responseCode >= 400) return false;
  if (e.code === "ESTREAM") return false;
  return sendPhase(error) !== "before_data";
}
