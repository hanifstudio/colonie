import { expect, test } from "vitest";
import { screenFrameHash, screenTouchingTool, settledFrameIsNews } from "./screen-frame-gate.ts";

test("a settled frame is news only when it differs from what the reader sees", () => {
  const shown = screenFrameHash("png-one");

  expect(settledFrameIsNews(shown, "png-one")).toBe(false);
  expect(settledFrameIsNews(shown, "png-two")).toBe(true);
  // with nothing to compare against it fails open: an unshown screen beats a wrongly hidden one
  expect(settledFrameIsNews(undefined, "png-one")).toBe(true);
});

test("the fingerprint is the frame's, not the reader's", () => {
  expect(screenFrameHash("png-one")).toBe(screenFrameHash("png-one"));
  expect(screenFrameHash("png-one")).toMatch(/^[0-9a-f]{64}$/);
  expect(screenFrameHash("png-one")).not.toBe(screenFrameHash("png-one "));
});

test("a shell command over the computer is not a screen touch", () => {
  expect(screenTouchingTool("mcp__computer__click")).toBe(true);
  expect(screenTouchingTool("computer_screenshot")).toBe(true);
  expect(screenTouchingTool("computer_exec")).toBe(false);
  expect(screenTouchingTool("browser_snapshot")).toBe(false);
});