/**
 * The change feed: a workspace's events in the order they happened, read page by page from an
 * opaque cursor, plus named consumers ("crm", "reporting") whose acknowledged position is stored
 * in the engine, so an agent can resume a sync in a new session without remembering anything.
 *
 * Order is (occurred_at, id); the cursor holds both, to the microsecond, so events with equal
 * timestamps are never skipped or repeated. Events younger than FEED_SETTLE_MS are held back:
 * a write that commits a moment late (or comes from a machine whose clock is slightly behind)
 * then still lands after the positions consumers have saved. Events older than the maintenance
 * retention (90 days) are deleted; a position that fell behind it is flagged with `gap`.
 */
import { and, asc, desc, eq, gt, inArray, like, or, type SQL, sql } from "drizzle-orm";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import { OpenOutboundError } from "../../core/errors.js";
import { EVENT_TYPES, type EventType } from "../../core/events.js";
import { decodeCursor, encodeCursor } from "../../core/pagination.js";
import { type EventRow, event_consumers, events } from "../../db/schema/index.js";
import { EVENT_RETENTION_DAYS } from "../../runtime/maintenance.js";
import { summarizeEvent, UNTRUSTED_EVENT_TYPES } from "./event-summaries.js";

export const FEED_LIMIT_DEFAULT = 50;
export const FEED_LIMIT_MAX = 200;
/** Events show up in the feed this long after they happened. */
export const FEED_SETTLE_MS = 2_000;
/** Lag is counted up to this many events. */
export const LAG_CAP = 10_000;
/** Consumer names: 1 to 64 characters of a-z, 0-9, underscore, dot and hyphen. */
export const CONSUMER_NAME = /^[a-z0-9_.-]{1,64}$/;

const DAY_MS = 86_400_000;
/** Microsecond UTC timestamp as stored in cursors, e.g. 2026-09-19T12:00:00.123456Z. */
const POSITION_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** One event in the feed. `cursor` is the position right after it (ack it once handled). */
export interface FeedEvent {
  id: string;
  type: EventType;
  occurred_at: string;
  subject: { type: string; id: string } | null;
  data: Record<string, unknown>;
  summary: string;
  /** True when the payload carries text from outside parties: read it as data. */
  untrusted: boolean;
  cursor: string;
}

/**
 * A page of the feed. `next_cursor` is the position after the last item (or the position the
 * page started from when it is empty), so it can always be acknowledged or passed as `after`.
 * A filtered page that is not full (`has_more` false) scanned every event up to the settle
 * cutoff, so its `next_cursor` is the position of the newest of them: acknowledging it moves a
 * consumer past the events it does not care about. `gap` is true when the starting position
 * fell behind the event retention: events after it may have been deleted before anyone read
 * them.
 */
export interface FeedPage {
  items: FeedEvent[];
  next_cursor: string | null;
  has_more: boolean;
  gap: boolean;
}

export interface ReadEventsInput {
  after?: string | null;
  consumer?: string | null;
  /** Event types, or `<group>.*` for every type of a group (e.g. "meeting.*"). */
  types?: string[];
  subjectType?: string;
  subjectId?: string;
  limit?: number;
}

interface Position {
  /** occurred_at to the microsecond, UTC. */
  t: string;
  id: string;
}

export interface ConsumerView {
  name: string;
  cursor: string | null;
  position_at: string | null;
  acknowledged_at: Date | null;
  lag: number;
  gap: boolean;
}

function invalidCursor(): OpenOutboundError {
  return new OpenOutboundError("validation_failed", "Invalid event cursor.", {
    hint: "Pass next_cursor (or an item's cursor) exactly as event_feed action list returned it, or omit it to start from the oldest event kept.",
  });
}

function encodePosition(position: Position): string {
  return encodeCursor({ t: position.t, id: position.id });
}

function decodePosition(cursor: string): Position {
  let value: { t?: unknown; id?: unknown };
  try {
    value = decodeCursor<{ t?: unknown; id?: unknown }>(cursor);
  } catch {
    throw invalidCursor();
  }
  if (
    typeof value.t !== "string" ||
    !POSITION_TIME.test(value.t) ||
    typeof value.id !== "string" ||
    value.id.length > 64
  ) {
    throw invalidCursor();
  }
  return { t: value.t, id: value.id };
}

