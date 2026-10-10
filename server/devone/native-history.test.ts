import { expect, it } from "vitest";
import { nativeHistoryConflict } from "./native-history.ts";

it("does not mistake a pre-chat discovery cursor for ownership of another provider's history", () => {
  expect(nativeHistoryConflict({ hasUserHistory: false, selectedInstanceId: "claude", cursors: { codex: "a", claude: "b" } })).toBe(false);
  expect(nativeHistoryConflict({ hasUserHistory: true, selectedInstanceId: "claude", lastInstanceId: "codex", cursors: { codex: "a", claude: "b" } })).toBe(true);
  expect(nativeHistoryConflict({ hasUserHistory: true, selectedInstanceId: "codex", lastInstanceId: "codex", cursors: { codex: "a", claude: "b" } })).toBe(false);
});

it("allows first-setup retry but refuses missing or ambiguous established native context", () => {
  expect(nativeHistoryConflict({ hasUserHistory: true, selectedInstanceId: "codex", cursors: {} })).toBe(false);
  expect(nativeHistoryConflict({ hasUserHistory: true, selectedInstanceId: "codex", lastInstanceId: "codex", cursors: {} })).toBe(true);
  expect(nativeHistoryConflict({ hasUserHistory: true, selectedInstanceId: "codex", cursors: { codex: "a" } })).toBe(false);
  expect(nativeHistoryConflict({ hasUserHistory: true, selectedInstanceId: "codex", cursors: { codex: "a", claude: "b" } })).toBe(true);
});
