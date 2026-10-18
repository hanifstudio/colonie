// A finished turn leaves two traces behind: a capture-queue entry for the
// memory-upkeep pass, and one line in the bot's daily log. Both belong to the
// person's own successful turn only, and neither may ever fail the turn.
import { expect, test, vi } from "vitest";
import type { RuntimeEvent } from "../../contracts.ts";
import { memoryDate, readMemoryLog } from "../workspace/workspace.ts";
import { registerCompletedTurnNotes } from "./completed-turn-notes.ts";

interface Msg {
  role: "user" | "bot";
  kind: "text" | "activity";
  text?: string;
  turnId?: string;
  peerAsk?: boolean;
  from?: { botId: string };
  tool?: { name: string };
}

interface Options {
  bot?: Record<string, unknown>;
  messages?: Msg[];
  ignored?: boolean;
  internal?: boolean;
  unattended?: boolean;
  noteThrows?: boolean;
}

function build(options: Options = {}) {
  const handlers: Array<(event: RuntimeEvent) => void> = [];
  const noteTurn = vi.fn(() => {
    if (options.noteThrows) throw new Error("capture down");
  });
  const bot = options.bot ?? { id: "b1", memoryUpkeep: true, memoryEnabled: true };
  const messages = options.messages ?? [];
  const store = {
    botByThread: () => bot,
    activePath: () => messages,
    messagesFor: () => messages,
    bot: () => bot,
    taskByThread: () => undefined,
  };
  registerCompletedTurnNotes({
    bus: { subscribe: (handler: (event: RuntimeEvent) => void) => { handlers.push(handler); return () => {}; } },
    isInternalTurn: () => options.internal === true,
    isUnattended: () => options.unattended === true,
    memoryUpkeep: () => ({ noteTurn }),
    routines: () => null,
    shouldIgnoreProviderEvent: () => options.ignored === true,
    store,
  } as never);
  const completed = (over: Partial<RuntimeEvent> = {}) =>
    ({ type: "turn.completed", threadId: "t1", turnId: "x", ok: true, provider: "claude", ...over } as RuntimeEvent);
  return { handlers, noteTurn, completed };
}

const pair: Msg[] = [
  { role: "user", kind: "text", text: "what did we decide?" },
  { role: "bot", kind: "text", text: "to ship on Friday", turnId: "x" },
];

test("the person's own finished turn is queued for capture", () => {
  const h = build({ messages: pair });
  h.handlers[0]!(h.completed());
  expect(h.noteTurn).toHaveBeenCalledWith("b1", "t1", {
    person: "what did we decide?",
    bot: "to ship on Friday",
    owner: true,
  });
});

test("an ignored, internal, unattended or failed turn is never queued", () => {
  for (const skip of [{ ignored: true }, { internal: true }, { unattended: true }]) {
    const h = build({ messages: pair, ...skip });
    h.handlers[0]!(h.completed());
    expect(h.noteTurn).not.toHaveBeenCalled();
  }
  const failed = build({ messages: pair });
  failed.handlers[0]!(failed.completed({ ok: false }));
  expect(failed.noteTurn).not.toHaveBeenCalled();
});

test("a peer's ask — or upkeep switched off — leaves no capture", () => {
  const room = build({
    messages: [{ role: "user", kind: "text", text: "hi", peerAsk: true }, { role: "bot", kind: "text", text: "hello", turnId: "x" }],
  });
  room.handlers[0]!(room.completed());
  expect(room.noteTurn).not.toHaveBeenCalled();

  const off = build({ messages: pair, bot: { id: "b1", memoryUpkeep: false, memoryEnabled: true } });
  off.handlers[0]!(off.completed());
  expect(off.noteTurn).not.toHaveBeenCalled();
});

test("a capture that cannot queue only warns, never fails the turn", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const h = build({ messages: pair, noteThrows: true });
    expect(() => h.handlers[0]!(h.completed())).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not queue a turn for capture"));
  } finally {
    warn.mockRestore();
  }
});

test("the daily log gets one line per finished turn, and none for a silent one", () => {
  const h = build({
    messages: [
      { role: "user", kind: "text", text: "deploy please" },
      { role: "bot", kind: "activity", tool: { name: "deploy" }, turnId: "x" },
      { role: "bot", kind: "text", text: "shipped it", turnId: "x" },
    ],
  });
  h.handlers[1]!(h.completed());
  const log = readMemoryLog("b1", `${memoryDate()}.md`) ?? "";
  expect(log).toContain("shipped it");
  expect(log).toContain("[tools: deploy]");
  expect(log).toContain("from thread t1");

  // A successful turn with no reply has nothing to write down.
  const silent = build({ messages: [{ role: "user", kind: "text", text: "hi" }] });
  silent.handlers[1]!(silent.completed());
  expect(readMemoryLog("b1", `${memoryDate()}.md`)).toBe(log);
});
