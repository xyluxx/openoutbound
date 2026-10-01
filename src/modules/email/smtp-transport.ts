import { createHash } from "node:crypto";
import nodemailer, { type SMTPPoolOptions, type Transporter } from "nodemailer";
import type { NodemailerError } from "nodemailer/lib/errors";
import { toMailOptions } from "./compose.js";
import type { MailAuth } from "./credentials.js";
import { StoppedSendError } from "./send-errors.js";
import type { EmailTransport, RecipientRejection, SendOptions, SendResult } from "./transport.js";

export interface SmtpSettings {
  mailboxId: string;
  host: string;
  port: number;
  /** true = implicit TLS (465); false = STARTTLS (587). */
  secure: boolean;
  auth: MailAuth;
  /** EHLO name (the mailbox domain). */
  name?: string;
}

/**
 * How long one send may take, from waiting for the mailbox's connection to the server's answer
 * after the data. Well below the send job's 2 minute timeout, so the job settles the outcome
 * itself and no SMTP session outlives it.
 */
export const SMTP_SEND_DEADLINE_MS = 90_000;
let sendDeadlineMs = SMTP_SEND_DEADLINE_MS;

/** Changes the send deadline (tests use a short one); without an argument it is the default. */
export function setSmtpSendDeadline(ms = SMTP_SEND_DEADLINE_MS): void {
  sendDeadlineMs = ms;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Loopback hosts (local relays, tests) may skip STARTTLS; everything else must use TLS. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host.toLowerCase()) || host.toLowerCase().endsWith(".localhost");
}

/**
 * Pooled nodemailer options: one connection per mailbox, TLS verification always on, and never
 * a silent resend: a message whose connection closes while it is being sent fails instead of
 * being queued again (the send job decides, see send-errors.ts `isDeliveryUncertain`).
 */
export function smtpPoolOptions(settings: SmtpSettings): SMTPPoolOptions {
  const auth =
    settings.auth.kind === "password"
      ? { user: settings.auth.user, pass: settings.auth.pass }
      : {
          type: "OAuth2",
          user: settings.auth.user,
          accessToken: settings.auth.accessToken,
          expires: settings.auth.expiresAt.getTime(),
        };
  return {
    pool: true,
    maxConnections: 1,
    maxMessages: 50,
    maxRequeues: 0,
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    requireTLS: !settings.secure && !isLoopbackHost(settings.host),
    tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
    auth,
    ...(settings.name ? { name: settings.name } : {}),
    connectionTimeout: 30_000,
    greetingTimeout: 20_000,
    socketTimeout: 60_000,
    logger: false,
  };
}

const pools = new Map<string, { key: string; transporter: Transporter }>();

/**
 * The sends of one mailbox take turns, one at a time like its single pooled connection, so a
 * send that runs out of time while it waits leaves the line and never goes out later from
 * nodemailer's own queue. `dataStarted` belongs to the send whose turn it is.
 */
interface Line {
  busy: boolean;
  waiting: Array<() => void>;
  dataStarted: boolean;
}

const lines = new Map<string, Line>();

/** Waits for the mailbox's turn; rejects and leaves the line when `stop` fires first. */
function takeTurn(mailboxId: string, stop: AbortSignal): Promise<Line> {
  let line = lines.get(mailboxId);
  if (!line) {
    line = { busy: false, waiting: [], dataStarted: false };
    lines.set(mailboxId, line);
  }
  const own = line;
  if (stop.aborted) return Promise.reject(stop.reason);
  if (!own.busy) {
    own.busy = true;
    own.dataStarted = false;
    return Promise.resolve(own);
  }
  return new Promise((resolve, reject) => {
    const go = () => {
      stop.removeEventListener("abort", leave);
      own.dataStarted = false;
      resolve(own);
    };
    const leave = () => {
      const index = own.waiting.indexOf(go);
      if (index >= 0) own.waiting.splice(index, 1);
      reject(stop.reason);
    };
    own.waiting.push(go);
    stop.addEventListener("abort", leave, { once: true });
  });
}

/** Hands the mailbox's turn to the next send in line. */
function passTurn(mailboxId: string, line: Line): void {
  const next = line.waiting.shift();
  if (next) {
    next();
    return;
  }
  line.busy = false;
  if (lines.get(mailboxId) === line) lines.delete(mailboxId);
}

/**
 * A nodemailer logger that prints nothing and notes when the mailbox's session sends the DATA
 * command (the session log of `transactionLog`), after which the message may be delivered.
 */
function dataWatch(mailboxId: string) {
  const ignore = () => {};
  return {
    trace: ignore,
    info: ignore,
    warn: ignore,
    error: ignore,
    fatal: ignore,
    debug(entry: { tnx?: unknown } | undefined, message: unknown) {
      if (entry?.tnx !== "client" || message !== "DATA") return;
      const line = lines.get(mailboxId);
      if (line) line.dataStarted = true;
    },
  };
}

function poolKey(settings: SmtpSettings): string {
  const secret = settings.auth.kind === "password" ? settings.auth.pass : settings.auth.accessToken;
  return createHash("sha256")
    .update(
      JSON.stringify([settings.host, settings.port, settings.secure, settings.auth.user, secret]),
    )
    .digest("hex");
}

