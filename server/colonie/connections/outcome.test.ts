import { expect, it } from "vitest";
import { toolResultFailed } from "./outcome.ts";

it("does not count a successful multi-execute envelope as a successful failed target", () => {
  expect(toolResultFailed({ content: [{ type: "text", text: JSON.stringify({ successful: true, data: { results: [{ tool_slug: "HACKERNEWS_GET_TOP_STORIES", result: { successful: false, error: "Target unavailable" } }] } }) }] })).toBe(true);
  expect(toolResultFailed({ content: [{ type: "text", text: JSON.stringify({ successful: true, data: { results: [{ result: { successful: true, data: [12345678] } }] } }) }] })).toBe(false);
  expect(toolResultFailed({ isError: true, content: [{ text: "Denied" }] })).toBe(true);
  expect(toolResultFailed({ content: [{ text: "Plain successful tool output" }] })).toBe(false);
});
