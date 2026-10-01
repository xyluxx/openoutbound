/**
 * Publishing a post at most once per attempt (docs/concepts/delivery-guarantees.md, boundary B6):
 * - An attempt claims the post (`approved` or `scheduled` to `publishing`, attempt + 1) before
 *   the provider call, and every later write checks that claim, so two runs never both hand a
 *   post over.
 * - Success: `published` with its link. An answer that accepted the post without a readable id
 *   counts as published too, with a note.
 * - A failure before anything reached LinkedIn (a refusal, a rate limit, a connection that never
 *   opened, missing credentials) is `failed`, or `scheduled` again when a later try can help (at
 *   most MAX_PUBLISH_ATTEMPTS tries per publish request, counted in `why.publish_retries`).
 * - A paused publisher (provider health: refused app credentials or API key, a used-up quota) is
 *   a wait, as for LinkedIn actions: `scheduled` again for when the pause may be over, not
 *   counted as a try, never `failed`.
 * - A failure after the request may have reached LinkedIn (a timeout, a dropped connection, a
 *   server error, an outcome the publisher calls unknown) is `unknown` with a `send_unknown`
 *   problem: never published again until a person settles it (resolve-unknown.ts). So is an
 *   attempt that stopped mid-call (`publishing` for POST_STUCK_MS, swept by `content.publish_due`).
 * - An answer that comes after the post moved on is settled: published when nothing else went
 *   out, a duplicate (`duplicate_send` problem) when a newer attempt published it too.
 */
