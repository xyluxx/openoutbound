/**
 * Unipile response mapping, one small function per shape (provider API notes, section 3).
 * Shapes marked UNVERIFIED in the notes (accounts list, relations, sent invitations, message
 * list) are read defensively: unknown fields are ignored and missing ones become null.
 */
import { OpenOutboundError } from "../../core/errors.js";
import { classFailure } from "../http.js";
import type {
  LinkedInAccountInfo,
  LinkedInEvent,
  LinkedInInboundMessage,
  LinkedInPost,
  LinkedInProfile,
  LinkedInTarget,
} from "../types.js";
import { UNIPILE } from "./unipile-client.js";

type Json = Record<string, unknown>;

export function asRecord(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
}

export function str(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

export function items(body: unknown): Json[] {
  const list = asRecord(body).items;
  return Array.isArray(list) ? list.map(asRecord) : [];
}

export function cursorOf(body: unknown): string | null {
  return str(asRecord(body).cursor);
}

/** Public identifier (vanity slug) from a LinkedIn profile URL. */
export function publicIdentifier(profileUrl: string | null | undefined): string | null {
  if (!profileUrl) return null;
  const match = /linkedin\.com\/in\/([^/?#]+)/i.exec(profileUrl);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/** Identifier for `/users/{identifier}`: provider id when known, else the public identifier. */
export function identifierFor(target: LinkedInTarget): string {
  const id = target.provider_id?.trim() || publicIdentifier(target.profile_url);
  if (!id) {
    throw new OpenOutboundError("validation_failed", "The person has no usable LinkedIn profile.", {
      hint: "Set the person's linkedin_url to https://www.linkedin.com/in/<slug>.",
      details: { provider: "unipile", retryable: false },
    });
  }
  return id;
}

export function profileUrlFor(publicId: string | null): string | null {
  return publicId
    ? `https://www.linkedin.com/in/${encodeURIComponent(publicId.toLowerCase())}`
    : null;
}

const RELATIVE_UNITS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  min: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 7 * 86_400_000,
  mo: 30 * 86_400_000,
  y: 365 * 86_400_000,
  yr: 365 * 86_400_000,
};

/** ISO date from ISO strings, epoch numbers or LinkedIn relative ages ("3d", "2w", "1mo"). */
export function parseDate(value: unknown, now: Date): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  const text = str(value);
  if (!text) return null;
  const relative = /^(\d+)\s*(mo|min|yr|[smhdwy])\b/i.exec(text);
  if (relative?.[1] && relative[2]) {
    const unit = RELATIVE_UNITS[relative[2].toLowerCase()];
    if (unit) return new Date(now.getTime() - Number(relative[1]) * unit).toISOString();
  }
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

const DEGREE: Record<string, 1 | 2 | 3> = {
  FIRST_DEGREE: 1,
  DISTANCE_1: 1,
  SECOND_DEGREE: 2,
  DISTANCE_2: 2,
  THIRD_DEGREE: 3,
  DISTANCE_3: 3,
  OUT_OF_NETWORK: 3,
};

export function mapProfile(body: unknown, fallbackUrl: string | null): LinkedInProfile {
  const raw = asRecord(body);
  const providerId = str(raw.provider_id);
  if (!providerId) {
    // LinkedIn sometimes serves a thin profile for a while: worth another try later.
    throw classFailure(UNIPILE, "malformed", {
      message: "Unipile returned a profile without provider_id.",
      retryable: true,
    });
  }
  const publicId = str(raw.public_identifier);
  const first = str(raw.first_name);
  const last = str(raw.last_name);
  const invitation = asRecord(raw.invitation);
  const invitationType = str(invitation.type)?.toUpperCase();
  const invitationStatus = str(invitation.status)?.toUpperCase();
  return {
    provider_id: providerId,
    profile_url: str(raw.public_profile_url) ?? profileUrlFor(publicId) ?? fallbackUrl ?? "",
    public_identifier: publicId,
    first_name: first,
    last_name: last,
    full_name: [first, last].filter(Boolean).join(" ") || null,
    headline: str(raw.headline),
    location: str(raw.location),
    connection_degree: DEGREE[str(raw.network_distance)?.toUpperCase() ?? ""] ?? null,
    invitation_pending:
      raw.is_invitation_pending === true ||
      (invitationType === "SENT" &&
        (invitationStatus === undefined || invitationStatus === "PENDING")),
    premium: raw.is_premium === true,
  };
}

/** Post list item -> LinkedInPost (null for reposts and items without an id). */
export function mapPost(value: unknown, now: Date): LinkedInPost | null {
  const raw = asRecord(value);
  if (raw.is_repost === true || raw.reposted === true) return null;
  const id = str(raw.social_id) ?? str(raw.id);
  if (!id) return null;
  const author = asRecord(raw.author);
  return {
    id,
    url: str(raw.share_url) ?? str(raw.url),
    text: str(raw.text) ?? "",
    published_at: parseDate(raw.parsed_datetime ?? raw.date, now),
    author_provider_id: str(author.id) ?? str(raw.author_id),
    reactions_count: typeof raw.reaction_counter === "number" ? raw.reaction_counter : 0,
    comments_count: typeof raw.comment_counter === "number" ? raw.comment_counter : 0,
  };
}

const ACCOUNT_STATUS: Record<string, LinkedInAccountInfo["status"]> = {
  OK: "active",
  SYNC_SUCCESS: "active",
  RECONNECTED: "active",
  CREATION_SUCCESS: "active",
  CONNECTING: "active",
  RUNNING: "active",
  CREDENTIALS: "credentials_needed",
  ERROR: "restricted",
  STOPPED: "restricted",
  PERMISSIONS: "restricted",
  DELETED: "disconnected",
  CREATION_FAIL: "disconnected",
};

export function mapAccountStatus(value: unknown): LinkedInAccountInfo["status"] {
  return ACCOUNT_STATUS[str(value)?.toUpperCase() ?? ""] ?? "active";
}

/** Accounts list item -> account info (LinkedIn accounts only). */
export function mapAccount(value: unknown): LinkedInAccountInfo | null {
  const raw = asRecord(value);
  const id = str(raw.id);
  const type = str(raw.type)?.toUpperCase();
  if (!id || (type && type !== "LINKEDIN")) return null;
  const im = asRecord(asRecord(raw.connection_params).im);
  const sources = Array.isArray(raw.sources) ? raw.sources.map(asRecord) : [];
  const worst = sources
    .map((source) => mapAccountStatus(source.status))
    .find((s) => s !== "active");
  const premiumFeatures = im.premiumFeatures;
  return {
    external_account_id: id,
    name: str(raw.name) ?? str(im.username) ?? id,
    profile_url: profileUrlFor(str(im.publicIdentifier)),
    status: worst ?? "active",
    premium:
      Boolean(str(im.premiumId)) || (Array.isArray(premiumFeatures) && premiumFeatures.length > 0),
  };
}

export interface PendingInvite {
  invitation_id: string;
  provider_id: string;
  profile_url?: string | null;
  sent_at?: string | null;
}

/** Sent invitation item (UNVERIFIED shape). */
export function mapPendingInvite(value: unknown, now: Date): PendingInvite | null {
  const raw = asRecord(value);
  const id = str(raw.id) ?? str(raw.invitation_id);
  const providerId =
    str(raw.invited_user_id) ?? str(raw.provider_id) ?? str(asRecord(raw.invited_user).provider_id);
  if (!id || !providerId) return null;
  const publicId = str(raw.invited_user_public_id) ?? str(raw.public_identifier);
  return {
    invitation_id: id,
    provider_id: providerId,
    profile_url: profileUrlFor(publicId),
    sent_at: parseDate(raw.parsed_datetime ?? raw.date ?? raw.sent_at, now),
  };
}

/** Message list item -> inbound message (UNVERIFIED shape). */
export function mapMessage(value: unknown, now: Date): LinkedInInboundMessage | null {
  const raw = asRecord(value);
  const id = str(raw.id) ?? str(raw.message_id);
  const chatId = str(raw.chat_id);
  const sender = str(raw.sender_id) ?? str(asRecord(raw.sender).attendee_provider_id);
  if (!id || !chatId || !sender) return null;
  return {
    id,
    chat_id: chatId,
    sender_provider_id: sender,
    sender_profile_url: str(asRecord(raw.sender).attendee_profile_url),
    text: str(raw.text) ?? "",
    sent_at: parseDate(raw.timestamp, now) ?? now.toISOString(),
    is_outbound: raw.is_sender === true || raw.is_sender === 1,
  };
}

/** Relation list item -> connection (UNVERIFIED shape). */
export function mapRelation(
  value: unknown,
  now: Date,
): { provider_id: string; profile_url: string | null; connected_at: string | null } | null {
  const raw = asRecord(value);
  const id = str(raw.member_id) ?? str(raw.provider_id);
  if (!id) return null;
  return {
    provider_id: id,
    profile_url: str(raw.public_profile_url) ?? profileUrlFor(str(raw.public_identifier)),
    connected_at: parseDate(raw.created_at, now),
  };
}

/** Webhook body -> events (new_relation, message_received, AccountStatus). */
export function parseUnipileWebhook(body: unknown, now: Date): LinkedInEvent[] {
  const raw = asRecord(body);
  const status = asRecord(raw.AccountStatus);
  if (str(status.account_id)) {
    const message = str(status.message) ?? "UNKNOWN";
    return [
      {
        type: "account_status",
        account_id: str(status.account_id) ?? "",
        status: mapAccountStatus(message),
        reason: message,
      },
    ];
  }
  const accountId = str(raw.account_id);
  const accountType = str(raw.account_type)?.toUpperCase();
  if (!accountId || (accountType && accountType !== "LINKEDIN")) return [];
  const event = str(raw.event);
  if (event === "new_relation") {
    const providerId = str(raw.user_provider_id);
    if (!providerId) return [];
    return [
      {
        type: "invite_accepted",
        account_id: accountId,
        provider_id: providerId,
        profile_url: str(raw.user_profile_url) ?? profileUrlFor(str(raw.user_public_identifier)),
        occurred_at: parseDate(raw.timestamp, now) ?? now.toISOString(),
      },
    ];
  }
  if (event === "message_received") {
    const sender = asRecord(raw.sender);
    const senderId = str(sender.attendee_provider_id);
    const messageId = str(raw.message_id);
    const chatId = str(raw.chat_id);
    if (!senderId || !messageId || !chatId) return [];
    const ownId = str(asRecord(raw.account_info).user_id);
    return [
      {
        type: "message_received",
        account_id: accountId,
        message: {
          id: messageId,
          chat_id: chatId,
          sender_provider_id: senderId,
          sender_profile_url: str(sender.attendee_profile_url),
          text: str(raw.message) ?? "",
          sent_at: parseDate(raw.timestamp, now) ?? now.toISOString(),
          is_outbound: raw.is_sender === true || (ownId !== null && ownId === senderId),
        },
      },
    ];
  }
  return [];
}
