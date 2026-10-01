import { ERROR_STATUS, type ErrorCode, OpenOutboundError } from "../core/errors.js";
import type { Catalog } from "../mcp/catalog.js";
import { codeForStatus } from "./problem.js";

/** Call options a bridge forwards to the server (the principal comes from the API key). */
export interface RemoteCallOptions {
  workspace?: string | null;
  idempotencyKey?: string;
  dryRun?: boolean;
  reason?: string;
  responseFormat?: "concise" | "detailed";
  signal?: AbortSignal;
}

export interface RemoteClientOptions {
  /** Server base URL, e.g. http://127.0.0.1:7331 */
  url: string;
  apiKey: string | null;
  fetch?: typeof globalThis.fetch;
  /** Per-request timeout. Default 120 s. */
  timeoutMs?: number;
  /**
   * Binds the key's principal to this workspace on every call (header
   * `OpenOutbound-Bind-Workspace`): the server refuses other workspaces.
   */
  boundWorkspace?: string | null;
}

/** Catalog plus whether the server has the agent brain enabled (adds the agent_brain toolset). */
export interface RemoteCatalog extends Catalog {
  agent_brain?: boolean;
}

/**
 * Talks to a running OpenOutbound server: the CLI and `openoutbound mcp` bridge modes. Every
 * operation goes through the generic RPC route `POST /v1/ops/{operation_id}`; problem+json
 * errors come back as OpenOutboundError with the server's code, message and hint.
 */
export interface RemoteClient {
  url: string;
  call(operationId: string, input: unknown, options?: RemoteCallOptions): Promise<unknown>;
  catalog(): Promise<RemoteCatalog>;
  health(): Promise<Record<string, unknown>>;
}

export function createRemoteClient(options: RemoteClientOptions): RemoteClient {
  const base = options.url.replace(/\/+$/, "");
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 120_000;

  async function request(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const all: Record<string, string> = { Accept: "application/json", ...headers };
    if (options.apiKey) all.Authorization = `Bearer ${options.apiKey}`;
    if (body !== undefined) all["Content-Type"] = "application/json";
    const timeout = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method,
        headers: all,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      throw new OpenOutboundError(
        "internal",
        `Could not reach the OpenOutbound server at ${base}.`,
        {
          hint: "Check that `openoutbound serve` is running and that --url (or OPENOUTBOUND_URL) points to it.",
          details: { url: base, reason: error instanceof Error ? error.message : String(error) },
          cause: error,
        },
      );
    }
    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    if (!response.ok) throw remoteError(response, parsed, base);
    return parsed;
  }

  return {
    url: base,
    async call(operationId, input, callOptions = {}) {
      const headers: Record<string, string> = {};
      if (callOptions.workspace) headers["OpenOutbound-Workspace"] = callOptions.workspace;
      if (options.boundWorkspace) headers["OpenOutbound-Bind-Workspace"] = options.boundWorkspace;
      if (callOptions.idempotencyKey) headers["Idempotency-Key"] = callOptions.idempotencyKey;
      const body: Record<string, unknown> =
        input && typeof input === "object" && !Array.isArray(input)
          ? { ...(input as Record<string, unknown>) }
          : {};
      if (callOptions.reason) body.reason = callOptions.reason;
      if (callOptions.dryRun !== undefined) body.dry_run = callOptions.dryRun;
      if (callOptions.responseFormat) body.response_format = callOptions.responseFormat;
      return request(
        "POST",
        `/v1/ops/${encodeURIComponent(operationId)}`,
        body,
        headers,
        callOptions.signal,
      );
    },
    async catalog() {
      const result = await request("GET", "/v1/ops", undefined, {});
      if (!result || typeof result !== "object" || !Array.isArray((result as Catalog).operations)) {
        throw new OpenOutboundError("internal", `${base} did not return an operation catalog.`, {
          hint: "Check that --url points to an OpenOutbound server (GET /v1/ops).",
        });
      }
      return result as RemoteCatalog;
    },
    async health() {
      return (await request("GET", "/health", undefined, {})) as Record<string, unknown>;
    },
  };
}

function remoteError(response: Response, body: unknown, base: string): OpenOutboundError {
  const problem = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const code =
    typeof problem.code === "string" && problem.code in ERROR_STATUS
      ? (problem.code as ErrorCode)
      : codeForStatus(response.status);
  const message =
    typeof problem.detail === "string"
      ? problem.detail
      : typeof problem.title === "string"
        ? problem.title
        : `The server at ${base} answered HTTP ${response.status}.`;
  // The body's exact wait first (the header is rounded up to whole seconds), then the header.
  const header = Number(response.headers.get("Retry-After"));
  const retryAfter =
    typeof problem.retry_after_seconds === "number" && problem.retry_after_seconds >= 0
      ? problem.retry_after_seconds
      : header;
  return new OpenOutboundError(code, message, {
    hint:
      typeof problem.hint === "string"
        ? problem.hint
        : code === "unauthorized"
          ? "Pass a valid API key with --api-key or OPENOUTBOUND_API_KEY."
          : undefined,
    details:
      problem.details && typeof problem.details === "object"
        ? (problem.details as Record<string, unknown>)
        : undefined,
    status: response.status,
    retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
  });
}