import { and, asc, eq, inArray, lt, type SQL, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import type { OpContext } from "../../core/context.js";
import type { PostStatus } from "../../core/enums.js";
import { isOpenOutboundError } from "../../core/errors.js";
import { failureOf, isRetryable, retryAfterOf } from "../../core/failures.js";
import {
  linkedin_accounts,
  type Post,
  posts,
  type SocialAccountRef,
  social_accounts,
} from "../../db/schema/index.js";
import type { SocialPublisher } from "../../providers/types.js";
import { PAUSE_CLASSES } from "../../runtime/provider-health.js";
import { deliveryUncertain } from "../linkedin/delivery-uncertain.js";
import {
  openPostUnknownProblem,
  recordPostDuplicate,
  resolvePostUnknownProblem,
} from "./post-problems.js";

/** Statuses a publish attempt may claim. */
const CLAIMABLE: PostStatus[] = ["approved", "scheduled"];

/**
 * Tries of one publish request (a publish, a schedule or a republish); a failure before handover
 * on the last one is final.
 */
export const MAX_PUBLISH_ATTEMPTS = 5;

/** A publish attempt still `publishing` after this long stopped mid-call. */
export const POST_STUCK_MS = 15 * 60_000;

/** Wait before the next try after a failure before handover, when the provider names none. */
const RETRY_DELAY_MS = 5 * 60_000;

/** Wait while the publisher is paused, when the pause names no end; never less than the minimum. */
const PAUSED_RETRY_MS = 60 * 60_000;
const PAUSED_MIN_MS = 15 * 60_000;

/** Posts settled per `content.publish_due` run. */
const STUCK_BATCH = 20;

const LATE_ROUNDS = 3;

export const ACCEPTED_WITHOUT_ID_NOTE =
  "LinkedIn accepted the post but sent back no post id, so there is no link to it here; it is on the profile.";

export interface PublishOptions {
  /** The job's signal: the provider call stops when the job is cancelled or runs out of time. */
  signal?: AbortSignal;
}

type PublishAnswer = { externalId: string; url?: string };

type PostSet = PgUpdateSetSource<typeof posts>;

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

/**
 * `why` with the publish note replaced (removed when null) and the count of tries before
 * handover dropped, plus `extra` fields (the retry path sets that count again).
 */
export function withPublishNote(note: string | null, extra: Record<string, unknown> = {}): SQL {
  const fields = JSON.stringify({ ...extra, ...(note ? { publish_note: note } : {}) });
  return sql`(coalesce(${posts.why}, '{}'::jsonb) - 'publish_note' - 'publish_retries') || ${fields}::jsonb`;
}

/** `why` fields about the last publish request, dropped when a new one starts. */
const REQUEST_FIELDS: ReadonlySet<string> = new Set([
  "publish_note",
  "publish_retries",
  "failed_before_handover",
]);

/**
 * The post's `why` for a new publish request or a cancel: without the last request's note, its
 * count of tries and its failure flag (the history of earlier attempts stays).
 */
export function whyForNewRequest(why: Post["why"]): Post["why"] {
  if (!why) return why;
  return Object.fromEntries(
    Object.entries(why).filter(([field]) => !REQUEST_FIELDS.has(field)),
  ) as Post["why"];
}

/** The note of a post whose publish got no clear answer. */
export function unknownNote(detail: string): string {
  return `LinkedIn may or may not have published it (${detail}). It is not published again on its own: check the profile, then settle it with manage_posts action resolve_unknown.`;
}

/**
 * Matches the post while publish attempt `attempt` holds it. With `evidence: "none"` it also
 * stops matching once a late answer showed an earlier attempt went out: only recording the post
 * as published applies then.
 */
function held(post: Pick<Post, "id" | "workspace_id">, attempt: number, evidence: "none" | "any") {
  return and(
    eq(posts.id, post.id),
    eq(posts.workspace_id, post.workspace_id),
    eq(posts.status, "publishing"),
    eq(posts.publish_attempt, attempt),
    ...(evidence === "none" ? [sql`(${posts.why} ->> 'earlier_attempt_went_out') is null`] : []),
  );
}

/** The earlier attempt a late answer showed went out while this attempt held the post. */
export function earlierPublishWentOut(post: Pick<Post, "why" | "publish_attempt">): number | null {
  const earlier = post.why?.earlier_attempt_went_out;
  return typeof earlier === "number" && earlier < post.publish_attempt ? earlier : null;
}

async function currentPost(
  ctx: OpContext,
  post: Pick<Post, "id" | "workspace_id">,
): Promise<Post | null> {
  const [row] = await ctx.db
    .select()
    .from(posts)
    .where(and(eq(posts.id, post.id), eq(posts.workspace_id, post.workspace_id)))
    .limit(1);
  return row ?? null;
}

async function publisherFor(ctx: OpContext, provider: string): Promise<SocialPublisher> {
  if (ctx.workspace?.is_sandbox) return ctx.providers.get("social");
  return ctx.providers.get("social", { id: provider });
}

/** Fails a post no attempt claimed yet (nothing was handed over); only from a claimable status. */
async function failUnclaimed(ctx: OpContext, post: Post, error: string): Promise<Post> {
  const [row] = await ctx.db
    .update(posts)
    .set({
      status: "failed",
      error: error.slice(0, 500),
      why: withPublishNote(null, { failed_before_handover: true }),
    })
    .where(
      and(
        eq(posts.id, post.id),
        eq(posts.workspace_id, post.workspace_id),
        inArray(posts.status, CLAIMABLE),
      ),
    )
    .returning();
  return row ?? (await currentPost(ctx, post)) ?? post;
}

/**
 * Publishes an approved or scheduled post (see module doc) and returns it as it is now:
 * `published`, `unknown`, `scheduled` (tried again later), `failed`, or unchanged when another
 * run claimed it first. Emits `post.published`.
 */
export async function publishPost(
  ctx: OpContext,
  post: Post,
  options: PublishOptions = {},
): Promise<Post> {
  const ref = post.account_ref;
  if (!ref) return failUnclaimed(ctx, post, "no posting account: connect one and schedule again");
  if (ref.provider !== "linkedin_official") {
    const [linked] = await ctx.db
      .select({ status: linkedin_accounts.status })
      .from(linkedin_accounts)
      .where(
        and(
          eq(linkedin_accounts.workspace_id, post.workspace_id),
          eq(linkedin_accounts.external_account_id, ref.account_id),
        ),
      )
      .limit(1);
    if (linked && linked.status !== "active") {
      return failUnclaimed(ctx, post, `LinkedIn account is ${linked.status}`);
    }
  }
  let credentials: Record<string, string> | undefined;
  if (ref.secret_id) {
    const raw = await ctx.vault.getSecret(ref.secret_id, post.workspace_id);
    if (!raw) {
      return failUnclaimed(ctx, post, "posting account credentials are missing: connect it again");
    }
    credentials = JSON.parse(raw) as Record<string, string>;
  }
  let publisher: SocialPublisher;
  try {
    publisher = await publisherFor(ctx, ref.provider);
  } catch (error) {
    return failUnclaimed(ctx, post, errorMessage(error));
  }

  const [claimed] = await ctx.db
    .update(posts)
    .set({
      status: "publishing",
      publish_attempt: sql`${posts.publish_attempt} + 1`,
      publish_started_at: ctx.clock.now(),
      error: null,
    })
    .where(
      and(
        eq(posts.id, post.id),
        eq(posts.workspace_id, post.workspace_id),
        inArray(posts.status, CLAIMABLE),
      ),
    )
    .returning();
  if (!claimed) return (await currentPost(ctx, post)) ?? post;

  let answer: PublishAnswer;
  try {
    answer = await publisher.publish({
      accountRef: {
        provider: ref.provider,
        account_id: ref.account_id,
        ...(ref.name ? { name: ref.name } : {}),
      },
      text: claimed.body,
      ...(claimed.media.length ? { media: claimed.media } : {}),
      ...(credentials ? { credentials } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    await flagRejectedToken(ctx, post, ref, error);
    return settleFailure(ctx, claimed, error);
  }
  return settlePublished(ctx, claimed, answer, null);
}

/**
 * The member's own OAuth token LinkedIn rejected (`details.expired`): the posting account needs
 * connecting again. A paused publisher or refused app credentials (scope account) say nothing
 * about this account's token, so they leave it alone.
 */
async function flagRejectedToken(
  ctx: OpContext,
  post: Post,
  ref: SocialAccountRef,
  error: unknown,
): Promise<void> {
  if (!ref.secret_id || !isOpenOutboundError(error)) return;
  if (error.details?.expired !== true) return;
  await ctx.db
    .update(social_accounts)
    .set({ status: "expired", status_reason: "LinkedIn rejected the token; connect again." })
    .where(
      and(
        eq(social_accounts.workspace_id, post.workspace_id),
        eq(social_accounts.secret_id, ref.secret_id),
      ),
    );
}

/** How a failed publish counts (see module doc). */
export type PublishFailureKind = "accepted" | "uncertain" | "retry" | "paused" | "refused";

/**
 * Reads a publish failure (old and new provider error shapes): an answer that accepted the
 * post but has no readable id (`malformed` without an error status), one that may have reached
 * LinkedIn, one before anything did that a later try can fix, a paused publisher, or one a
 * later try cannot fix (the member's rejected token, a refusal, bad input, a missing setup).
 */
export function publishFailureKind(error: unknown): PublishFailureKind {
  if (isOpenOutboundError(error) && error.details?.expired === true) return "refused";
  const failure = failureOf(error);
  const status = failure?.upstream_status;
  if (failure?.class === "malformed" && (status === undefined || (status >= 200 && status < 300))) {
    return "accepted";
  }
  if (publisherPaused(error)) return "paused";
  if (deliveryUncertain(error)) return "uncertain";
  return isRetryable(error) ? "retry" : "refused";
}

/**
 * The publisher is paused for the workspace (provider health refused the call before any
 * request), or this failure pauses it: refused app credentials or API key, a missing permission
 * or a used-up quota of the provider account (scope account or provider), as for LinkedIn
 * actions. Nothing reached LinkedIn, and the fix is a person's, not this post's.
 */
function publisherPaused(error: unknown): boolean {
  if (isOpenOutboundError(error) && error.details?.paused === true) return true;
  const failure = failureOf(error);
  return failure !== null && PAUSE_CLASSES.has(failure.class) && failure.scope !== "call";
}

/** When a post waiting for a paused publisher is tried again (see `publisherPaused`). */
function pausedUntil(ctx: OpContext, error: unknown): Date {
  const retryAfter = retryAfterOf(error);
  const waitMs = Math.max(
    retryAfter === undefined ? PAUSED_RETRY_MS : retryAfter * 1000,
    PAUSED_MIN_MS,
  );
  return new Date(ctx.clock.now().getTime() + waitMs);
}

async function settleFailure(ctx: OpContext, claimed: Post, error: unknown): Promise<Post> {
  const kind = publishFailureKind(error);
  if (kind === "accepted") {
    return settlePublished(ctx, claimed, { externalId: "" }, ACCEPTED_WITHOUT_ID_NOTE);
  }
  const attempt = claimed.publish_attempt;
  const message = errorMessage(error);
  // Tries of this publish request so far, this one included.
  const tries = (claimed.why?.publish_retries ?? 0) + 1;
  let values: PostSet;
  if (kind === "uncertain") {
    values = { status: "unknown", error: message, why: withPublishNote(unknownNote(message)) };
  } else if (kind === "paused") {
    // A wait, not a try: the count of tries of this request stays as it was.
    const at = pausedUntil(ctx, error);
    const retries = claimed.why?.publish_retries;
    values = {
      status: "scheduled",
      scheduled_for: at,
      error: message,
      why: withPublishNote(
        `Nothing reached LinkedIn (${message}); the publisher is paused, so the post waits and is tried again at ${at.toISOString()}. The provider_down problem says what to fix.`,
        retries === undefined ? {} : { publish_retries: retries },
      ),
    };
  } else if (kind === "retry" && tries < MAX_PUBLISH_ATTEMPTS) {
    const waitMs = Math.max((retryAfterOf(error) ?? 0) * 1000, RETRY_DELAY_MS);
    const at = new Date(ctx.clock.now().getTime() + waitMs);
    values = {
      status: "scheduled",
      scheduled_for: at,
      error: message,
      why: withPublishNote(
        `Nothing reached LinkedIn (${message}); it is tried again at ${at.toISOString()}.`,
        { publish_retries: tries },
      ),
    };
  } else {
    const gaveUp = kind === "retry" ? ` (gave up after ${tries} tries)` : "";
    values = {
      status: "failed",
      error: `${message}${gaveUp}`.slice(0, 500),
      why: withPublishNote(null, { failed_before_handover: true }),
    };
  }
  const [row] = await ctx.db
    .update(posts)
    .set(values)
    .where(held(claimed, attempt, "none"))
    .returning();
  if (row) {
    if (row.status === "unknown") {
      await openPostUnknownProblem(ctx, row, `the publish got no clear answer (${message})`);
    }
    return row;
  }
  return settleNotHeld(ctx, claimed, kind === "uncertain");
}

/**
 * A failure answer found the claim gone. When a late answer showed an earlier attempt went
 * out, the post is published from it (and may have gone out twice when this attempt's own
 * outcome is unclear); when the post moved on, the answer is only logged.
 */
async function settleNotHeld(ctx: OpContext, claimed: Post, uncertain: boolean): Promise<Post> {
  const attempt = claimed.publish_attempt;
  const fresh = await currentPost(ctx, claimed);
  if (!fresh) return claimed;
  const earlier =
    fresh.status === "publishing" && fresh.publish_attempt === attempt
      ? earlierPublishWentOut(fresh)
      : null;
  if (earlier === null) {
    ctx.log.warn(
      { post_id: claimed.id, attempt, status: fresh.status },
      "a publish answer came after the post moved on; it is not recorded",
    );
    return fresh;
  }
  const published = await recordPublished(ctx, fresh, {
    from: "publishing",
    attempt,
    externalId: null,
    url: null,
    note: `An earlier try went out (try ${earlier}).`,
  });
  if (!published) return (await currentPost(ctx, claimed)) ?? fresh;
  if (uncertain) {
    await recordPostDuplicate(ctx, published, { attempts: [earlier, attempt], proven: false });
  }
  return published;
}

interface PublishedRecord {
  /** The status and publish attempt the post must still have. */
  from: PostStatus;
  attempt: number;
  externalId: string | null;
  url: string | null;
  note: string | null;
  publishedAt?: Date;
}

/**
 * Records the post as published (only while it still has `from` and `attempt`), keeps a link
 * already known, resolves its `send_unknown` problem and emits `post.published`. Null when the
 * post changed meanwhile.
 */
export async function recordPublished(
  ctx: OpContext,
  post: Pick<Post, "id" | "workspace_id">,
  input: PublishedRecord,
): Promise<Post | null> {
  const [row] = await ctx.db
    .update(posts)
    .set({
      status: "published",
      published_at: input.publishedAt ?? ctx.clock.now(),
      external_id: sql`coalesce(${posts.external_id}, ${input.externalId}::text)`,
      url: sql`coalesce(${posts.url}, ${input.url}::text)`,
      error: null,
      why: withPublishNote(input.note),
    })
    .where(
      and(
        eq(posts.id, post.id),
        eq(posts.workspace_id, post.workspace_id),
        eq(posts.status, input.from),
        eq(posts.publish_attempt, input.attempt),
      ),
    )
    .returning();
  if (!row) return null;
  if (input.from !== "publishing") {
    await resolvePostUnknownProblem(ctx, row.id, input.note ?? "Recorded as published.");
  }
  await ctx.events.emit("post.published", {
    workspaceId: row.workspace_id,
    subject: { type: "post", id: row.id },
    data: { post_id: row.id, url: row.url, external_id: row.external_id },
  });
  return row;
}

async function settlePublished(
  ctx: OpContext,
  claimed: Post,
  answer: PublishAnswer,
  note: string | null,
): Promise<Post> {
  const attempt = claimed.publish_attempt;
  const row = await recordPublished(ctx, claimed, {
    from: "publishing",
    attempt,
    externalId: answer.externalId || null,
    url: answer.url ?? null,
    note: note ?? (answer.externalId ? null : ACCEPTED_WITHOUT_ID_NOTE),
  });
  if (!row) return settleLateSuccess(ctx, claimed, answer);
  const earlier = earlierPublishWentOut(row);
  if (earlier === null) return row;
  // An earlier attempt's late answer said it went out too: two copies.
  await recordPostDuplicate(ctx, row, {
    attempts: [earlier, attempt],
    proven: true,
    otherUrl: answer.url ?? null,
  });
  return (await currentPost(ctx, row)) ?? row;
}

/**
 * The success answer of an attempt that lost its claim (see module doc): a post published by a
 * newer attempt went out twice; one a newer attempt is publishing right now remembers that this
 * one went out; any other status means nothing else went out, so the post is published now.
 */
async function settleLateSuccess(
  ctx: OpContext,
  claimed: Post,
  answer: PublishAnswer,
): Promise<Post> {
  const attempt = claimed.publish_attempt;
  const externalId = answer.externalId || null;
  const url = answer.url ?? null;
  for (let round = 0; round < LATE_ROUNDS; round++) {
    const fresh = await currentPost(ctx, claimed);
    if (!fresh) return claimed;
    if (fresh.status === "published") {
      // Recorded already from this attempt (a person confirmed it): nothing more to say.
      if (fresh.publish_attempt === attempt) return fresh;
      await recordPostDuplicate(ctx, fresh, {
        attempts: [attempt, fresh.publish_attempt],
        proven: true,
        otherUrl: url,
      });
      return (await currentPost(ctx, fresh)) ?? fresh;
    }
    if (fresh.status === "publishing") {
      if (fresh.publish_attempt === attempt) {
        const row = await recordPublished(ctx, fresh, {
          from: "publishing",
          attempt,
          externalId,
          url,
          note: null,
        });
        if (row) return row;
        continue;
      }
      const [kept] = await ctx.db
        .update(posts)
        .set({
          why: sql`coalesce(${posts.why}, '{}'::jsonb) || jsonb_build_object('earlier_attempt_went_out', ${attempt}::int)`,
          external_id: sql`coalesce(${posts.external_id}, ${externalId}::text)`,
          url: sql`coalesce(${posts.url}, ${url}::text)`,
        })
        .where(held(fresh, fresh.publish_attempt, "any"))
        .returning();
      if (kept) return kept;
      continue;
    }
    const newerUnknown = fresh.status === "unknown" && fresh.publish_attempt > attempt;
    const row = await recordPublished(ctx, fresh, {
      from: fresh.status,
      attempt: fresh.publish_attempt,
      externalId,
      url,
      note: `An earlier try's answer came late: it went out (try ${attempt}).`,
    });
    if (!row) continue;
    // A request to publish it again is moot now.
    await ctx.approvals.cancel({ target: { type: "post", id: row.id } }, "already published");
    if (newerUnknown) {
      await recordPostDuplicate(ctx, row, {
        attempts: [attempt, fresh.publish_attempt],
        proven: false,
      });
    }
    return row;
  }
  ctx.log.warn(
    { post_id: claimed.id, attempt },
    "a late answer said a post went out, but the post kept changing; it is not recorded",
  );
  return (await currentPost(ctx, claimed)) ?? claimed;
}

/**
 * Posts whose publish attempt stopped mid-call (`publishing` for POST_STUCK_MS: the worker
 * stopped or the job ran out of time) become `unknown` with a `send_unknown` problem. Returns
 * how many. Run by `content.publish_due` whatever the workspace status.
 */
export async function sweepStuckPublishes(ctx: OpContext, workspaceId: string): Promise<number> {
  const before = new Date(ctx.clock.now().getTime() - POST_STUCK_MS);
  const stuck = await ctx.db
    .select()
    .from(posts)
    .where(
      and(
        eq(posts.workspace_id, workspaceId),
        eq(posts.status, "publishing"),
        lt(posts.publish_started_at, before),
      ),
    )
    .orderBy(asc(posts.publish_started_at))
    .limit(STUCK_BATCH);
  const detail =
    "the publish stopped before an answer came back (the worker stopped or the job ran out of time)";
  let settled = 0;
  for (const post of stuck) {
    const [row] = await ctx.db
      .update(posts)
      .set({
        status: "unknown",
        error: "publish_interrupted",
        why: withPublishNote(unknownNote(detail)),
      })
      .where(held(post, post.publish_attempt, "none"))
      .returning();
    if (row) {
      await openPostUnknownProblem(ctx, row, detail);
      settled++;
      continue;
    }
    // A late answer showed an earlier attempt went out: published from it, and the stopped
    // attempt may have gone out too.
    const fresh = await currentPost(ctx, post);
    const earlier =
      fresh?.status === "publishing" && fresh.publish_attempt === post.publish_attempt
        ? earlierPublishWentOut(fresh)
        : null;
    if (!fresh || earlier === null) continue;
    const published = await recordPublished(ctx, fresh, {
      from: "publishing",
      attempt: fresh.publish_attempt,
      externalId: null,
      url: null,
      note: `An earlier try went out (try ${earlier}).`,
    });
    if (published) {
      await recordPostDuplicate(ctx, published, {
        attempts: [earlier, fresh.publish_attempt],
        proven: false,
      });
      settled++;
    }
  }
  return settled;
}
