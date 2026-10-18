// The state gates behind every dispatch: which bot a thread really belongs to,
// whether it is busy, how many of a bot's threads hold a slot, and which
// admission decision that produces.
import { expect, test } from "vitest";
import { admit } from "../../admission.ts";
import { createThreadAdmission } from "./thread-admission.ts";

function build(options: {
  bot?: { id: string; threadId?: string } | null;
  tasks?: Array<{ threadId: string; busy?: boolean }>;
  claims?: Array<[string, { botId: string }]>;
  direct?: Array<[string, { id: string }]>;
  maxThreads?: number;
  botByThread?: Record<string, { id: string }>;
} = {}) {
  const claims = new Map(options.claims ?? []);
  const admission = createThreadAdmission({
    admit,
    directTurnBots: new Map(options.direct ?? []),
    directTurnDispatchClaims: claims,
    maxConcurrentThreads: () => options.maxThreads ?? 2,
    store: () => ({
      bot: () => options.bot ?? undefined,
      tasks: () => options.tasks ?? [],
      taskByThread: (_botId: string, threadId: string) => (options.tasks ?? []).find((task) => task.threadId === threadId && task.busy),
      projectBotForTask: () => options.bot ?? undefined,
    }),
  } as never);
  return { ...admission, claims };
}

test("a thread is busy from its stored flag or a live dispatch claim", () => {
  expect(build({ tasks: [{ threadId: "t1", busy: true }] }).threadBusy("b1", "t1")).toBe(true);
  expect(build({ claims: [["t1", { botId: "b1" }]] }).threadBusy("b1", "t1")).toBe(true);
  expect(build({ tasks: [{ threadId: "t1" }] }).threadBusy("b1", "t1")).toBe(false);
});

test("a live direct bot shadows the stored one for its thread", () => {
  expect(build({ direct: [["t1", { id: "live" }]], bot: { id: "stored" } }).botForThread("b1", "t1")?.id).toBe("live");
  expect(build({ bot: { id: "stored" } }).botForThread("b1", "t1")?.id).toBe("stored");
});

test("capacity counts the busy threads, not the total", () => {
  const tasks = [{ threadId: "t1", busy: true }, { threadId: "t2" }, { threadId: "t3", busy: true }];
  expect(build({ tasks, maxThreads: 2 }).botAtThreadCapacity("b1")).toBe(true);
  expect(build({ tasks, maxThreads: 3 }).botAtThreadCapacity("b1")).toBe(false);
});

test("a direct turn is admitted only with a free thread and a free slot", () => {
  expect(build({}).canAdmitDirectTurn("b1", "t1")).toBe(true);
  expect(build({ tasks: [{ threadId: "t1", busy: true }] }).canAdmitDirectTurn("b1", "t1")).toBe(false);
  expect(build({ tasks: [{ threadId: "t1", busy: true }, { threadId: "t2", busy: true }] }).canAdmitDirectTurn("b1", "t1")).toBe(false);
});

test("an unattended start reads ready, busy or missing", () => {
  expect(build({ bot: { id: "b1" } }).unattendedDispatchState("b1")).toBe("ready");
  expect(build({}).unattendedDispatchState("b1")).toBe("missing");
  expect(build({ bot: { id: "b1" }, tasks: [{ threadId: "t1", busy: true }, { threadId: "t2", busy: true }] }).unattendedDispatchState("b1")).toBe("busy");
});

test("a requested task bot refuses unknown bots, bad ids and missing tasks", () => {
  expect(() => build({}).requestedTaskBot("b1", undefined)).toThrowError(expect.objectContaining({ status: 404 }));
  expect(() => build({ bot: { id: "b1" } }).requestedTaskBot("b1", "bad id")).toThrowError(expect.objectContaining({ status: 400 }));
  expect(build({ bot: { id: "b1" } }).hasDirectDispatch("b1")).toBe(false);
  expect(build({ claims: [["t1", { botId: "b1" }]] }).hasDirectDispatch("b1")).toBe(true);
});
