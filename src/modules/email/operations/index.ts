import { defineTool } from "../../../core/operation.js";
import { addMailbox, importMailboxesCsvOperation } from "./add.js";
import { checkDnsOperation } from "./dns.js";
import { listMailboxes } from "./list.js";
import { oauthStartOperation } from "./oauth-start.js";
import { pauseMailboxOperation, resumeMailboxOperation, testMailboxOperation } from "./status.js";
import { removeMailbox, updateMailbox } from "./update.js";

export const mailboxOperations = [
  listMailboxes,
  addMailbox,
  importMailboxesCsvOperation,
  updateMailbox,
  removeMailbox,
  pauseMailboxOperation,
  resumeMailboxOperation,
  testMailboxOperation,
  checkDnsOperation,
  oauthStartOperation,
];

export const manageMailboxesTool = defineTool({
  name: "manage_mailboxes",
  title: "Manage sending mailboxes",
  description:
    "Connect and look after the mailboxes that send cold email. Actions: list (health, today's usage, ramp, bounce rate, DNS), add (Google or Zoho app password, custom SMTP/IMAP), import_csv (Instantly/Smartlead/generic exports), update, remove, pause, resume, test (SMTP and IMAP login), check_dns (MX, SPF, DKIM, DMARC with fixes), oauth_start (link to connect Google or Microsoft 365; the only way for Microsoft). Pass passwords as password_env (a MAILBOX_* variable), never in chat. Not for sending: campaigns send, and replies go through reply_to_thread.",
  toolset: "core",
  actions: {
    list: "mailboxes.list",
    add: "mailboxes.add",
    import_csv: "mailboxes.import_csv",
    update: "mailboxes.update",
    remove: "mailboxes.remove",
    pause: "mailboxes.pause",
    resume: "mailboxes.resume",
    test: "mailboxes.test",
    check_dns: "mailboxes.check_dns",
    oauth_start: "mailboxes.oauth_start",
  },
});
