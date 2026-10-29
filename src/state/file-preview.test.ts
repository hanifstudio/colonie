import { expect, test } from "vitest";
import { initialState, reducer } from "./store";

const preview = { threadId: "fixture-thread", messageId: "fixture-message", path: "/report.docx", name: "report.docx" };
test("a file replaces the current side panel without changing the conversation", () => {
  const state = reducer({ ...initialState, selectedConversationId: "fixture-group", computerOpen: true, settingsOpen: true, inspectorOpen: true }, { type: "openFilePreview", preview });
  expect(state).toMatchObject({ filePreview: preview, selectedConversationId: "fixture-group", computerOpen: false, settingsOpen: false, inspectorOpen: false });
});
test("switching conversations clears a file from the previous conversation", () => {
  const state = reducer({ ...initialState, filePreview: preview }, { type: "selectConversation", id: "another-conversation" });
  expect(state.filePreview).toBeNull();
});
