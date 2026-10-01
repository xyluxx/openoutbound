import { describe, expect, it } from "vitest";
import { ALL_SCOPES, type Principal, SYSTEM_PRINCIPAL } from "../core/context.js";
import { mustRequestApproval } from "./approval-rule.js";

const principal = (overrides: Partial<Principal>): Principal => ({
  type: "human",
  id: "key_x",
  name: "X",
  scopes: [...ALL_SCOPES],
  workspaceId: null,
  via: "http",
  ...overrides,
});

describe("mustRequestApproval", () => {
  it("lets only a human holding approve pass a gate", () => {
    expect(mustRequestApproval(principal({}))).toBe(false);
    expect(mustRequestApproval(principal({ scopes: ["approve"] }))).toBe(false);
  });

  it("holds everyone else: people without approve, agents, services, the local agent, the engine", () => {
    expect(mustRequestApproval(principal({ scopes: ["read", "write", "send"] }))).toBe(true);
    expect(mustRequestApproval(principal({ type: "agent" }))).toBe(true);
    expect(mustRequestApproval(principal({ type: "service" }))).toBe(true);
    expect(mustRequestApproval(principal({ type: "agent", id: "local-agent", via: "mcp" }))).toBe(
      true,
    );
    expect(mustRequestApproval(SYSTEM_PRINCIPAL)).toBe(true);
  });
});