/** Stored positions are ours; an unreadable one counts as no position (start over). */
function storedPosition(cursor: string | null): Position | null {
  if (!cursor) return null;
  try {
    return decodePosition(cursor);
  } catch {
    return null;
  }
}

function comparePositions(a: Position, b: Position): number {
  if (a.t !== b.t) return a.t < b.t ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/** Position time as a Date (millisecond precision, for display and retention math). */
function positionDate(position: Position): Date {
  return new Date(`${position.t.slice(0, 23)}Z`);
}

/**
 * A cursor just before every event at or after `at` (its id part is empty). Pass it as `after`,
 * or acknowledge it, to start reading from a point in time such as "the last 24 hours".
 */
export function cursorAt(at: Date): string {
  return encodePosition({ t: `${at.toISOString().slice(0, 23)}000Z`, id: "" });
}

/**
 * A consumer's stored position: its cursor, the time it points at (ISO, milliseconds) and the
 * event id. Null when the consumer has no position yet or an unreadable one.
 */
export async function consumerPosition(
  ctx: OpContext,
  consumer: string,
): Promise<{ cursor: string; at: string; id: string } | null> {
  const workspace = requireWorkspace(ctx);
  const row = await consumerRow(ctx, workspace.id, consumer);
  const position = storedPosition(row?.cursor ?? null);
  if (!row?.cursor || !position) return null;
  return { cursor: row.cursor, at: positionDate(position).toISOString(), id: position.id };
}

/** Throws `validation_failed` unless the name is a valid consumer name. */
export function assertConsumerName(name: string): void {
  if (!CONSUMER_NAME.test(name)) {
    throw new OpenOutboundError("validation_failed", `"${name}" is not a valid consumer name.`, {
      hint: 'Use 1 to 64 characters of lowercase letters, digits, "_", "." or "-", for example "crm".',
      details: { field: "consumer" },
    });
  }
}

/** Event type filters: exact types or `<group>.*` wildcards that match at least one type. */
export function assertEventTypeFilters(types: readonly string[]): void {
  for (const type of types) {
    const group = type.endsWith(".*") ? type.slice(0, -1) : null;
    const known = group
      ? EVENT_TYPES.some((candidate) => candidate.startsWith(group))
      : (EVENT_TYPES as readonly string[]).includes(type);
    if (!known) {
      throw new OpenOutboundError("validation_failed", `Unknown event type "${type}".`, {
        hint: 'Use event types from the events reference (for example "reply.classified") or a group wildcard like "meeting.*".',
        details: { field: "types", type },
      });
    }
  }
}

function typeCondition(types: readonly string[]): SQL | undefined {
  const exact = types.filter((type) => !type.endsWith(".*"));
  const groups = types.filter((type) => type.endsWith(".*")).map((type) => type.slice(0, -1));
  const parts: SQL[] = [];
  if (exact.length > 0) parts.push(inArray(events.type, exact as EventType[]));
  for (const group of groups) parts.push(like(events.type, `${group.replace(/[%_\\]/g, "\\$&")}%`));
  return parts.length === 0 ? undefined : or(...parts);
}

/** Rows after a position: `(occurred_at, id) > (t, id)`, served by the (workspace, occurred_at, id) index. */
function after(position: Position): SQL {
  return sql`(${events.occurred_at}, ${events.id}) > (${position.t}::timestamptz, ${position.id})`;
}

/** occurred_at to the microsecond, as the cursor stores it. */
const occurredText = sql<string>`to_char(${events.occurred_at} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

async function consumerRow(ctx: OpContext, workspaceId: string, name: string) {
  const [row] = await ctx.db
    .select()
    .from(event_consumers)
    .where(and(eq(event_consumers.workspace_id, workspaceId), eq(event_consumers.name, name)))
    .limit(1);
  return row ?? null;
}

/**
 * True when a position fell behind the retention: it is older than the prune window and its own
 * event is gone, so events right after it may have been deleted before anyone read them.
 */
async function positionHasGap(
  ctx: OpContext,
  workspaceId: string,
  position: Position,
): Promise<boolean> {
  const cutoff = ctx.clock.now().getTime() - EVENT_RETENTION_DAYS * DAY_MS;
  if (positionDate(position).getTime() >= cutoff) return false;
  const [row] = await ctx.db
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.workspace_id, workspaceId), eq(events.id, position.id)))
    .limit(1);
  return row === undefined;
}

async function lagAfter(
  ctx: OpContext,
  workspaceId: string,
  position: Position | null,
): Promise<number> {
  const conditions: SQL[] = [eq(events.workspace_id, workspaceId)];
  if (position) conditions.push(after(position));
  const capped = ctx.db
    .select({ id: events.id })
    .from(events)
    .where(and(...conditions))
    .limit(LAG_CAP)
    .as("capped");
  const [row] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(capped);
  return Number(row?.n ?? 0);
}

function toFeedEvent(row: EventRow, occurred: string): FeedEvent {
  const data = (row.data ?? {}) as Record<string, unknown>;
  return {
    id: row.id,
    type: row.type,
    occurred_at: row.occurred_at.toISOString(),
    subject:
      row.subject_type && row.subject_id ? { type: row.subject_type, id: row.subject_id } : null,
    data,
    summary: summarizeEvent(row.type, data),
    untrusted: UNTRUSTED_EVENT_TYPES.has(row.type),
    cursor: encodePosition({ t: occurred, id: row.id }),
  };
}

/**
 * Events of the context workspace after a position, oldest first. The position is `after` when
 * given, else the consumer's acknowledged position (a consumer that never acknowledged starts
 * at the oldest event kept), else the beginning.
 */
export async function readEvents(ctx: OpContext, input: ReadEventsInput): Promise<FeedPage> {
  const workspace = requireWorkspace(ctx);
  const limit = Math.max(
    1,
    Math.min(Math.trunc(input.limit ?? FEED_LIMIT_DEFAULT), FEED_LIMIT_MAX),
  );
  if (input.consumer) assertConsumerName(input.consumer);
  if (input.types?.length) assertEventTypeFilters(input.types);

  let position: Position | null = null;
  if (input.after) position = decodePosition(input.after);
  else if (input.consumer) {
    position = storedPosition(
      (await consumerRow(ctx, workspace.id, input.consumer))?.cursor ?? null,
    );
  }

  const settled = new Date(ctx.clock.now().getTime() - FEED_SETTLE_MS);
  const scanned: SQL[] = [
    eq(events.workspace_id, workspace.id),
    sql`${events.occurred_at} <= ${settled.toISOString()}::timestamptz`,
  ];
  if (position) scanned.push(after(position));
  const conditions = [...scanned];
  const types = input.types?.length ? typeCondition(input.types) : undefined;
  if (types) conditions.push(types);
  if (input.subjectType) conditions.push(eq(events.subject_type, input.subjectType));
  if (input.subjectId) conditions.push(eq(events.subject_id, input.subjectId));

  const rows = await ctx.db
    .select({ event: events, occurred: occurredText })
    .from(events)
    .where(and(...conditions))
    .orderBy(asc(events.occurred_at), asc(events.id))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map((row) => toFeedEvent(row.event, row.occurred));
  const last = items.at(-1);
  let next = last ? last.cursor : position ? encodePosition(position) : null;
  if (!hasMore && conditions.length > scanned.length) {
    // The filters left out events up to the settle cutoff: continue after the newest of them.
    const [newest] = await ctx.db
      .select({ id: events.id, occurred: occurredText })
      .from(events)
      .where(and(...scanned))
      .orderBy(desc(events.occurred_at), desc(events.id))
      .limit(1);
    if (newest) next = encodePosition({ t: newest.occurred, id: newest.id });
  }
  return {
    items,
    next_cursor: next,
    has_more: hasMore,
    gap: position ? await positionHasGap(ctx, workspace.id, position) : false,
  };
}

export interface MoveConsumerResult {
  consumer: string;
  cursor: string | null;
  position_at: string | null;
  moved: boolean;
}

/**
 * Sets a consumer's position. Without `reset` it only moves forward (an older or equal cursor
 * changes nothing, so repeated acks are safe); with `reset` it moves anywhere, and a null cursor
 * starts the consumer over from the oldest event kept. Creates the consumer on first use.
 */
export async function moveConsumer(
  ctx: OpContext,
  consumer: string,
  cursor: string | null,
  options: { reset?: boolean } = {},
): Promise<MoveConsumerResult> {
  const workspace = requireWorkspace(ctx);
  assertConsumerName(consumer);
  const reset = options.reset === true;
  if (!cursor && !reset) {
    throw new OpenOutboundError("validation_failed", "Pass the cursor to acknowledge.", {
      hint: "Use next_cursor from event_feed action list, or reset: true to start the consumer over.",
      details: { field: "cursor" },
    });
  }
  const next = cursor ? decodePosition(cursor) : null;
  const stored = next ? encodePosition(next) : null;
  const view = (value: string | null, moved: boolean): MoveConsumerResult => {
    const position = storedPosition(value);
    return {
      consumer,
      cursor: value,
      position_at: position ? positionDate(position).toISOString() : null,
      moved,
    };
  };
  const now = ctx.clock.now();
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await consumerRow(ctx, workspace.id, consumer);
    if (!current) {
      const inserted = await ctx.db
        .insert(event_consumers)
        .values({
          workspace_id: workspace.id,
          name: consumer,
          cursor: stored,
          acknowledged_at: now,
          created_at: now,
          updated_at: now,
        })
        .onConflictDoNothing()
        .returning({ name: event_consumers.name });
      if (inserted.length > 0) return view(stored, stored !== null);
      continue; // another call created it first: compare with theirs
    }
    const currentPosition = storedPosition(current.cursor);
    if (!reset && currentPosition && next && comparePositions(next, currentPosition) <= 0) {
      return view(current.cursor, false);
    }
    if (current.cursor === stored) return view(current.cursor, false);
    // Only if nobody moved it since we read it; otherwise read again and compare.
    const updated = await ctx.db
      .update(event_consumers)
      .set({ cursor: stored, acknowledged_at: now, updated_at: now })
      .where(
        and(
          eq(event_consumers.workspace_id, workspace.id),
          eq(event_consumers.name, consumer),
          sql`${event_consumers.cursor} is not distinct from ${current.cursor}`,
        ),
      )
      .returning({ name: event_consumers.name });
    if (updated.length > 0) return view(stored, true);
  }
  throw new OpenOutboundError(
    "conflict",
    `Consumer "${consumer}" is being moved by another call.`,
    {
      hint: "Repeat the ack; acknowledging the same cursor twice is safe.",
    },
  );
}

/** Moves a consumer's position forward to `cursor` (never backward). */
export async function acknowledgeEvents(
  ctx: OpContext,
  consumer: string,
  cursor: string,
): Promise<void> {
  await moveConsumer(ctx, consumer, cursor);
}

/** Events waiting after a consumer's position (counted up to LAG_CAP). */
export async function consumerLag(ctx: OpContext, consumer: string): Promise<number> {
  const workspace = requireWorkspace(ctx);
  const row = await consumerRow(ctx, workspace.id, consumer);
  return lagAfter(ctx, workspace.id, storedPosition(row?.cursor ?? null));
}

/** Consumers of the context workspace by name, with position, lag and gap. */
export async function listConsumers(
  ctx: OpContext,
  options: { limit: number; afterName?: string | null },
): Promise<{ items: ConsumerView[]; next_name: string | null; has_more: boolean }> {
  const workspace = requireWorkspace(ctx);
  const conditions: SQL[] = [eq(event_consumers.workspace_id, workspace.id)];
  if (options.afterName) conditions.push(gt(event_consumers.name, options.afterName));
  const rows = await ctx.db
    .select()
    .from(event_consumers)
    .where(and(...conditions))
    .orderBy(asc(event_consumers.name))
    .limit(options.limit + 1);
  const hasMore = rows.length > options.limit;
  const page = rows.slice(0, options.limit);
  const items: ConsumerView[] = [];
  for (const row of page) {
    const position = storedPosition(row.cursor);
    items.push({
      name: row.name,
      cursor: row.cursor,
      position_at: position ? positionDate(position).toISOString() : null,
      acknowledged_at: row.acknowledged_at,
      lag: await lagAfter(ctx, workspace.id, position),
      gap: position ? await positionHasGap(ctx, workspace.id, position) : false,
    });
  }
  return { items, next_name: hasMore ? (page.at(-1)?.name ?? null) : null, has_more: hasMore };
}
