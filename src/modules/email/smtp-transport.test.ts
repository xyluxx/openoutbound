import type { AddressInfo } from "node:net";
import { SMTPServer } from "smtp-server";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { OutgoingEmail } from "./compose.js";
import {
  classifySendError,
  isDeliveryUncertain,
  StoppedSendError,
  sendPhase,
} from "./send-errors.js";
import { closeSmtpPools, setSmtpSendDeadline, smtpTransport } from "./smtp-transport.js";

/** Envelopes the server saw start (MAIL FROM) and messages it answered with 250. */
const started: string[] = [];
const accepted: string[] = [];
let closedSessions = 0;
/** While set, the server holds every message's data without answering. */
let hold: Promise<void> | null = null;
let release: () => void = () => {};
let server: SMTPServer;
let port = 0;

function holdAnswers(): void {
  hold = new Promise<void>((resolve) => {
    release = resolve;
  });
}

beforeAll(async () => {
  server = new SMTPServer({
    logger: false,
    disabledCommands: ["STARTTLS"],
    allowInsecureAuth: true,
    onAuth(auth, _session, callback) {
      callback(null, { user: auth.username });
    },
    onMailFrom(address, _session, callback) {
      started.push(address.address);
      callback();
    },
    onData(stream, session, callback) {
      stream.on("data", () => {});
      stream.on("end", () => {
        const to = session.envelope.rcptTo.map((rcpt) => rcpt.address).join(",");
        const answer = () => {
          accepted.push(to);
          callback(null, "Ok: queued as ABC123");
        };
        if (hold) void hold.then(answer);
        else answer();
      });
    },
    onClose() {
      closedSessions += 1;
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.server.address() as AddressInfo).port;
});

afterAll(async () => {
  closeSmtpPools();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  release();
  hold = null;
  closeSmtpPools();
  setSmtpSendDeadline();
  started.length = 0;
  accepted.length = 0;
  closedSessions = 0;
});

function transport(mailboxId = "mbx_deadline") {
  return smtpTransport({
    mailboxId,
    host: "127.0.0.1",
    port,
    secure: false,
    auth: { kind: "password", user: "sam@brand.example.com", pass: "pw" },
    name: "brand.example.com",
  });
}

function email(to: string): OutgoingEmail {
  return {
    from: { name: "Sam Carter", address: "sam@brand.example.com" },
    to: [to],
    subject: "Quick question",
    text: "Hi Dana, short note.",
    messageId: `<${to.replace(/@.*/, "")}-${Date.now()}@brand.example.com>`,
    date: new Date("2026-09-22T15:00:00Z"),
    headers: {},
  };
}

async function waitUntil(check: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition never became true");
}

describe("smtp transport deadline", () => {
  it("stops a send the server never answers after its data, and closes the session", async () => {
    setSmtpSendDeadline(300);
    holdAnswers();
    const began = Date.now();
    const error = await transport()
      .send(email("dana@harbor.example.com"))
      .catch((e: unknown) => e);
    expect(Date.now() - began).toBeLessThan(2_000);
    expect(error).toBeInstanceOf(StoppedSendError);
    expect((error as StoppedSendError).dataStarted).toBe(true);
    expect((error as Error).message).toContain("did not finish within 0.3 seconds");
    // The data may have arrived: the send job settles it as unknown, never retries it.
    expect(sendPhase(error)).toBe("data");
    expect(isDeliveryUncertain(error)).toBe(true);
    // The session is gone at once, not when the server finally answers.
    await waitUntil(() => closedSessions === 1);
    expect(accepted).toHaveLength(0);

    // The mailbox is not stuck: the next send opens a new connection and goes out.
    release();
    hold = null;
    setSmtpSendDeadline();
    await expect(transport().send(email("lee@harbor.example.com"))).resolves.toMatchObject({
      accepted: ["lee@harbor.example.com"],
    });
  });

  it("stops a send still waiting for the mailbox's connection; it never goes out later", async () => {
    setSmtpSendDeadline(1_000);
    holdAnswers();
    const first = transport()
      .send(email("dana@harbor.example.com"))
      .catch((e: unknown) => e);
    await waitUntil(() => started.length === 1);
    setSmtpSendDeadline(200);
    const waiting = await transport()
      .send(email("lee@harbor.example.com"))
      .catch((e: unknown) => e);
    // Nothing was handed over: a temporary failure the send job retries.
    expect(waiting).toBeInstanceOf(StoppedSendError);
    expect((waiting as StoppedSendError).dataStarted).toBe(false);
    expect(sendPhase(waiting)).toBe("before_data");
    expect(isDeliveryUncertain(waiting)).toBe(false);
    expect(classifySendError(waiting).kind).toBe("temporary");

    expect(await first).toBeInstanceOf(StoppedSendError);
    release();
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Only the first envelope ever started: the stopped one left the line for good.
    expect(started).toEqual(["sam@brand.example.com"]);
  });

  it("stops a send when its job ends, before the deadline", async () => {
    holdAnswers();
    const job = new AbortController();
    const sending = transport()
      .send(email("dana@harbor.example.com"), { signal: job.signal })
      .catch((e: unknown) => e);
    await waitUntil(() => started.length === 1);
    job.abort();
    const error = await sending;
    expect(error).toBeInstanceOf(StoppedSendError);
    expect((error as Error).message).toContain("its job ended");
    await waitUntil(() => closedSessions === 1);
  });
});
