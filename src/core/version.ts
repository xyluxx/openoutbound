import { readFileSync } from "node:fs";

function readVersion(): string {
  try {
    // Same relative path from src/core and dist/core.
    const raw = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === "string" ? version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Package version, read once from package.json. */
export const VERSION: string = readVersion();

/** User agent for every outbound request (spec 6, safe fetch). */
export const USER_AGENT = `OpenOutboundBot/${VERSION} (+https://github.com/xyluxx/openoutbound)`;
