import { eq, type SQL, sql } from "drizzle-orm";
import { signal_definitions } from "../../../db/schema/index.js";
import { metric, rate, round2 } from "../metric.js";
import type { SignalRow, SignalsData } from "../schemas.js";
import {
  CONTACT_ACTIONS,
  inWorkspaces,
  literalList,
  meetingOutcomesDef,
  meetingsDefs,
  POSITIVE_CATEGORIES,
  repliesDef,
  rows,
  sentDef,
  windowsDef,
  withDefs,
} from "../sql.js";
import { type BuildArgs, type Built, windowsOf } from "./common.js";

/** Minimum sample per arm before a weight is suggested (signals playbook, section 8). */
export const MIN_PEOPLE_FOR_WEIGHT = 150;
export const MIN_POSITIVES_FOR_WEIGHT = 5;
const PSEUDO_SENDS = 100;
const MAX_WEIGHT_STEP = 15;

/**
 * `sent_keys` and `reached`: signal keys used by each sent message (why.signal_keys, plus the
 * definition keys of why.signal_ids), and per key the people reached with their first such
 * message. Requires `w` and `sent`.
 */
function reachedDefs(): SQL[] {
  return [
    sql`sent_keys as (
      select s.id, s.workspace_id, s.idx, s.person_id, s.sent_at, k.key
      from sent s
      cross join lateral (
        select jsonb_array_elements_text(
          case when jsonb_typeof(s.why->'signal_keys') = 'array'
            then s.why->'signal_keys' else '[]'::jsonb end
        ) as key
        union
        select sg.definition_key from signals sg
        where sg.workspace_id = s.workspace_id and sg.id in (
          select jsonb_array_elements_text(
            case when jsonb_typeof(s.why->'signal_ids') = 'array'
              then s.why->'signal_ids' else '[]'::jsonb end
          )
        )
      ) k
      where s.person_id is not null
    )`,
    sql`reached as (
      select workspace_id, idx, key, person_id, min(sent_at) as first_at, count(*)::int as messages
      from sent_keys
      group by 1, 2, 3, 4
    )`,
  ];
}

const repliedAfter = (alias: string, positiveOnly: boolean) => sql`exists (
  select 1 from replies r
  where r.workspace_id = ${sql.raw(alias)}.workspace_id and r.idx = ${sql.raw(alias)}.idx
    and r.person_id = ${sql.raw(alias)}.person_id and r.at >= ${sql.raw(alias)}.first_at
    ${positiveOnly ? sql`and r.category in (${literalList(POSITIVE_CATEGORIES)})` : sql``}
)`;

interface KeyRow {
  idx: number;
  key: string;
  messages: number;
  people: number;
  replies: number;
  positive_replies: number;
}

/**
 * Signal attribution per signal key (spec 11.12): messages that used the signal, people reached,
 * their replies, positive replies, meetings booked and meetings held, compared with people
 * contacted without signals.
 */
