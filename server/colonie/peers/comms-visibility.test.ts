import { expect, test } from "vitest";
import { mirrorExchange } from "./comms-visibility.ts";

function bus() {
  const written: Array<{ threadId: string; message: Record<string, unknown> }> = [];
  return {
    written,
    store: { appendMessage: (threadId: string, message: Record<string, unknown>) => { written.push({ threadId, message }); return { id: "m1", at: 1, ...message }; } },
    broadcast: () => {},
  } as never as { written: typeof written; store: never; broadcast: () => void };
}

const bot = (id: string, name: string, threadId: string) => ({ id, name, threadId }) as never;

test("a peer exchange leaves a chip in both threads, so neither side is hidden", () => {
  const world = bus();

  mirrorExchange(world as never, bot("a", "Ada", "t-ada"), bot("b", "Bogdan", "t-bogdan"));

  expect(world.written).toHaveLength(2);
  expect(world.written.map((entry) => entry.threadId)).toEqual(["t-ada", "t-bogdan"]);
  for (const entry of world.written) {
    expect(entry.message.role).toBe("bot");
    expect(entry.message.kind).toBe("activity");
  }
});

test("each chip names the other bot, in that bot's own thread", () => {
  const world = bus();

  mirrorExchange(world as never, bot("a", "Ada", "t-ada"), bot("b", "Bogdan", "t-bogdan"));

  const [mine, theirs] = world.written.map((entry) => (entry.message.tool as { name: string }).name);
  expect(mine).toBe("Messaged @Bogdan");
  expect(theirs).toBe("Message from @Ada");
});

test("a delegation names the thread it happened in, not the bot's standing one", () => {
  const world = bus();

  mirrorExchange(world as never, bot("a", "Ada", "t-ada"), bot("b", "Bogdan", "t-bogdan"), "t-elsewhere");

  expect(world.written[0]?.threadId).toBe("t-elsewhere");
  expect(world.written[1]?.threadId).toBe("t-bogdan");
});