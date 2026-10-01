import type { Clock } from "../../core/clock.js";
import { buildRawMessage, type OutgoingEmail } from "./compose.js";
import type { EmailTransport, SendResult } from "./transport.js";

/** One email "sent" by the sandbox transport. */
export interface SandboxOutboxEntry {
  mailboxId: string;
  workspaceId: string;
  email: OutgoingEmail;
  /** RFC 5322 source, exactly as SMTP would have sent it. */
  raw: string;
  sentAt: Date;
  queueId: string;
}

const MAX_ENTRIES = 1000;
const outbox: SandboxOutboxEntry[] = [];
let sequence = 0;

/**
 * Recipients whose local part is `bounce`, `bounce+...` or `bounce.<...>` are rejected with a
 * hard bounce (550 5.1.1), so sandbox runs and tests can exercise the bounce path.
 */
export function isSandboxBounceAddress(address: string): boolean {
  const local = address.slice(0, address.lastIndexOf("@")).toLowerCase();
  return /^bounce([+._-]|$)/.test(local);
}

/** Emails sent through the sandbox transport in this process (newest last). */
export function getSandboxOutbox(filter: { workspaceId?: string; mailboxId?: string } = {}) {
  return outbox.filter(
    (entry) =>
      (!filter.workspaceId || entry.workspaceId === filter.workspaceId) &&
      (!filter.mailboxId || entry.mailboxId === filter.mailboxId),
  );
}

export function clearSandboxOutbox(): void {
  outbox.length = 0;
}

/** Transport that writes to an in-memory outbox and never opens a socket. */
export function sandboxTransport(input: {
  mailboxId: string;
  workspaceId: string;
  clock: Clock;
}): EmailTransport {
  return {
    kind: "sandbox",
    async send(email): Promise<SendResult> {
      const rejected = email.to.filter(isSandboxBounceAddress);
      const accepted = email.to.filter((address) => !rejected.includes(address));
      const rejectedErrors = rejected.map((recipient) => ({
        recipient,
        responseCode: 550,
        response: "550 5.1.1 The email account that you tried to reach does not exist (sandbox)",
      }));
      if (accepted.length === 0) {
        return { providerMessageId: null, accepted, rejected, rejectedErrors, response: null };
      }
      sequence += 1;
      const queueId = `sandbox-${sequence}`;
      outbox.push({
        mailboxId: input.mailboxId,
        workspaceId: input.workspaceId,
        email,
        raw: await buildRawMessage(email),
        sentAt: input.clock.now(),
        queueId,
      });
      if (outbox.length > MAX_ENTRIES) outbox.splice(0, outbox.length - MAX_ENTRIES);
      return {
        providerMessageId: queueId,
        accepted,
        rejected,
        rejectedErrors,
        response: `250 2.0.0 Ok: queued as ${queueId}`,
      };
    },
    async verify() {},
  };
}