export async function buildSignals(args: BuildArgs): Promise<Built<SignalsData>> {
  const ids = [args.workspace.id];
  const windows = windowsOf(args);
  const base = [windowsDef(windows), sentDef(ids), ...reachedDefs(), repliesDef(ids)];
  const [keyRows, meetingRows, heldRows, baselineRows, detectedRows, totalRows, definitions] =
    await Promise.all([
      rows<KeyRow>(
        args.db,
        sql`${withDefs(...base)}
          select re.idx, re.key, sum(re.messages)::int as messages, count(*)::int as people,
            count(*) filter (where ${repliedAfter("re", false)})::int as replies,
            count(*) filter (where ${repliedAfter("re", true)})::int as positive_replies
          from reached re
          group by 1, 2`,
      ),
      rows<{ idx: number; key: string; n: number }>(
        args.db,
        sql`${withDefs(windowsDef(windows), sentDef(ids), ...reachedDefs(), ...meetingsDefs(ids))}
          select m.idx, k.key, count(distinct m.id)::int as n
          from meetings m
          cross join lateral (
            select unnest(m.source_signal_keys) as key
            union
            select re.key from reached re
            where re.workspace_id = m.workspace_id and re.idx = m.idx
              and re.person_id = m.person_id and re.first_at <= m.at
          ) k
          group by 1, 2`,
      ),
      // Held meetings (by start time), attributed like booked ones: the opportunity's signal
      // keys, or a signal-based message to the person before the meeting was booked.
      rows<{ idx: number; key: string; n: number }>(
        args.db,
        sql`${withDefs(windowsDef(windows), sentDef(ids), ...reachedDefs(), meetingOutcomesDef(ids))}
          select m.idx, k.key, count(distinct m.id)::int as n
          from meeting_outcomes m
          cross join lateral (
            select unnest(m.source_signal_keys) as key
            union
            select re.key from reached re
            where re.workspace_id = m.workspace_id and re.idx = m.idx
              and re.person_id = m.person_id and re.first_at <= m.booked_at
          ) k
          where m.status = 'held'
          group by 1, 2`,
      ),
      rows<{ idx: number; people: number; replies: number; positive_replies: number }>(
        args.db,
        sql`${withDefs(
          ...base,
          sql`contacted as (
            select workspace_id, idx, person_id, min(sent_at) as first_at
            from sent
            where person_id is not null and action in (${literalList(CONTACT_ACTIONS)})
            group by 1, 2, 3
          )`,
        )}
          select c.idx, count(*)::int as people,
            count(*) filter (where ${repliedAfter("c", false)})::int as replies,
            count(*) filter (where ${repliedAfter("c", true)})::int as positive_replies
          from contacted c
          where not exists (
            select 1 from reached re
            where re.workspace_id = c.workspace_id and re.idx = c.idx and re.person_id = c.person_id
          )
          group by 1`,
      ),
      rows<{ idx: number; key: string; n: number }>(
        args.db,
        sql`${withDefs(windowsDef(windows))}
          select w.idx, s.definition_key as key, count(*)::int as n
          from signals s join w on s.detected_at >= w.f and s.detected_at < w.t
          where ${inWorkspaces("s", ids)}
          group by 1, 2`,
      ),
      rows<{ idx: number; messages: number; people: number; positive_replies: number }>(
        args.db,
        sql`${withDefs(
          ...base,
          sql`reached_any as (
            select workspace_id, idx, person_id, min(first_at) as first_at
            from reached group by 1, 2, 3
          )`,
        )}
          select ra.idx,
            (select count(distinct sk.id)::int from sent_keys sk where sk.idx = ra.idx) as messages,
            count(*)::int as people,
            count(*) filter (where ${repliedAfter("ra", true)})::int as positive_replies
          from reached_any ra
          group by 1`,
      ),
      args.db
        .select({
          key: signal_definitions.key,
          name: signal_definitions.name,
          weight: signal_definitions.weight,
        })
        .from(signal_definitions)
        .where(eq(signal_definitions.workspace_id, args.workspace.id)),
    ]);

  const baseline = baselineRows.find((row) => row.idx === 0) ?? {
    idx: 0,
    people: 0,
    replies: 0,
    positive_replies: 0,
  };
  const baselineRate = baseline.people > 0 ? baseline.positive_replies / baseline.people : null;
  const definitionByKey = new Map(definitions.map((row) => [row.key, row]));
  const keys = new Set<string>();
  for (const row of [...keyRows, ...meetingRows, ...heldRows, ...detectedRows]) {
    if (row.idx === 0) keys.add(row.key);
  }

  const keyList: SignalRow[] = [...keys].map((key) => {
    const usage = keyRows.find((row) => row.idx === 0 && row.key === key);
    const people = usage?.people ?? 0;
    const positive = usage?.positive_replies ?? 0;
    const meetings = meetingRows.find((row) => row.idx === 0 && row.key === key)?.n ?? 0;
    const definition = definitionByKey.get(key);
    const keyRate = people > 0 ? positive / people : null;
    return {
      key,
      name: definition?.name ?? null,
      detected: detectedRows.find((row) => row.idx === 0 && row.key === key)?.n ?? 0,
      messages: usage?.messages ?? 0,
      people,
      replies: usage?.replies ?? 0,
      positive_replies: positive,
      meetings,
      meetings_held: heldRows.find((row) => row.idx === 0 && row.key === key)?.n ?? 0,
      reply_rate: rate(usage?.replies ?? 0, people),
      positive_rate: rate(positive, people),
      meeting_rate: rate(meetings, people),
      lift:
        keyRate !== null && baselineRate !== null && baselineRate > 0
          ? round2(keyRate / baselineRate)
          : null,
      current_weight: definition?.weight ?? null,
      suggested_weight: suggestWeight({
        people,
        positives: positive,
        baselinePeople: baseline.people,
        baselinePositives: baseline.positive_replies,
        currentWeight: definition?.weight ?? null,
      }),
    };
  });
  keyList.sort(
    (a, b) => b.people - a.people || b.detected - a.detected || a.key.localeCompare(b.key),
  );

  const total = (idx: number) => totalRows.find((row) => row.idx === idx);
  const detectedTotal = (idx: number) =>
    detectedRows.filter((row) => row.idx === idx).reduce((sum, row) => sum + row.n, 0);
  const compare = args.previous !== null;
  const notes: string[] = [];
  if (keyList.every((row) => row.suggested_weight === null) && keyList.length > 0) {
    notes.push(
      `Suggested weights need at least ${MIN_PEOPLE_FOR_WEIGHT} people and ${MIN_POSITIVES_FOR_WEIGHT} positive replies per signal and in the no-signal baseline; until then compare lift with care.`,
    );
  }
  return {
    data: {
      type: "signals",
      metrics: {
        detected: metric(detectedTotal(0), compare ? detectedTotal(1) : undefined),
        messages: metric(total(0)?.messages ?? 0, compare ? (total(1)?.messages ?? 0) : undefined),
        people: metric(total(0)?.people ?? 0, compare ? (total(1)?.people ?? 0) : undefined),
        positive_replies: metric(
          total(0)?.positive_replies ?? 0,
          compare ? (total(1)?.positive_replies ?? 0) : undefined,
        ),
      },
      keys: keyList,
      baseline: {
        people: baseline.people,
        replies: baseline.replies,
        positive_replies: baseline.positive_replies,
        reply_rate: rate(baseline.replies, baseline.people),
        positive_rate: rate(baseline.positive_replies, baseline.people),
      },
    },
    metrics: [
      "detected",
      "messages",
      "people",
      "replies",
      "positive_replies",
      "meetings",
      "meetings_held",
      "reply_rate",
      "positive_rate",
      "meeting_rate",
      "lift",
      "suggested_weight",
    ],
    notes: [
      "Signal rows count replies from the people reached with the signal, after their first signal-based message in the period.",
      ...notes,
    ],
  };
}

