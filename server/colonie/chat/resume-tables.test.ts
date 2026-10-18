// A parked computer turn must only resume the work it parked: a drain drops an
// entry whose ask was replaced, whose bot/thread is gone, or whose thread a
// newer turn now owns, and never re-dispatches those.
import { expect, test } from "vitest";
import { createResumeTables } from "./resume-tables.ts";

const entry = { botId: "bot-1", threadId: "t-1", resource: "seat-1", generation: "g-1", afterMessageId: "m-1" };

const build = (over: Record<string, unknown> = {}) =>
  createResumeTables({
    activeInternalGenerationByThread: new Map(),
    connectorThread: () => ({ bot: {} }),
    startTurn: () => Promise.resolve(),
    store: { activePath: () => [{ id: "m-1", role: "user" }] },
    threadBusy: () => false,
    turnResources: { free: () => true },
    ...over,
  } as never);

test("a replaced ask is dropped, not resumed", () => {
  const { pendingComputerResumes, drainComputerResumes } = build({
    store: { activePath: () => [{ id: "m-2", role: "user" }] },
  });
  pendingComputerResumes.set("t-1", entry);
  drainComputerResumes();
  expect(pendingComputerResumes.size).toBe(0);
});

test("a thread whose bot is gone is dropped", () => {
  const { pendingComputerResumes, drainComputerResumes } = build({ connectorThread: () => null });
  pendingComputerResumes.set("t-1", entry);
  drainComputerResumes();
  expect(pendingComputerResumes.size).toBe(0);
});

test("a thread a newer turn owns is dropped", () => {
  const { pendingComputerResumes, drainComputerResumes } = build({
    activeInternalGenerationByThread: new Map([["t-1", "g-2"]]),
  });
  pendingComputerResumes.set("t-1", entry);
  drainComputerResumes();
  expect(pendingComputerResumes.size).toBe(0);
});