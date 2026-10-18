// The emergency-stop path must fail closed: a downgrade has to revoke the
// wider permission before any provider teardown yields, and one thread's Stop
// must never close a replacement turn's approvals.
import { expect, test } from "vitest";
import { createChatInterrupts } from "./interrupts.ts";

type Task = { threadId: string; busy?: boolean; activity?: string; approvalMode?: string };

function build(tasks: Task[] = [], onInterrupt?: (threadId: string) => void) {
  const calls: string[] = [];
  const state = {
    patchedMessages: [] as Array<[string, string, object]>,
    patchedTasks: [] as Array<[string, string, object]>,
    activities: [] as Array<[string, string, string]>,
    interrupted: [] as string[],
    closed: [] as string[],
  };
  const pendingComputerResumes = new Map<string, unknown>([["parked", {}]]);
  const directTurnGenerationByThread = new Map<string, string>([["t1", "g1"], ["t2", "g2"], ["parked", "gp"]]);
  const directTurnDispatchClaims = new Map<string, { botId: string }>([["t1", { botId: "b1" }], ["t2", { botId: "b1" }]]);
  const directRequestOwners = new Map<string, { generation: string; messageId?: string; stopped?: boolean }>([
    ["t1", { generation: "g1", messageId: "m1" }],
  ]);
  // Getters mirror the real wire site: names index.ts declares after it.
  const deps = {
    botForThread: () => ({ generation: "g1" }),
    cancelDirectTurnDispatch: () => calls.push("cancel"),
    closeOpenApprovals: () => (threadId: string) => { calls.push("close"); state.closed.push(threadId); },
    colonieChief: () => ({ cancelSource: () => calls.push("chief") }),
    colonieMemory: () => ({ cancelThread: () => calls.push("memory") }),
    colonieMemorySources: () => new Map([["t1", { botId: "b1" }]]),
    colonieTurnByThread: () => new Map<string, string>([["t1", "turn1"]]),
    connectedTools: () => ({ cancel: () => calls.push("tools") }),
    directRequestOwners,
    directTurnDispatchClaims,
    directTurnGenerationByThread,
    pendingComputerResumes: () => pendingComputerResumes,
    registry: { get: () => ({ driverKind: "claude-acp" }) },
    revokeInternalCapabilitiesForThread: () => calls.push("revoke"),
    runningTurnInstance: () => (() => ({
      adapter: {
        interruptTurn: async (threadId: string) => {
          calls.push("interrupt");
          state.interrupted.push(threadId);
          onInterrupt?.(threadId);
        },
      },
    })),
    store: () => ({
      bot: () => ({ id: "b1", modelSelection: { instanceId: "i1" } }),
      tasks: () => tasks,
      taskByThread: (_botId: string, threadId: string) => tasks.find((task) => task.threadId === threadId),
      setTaskActivity: (botId: string, threadId: string, activity: string) => { state.activities.push([botId, threadId, activity]); },
      patchMessage: (threadId: string, messageId: string, patch: object) => { state.patchedMessages.push([threadId, messageId, patch]); },
      patchTask: (botId: string, threadId: string, patch: object) => { state.patchedTasks.push([botId, threadId, patch]); },
    }),
    routines: () => null,
  };
  return { ...createChatInterrupts(deps as never), deps, calls, state, pendingComputerResumes, directRequestOwners };
}

test("interruptDirectThread revokes the thread's authority before asking the adapter", async () => {
  const { interruptDirectThread, calls, state } = build([{ threadId: "t1", busy: true }]);
  await interruptDirectThread("b1", "t1");
  expect(calls.indexOf("revoke")).toBeLessThan(calls.indexOf("interrupt"));
  expect(calls).toContain("tools");
  expect(calls).toContain("memory");
  expect(state.interrupted).toEqual(["t1"]);
  // The generation fence held, so this thread's open approvals are closed here.
  expect(state.closed).toEqual(["t1"]);
});

test("a turn replaced while the interrupt was in flight keeps its approvals open", async () => {
  const built = build([{ threadId: "t1", busy: true }], (threadId) => {
    // A replacement turn claimed the thread before the adapter interrupt returned.
    built.deps.directTurnGenerationByThread.set(threadId, "g2");
  });
  await built.interruptDirectThread("b1", "t1");
  expect(built.state.interrupted).toEqual(["t1"]);
  expect(built.state.closed).toEqual([]);
});

test("Stop records the cancelled request and its message", async () => {
  const { interruptDirectThread, state, directRequestOwners } = build([{ threadId: "t1", busy: true }]);
  await interruptDirectThread("b1", "t1");
  expect(directRequestOwners.get("t1")?.stopped).toBe(true);
  expect(state.patchedMessages).toEqual([["t1", "m1", { requestCancelled: true }]]);
});

test("a parked computer resume is cancelled unless the parking teardown preserves it", async () => {
  const kept = build([{ threadId: "parked", busy: true, activity: "parked.computer" }]);
  await kept.interruptDirectThread("b1", "parked");
  expect(kept.state.activities).toEqual([["b1", "parked", "idle"]]);
  expect(kept.pendingComputerResumes.has("parked")).toBe(false);

  const preserved = build([{ threadId: "parked", busy: true, activity: "parked.computer" }]);
  await preserved.interruptDirectThread("b1", "parked", { preserveComputerResume: true });
  expect(preserved.state.activities).toEqual([]);
  expect(preserved.pendingComputerResumes.has("parked")).toBe(true);
});

test("interruptAllDirectThreads revokes every sibling before any provider teardown", async () => {
  const { interruptAllDirectThreads, state, calls } = build([
    { threadId: "t1", busy: true },
    { threadId: "t2", busy: true },
    { threadId: "t3" },
  ]);
  await interruptAllDirectThreads("b1");
  // Both busy/claimed threads were interrupted and the idle sibling was left alone.
  expect([...state.interrupted].sort()).toEqual(["t1", "t2"]);
  // Five revokes: one pair in the pre-pass per thread, then one per thread inside.
  expect(calls.filter((call) => call === "revoke")).toHaveLength(4);
});

test("an emergency downgrade forces full/custom tasks to Ask and cancels the active run", async () => {
  const tasks: Task[] = [
    { threadId: "t1", busy: true, approvalMode: "full" },
    { threadId: "t2", busy: true, approvalMode: "custom" },
    { threadId: "t3", approvalMode: "ask" },
  ];
  const built = build(tasks);
  const cancelled: string[] = [];
  const { stopBotForEmergencyApprovalDowngrade } = createChatInterrupts({
    ...built.deps,
    routines: () => ({ activeBotRunForBot: () => ({ id: "run1", threadId: "t2" }), cancelRun: async (id: string) => { cancelled.push(id); } }),
  } as never);
  await stopBotForEmergencyApprovalDowngrade("b1");
  // The task that already had Ask is left exactly as it was.
  expect(built.state.patchedTasks).toEqual([
    ["b1", "t1", { approvalMode: "ask", autoApprove: false, alwaysAllow: [] }],
    ["b1", "t2", { approvalMode: "ask", autoApprove: false, alwaysAllow: [] }],
  ]);
  expect(cancelled).toEqual(["run1"]);
});