function transporterFor(settings: SmtpSettings): Transporter {
  const key = poolKey(settings);
  const existing = pools.get(settings.mailboxId);
  if (existing?.key === key) return existing.transporter;
  existing?.transporter.close();
  const transporter = nodemailer.createTransport({
    ...smtpPoolOptions(settings),
    transactionLog: true,
    logger: dataWatch(settings.mailboxId),
  } as SMTPPoolOptions & { pool: true });
  pools.set(settings.mailboxId, { key, transporter });
  return transporter;
}

/** Closes pooled connections (one mailbox, or all). */
export function closeSmtpPools(mailboxId?: string): void {
  for (const [id, entry] of pools) {
    if (mailboxId && id !== mailboxId) continue;
    entry.transporter.close();
    pools.delete(id);
  }
}

/**
 * Ends the transporter's sessions at once, one that is sending included. nodemailer's close()
 * lets a send in progress finish, so the pool's connections (not part of its public API) are
 * closed directly. The mailbox's next send opens a new connection.
 */
function tearDown(mailboxId: string, transporter: Transporter): void {
  if (pools.get(mailboxId)?.transporter === transporter) pools.delete(mailboxId);
  transporter.close();
  const pool = (transporter as unknown as { transporter?: { _connections?: unknown } }).transporter;
  const connections = pool?._connections;
  if (!Array.isArray(connections)) return;
  for (const connection of [...connections]) {
    (connection as { close?: () => void }).close?.();
  }
}

/** Fires at the send deadline, or when the caller's signal fires (its job ended). */
function sendLimit(signal: AbortSignal | undefined) {
  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(`the mail server did not finish within ${sendDeadlineMs / 1000} seconds`),
    sendDeadlineMs,
  );
  const ended = () => controller.abort("its job ended before the mail server finished");
  if (signal?.aborted) ended();
  else signal?.addEventListener("abort", ended, { once: true });
  return {
    signal: controller.signal,
    clear() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", ended);
    },
  };
}

const STOPPED = Symbol("stopped");

/** Resolves with `STOPPED` when the signal fires. */
function whenStopped(signal: AbortSignal): Promise<typeof STOPPED> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve(STOPPED);
    signal.addEventListener("abort", () => resolve(STOPPED), { once: true });
  });
}

function rejection(error: NodemailerError): RecipientRejection {
  return {
    recipient: error.recipient ?? null,
    responseCode: error.responseCode ?? null,
    response: error.response ?? error.message ?? null,
  };
}

/**
 * SMTP transport over a pooled nodemailer connection for one mailbox. A send has a deadline
 * (`SMTP_SEND_DEADLINE_MS`, waiting for the connection included) and also stops when its job
 * ends: the session is closed then and the send fails with a `StoppedSendError` that says
 * whether the message data may have gone out.
 */
export function smtpTransport(settings: SmtpSettings): EmailTransport {
  return {
    kind: "smtp",
    async send(email, options: SendOptions = {}): Promise<SendResult> {
      const limit = sendLimit(options.signal);
      try {
        let line: Line;
        try {
          line = await takeTurn(settings.mailboxId, limit.signal);
        } catch {
          throw new StoppedSendError(
            `The send was stopped before it started: ${String(limit.signal.reason)}.`,
            false,
          );
        }
        let info: unknown;
        try {
          const transporter = transporterFor(settings);
          const sending = transporter.sendMail(toMailOptions(email));
          // A stopped send settles later on its own; its result is not used.
          sending.catch(() => {});
          info = await Promise.race([sending, whenStopped(limit.signal)]);
          if (info === STOPPED) {
            tearDown(settings.mailboxId, transporter);
            throw new StoppedSendError(
              `The send was stopped: ${String(limit.signal.reason)}; the engine closed the connection.`,
              line.dataStarted,
            );
          }
        } finally {
          passTurn(settings.mailboxId, line);
        }
        const data = info as {
          messageId?: string;
          accepted?: Array<string | { address: string }>;
          rejected?: Array<string | { address: string }>;
          rejectedErrors?: NodemailerError[];
          response?: string;
        };
        const addresses = (list: Array<string | { address: string }> | undefined) =>
          (list ?? []).map((entry) => (typeof entry === "string" ? entry : entry.address));
        const queueId = data.response?.match(/queued as ([\w.-]+)/i)?.[1] ?? null;
        return {
          providerMessageId: queueId ?? data.response ?? null,
          accepted: addresses(data.accepted),
          rejected: addresses(data.rejected),
          rejectedErrors: (data.rejectedErrors ?? []).map(rejection),
          response: data.response ?? null,
        };
      } finally {
        limit.clear();
      }
    },
    async verify() {
      // A one-off (non-pooled) connection so a bad login never poisons the pool.
      const options = { ...smtpPoolOptions(settings), pool: false };
      const transporter = nodemailer.createTransport(options);
      try {
        await transporter.verify();
      } finally {
        transporter.close();
      }
    },
  };
}
