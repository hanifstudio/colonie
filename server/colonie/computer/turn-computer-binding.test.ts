// bindTurnComputer is the single gate every computer claim passes, so the
// cases here pin its four exits: a free seat binds at once, a cancelled setup
// throws before binding, a held seat waits and then acquires, and the deadline
// parks the turn instead of failing it.
import { expect, test } from "vitest";
import { createTurnComputerBinding } from "./turn-computer-binding.ts";

// The real classes come from the turn-dispatch factory, so stand in for them:
// the module only constructs and rethrows whatever it was handed.
class DirectTurnSetupCancelled extends Error {}
class ComputerWaitParked extends Error {
  readonly resource: string;
  readonly generation: string;
  constructor(message: string, resource: string, generation: string) {
    super(message);
    this.resource = resource;
    this.generation = generation;
  }
}

const deps = (over: Record<string, unknown> = {}) => {
  const appended: any[] = [];
  const published: any[] = [];
  const notes: Array<[string, number]> = [];
  const owners = new Map<string, any>([["t1", { threadId: "t1", generation: "g1" }]]);
  const computers = new Map<string, { owner: any; resource: string }>();
  const claims: string[] = [];
  const claimOverride = over.claimTurnResource as ((owner: any, resource: string) => boolean) | undefined;
  const { bindTurnComputer } = createTurnComputerBinding({
    COMPUTER_WAIT_MAX_MS: () => 60_000,
    ComputerWaitParked,
    DirectTurnSetupCancelled,
    activeInternalGenerationByThread: new Map([["t1", "g1"]]),
    bus: { publish: (event: any) => published.push(event) },
    registry: { get: () => undefined },
    store: () => ({
      appendMessage: (_threadId: string, message: any) => {
        appended.push(message);
        return { id: `m${appended.length}`, ...message };
      },
      botByThread: () => undefined,
      taskByThread: () => undefined,
    }),
    turnComputerResources: computers,
    turnResources: {
      blocker: () => null,
      noteWait: (resource: string, waitedMs: number) => notes.push([resource, waitedMs]),
      owns: () => true,
      startWaiting: () => 1,
      stopWaiting: () => {},
      waitEstimateMs: () => 100,
    },
    ...over,
    // After `over` so the recorder always sees every claim, whatever the case
    // overrides about granting one.
    claimTurnResource: (owner: any, resource: string) => {
      claims.push(resource);
      const granted = claimOverride?.(owner, resource) ?? true;
      if (granted) owners.set(owner.threadId, owner);
      return granted;
    },
    turnResourceOwners: owners,
  });
  return { bind: bindTurnComputer, appended, published, notes, owners, computers, claims };
};

const owner = { threadId: "t1", generation: "g1" };

test("a free seat binds the turn without a waiting chip", async () => {
  const { bind, appended, published, owners, computers, claims } = deps();
  await bind(owner as never, "desktop", true);
  expect(claims).toEqual(["desktop"]);
  expect(appended).toEqual([]);
  expect(published).toEqual([]);
  expect(owners.get("t1")).toBe(owner);
  expect(computers.get("t1")).toEqual({ owner, resource: "desktop" });
});

test("a non-exclusive claim binds without asking for the seat", async () => {
  const { bind, claims, computers } = deps();
  await bind(owner as never, "desktop");
  expect(claims).toEqual([]);
  expect(computers.get("t1")?.resource).toBe("desktop");
});

test("a cancelled setup throws before binding", async () => {
  const { bind, computers } = deps({ activeInternalGenerationByThread: new Map() });
  await expect(bind(owner as never, "desktop", true)).rejects.toBeInstanceOf(DirectTurnSetupCancelled);
  expect(computers.has("t1")).toBe(false);
});

test("a held seat waits, then acquires and notes the wait", async () => {
  let attempts = 0;
  const { bind, appended, published, notes, claims } = deps({
    claimTurnResource: () => (++attempts > 1),
  });
  await bind(owner as never, "desktop", true);
  expect(claims).toEqual(["desktop", "desktop"]);
  // One waiting chip, then the resolution line beside it.
  expect(appended).toHaveLength(2);
  expect(published[0].type).toBe("turn.wait_started");
  expect(published.at(-1)).toMatchObject({ type: "turn.wait_ended", outcome: "acquired" });
  expect(notes).toHaveLength(1);
  expect(notes[0]![0]).toBe("desktop");
});

test("the ceiling parks the turn with the resource and generation", async () => {
  const { bind, appended, published, computers } = deps({
    COMPUTER_WAIT_MAX_MS: () => 0,
    claimTurnResource: () => false,
  });
  const error = await bind(owner as never, "desktop", true).catch((err: unknown) => err);
  expect(error).toBeInstanceOf(ComputerWaitParked);
  expect((error as ComputerWaitParked).resource).toBe("desktop");
  expect((error as ComputerWaitParked).generation).toBe("g1");
  expect(computers.has("t1")).toBe(false);
  expect(appended.at(-1)!.tool.name).toContain("Parked");
  expect(published.at(-1)).toMatchObject({ type: "turn.wait_ended", outcome: "parked" });
});
