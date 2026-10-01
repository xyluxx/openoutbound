/**
 * Google API error envelopes (Places, Gemini): `{ error: { code, message, status, details } }`,
 * also sent as a one-item array by Gemini's OpenAI-compatible endpoint. Read by their documented
 * fields (`ErrorInfo.reason` and quota metadata, `QuotaFailure` violations, `RetryInfo`), so a
 * daily quota (`quota_exhausted` until midnight Pacific time, when Google resets it) is told
 * apart from a per-minute rate limit.
 */

export interface GoogleError {
  /** `RESOURCE_EXHAUSTED`, `PERMISSION_DENIED`, ... */
  status: string | null;
  message: string;
  /** `ErrorInfo.reason` values, e.g. `API_KEY_INVALID`, `RATE_LIMIT_EXCEEDED`. */
  reasons: string[];
  /** Quota ids, metrics and limits named in the details. */
  quota: string[];
  /** `RetryInfo.retryDelay` in seconds, when sent. */
  retryDelaySeconds?: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The envelope inside a body (object, one-item array, or the inner error itself), or null. */
export function readGoogleError(body: unknown): GoogleError | null {
  const outer = Array.isArray(body) ? body[0] : body;
  const inner = record(record(outer)?.error) ?? record(outer);
  if (!inner || (inner.status === undefined && inner.details === undefined)) return null;
  const reasons: string[] = [];
  const quota: string[] = [];
  let retryDelaySeconds: number | undefined;
  for (const item of Array.isArray(inner.details) ? inner.details : []) {
    const detail = record(item);
    if (!detail) continue;
    const reason = text(detail.reason);
    if (reason) reasons.push(reason);
    const metadata = record(detail.metadata);
    for (const key of ["quota_limit", "quota_metric", "quota_limit_value"]) {
      const value = text(metadata?.[key]);
      if (value) quota.push(value);
    }
    for (const violation of Array.isArray(detail.violations) ? detail.violations : []) {
      const entry = record(violation);
      for (const key of ["quotaId", "quotaMetric", "description", "subject"]) {
        const value = text(entry?.[key]);
        if (value) quota.push(value);
      }
    }
    const delay = text(detail.retryDelay)?.match(/^(\d+(?:\.\d+)?)s$/);
    if (delay?.[1]) retryDelaySeconds = Math.ceil(Number(delay[1]));
  }
  return {
    status: text(inner.status),
    message: text(inner.message) ?? "",
    reasons,
    quota,
    ...(retryDelaySeconds === undefined ? {} : { retryDelaySeconds }),
  };
}

/** True for a used-up daily quota (a quota id or limit per day), not a per-minute limit. */
export function isDailyQuota(error: GoogleError): boolean {
  return [error.message, ...error.quota].some((value) => /per ?day|daily/i.test(value));
}

/** Seconds until midnight Pacific time, when Google resets daily quotas. */
export function secondsUntilPacificMidnight(now: number = Date.now()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date(now));
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const elapsed = part("hour") * 3600 + part("minute") * 60 + part("second");
  return Math.max(60, 86_400 - elapsed);
}