/**
 * Suggested weight (signals playbook, section 8): smooth the key's positive rate toward the
 * rate its current weight implies (100 pseudo-sends), weight = 100 x (1 - 1 / relative rate),
 * clamped to 0-95 and at most 15 points from the current weight. Null without enough data.
 */
export function suggestWeight(input: {
  people: number;
  positives: number;
  baselinePeople: number;
  baselinePositives: number;
  currentWeight: number | null;
}): number | null {
  if (
    input.people < MIN_PEOPLE_FOR_WEIGHT ||
    input.positives < MIN_POSITIVES_FOR_WEIGHT ||
    input.baselinePeople < MIN_PEOPLE_FOR_WEIGHT ||
    input.baselinePositives < MIN_POSITIVES_FOR_WEIGHT
  ) {
    return null;
  }
  const baseline = input.baselinePositives / input.baselinePeople;
  const current = Math.min(95, Math.max(0, input.currentWeight ?? 0));
  const priorRate = baseline / (1 - current / 100);
  const smoothed = (input.positives + PSEUDO_SENDS * priorRate) / (input.people + PSEUDO_SENDS);
  const relative = smoothed / baseline;
  const raw = relative > 0 ? Math.round(100 * (1 - 1 / relative)) : 0;
  const clamped = Math.min(95, Math.max(0, raw));
  return Math.min(current + MAX_WEIGHT_STEP, Math.max(current - MAX_WEIGHT_STEP, clamped));
}
