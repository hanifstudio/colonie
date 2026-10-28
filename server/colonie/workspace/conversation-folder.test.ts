// A group's project folder: a bot's earlier files move in without replacing
// another bot's, its people see only visible regular files inside it, and
// deleting the conversation deletes it.
import { afterEach, beforeEach, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { removeTempDir } from "../../testing/cleanup.ts";
import { conversationFilePath, ensureConversationFolder, isTaskWorkspace, listConversationFiles, moveIntoConversationFolder, removeConversationFolder } from "./workspace.ts";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "colonie-conversation-folder-")); });
afterEach(async () => { await removeTempDir(root); });

test("a bot's earlier files move in, and a taken name goes aside instead of replacing", () => {
  const folder = ensureConversationFolder("group-1", join(root, "conversations"));
  writeFileSync(join(folder, "plan.md"), "another bot's plan");
  const own = join(root, "task-workspaces", "bot-a", "thread-a");
  mkdirSync(join(own, "drafts"), { recursive: true });
  writeFileSync(join(own, "plan.md"), "my plan");
  writeFileSync(join(own, "drafts", "intro.md"), "intro");
  expect(isTaskWorkspace(own, "bot-a", "thread-a", join(root, "task-workspaces"))).toBe(true);
  expect(isTaskWorkspace(own, "bot-b", "thread-a", join(root, "task-workspaces"))).toBe(false);

  moveIntoConversationFolder(own, folder, "Writer");

  expect(readFileSync(join(folder, "plan.md"), "utf8")).toBe("another bot's plan");
  expect(readFileSync(join(folder, "Writer earlier files", "plan.md"), "utf8")).toBe("my plan");
  expect(readFileSync(join(folder, "drafts", "intro.md"), "utf8")).toBe("intro");
  expect(existsSync(own)).toBe(false);
});

test("people see visible regular files inside the folder, and nothing else", () => {
  const folder = ensureConversationFolder("group-2", root);
  mkdirSync(join(folder, "docs"));
  mkdirSync(join(folder, ".git"));
  writeFileSync(join(folder, "docs", "brief.md"), "brief");
  writeFileSync(join(folder, ".git", "HEAD"), "ref");
  writeFileSync(join(folder, ".env"), "SECRET=1");
  writeFileSync(join(root, "outside.txt"), "outside");
  symlinkSync(join(root, "outside.txt"), join(folder, "link.txt"));

  expect(listConversationFiles(folder).files.map((file) => file.path)).toEqual(["docs/brief.md"]);
  expect(conversationFilePath(folder, "docs/brief.md")).toBe(join(folder, "docs", "brief.md"));
  for (const path of ["link.txt", ".env", ".git/HEAD", "../outside.txt", "docs/../../outside.txt", "docs", "", "/etc/hosts", "missing.md"]) {
    expect(conversationFilePath(folder, path), path).toBeNull();
  }
});

test("deleting the conversation deletes its folder", () => {
  const folder = ensureConversationFolder("group-3", root);
  writeFileSync(join(folder, "a.md"), "a");
  removeConversationFolder("group-3", root);
  expect(existsSync(folder)).toBe(false);
  expect(() => ensureConversationFolder("../escape", root)).toThrow();
});
