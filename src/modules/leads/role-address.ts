/**
 * System and abuse mailboxes that must never get cold email (RFC 2142 style addresses,
 * no-reply senders, bounce and list handlers). Business role inboxes such as info@, sales@,
 * contact@, hello@ and office@ stay allowed: local businesses often publish only those.
 */
export const BLOCKED_ROLE_LOCAL_PARTS = [
  "abuse",
  "postmaster",
  "hostmaster",
  "mailer-daemon",
  "noreply",
  "no-reply",
  "donotreply",
  "do-not-reply",
  "bounce",
  "bounces",
  "unsubscribe",
  "spam",
  "root",
] as const;

/** Local part without a +tag and without separators: No_Reply+42 gives noreply. */
function squash(local: string): string {
  return (local.toLowerCase().split("+")[0] ?? "").replace(/[._-]/g, "");
}

const BLOCKED = new Set(BLOCKED_ROLE_LOCAL_PARTS.map(squash));

/** True for addresses like noreply@, no_reply+x@, postmaster@ or mailer-daemon@. */
export function isBlockedRoleAddress(email: string | null | undefined): boolean {
  if (!email) return false;
  const at = email.lastIndexOf("@");
  if (at <= 0) return false;
  return BLOCKED.has(squash(email.slice(0, at)));
}
