// The one progress line a chat shows while a bot's computer starts.
import { describe, expect, it } from "vitest";

import { computerStartLine } from "./computer-start";

describe("computerStartLine", () => {
  it("names the bot's computer being set up", () => {
    expect(computerStartLine({ state: "provisioning" })).toBe("Setting up this bot's computer…");
  });

  it("shows nothing when nothing is starting", () => {
    expect(computerStartLine(undefined)).toBeNull();
  });
});