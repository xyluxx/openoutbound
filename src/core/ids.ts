import { getRandomValues } from "node:crypto";
import { z } from "zod";

/**
 * Id prefix per table (spec section 7). Ids look like `pe_01k6a3v0q8x3...` (prefix + 26 chars).
 * Tables with composite keys (idempotency_records, list_members, linkedin_relations,
 * sender_counters, crm_links) have no prefix.
 */
export const ID_PREFIX = {
  workspace: "ws",
  apiKey: "key",
  secret: "sec",
  providerSetting: "prv",
  auditEvent: "aud",
  approval: "apr",
  job: "job",
  schedule: "sch",
  event: "evt",
  webhookEndpoint: "whk",
  webhookDelivery: "whd",
  usageRecord: "use",
  agentTask: "tsk",
  automationRule: "rul",
  notificationChannel: "ntf",
  report: "rpt",
  knowledgeItem: "kn",
  offer: "off",
  knowledgeGap: "gap",
  company: "co",
  person: "pe",
  list: "ls",
  icp: "icp",
  import: "imp",
  suppression: "sup",
  savedSearch: "ss",
  researchBrief: "rb",
  pageSnapshot: "snap",
  signalDefinition: "sd",
  signal: "sig",
  monitor: "mon",
  mailbox: "mbx",
  linkedinAccount: "lia",
  campaign: "cmp",
  campaignStep: "stp",
  enrollment: "enr",
  thread: "thr",
  message: "msg",
  template: "tpl",
  opportunity: "opp",
  task: "tk",
  post: "pst",
  meeting: "mt",
  leadFact: "lf",
  problem: "pb",
  change: "chg",
  proposal: "prop",
} as const;

export type IdPrefix = (typeof ID_PREFIX)[keyof typeof ID_PREFIX];

/** Crockford base32, lowercase (decoding is case-insensitive by definition). */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const TIME_LEN = 10;
const RANDOM_LEN = 16;
const BODY_LEN = TIME_LEN + RANDOM_LEN;
const MAX_TIME = 2 ** 48 - 1;

let lastTime = -1;
let lastRandom: Uint8Array = new Uint8Array(10);

function encodeTime(ms: number): string {
  let out = "";
  let value = ms;
  for (let i = 0; i < TIME_LEN; i++) {
    out = ALPHABET.charAt(value % 32) + out;
    value = Math.floor(value / 32);
  }
  return out;
}

/** Encodes 80 bits (10 bytes) as 16 base32 chars. */
function encodeRandom(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET.charAt((buffer >> bits) & 31);
    }
    buffer &= (1 << bits) - 1;
  }
  return out;
}

/** Adds one to an 80-bit big-endian number; returns false on overflow. */
function increment(bytes: Uint8Array): boolean {
  for (let i = bytes.length - 1; i >= 0; i--) {
    const next = (bytes[i] ?? 0) + 1;
    if (next <= 255) {
      bytes[i] = next;
      return true;
    }
    bytes[i] = 0;
  }
  return false;
}

/**
 * New id `<prefix>_<26 chars>`: 48-bit ms timestamp + 80 random bits, Crockford base32.
 * Lexicographically sortable by creation time, and strictly increasing within one process
 * (same-millisecond ids increment the random part), so `order by id` follows insert order.
 * Pass `at` to mint an id for a past or future moment (no monotonic guarantee then).
 */
export function newId(prefix: IdPrefix | (string & {}), at?: Date): string {
  let time: number;
  let random: Uint8Array;
  if (at) {
    time = at.getTime();
    random = getRandomValues(new Uint8Array(10));
  } else {
    time = Date.now();
    if (time <= lastTime) {
      time = lastTime;
      random = lastRandom;
      if (!increment(random)) {
        // 2^80 ids in one millisecond: move to the next millisecond instead.
        time = lastTime + 1;
        random = getRandomValues(new Uint8Array(10));
      }
    } else {
      random = getRandomValues(new Uint8Array(10));
    }
    lastTime = time;
    lastRandom = random;
  }
  if (!Number.isInteger(time) || time < 0 || time > MAX_TIME) {
    throw new RangeError(`newId: timestamp out of range (${time})`);
  }
  return `${prefix}_${encodeTime(time)}${encodeRandom(random)}`;
}

const ID_BODY = `[0-9a-hjkmnp-tv-z]{${BODY_LEN}}`;

/** True when `value` looks like an id (optionally with the given prefix). */
export function isId(value: unknown, prefix?: IdPrefix | (string & {})): value is string {
  if (typeof value !== "string") return false;
  const pattern = prefix ? `^${prefix}_${ID_BODY}$` : `^[a-z][a-z0-9]*_${ID_BODY}$`;
  return new RegExp(pattern).test(value);
}

/** Creation time encoded in an id. Throws on malformed ids. */
export function idTimestamp(id: string): Date {
  const body = id.slice(id.lastIndexOf("_") + 1);
  if (body.length !== BODY_LEN) throw new RangeError(`Not an OpenOutbound id: ${id}`);
  let ms = 0;
  for (const char of body.slice(0, TIME_LEN).toLowerCase()) {
    const digit = ALPHABET.indexOf(char);
    if (digit === -1) throw new RangeError(`Not an OpenOutbound id: ${id}`);
    ms = ms * 32 + digit;
  }
  return new Date(ms);
}

/**
 * Zod schema for an id with the given prefix, for operation inputs:
 * `person_id: idSchema("pe")`. The error message names the expected shape.
 */
export function idSchema(prefix: IdPrefix | (string & {})) {
  return z
    .string()
    .regex(new RegExp(`^${prefix}_${ID_BODY}$`), {
      message: `Expected an id like ${prefix}_01k6... (${prefix}_ followed by 26 characters)`,
    })
    .describe(`Id with prefix "${prefix}_"`);
}
