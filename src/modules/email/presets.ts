import type { MailboxProviderLabel } from "../../core/enums.js";
import type { MailServerConfig } from "../../db/schema/index.js";

export const MAILBOX_PRESETS = ["google", "microsoft", "zoho", "custom"] as const;
export type MailboxPreset = (typeof MAILBOX_PRESETS)[number];

type Server = Omit<MailServerConfig, "user">;

/** Server settings per provider (users default to the mailbox address). */
export const PRESET_SERVERS: Record<
  Exclude<MailboxPreset, "custom">,
  { smtp: Server; imap: Server }
> = {
  google: {
    smtp: { host: "smtp.gmail.com", port: 465, secure: true },
    imap: { host: "imap.gmail.com", port: 993, secure: true },
  },
  microsoft: {
    smtp: { host: "smtp.office365.com", port: 587, secure: false },
    imap: { host: "outlook.office365.com", port: 993, secure: true },
  },
  zoho: {
    smtp: { host: "smtp.zoho.com", port: 465, secure: true },
    imap: { host: "imap.zoho.com", port: 993, secure: true },
  },
};

/** Setup notes returned with the preset (and in errors). */
export const PRESET_NOTES: Record<MailboxPreset, string> = {
  google:
    "Google Workspace: use OAuth (action oauth_start, provider google) or an app password (needs 2-Step Verification); plain account passwords stopped working for SMTP and IMAP in March 2025.",
  microsoft:
    "Microsoft 365: Exchange Online retired basic authentication for IMAP and is retiring it for SMTP AUTH, so Microsoft mailboxes connect with OAuth only (action oauth_start, provider microsoft). The mailbox must allow authenticated SMTP (ask the tenant admin).",
  zoho: "Zoho: accounts outside the US use regional hosts (smtp.zoho.eu and imap.zoho.eu, or .in, .com.au, .jp); organization mailboxes use smtppro.zoho.<region> and imappro.zoho.<region>. Pass smtp_host and imap_host to override.",
  custom:
    "Custom: pass smtp_host, smtp_port, imap_host and imap_port (TLS on 465/993, STARTTLS on 587/143). Password login is only available for custom hosts and Google or Zoho app passwords.",
};

/** Microsoft 365 / Outlook hosted SMTP or IMAP servers. */
export function isMicrosoftHost(host: string | null | undefined): boolean {
  return /(^|\.)(office365\.com|outlook\.com|office\.com)$/i.test((host ?? "").trim());
}

/** The provider label implied by an SMTP host (CSV imports, custom settings). */
export function presetForHost(host: string | null | undefined): MailboxProviderLabel {
  const value = (host ?? "").trim().toLowerCase();
  if (/(^|\.)(gmail\.com|googlemail\.com|google\.com)$/.test(value)) return "google";
  if (isMicrosoftHost(value)) return "microsoft";
  if (/(^|\.)zoho(pro)?\.[a-z.]+$/.test(value) || /^smtppro\.zoho|^imappro\.zoho/.test(value))
    return "zoho";
  return "custom";
}

/** `*.onmicrosoft.com` addresses are capped at 100 external recipients a day: never send from them. */
export function isOnMicrosoftAddress(email: string): boolean {
  return /@([a-z0-9-]+\.)*onmicrosoft\.com$/i.test(email.trim());
}

/** Implicit TLS for the usual TLS ports, STARTTLS otherwise. */
export function defaultSecure(port: number): boolean {
  return port === 465 || port === 993;
}
