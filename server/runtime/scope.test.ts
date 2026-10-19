// The workspace owns its paths. Today the process runs in one workspace, so the
// active scope must be exactly the data directory the process was started with;
// two scopes must share nothing, or "workspace B does not inherit workspace A"
// would be a convention instead of a property.
import { join } from "node:path";
import { expect, test } from "vitest";
import { DATA_DIR } from "../config.ts";
import { activeWorkspaceScope, workspaceScope } from "./scope.ts";

test("a workspace's paths are derived from its own directory", () => {
  const scope = workspaceScope("/tmp/colonie-workspace-a");

  expect(scope.dataDir).toBe("/tmp/colonie-workspace-a");
  expect(scope.botsFile).toBe(join("/tmp/colonie-workspace-a", "bots.json"));
  expect(scope.groupsFile).toBe(join("/tmp/colonie-workspace-a", "groups.json"));
  expect(scope.configFile).toBe(join("/tmp/colonie-workspace-a", "config.json"));
  expect(scope.messageDbFile).toBe(join("/tmp/colonie-workspace-a", "messages.db"));
  expect(scope.nativeDir).toBe(join("/tmp/colonie-workspace-a", "native"));
  expect(scope.eventsDir).toBe(join("/tmp/colonie-workspace-a", "events"));
  expect(scope.legacyThreadFile("t1")).toBe(join("/tmp/colonie-workspace-a", "messages-t1.json"));
});

test("two workspaces share no path", () => {
  const pathsOf = (scope: ReturnType<typeof workspaceScope>) => [
    scope.dataDir,
    scope.nativeDir,
    scope.eventsDir,
    scope.configFile,
    scope.messageDbFile,
    scope.botsFile,
    scope.groupsFile,
    scope.threadModelCopiesCleared,
    scope.legacyThreadFile("t1"),
  ];
  const a = pathsOf(workspaceScope("/tmp/colonie-workspace-a"));
  const b = pathsOf(workspaceScope("/tmp/colonie-workspace-b"));

  expect(a.filter((path) => b.includes(path))).toEqual([]);
});

test("the process's own workspace is the data directory it was started with", () => {
  const active = activeWorkspaceScope();

  expect(active.dataDir).toBe(DATA_DIR);
  expect(active.configFile).toBe(join(DATA_DIR, "config.json"));
  expect(active.messageDbFile).toBe(join(DATA_DIR, "messages.db"));
  expect(active.botsFile).toBe(join(DATA_DIR, "bots.json"));
  expect(active.nativeDir).toBe(join(DATA_DIR, "native"));
});
