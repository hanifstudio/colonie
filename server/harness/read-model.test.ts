// The read models every HTTP/SSE reply is built from. These cases pin the
// cheap, pure shapes — message paging and the wire slimming — so a later move
// of the routes cannot silently change what a client receives.
import { expect, test } from "vitest";
import { createReadModel } from "./read-model.ts";

type Row = Record<string, unknown>;

const model = (over: Record<string, unknown> = {}) => {
  const messages: Record<string, Row[]> = {};
  const store = {
    messagesFor: (threadId: string) => messages[threadId] ?? [],
    messagesTail: (threadId: string, limit: number) => {
      const all = messages[threadId] ?? [];
      return { messages: all.slice(Math.max(0, all.length - limit)), hasMore: all.length > limit, activeLeafId: "leaf" };
    },
    activeLeaf: () => "leaf",
    taskByThread: () => ({ threadId: "t1" }),
    ...over,
  };
  return { read: createReadModel({ store, directRequestOwners: new Map(), threadBusy: () => false, pendingTeamSetupResumes: () => new Map() } as never), messages };
};

test("pageSize treats absent, invalid and bounded input differently", () => {
  const { read } = model();
  expect(read.pageSize(null)).toBeUndefined();
  expect(read.pageSize("nope")).toBeNull();
  expect(read.pageSize("-1")).toBeNull();
  expect(read.pageSize("5")).toBe(5);
  expect(read.pageSize("100000")).toBe(200);
});

test("slimMessage strips pixels from a screen row and keeps other rows whole", () => {
  const { read } = model();
  const screen = read.slimMessage({ id: "m1", role: "bot", at: 0, kind: "screen", png: "AAAA", mime: "image/png" });
  expect(screen).toEqual({ id: "m1", role: "bot", at: 0, kind: "screen", mime: "image/png", hasImage: true });
  const text = { id: "m2", role: "bot" as const, at: 0, kind: "text" as const, text: "hello" };
  expect(read.slimMessage(text)).toBe(text);
});

test("messagePage with a limit reads only the newest rows", () => {
  const { read, messages } = model();
  messages.t1 = Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, kind: "text" }));
  const page = read.messagePage("t1", 3) as { messages: Row[]; hasMore: boolean };
  expect(page.messages.map((m) => m.id)).toEqual(["m7", "m8", "m9"]);
  expect(page.hasMore).toBe(true);
});

test("messageWindow centres on the wanted row and clamps at the edges", () => {
  const { read, messages } = model();
  messages.t1 = Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, kind: "text" }));
  expect((read.messageWindow("t1", "m5", 3) as { messages: Row[] }).messages.map((m) => m.id)).toEqual(["m4", "m5", "m6"]);
  expect((read.messageWindow("t1", "m0", 3) as { messages: Row[] }).messages.map((m) => m.id)).toEqual(["m0", "m1", "m2"]);
  expect(read.messageWindow("t1", "missing", 3)).toBeNull();
});
