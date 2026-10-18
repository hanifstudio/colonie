// Which reply a composer action targets, which folders it may read, whether a
// thread belongs to the sender, and the one open-proposal budget they share.
import { expect, test } from "vitest";
import type { Message } from "../../persistence/store.ts";
import { createConversationSources } from "./conversation-sources.ts";

function build(options: {
  bot?: { id: string; threadId?: string; cwd?: string } | null;
  task?: { cwd?: string } | null;
  group?: { id: string; threadId?: string; cwd?: string; pinnedCwd?: string | null } | null;
  groupTask?: { pinnedCwd?: string | null } | null;
  messages?: Message[];
  activePath?: Message[];
  fullAccess?: boolean;
} = {}) {
  const fullAccess = options.fullAccess === true;
  const sources = createConversationSources({
    fullAccessForSource: () => fullAccess,
    store: {
      bot: () => options.bot ?? undefined,
      botByThread: () => options.bot ?? undefined,
      groupByThread: () => options.group ?? undefined,
      taskByThread: () => options.task ?? undefined,
      groupTaskByThread: () => options.groupTask ?? undefined,
      messagesFor: () => options.messages ?? [],
      activePath: () => options.activePath ?? [],
    },
  } as never);
  return sources;
}

const userText = (id: string, text = "hi"): Message => ({ id, role: "user", kind: "text", text }) as Message;

test("an absent reply target is allowed, a malformed or stale one is refused", () => {
  const { resolveReplyTarget } = build({ messages: [userText("m1")] });
  expect(resolveReplyTarget("t1", undefined)).toBeUndefined();
  expect(resolveReplyTarget("t1", "")).toBeUndefined();
  expect(() => resolveReplyTarget("t1", 7)).toThrowError(expect.objectContaining({ status: 400 }));
  expect(() => resolveReplyTarget("t1", "gone")).toThrowError(expect.objectContaining({ status: 404 }));
  expect(resolveReplyTarget("t1", "m1")?.id).toBe("m1");
});

test("a reply target must be a non-empty text line", () => {
  const { resolveReplyTarget } = build({ messages: [{ id: "card", role: "bot", kind: "activity" } as Message, userText("blank", "   ")] });
  expect(() => resolveReplyTarget("t1", "card")).toThrowError(expect.objectContaining({ status: 404 }));
  expect(() => resolveReplyTarget("t1", "blank")).toThrowError(expect.objectContaining({ status: 404 }));
});

test("only the sender's own main chat or task thread is writable", () => {
  expect(build({ bot: { id: "b1", threadId: "main" } }).connectorThread("b1", "main")).toBeTruthy();
  expect(build({ bot: { id: "b1", threadId: "main" }, task: { cwd: "/w" } }).connectorThread("b1", "side")).toBeTruthy();
  // A stored room thread is read-only history for a bot tool.
  expect(build({ bot: { id: "b1", threadId: "main" } }).connectorThread("b1", "room")).toBeNull();
  expect(build({}).connectorThread("b1", "main")).toBeNull();
});

test("a proposal from an unknown sender or a foreign thread is refused", () => {
  expect(build({}).proposalPersistence("b1", "t1")).toEqual({ ok: false, status: 403, error: "unknown sender" });
  expect(build({ bot: { id: "b1", threadId: "main" } }).proposalPersistence("b1", "room"))
    .toEqual({ ok: false, status: 403, error: "source conversation does not belong to sender" });
});

test("eight open cards fill the budget unless the change applies directly", () => {
  const cards = Array.from({ length: 8 }, (_, index) => ({
    id: `c${index}`, role: "bot", kind: "text", card: { routineRequest: { botId: "b1" } },
  })) as Message[];
  const bot = { id: "b1", threadId: "t1" };
  expect(build({ bot, activePath: cards }).proposalPersistence("b1", "t1"))
    .toEqual({ ok: false, status: 429, error: "confirm or cancel an existing proposal first" });
  expect(build({ bot, activePath: cards, fullAccess: true }).proposalPersistence("b1", "t1")).toEqual({ ok: true });
  expect(build({ bot, activePath: cards }).proposalPersistence("b1", "t1", false)).toEqual({ ok: true });
});

test("a conversation's roots put its pinned folder first, then its workspace", () => {
  const { messageFileRootsForThread } = build({ bot: { id: "b1", threadId: "t1", cwd: "/configured" }, task: { cwd: "/pinned" } });
  const roots = messageFileRootsForThread("b1", "t1");
  expect(roots[0]).toBe("/pinned");
  // With no pin the configured folder is the conversation root.
  expect(build({ bot: { id: "b1", threadId: "t1", cwd: "/configured" } }).messageFileRootsForThread("b1", "t1")[0]).toBe("/configured");
});
