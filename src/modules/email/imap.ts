import { ImapFlow, type ListResponse } from "imapflow";
import type { MailAuth } from "./credentials.js";
import { isLoopbackHost } from "./smtp-transport.js";

/** First sync of a folder (or after a UIDVALIDITY change): the last 3 days. */
export const FIRST_SYNC_LOOKBACK_MS = 3 * 86_400_000;
/** Messages read per folder and sync. */
export const MAX_PER_FOLDER = 200;
/** Larger message sources are cut at this size. */
export const MAX_SOURCE_BYTES = 5_000_000;

export interface ImapSettings {
  host: string;
  port: number;
  /** true = implicit TLS (993); false = STARTTLS (required unless the host is loopback). */
  secure: boolean;
  auth: MailAuth;
}

/** An imapflow client with TLS verification on and no logging of protocol traffic. */
export function createImapClient(settings: ImapSettings): ImapFlow {
  const auth =
    settings.auth.kind === "password"
      ? { user: settings.auth.user, pass: settings.auth.pass }
      : { user: settings.auth.user, accessToken: settings.auth.accessToken };
  return new ImapFlow({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    ...(!settings.secure && !isLoopbackHost(settings.host) ? { doSTARTTLS: true } : {}),
    auth,
    logger: false,
    disableAutoIdle: true,
    tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
    connectionTimeout: 30_000,
    greetingTimeout: 16_000,
    socketTimeout: 120_000,
    clientInfo: { name: "OpenOutbound" },
  });
}

/** Connects, logs in and logs out (mailbox tests). */
export async function verifyImap(settings: ImapSettings): Promise<void> {
  const client = createImapClient(settings);
  await client.connect();
  await client.logout().catch(() => client.close());
}

/** True when an imapflow error means the login itself was refused. */
export function isImapAuthError(error: unknown): boolean {
  const e = error as {
    authenticationFailed?: unknown;
    serverResponseCode?: unknown;
    responseText?: unknown;
  };
  return (
    e?.authenticationFailed === true ||
    e?.serverResponseCode === "AUTHENTICATIONFAILED" ||
    /authenticat|invalid credentials|login failed/i.test(String(e?.responseText ?? ""))
  );
}

/** Leaf names of Sent folders, most common first (English, then a few other languages). */
const SENT_NAMES = [
  "sent",
  "sent items",
  "sent mail",
  "sent messages",
  "sent-mail",
  "gesendet",
  "gesendete elemente",
  "gesendete objekte",
  "envoyés",
  "messages envoyés",
  "éléments envoyés",
  "enviados",
  "elementos enviados",
  "posta inviata",
  "verzonden items",
  "verzonden",
];

/**
 * The Sent folder: the one with special-use `\Sent`, else the first common name (`Sent`,
 * `Sent Items`, `Sent Mail`, `Sent Messages`, matched on the leaf so `[Gmail]/Sent Mail` and
 * `INBOX.Sent` count). Null when there is none.
 */
export function findSentFolder(list: ListResponse[]): string | null {
  const selectable = list.filter(
    (entry) => !entry.flags.has("\\Noselect") && !entry.flags.has("\\NonExistent"),
  );
  const special = selectable.find((entry) => entry.specialUse === "\\Sent");
  if (special) return special.path;
  for (const name of SENT_NAMES) {
    const match = selectable.find((entry) => entry.name.trim().toLowerCase() === name);
    if (match) return match.path;
  }
  return null;
}

export interface SyncFolder {
  path: string;
  kind: "inbox" | "junk";
}

const JUNK_NAMES =
  /^(spam|junk|junk e-?mail|junk-e-mail|bulk mail|spamverdacht|courrier ind(é|e)sirable|correo no deseado)$/i;

/** INBOX plus spam/junk folders (special-use `\Junk`, else common names). */
export function foldersToSync(list: ListResponse[]): SyncFolder[] {
  const folders: SyncFolder[] = [];
  const inbox = list.find(
    (entry) => entry.specialUse === "\\Inbox" || entry.path.toUpperCase() === "INBOX",
  );
  folders.push({ path: inbox?.path ?? "INBOX", kind: "inbox" });
  for (const entry of list) {
    if (entry.flags.has("\\Noselect")) continue;
    if (entry.specialUse === "\\Junk" || JUNK_NAMES.test(entry.name)) {
      if (!folders.some((folder) => folder.path === entry.path))
        folders.push({ path: entry.path, kind: "junk" });
    }
  }
  return folders;
}
