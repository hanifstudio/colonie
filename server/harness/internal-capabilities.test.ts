// The internal capability table every proxy bearer is minted from. These cases
// pin the generation fence (the safety property) and the bearer reuse that keeps
// an engine warm, without starting a turn.
import { expect, test } from "vitest";
import { createInternalCapabilities } from "./internal-capabilities.ts";

const G1 = "11111111-1111-4111-8111-111111111111";
const G2 = "22222222-2222-4222-8222-222222222222";
const make = () => createInternalCapabilities({ botForThread: () => () => undefined } as never);
const cap = (over: Record<string, unknown> = {}) => ({
  botId: "b1", threadId: "t1", generation: G1, depth: 0, kind: "agents" as const,
  skillAuthoring: false, createdBots: 0, openedThreads: 0, ...over,
});

test("minting for a generation the thread does not hold throws", () => {
  const api = make();
  expect(() => api.mintInternalCapability(cap())).toThrow(/inactive turn/);
});

test("within one active generation the same grants reuse one bearer", () => {
  const api = make();
  api.beginInternalCapabilityGeneration("t1", G1);
  const first = api.mintInternalCapability(cap());
  const second = api.mintInternalCapability(cap());
  expect(first).toBe(second);
  expect(api.activeInternalGenerationByThread.get("t1")).toBe(G1);
});

test("a new generation revokes the previous one's bearer", () => {
  const api = make();
  api.beginInternalCapabilityGeneration("t1", G1);
  api.mintInternalCapability(cap());
  api.beginInternalCapabilityGeneration("t1", G2);
  expect(api.activeInternalGenerationByThread.get("t1")).toBe(G2);
  expect(() => api.mintInternalCapability(cap({ generation: G1 }))).toThrow(/inactive turn/);
});

test("revoking a thread's capabilities drops its active generation", () => {
  const api = make();
  api.beginInternalCapabilityGeneration("t1", G1);
  api.mintInternalCapability(cap());
  api.revokeInternalCapabilitiesForThread("t1");
  expect(api.activeInternalGenerationByThread.has("t1")).toBe(false);
  expect(() => api.mintInternalCapability(cap())).toThrow(/inactive turn/);
});

test("a perTurn bridge gets a fresh bearer each mint", () => {
  const api = make();
  api.beginInternalCapabilityGeneration("t1", G1);
  const a = api.mintInternalCapability(cap({ kind: "computer" }), { perTurn: true });
  const b = api.mintInternalCapability(cap({ kind: "computer" }), { perTurn: true });
  expect(a).not.toBe(b);
});
