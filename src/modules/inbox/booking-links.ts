/**
 * Booking links with a hidden per-person code (spec 2.4). When the engine puts a booking link
 * into a message for a person, Calendly links get `utm_content=<ref>` (plus
 * `utm_source=openoutbound`) and Cal.com links get `metadata[oo_ref]=<ref>`. Both tools hand
 * the value back in their webhooks, so a booking made by an assistant or from another address
 * still matches the right lead. Links to other booking tools are left untouched.
 */
import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import { isOpenOutboundError, notFound } from "../../core/errors.js";
import { parseWorkspaceSettings } from "../../core/settings.js";
import { type Offer, people, type Workspace } from "../../db/schema/index.js";
import { resolveOffer } from "../knowledge/service.js";

/** Crockford base32, lowercase (no i, l, o or u), like ids. */
const REF_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const REF_LENGTH = 10;
const REF_PATTERN = /^bk[0-9a-hjkmnp-tv-z]{10}$/;
const CALCOM_REF_PARAM = "metadata[oo_ref]";
const MAX_ATTEMPTS = 5;

export type BookingLinkPurpose = "reply" | "template";

/** A new random booking reference: `bk` + 10 lowercase base32 characters. */
export function newBookingRef(): string {
  const bytes = randomBytes(REF_LENGTH);
  let out = "bk";
  // 256 is a multiple of 32, so every character is equally likely.
  for (const byte of bytes) out += REF_ALPHABET.charAt(byte % REF_ALPHABET.length);
  return out;
}

/** True for strings shaped like a booking reference. */
export function isBookingRef(value: string): boolean {
  return REF_PATTERN.test(value);
}

/**
 * Whether a query parameter is part of the tag this module adds (`utm_content` holding a
 * booking reference, `utm_source=openoutbound`, `metadata[oo_ref]`), so a tagged link and the
 * plain one can be compared as the same link.
 */
export function isBookingTagParam(key: string, value: string): boolean {
  const name = key.trim().toLowerCase();
  const clean = value.trim().toLowerCase();
  if (name === CALCOM_REF_PARAM) return true;
  if (name === "utm_source") return clean === "openoutbound";
  return name === "utm_content" && isBookingRef(clean);
}

type BookingTool = "calendly" | "cal_com";

