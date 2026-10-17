import { describe, expect, it } from "vitest";

import type { Message } from "@/state/store";
import { showWorkingDots } from "./turn-tail";

const msg = (m: Partial<Message>): Message => ({ id: "m1", role: "bot", kind: "text", at: 1, ...m });

describe("showWorkingDots", () => {
  it("hides the dots when the bot is idle", () => {
    expect(showWorkingDots(false, msg({ role: "user" }))).toBe(false);
  });

  it("shows the dots while a turn runs with nothing settled yet", () => {
    expect(showWorkingDots(true, undefined)).toBe(true);
    expect(showWorkingDots(true, msg({ role: "user" }))).toBe(true);
    expect(showWorkingDots(true, msg({ kind: "activity" }))).toBe(true);
    expect(showWorkingDots(true, msg({ kind: "options" }))).toBe(true);
  });

  it("keeps the dots hidden after the reply settles, while busy winds down", () => {
    // the end-of-stream window: reply landed, turn.completed + busy:false
    // still in flight — re-showing the dots here is the jitter
    expect(showWorkingDots(true, msg({}))).toBe(false);
  });
});
