import { describe, expect, it } from "vitest";
import { approvedOutcome } from "./approvals.js";

describe("approvedOutcome", () => {
  it("says the message is scheduled, or why it waits and whether it goes out on its own", () => {
    expect(approvedOutcome("scheduled", "msg_1")).toBe(
      "Approved and scheduled inside the recipient's sending window.",
    );
    expect(approvedOutcome("waiting:outside_window", "msg_1")).toBe(
      "Approved; the send window is closed now, so it goes out on its own when the window opens (waiting:outside_window).",
    );
    expect(approvedOutcome("waiting:no_capacity", "msg_1")).toContain(
      "when a sender has capacity again",
    );
    expect(approvedOutcome("waiting:workspace_paused", "msg_1")).toContain(
      "once the workspace is resumed",
    );
    expect(approvedOutcome("waiting:campaign_paused", "msg_1")).toBe(
      "Approved; it will be scheduled when the campaign runs again.",
    );
    // Anything else names the way to find out why, with the message id filled in.
    expect(approvedOutcome("waiting:no_senders", "msg_1")).toBe(
      "Approved, but not scheduled yet (waiting:no_senders). See why with explain_blocker (message_id msg_1; CLI: openoutbound operating explain --message-id msg_1).",
    );
  });
});
