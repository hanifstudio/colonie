// The memory-upkeep wiring picks the engine a capture/organize call runs on:
// the bot's live instance, but only when it is not an ACP-driven one and can
// actually generate text. `status().modelSteps` is the visible edge of that.
import { expect, test } from "vitest";
import { createMemoryUpkeepWiring } from "./memory-upkeep-wiring.ts";

interface Instance {
  instanceId: string;
  driverKind: string;
  generateText?: (prompt: string) => Promise<string>;
}

function build(options: { driverKind?: string; generateText?: boolean; knownBot?: boolean } = {}) {
  const instance: Instance = {
    instanceId: "i1",
    driverKind: options.driverKind ?? "claude-code",
    ...(options.generateText === false ? {} : { generateText: async () => "" }),
  };
  const bot = { id: "b1", name: "Bot", modelSelection: { instanceId: "i1" } };
  const upkeep = createMemoryUpkeepWiring({
    botHasActiveTurn: () => false,
    bookTurnUsage: () => {},
    broadcast: () => {},
    cfg: {},
    configStatus: () => ({}),
    learnedFacts: { plan: () => [], commit: () => {} },
    registry: { get: (id: string) => (id === "i1" ? instance : null) },
    store: {
      bots: [bot],
      bot: (id: string) => (options.knownBot === false ? undefined : id === "b1" ? bot : undefined),
      taskByThread: () => undefined,
    },
  } as never);
  return upkeep;
}

test("the model step follows the instance's own generateText", () => {
  expect(build().status("b1").modelSteps).toBe(true);
  expect(build({ generateText: false }).status("b1").modelSteps).toBe(false);
});

test("an ACP-driven instance is never a memory engine", () => {
  // The adapter owns that conversation; upkeep must not reach through it.
  expect(build({ driverKind: "codex-acp" }).status("b1").modelSteps).toBe(false);
  expect(build({ driverKind: "claude-acp" }).status("b1").modelSteps).toBe(false);
});

test("an unknown bot has no model step", () => {
  expect(build({ knownBot: false }).status("b1").modelSteps).toBe(false);
});
