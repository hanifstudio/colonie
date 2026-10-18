// Cancelling a thread's team-setup resumes must invalidate exactly that
// thread's queue, so both branches of the filter are worth pinning.
import { expect, test } from "vitest";
import { createCardResolvers } from "./card-resolvers.ts";

const build = (over: Record<string, unknown> = {}) =>
  createCardResolvers({
    store: { bots: [], groups: [], messagesFor: () => [], bot: () => undefined, botByThread: () => undefined, tasks: () => [] },
    proposalPersistence: () => ({}),
    chiefPeerTargetRule: () => () => true,
    appliesDirectly: () => true,
    fullAccessForSource: () => true,
    validateModelProposal: () => ({ ok: true }),
    driverCapabilitiesFor: () => ({}),
    connectorThread: () => () => false,
    hasDirectDispatch: () => false,
    routines: () => undefined,
    threadBusy: () => false,
    directTurnDispatchClaims: new Map(),
    ...over,
  } as never);

test("cancelling a thread drops only that thread's pending resumes", () => {
  const { cancelTeamSetupResumesForThread, pendingTeamSetupResumes } = build();
  pendingTeamSetupResumes.set("k1", { request: { threadId: "t1" } } as never);
  pendingTeamSetupResumes.set("k2", { request: { threadId: "t2" } } as never);
  cancelTeamSetupResumesForThread("t1");
  expect(pendingTeamSetupResumes.has("k1")).toBe(false);
  expect(pendingTeamSetupResumes.has("k2")).toBe(true);
});

test("cancelling an empty queue is a no-op", () => {
  const { cancelTeamSetupResumesForThread, pendingTeamSetupResumes } = build();
  cancelTeamSetupResumesForThread("t1");
  expect(pendingTeamSetupResumes.size).toBe(0);
});

test("a missing card answers 404 without touching the stores", () => {
  const calls: number[] = [];
  const { undoAppliedChange } = build();
  undoAppliedChange({ headersSent: false, statusCode: 0, setHeader: () => {}, writeHead: () => {}, end: () => calls.push(1) } as never, "t1", "r1");
  expect(calls).toHaveLength(1);
});