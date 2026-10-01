/**
 * A local SMTP server (127.0.0.1 only) for the acceptance scenarios that need a real mail server
 * conversation: a connection that drops after the message data, a refused login. Scenarios
 * decide what the next deliveries meet; everything the server takes in is kept in `received`.
 * The mailbox's Sent folder is the in-memory IMAP fake (`fakeImap`), which the scenario files
 * wire with `vi.mock("imapflow", ...)`.
 */
import type { AddressInfo } from "node:net";
import { SMTPServer } from "smtp-server";
import type { Mailbox } from "../../../src/db/schema/index.js";
import { storePasswords } from "../../../src/modules/email/credentials.js";
import { closeSmtpPools } from "../../../src/modules/email/smtp-transport.js";
import { seedMailbox } from "../../../src/testing/factories.js";
import type { FakeImapFolder, FakeImapMessage } from "../../../src/testing/fake-imap.js";
import type { World } from "./support.js";

/** The password the server accepts. */
export const MAIL_PASSWORD = "right-password";

export interface Received {
  from: string;
  to: string[];
  /** The message source as the server got it. */
  raw: string;
  messageId: string | null;
  /** The connection dropped after the data, before the server answered. */
  dropped: boolean;
}

export interface MailServer {
  port: number;
  received: Received[];
  /** How many of the next deliveries lose their connection after the data. */
  dropNext: number;
  close(): Promise<void>;
}

/** A header value, unfolded (long headers continue on indented lines). */
function headerOf(raw: string, name: string): string | null {
  const match = raw.match(new RegExp(`^${name}:[ \\t]*(.*(?:\\r?\\n[ \\t].*)*)`, "im"));
  return (
    match?.[1]
      ?.replace(/\r?\n[ \t]+/g, " ")
      .replace(/\r/g, "")
      .trim() ?? null
  );
}

/** Starts the server on a free local port. */
export async function startMailServer(): Promise<MailServer> {
  const state: MailServer = {
    port: 0,
    received: [],
    dropNext: 0,
    close: async () => {},
  };
  const server = new SMTPServer({
    logger: false,
    disabledCommands: ["STARTTLS"],
    allowInsecureAuth: true,
    onAuth(auth, _session, callback) {
      if (auth.password !== MAIL_PASSWORD) {
        callback(
          Object.assign(new Error("5.7.8 Authentication credentials invalid"), {
            responseCode: 535,
          }),
        );
        return;
      }
      callback(null, { user: auth.username });
    },
    onData(stream, session, callback) {
      let raw = "";
      stream.on("data", (chunk: Buffer) => {
        raw += chunk.toString("utf8");
      });
      stream.on("end", () => {
        const dropped = state.dropNext > 0;
        state.received.push({
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "",
          to: session.envelope.rcptTo.map((rcpt) => rcpt.address),
          raw,
          messageId: headerOf(raw, "Message-ID"),
          dropped,
        });
        if (!dropped) {
          callback(null, "Ok: queued as ACCEPTANCE1");
          return;
        }
        // The data arrived, then the connection died before the server's answer.
        state.dropNext -= 1;
        const { connections } = server as unknown as {
          connections: Set<{ id: string; _socket: { destroy(): void } }>;
        };
        for (const connection of connections) {
          if (connection.id === session.id) connection._socket.destroy();
        }
      });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.port = (server.server.address() as AddressInfo).port;
  state.close = async () => {
    closeSmtpPools();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return state;
}

/**
 * A password mailbox of the world's workspace on the local server, with an IMAP server (the
 * in-memory fake) for its Sent folder.
 */
export async function addSmtpMailbox(
  world: World,
  server: MailServer,
  options: {
    email: string;
    fromName?: string;
    password?: string;
    /** When the engine first found one of its own emails in the Sent folder (the proof). */
    sentCopiesSeenAt?: Date | null;
  },
): Promise<Mailbox> {
  const ctx = await world.context();
  const secretId = await storePasswords(
    ctx,
    world.workspaceId,
    options.email,
    options.password ?? MAIL_PASSWORD,
  );
  return seedMailbox(world.target, {
    email: options.email,
    from_name: options.fromName ?? "Alex Rivera",
    provider_label: "custom",
    auth_type: "password",
    secret_id: secretId,
    smtp: { host: "127.0.0.1", port: server.port, secure: false, user: options.email },
    imap: {
      host: "imap.brightline-answering.example.org",
      port: 993,
      secure: true,
      user: options.email,
    },
    sent_copies_seen_at: options.sentCopiesSeenAt ?? null,
    daily_limit: 40,
    ramp: null,
    min_gap_seconds: 60,
    max_gap_seconds: 120,
  });
}

/** INBOX and Sent folders for the IMAP fake, the Sent folder holding `sent`. */
export function mailFolders(sent: FakeImapMessage[] = [], inbox: FakeImapMessage[] = []) {
  const folders: FakeImapFolder[] = [
    {
      path: "INBOX",
      name: "INBOX",
      specialUse: "\\Inbox",
      flags: [],
      uidValidity: 7n,
      messages: inbox,
    },
    {
      path: "Sent",
      name: "Sent",
      specialUse: "\\Sent",
      flags: [],
      uidValidity: 5n,
      messages: sent,
    },
  ];
  return folders;
}

/** The copy of a received message that a server keeping sent copies files in the Sent folder. */
export function sentCopy(received: Received, uid: number, at: Date): FakeImapMessage {
  return { uid, internalDate: at, source: received.raw };
}
