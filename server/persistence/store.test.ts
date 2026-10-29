import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, sep } from "node:path";
import { expect, test } from "vitest";
import { DATA_DIR } from "../config.ts";
import { workspaceScope, type WorkspaceScope } from "../runtime/scope.ts";
import type { ModelSelection } from "../contracts.ts";
import { mentionedBots, Store } from "./store.ts";

// Persistence reads and writes whatever DATA_DIR points at. The vitest setup
// (server/testing/setup.ts) gives every test file a throwaway home for exactly
// that reason; this is the guard that says so out loud, next to the code that
// would do the damage if it ever stopped being true. os.homedir() follows the
// setup's HOME, so the real one is asked of the system instead.
test("a test process reads a throwaway data directory, never the owner's", () => {
  expect(DATA_DIR.startsWith(homedir())).toBe(true);
  expect(DATA_DIR).not.toBe(`${userInfo().homedir}${sep}.colonie`);
});

const selection = (): ModelSelection => ({ instanceId: "claude-acp", model: "default" });

/** A disposable workspace holding the given bots, built the way the app builds
 * one: a data directory with its own registry file inside. Each bot carries the
 * thread it was created with, which is what the loader reads a task title from. */
function scopeWithBots(bots: Array<{ id: string; name: string }>): WorkspaceScope {
  const scope = workspaceScope(mkdtempSync(join(tmpdir(), "colonie-workspace-")));
  const records = bots.map((bot) => ({
    ...bot,
    threadId: `${bot.id}-thread`,
    createdAt: 1_700_000_000_000,
    modelSelection: selection(),
  }));
  writeFileSync(scope.botsFile, JSON.stringify(records));
  return scope;
}

// The point of the workspace scope: which bots a store sees follows from the
// workspace it was built for, not from a path the process happens to hold. Both
// halves matter — isolation between two workspaces, and a restart on the same
// workspace reading the same file again.
test("a store reads the workspace it was built for, and reloads it after a restart", () => {
  const workspaceA = scopeWithBots([{ id: "bot-a", name: "Bot A" }]);
  const workspaceB = scopeWithBots([{ id: "bot-b", name: "Bot B" }]);

  const first = new Store(selection, undefined, undefined, workspaceA);
  const second = new Store(selection, undefined, undefined, workspaceB);

  expect(first.bots.map((bot) => bot.id)).toEqual(["bot-a"]);
  expect(second.bots.map((bot) => bot.id)).toEqual(["bot-b"]);
  expect(new Store(selection, undefined, undefined, workspaceA).bots.map((bot) => bot.id)).toEqual(["bot-a"]);
});

test("a store built without a workspace still uses the process's own data directory", () => {
  const store = new Store(selection);

  expect(store.bots).toBeInstanceOf(Array);
  expect(DATA_DIR.startsWith(homedir())).toBe(true);
});

// The first bot of a new workspace gets a friendly name like every other bot,
// not the name of an engine.
test("the first bot of a workspace is named like any bot, and leads as Chief of Staff", () => {
  const before = process.env.COLONIE_PROFILE;
  process.env.COLONIE_PROFILE = "1";
  try {
    const store = new Store(selection, undefined, undefined, scopeWithBots([]));
    store.seedIfEmpty();
    const [first] = store.bots;
    expect(first?.name).toBeTruthy();
    expect(first?.name).not.toBe("Codex");
    expect(first?.chiefOfStaff).toBe(true);
    // it can use its computer like every bot
    expect(first?.computer).toBeUndefined();
  } finally {
    if (before === undefined) delete process.env.COLONIE_PROFILE; else process.env.COLONIE_PROFILE = before;
  }
});

test("a bot saved without a name is never mentioned and never stops a message", () => {
  const bots = [{ id: "a", name: "Tango" }, { id: "b" } as unknown as { id: string; name: string }];
  expect(mentionedBots("@Tango and @ hi", bots).map((bot) => bot.id)).toEqual(["a"]);
});

test("a bot saved without a name gets one back when the workspace loads", () => {
  const scope = scopeWithBots([{ id: "a" } as unknown as { id: string; name: string }, { id: "b", title: "Researcher" } as unknown as { id: string; name: string }]);
  const bots = new Store(selection, undefined, undefined, scope).bots;
  expect(bots.map((bot) => [bot.name, bot.title])).toEqual([["Bot", ""], ["Researcher", "Researcher"]]);
});

test("three approval levels: Ask moves once to Ask when risky, Accept edits and Custom become Ask, new bots start on Ask when risky", () => {
  type Seed = { id: string; name: string };
  const scope = scopeWithBots([
    { id: "asks", name: "Asks", approvalMode: "ask" },
    { id: "edits", name: "Edits", approvalMode: "edits" },
    { id: "custom", name: "Custom", approvalMode: "custom" },
    { id: "full", name: "Full", approvalMode: "full" },
    { id: "mac", name: "Mac", approvalMode: "ask", computer: "local" },
  ] as unknown as Seed[]);
  const first = new Store(selection, undefined, undefined, scope);
  const level = (store: Store) => Object.fromEntries(store.bots.map((bot) => [bot.id, bot.approvalMode]));
  expect(level(first)).toEqual({ asks: "auto", edits: "ask", custom: "ask", full: "full", mac: "ask" });
  expect(first.createBot({ name: "New" }).approvalMode).toBe("auto");
  // a bot the person sets back to Ask afterwards stays on Ask
  first.patchBot("asks", { approvalMode: "ask" });
  expect(level(new Store(selection, undefined, undefined, scope)).asks).toBe("ask");
});
