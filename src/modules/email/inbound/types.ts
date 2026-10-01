/** One inbound email as the single inbound path receives it (IMAP sync, sandbox, tests). */
export interface InboundEmail {
  mailboxId: string;
  /** Sender, `Name <address>` or a bare address. */
  from: string;
  to: string[];
  /** Cc addresses (lowercase), when known. */
  cc?: string[];
  subject: string;
  text: string;
  html?: string;
  /** Header name (any case) -> value. */
  headers: Record<string, string>;
  messageIdHeader?: string;
  inReplyTo?: string;
  references?: string[];
  receivedAt: Date;
  /**
   * Full RFC 5322 source when available (IMAP sync). Optional; lets bounce parsing read the
   * delivery-status part and the original message headers precisely.
   */
  raw?: string;
}

export interface IngestResult {
  /** Stored (or affected) message id; "" when nothing was stored (warmup, ignored mail). */
  messageId: string;
  threadId: string | null;
  kind: "reply" | "bounce" | "auto_reply" | "warmup" | "unsubscribe" | "unmatched";
}
