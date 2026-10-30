// A group's right panel (owner, October 30): Files or Members beside the
// conversation, one side panel at a time, and a file opened from Files
// comes back to Files when its preview closes.
import { expect, it } from "vitest";

import { initialState, reducer, type AppState } from "./store";

const inGroup: AppState = { ...initialState, selectedConversationId: "group-1" };

it("opens a tab, switches tabs, and closes when its tab is chosen again", () => {
  const files = reducer({ ...inGroup, computerOpen: true }, { type: "toggleGroupPanel", tab: "files" });
  expect(files.groupPanel).toBe("files");
  expect(files.computerOpen).toBe(false);
  expect(reducer(files, { type: "toggleGroupPanel", tab: "members" }).groupPanel).toBe("members");
  expect(reducer(files, { type: "toggleGroupPanel", tab: "files" }).groupPanel).toBeNull();
});

it("gives way to another side panel and closes when the group is left", () => {
  const open = reducer(inGroup, { type: "toggleGroupPanel", tab: "members" });
  expect(reducer(open, { type: "toggleComputer", open: true }).groupPanel).toBeNull();
  expect(reducer(open, { type: "selectConversation", id: null }).groupPanel).toBeNull();
  expect(reducer(open, { type: "selectConversation", id: "group-2" }).groupPanel).toBe("members");
});

it("a group's file previews in place of Files and returns there when closed", () => {
  const files = reducer(inGroup, { type: "toggleGroupPanel", tab: "files" });
  const preview = reducer(files, { type: "openFilePreview", preview: { threadId: "t", messageId: "", path: "README.md", name: "README.md", conversationId: "group-1" } });
  expect(preview.groupPanel).toBeNull();
  expect(reducer(preview, { type: "closeFilePreview" }).groupPanel).toBe("files");
  const message = reducer(inGroup, { type: "openFilePreview", preview: { threadId: "t", messageId: "m", path: "a.md", name: "a.md" } });
  expect(reducer(message, { type: "closeFilePreview" }).groupPanel).toBeNull();
});
