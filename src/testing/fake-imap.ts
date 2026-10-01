/**
 * In-memory IMAP server for tests of the IMAP paths (INBOX sync, Sent folder, reconcile).
 * Tests wire it with
 * `vi.mock("imapflow", async () => (await import("../../testing/fake-imap.js")).fakeImapModule())`
 * and set `fakeImap.folders` (reset with `resetFakeImap()` before each test).
 */

export interface FakeImapMessage {
  uid: number;
  /** RFC 5322 source. */
  source: string;
  internalDate: Date;
}

export interface FakeImapFolder {
  path: string;
  name: string;
  specialUse?: string;
  flags: string[];
  uidValidity: bigint;
  messages: FakeImapMessage[];
}

export interface FakeImapState {
  folders: FakeImapFolder[];
  connectError: Error | null;
  /** Options each client was created with. */
  options: Array<Record<string, unknown>>;
  searches: Array<{ path: string; query: Record<string, unknown> }>;
  fetches: Array<{ path: string; uids: number[]; query: Record<string, unknown> }>;
}

export const fakeImap: FakeImapState = {
  folders: [],
  connectError: null,
  options: [],
  searches: [],
  fetches: [],
};

export function resetFakeImap(): void {
  fakeImap.folders = [];
  fakeImap.connectError = null;
  fakeImap.options = [];
  fakeImap.searches = [];
  fakeImap.fetches = [];
}

/** The header block of a raw message (with its closing blank line). */
function headerBlock(source: string): string {
  const end = source.indexOf("\r\n\r\n");
  return end === -1 ? `${source}\r\n\r\n` : source.slice(0, end + 4);
}

function headerValue(source: string, name: string): string {
  const pattern = new RegExp(`^${name}:[ \\t]*(.*(?:\\r\\n[ \\t].*)*)`, "im");
  return (
    headerBlock(source)
      .match(pattern)?.[1]
      ?.replace(/\r\n[ \t]+/g, " ")
      .trim() ?? ""
  );
}

/** The mocked `imapflow` module. */
export function fakeImapModule() {
  class ImapFlow {
    mailbox: { path: string; uidValidity: bigint; uidNext: number } | false = false;

    constructor(options: Record<string, unknown>) {
      fakeImap.options.push(options);
    }

    async connect() {
      if (fakeImap.connectError) throw fakeImap.connectError;
    }

    async list() {
      return fakeImap.folders.map((folder) => ({
        path: folder.path,
        name: folder.name,
        specialUse: folder.specialUse,
        flags: new Set(folder.flags),
      }));
    }

    async getMailboxLock(path: string) {
      const folder = fakeImap.folders.find((candidate) => candidate.path === path);
      if (!folder) throw new Error(`no folder ${path}`);
      const uidNext = Math.max(0, ...folder.messages.map((message) => message.uid)) + 1;
      this.mailbox = { path, uidValidity: folder.uidValidity, uidNext };
      return { release: () => {} };
    }

    private folder(): FakeImapFolder {
      const path = this.mailbox ? this.mailbox.path : "";
      const folder = fakeImap.folders.find((candidate) => candidate.path === path);
      if (!folder) throw new Error("no folder selected");
      return folder;
    }

    async search(query: { since?: Date; uid?: string; header?: Record<string, string> }) {
      const folder = this.folder();
      fakeImap.searches.push({ path: folder.path, query });
      if (query.header) {
        const [name, value] = Object.entries(query.header)[0] ?? ["", ""];
        return folder.messages
          .filter((m) => headerValue(m.source, name).toLowerCase().includes(value.toLowerCase()))
          .map((m) => m.uid);
      }
      if (query.since) {
        const since = query.since.getTime();
        return folder.messages.filter((m) => m.internalDate.getTime() >= since).map((m) => m.uid);
      }
      const from = Number(String(query.uid).split(":")[0]);
      const uids = folder.messages.map((m) => m.uid);
      if (uids.length === 0) return [];
      // IMAP quirk: "n:*" always includes the highest UID.
      return [...new Set([...uids.filter((uid) => uid >= from), Math.max(...uids)])];
    }

    async fetchAll(
      range: number[] | string,
      query: { source?: unknown; headers?: unknown },
    ): Promise<
      Array<{ uid: number; internalDate: Date; size: number; source?: Buffer; headers?: Buffer }>
    > {
      const folder = this.folder();
      const uids = Array.isArray(range) ? range : String(range).split(",").map(Number);
      fakeImap.fetches.push({ path: folder.path, uids, query });
      return folder.messages
        .filter((m) => uids.includes(m.uid))
        .map((m) => ({
          uid: m.uid,
          internalDate: m.internalDate,
          size: m.source.length,
          ...(query.source ? { source: Buffer.from(m.source) } : {}),
          ...(query.headers ? { headers: Buffer.from(headerBlock(m.source)) } : {}),
        }));
    }

    async logout() {}

    close() {}
  }
  return { ImapFlow };
}