function toolOf(url: URL): BookingTool | null {
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  if (host === "calendly.com" || host.endsWith(".calendly.com")) return "calendly";
  if (host === "cal.com" || host.endsWith(".cal.com")) return "cal_com";
  return null;
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** Whether `tagBookingUrl` would add a code to this link (a Calendly or Cal.com URL). */
export function isTaggableBookingUrl(url: string): boolean {
  const parsed = parseUrl(url.trim());
  return parsed !== null && toolOf(parsed) !== null;
}

function decodedKey(part: string): string {
  const key = part.split("=")[0] ?? "";
  try {
    return decodeURIComponent(key.replace(/\+/g, " "));
  } catch {
    return key;
  }
}

/**
 * Appends query parameters to a URL string, keeping its other parameters exactly as written
 * (no re-encoding) and its fragment. Parameters whose decoded name is in `drop` are removed.
 */
function withParams(url: string, params: Array<[string, string]>, drop: string[] = []): string {
  const hashAt = url.indexOf("#");
  const beforeHash = hashAt === -1 ? url : url.slice(0, hashAt);
  const fragment = hashAt === -1 ? "" : url.slice(hashAt);
  const queryAt = beforeHash.indexOf("?");
  const base = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);
  const kept = (queryAt === -1 ? "" : beforeHash.slice(queryAt + 1))
    .split("&")
    .filter((part) => part !== "" && !drop.includes(decodedKey(part)));
  const added = params.map(
    ([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
  );
  return `${base}?${[...kept, ...added].join("&")}${fragment}`;
}

/**
 * Adds the person's booking reference to a booking link (pure). Calendly (`calendly.com` and
 * its subdomains): `utm_content=<ref>` and `utm_source=openoutbound` when absent. A
 * `utm_content` that holds another booking reference (a link copied from a reply sent to
 * someone else) is replaced; any other `utm_content` is the user's own tracking, so the link
 * is returned unchanged. Cal.com (`cal.com`, `app.cal.com`, `*.cal.com`):
 * `metadata[oo_ref]=<ref>` (brackets percent-encoded). Existing parameters and the fragment are
 * kept. Any other host, or a string that is not a URL: unchanged.
 */
export function tagBookingUrl(url: string, ref: string): string {
  const trimmed = url.trim();
  const parsed = parseUrl(trimmed);
  if (!parsed || !ref) return url;
  const tool = toolOf(parsed);
  if (tool === "calendly") {
    const current = parsed.searchParams.get("utm_content")?.trim().toLowerCase() ?? null;
    if (current === ref) return trimmed;
    if (current !== null && !isBookingRef(current)) return url;
    const params: Array<[string, string]> = [["utm_content", ref]];
    if (!parsed.searchParams.has("utm_source")) params.push(["utm_source", "openoutbound"]);
    return withParams(trimmed, params, current === null ? [] : ["utm_content"]);
  }
  if (tool === "cal_com") {
    if (parsed.searchParams.get(CALCOM_REF_PARAM) === ref) return trimmed;
    return withParams(trimmed, [[CALCOM_REF_PARAM, ref]], [CALCOM_REF_PARAM]);
  }
  return url;
}

/** The booking reference carried by a tagged link (`utm_content` or `metadata[oo_ref]`), or null. */
export function bookingRefFromUrl(url: string): string | null {
  const parsed = parseUrl(url.trim());
  if (!parsed) return null;
  const tool = toolOf(parsed);
  const value =
    tool === "calendly"
      ? parsed.searchParams.get("utm_content")
      : tool === "cal_com"
        ? parsed.searchParams.get(CALCOM_REF_PARAM)
        : null;
  const ref = value?.trim().toLowerCase() ?? "";
  return isBookingRef(ref) ? ref : null;
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (typeof current === "object" && (current as { code?: unknown }).code === "23505") {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * The person's booking reference in one workspace, created on first use. Returns null when the
 * person does not exist there. A random reference that another person of the workspace already
 * holds (unique index) is replaced by a new one; a concurrent first use keeps the stored one.
 */
export async function assignBookingRef(
  ctx: OpContext,
  workspaceId: string,
  personId: string,
  generate: () => string = newBookingRef,
): Promise<string | null> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const [row] = await ctx.db
      .select({ ref: people.booking_ref })
      .from(people)
      .where(and(eq(people.workspace_id, workspaceId), eq(people.id, personId)))
      .limit(1);
    if (!row) return null;
    if (row.ref) return row.ref;
    try {
      const [updated] = await ctx.db
        .update(people)
        .set({ booking_ref: generate() })
        .where(
          and(
            eq(people.workspace_id, workspaceId),
            eq(people.id, personId),
            isNull(people.booking_ref),
          ),
        )
        .returning({ ref: people.booking_ref });
      if (updated?.ref) return updated.ref;
      // Set by someone else meanwhile: the next pass reads it.
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // The random reference is taken in this workspace: draw another one.
    }
  }
  throw new Error(`assignBookingRef: no unique booking reference after ${MAX_ATTEMPTS} attempts`);
}

/**
 * The person's booking reference (`people.booking_ref`), created on first use as `bk` plus 10
 * random lowercase base32 characters, unique per workspace. Throws `not_found` for a person
 * outside the workspace.
 */
export async function ensureBookingRef(ctx: OpContext, personId: string): Promise<string> {
  const workspace = requireWorkspace(ctx);
  const ref = await assignBookingRef(ctx, workspace.id, personId);
  if (!ref) throw notFound("Person", personId);
  return ref;
}

/**
 * The booking link for a message, in a given workspace (see `bookingLinkFor`). For callers that
 * hold the workspace row, like the email sender.
 */
export async function resolveBookingLink(
  ctx: OpContext,
  workspace: Workspace,
  input: { personId: string | null; offerUrl: string | null; purpose: BookingLinkPurpose },
): Promise<string | null> {
  const booking = parseWorkspaceSettings(workspace.settings).booking;
  if (input.purpose === "reply" && booking.mode !== "link") return null;
  const url = input.offerUrl?.trim() || booking.default_url || null;
  if (!url) return null;
  if (!booking.tag_links || !input.personId || !isTaggableBookingUrl(url)) return url;
  const ref = await assignBookingRef(ctx, workspace.id, input.personId);
  return ref ? tagBookingUrl(url, ref) : url;
}

/**
 * The booking link to put into a message: the offer's link, else `booking.default_url`. For
 * `purpose: "reply"` (a reply draft offering a meeting) it is null unless `booking.mode` is
 * `link`; for `purpose: "template"` (someone wrote `{{booking_url}}` in a step or an email) the
 * link comes back in every mode. With `booking.tag_links` on and a known person, Calendly and
 * Cal.com links carry the person's booking reference.
 */
export async function bookingLinkFor(
  ctx: OpContext,
  input: { personId: string | null; offerUrl: string | null; purpose: BookingLinkPurpose },
): Promise<string | null> {
  return resolveBookingLink(ctx, requireWorkspace(ctx), input);
}

/** The booking link a reply offers, and the plain link it is made from. */
export interface ReplyBookingLink {
  /** The link to put into the reply (tagged for the person), or null when a reply offers none. */
  url: string | null;
  /** The same link without the person's code, or null. */
  plain: string | null;
  /** Why the campaign's offer cannot be used (gone or not active), or null. */
  offerIssue: string | null;
}

/**
 * The booking link of a reply, picked the way the reply draft picks it, so the draft and
 * everything that describes it (the `meeting_to_book` problem, follow-up drafts after a missed
 * or cancelled meeting) agree: the offer the draft's grounding uses (`resolveOffer`: the
 * campaign's offer, else the default or only active offer), its booking link, else
 * `booking.default_url`, tagged for the person. No link outside `booking.mode` link, and none
 * while the campaign's offer cannot be used (the draft is refused then). Pass `offer` when the
 * grounding already picked it.
 */
export async function replyBookingLink(
  ctx: OpContext,
  input: { personId: string | null; offerId: string | null; offer?: Offer | null },
): Promise<ReplyBookingLink> {
  let offer = input.offer ?? null;
  if (input.offer === undefined) {
    try {
      offer = await resolveOffer(ctx, input.offerId);
    } catch (error) {
      if (!isOpenOutboundError(error)) throw error;
      return { url: null, plain: null, offerIssue: error.message };
    }
  }
  const workspace = requireWorkspace(ctx);
  const booking = parseWorkspaceSettings(workspace.settings).booking;
  const plain =
    booking.mode === "link" ? offer?.booking_url?.trim() || booking.default_url || null : null;
  if (!plain) return { url: null, plain: null, offerIssue: null };
  const url = await resolveBookingLink(ctx, workspace, {
    personId: input.personId,
    offerUrl: plain,
    purpose: "reply",
  });
  return { url, plain, offerIssue: null };
}

/** The person holding a booking reference in the context workspace, or null. */
export async function findPersonByBookingRef(ctx: OpContext, ref: string): Promise<string | null> {
  const workspace = requireWorkspace(ctx);
  const clean = ref.trim().toLowerCase();
  if (!isBookingRef(clean)) return null;
  const [row] = await ctx.db
    .select({ id: people.id })
    .from(people)
    .where(and(eq(people.workspace_id, workspace.id), eq(people.booking_ref, clean)))
    .limit(1);
  return row?.id ?? null;
}
