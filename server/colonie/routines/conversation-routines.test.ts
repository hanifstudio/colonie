// An isolated Store, scheduler, chat cards and group registry together. No
// network or provider calls; the app-level ACP journey is a separate check.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { expect, test } from "vitest";
import { DATA_DIR } from "../../config.ts";
import { Store } from "../../persistence/store.ts";
import type { RuntimeEvent } from "../../contracts.ts";
import { VisibleSet, routineVisible } from "../bots/bot-visibility.ts";
import { createGroupConversations } from "../groups/group-conversations.ts";
import { createConversationRoutines } from "./conversation-routines.ts";
import { createRoutineRunCards } from "./run-cards.ts";
import { RoutineManager, type RoutineRun } from "./routines.ts";
import { RoutineRequestService } from "./routine-requests.ts";

const ana = { id: "ana@example.com", name: "Ana" };
const bob = { id: "bob@example.com", name: "Bob" };
const caller = { key: ana.id, name: ana.name, seesBot: () => true, canDeleteGroup: true };

function fixture() {
  const store = new Store(() => ({ instanceId: "codex-acp", model: "agent-default" }));
  const bot = store.createBot({ name: `Ada-${randomUUID()}` });
  let scheduler: RoutineManager;
  const file = join(DATA_DIR, `${randomUUID()}-routines.json`);
  const groups = createGroupConversations({
    file: join(DATA_DIR, `${randomUUID()}-groups.json`), store: () => store,
    directory: () => [ana, bob].map((person) => ({ email: person.id, name: person.name })),
    isMember: () => true, keyOf: (email) => email, runBotTurn: async () => {},
    routineForThread: (threadId) => scheduler?.runForThread(threadId) ?? null,
    hasRoutinesFor: (id) => scheduler.listRoutines().some((routine) => routine.conversation?.id === id),
  });
  const group = groups.create(caller, { kind: "group", name: "Launch", emails: [bob.id], bots: [bot.id] }).body as { id: string; threadId: string };
  const worker = store.createTask(bot.id, "Work for Launch", false, undefined, undefined, undefined, undefined, [ana.id, bob.id], { forConversation: group.id })!;
  groups.byId(group.id)!.botThreads[bot.id] = worker.threadId;
  groups.update(caller, group.id, { instructions: "Use the launch checklist." });
  const dm = store.createTask(bot.id, "Ana's DM", false, undefined, undefined, undefined, undefined, [ana.id])!;
  const binding = createConversationRoutines({ store, groups, local: () => false });
  const cards = createRoutineRunCards({ store, conversationOf: groups.byThread });
  const starts: string[] = [];
  const options = {
    file, botState: () => "ready" as const, conversationForRequest: binding.bind, recoverConversation: binding.recover,
    canRun: binding.canRun, createTask: binding.createTask,
    startTurn: async (_botId: string, threadId: string) => { starts.push(threadId); },
    onRunChanged: cards.syncRoutineRunToSource,
  };
  scheduler = new RoutineManager(options);
  const requests = new RoutineRequestService({ store, routines: scheduler, autoApply: () => "self",
    validateScope: (botId, threadId, id) => {
      const routine = scheduler.listRoutines().find((entry) => entry.id === id);
      return routine && binding.inThread(routine, botId, threadId) ? null : "That routine is not in this conversation.";
    },
  });
  const schedule = async (threadId = worker.threadId, who = ana, name = "Launch report") => {
    store.appendMessage(threadId, { role: "user", kind: "text", text: "Every weekday at 9, report here.", sender: who });
    const proposal = await requests.submit({ botId: bot.id, threadId, proposal: { action: "create", routine: {
      name, instructions: "Read the launch checklist and report progress.", schedule: { type: "weekly", time: "09:00", weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday"] },
    } } });
    return { ...proposal, routine: scheduler.listRoutines().find((entry) => entry.id === proposal.result?.resultId)! };
  };
  const event = (run: RoutineRun, detail: Record<string, unknown>) => scheduler.handleRuntimeEvent({ eventId: randomUUID(), provider: "codex-acp", threadId: run.threadId!, createdAt: new Date().toISOString(), ...detail } as RuntimeEvent);
  return { store, bot, groups, group, worker, dm, binding, cards, scheduler, requests, schedule, event, starts, restart: () => new RoutineManager(options) };
}

test("scheduled group work keeps its person, folder and a single status/report in the group", async () => {
  const f = fixture();
  const { routine } = await f.schedule();
  expect(routine.conversation).toEqual({ id: f.group.id, threadId: f.group.threadId, requestedBy: ana });
  const run = f.scheduler.runNow(routine.id)!;
  await f.scheduler.tick();
  const current = f.scheduler.listRuns().find((entry) => entry.id === run.id)!;
  expect(current.threadId).not.toBe(f.worker.threadId);
  expect(f.store.taskByThread(f.bot.id, current.threadId!)?.forConversation).toBe(f.group.id);
  expect(f.store.threadParticipants(current.threadId!)).toEqual([ana.id, bob.id]);
  expect(f.binding.turnContext(current, "Do the report")).toMatchObject({ sender: ana, providerPrompt: expect.stringContaining("Use the launch checklist.") });
  f.event(current, { type: "request.opened", requestId: "permission", requestType: "permission", tool: "write-file", summary: "Approve writing a file" });
  const ask = f.store.appendMessage(current.threadId!, { role: "bot", kind: "options", card: { requestId: "permission", title: "Write a file?", subtitle: "Approve writing a file", options: ["Allow", "Deny"] } });
  f.groups.relayWork(current.threadId!, ask);
  expect(f.store.messagesFor(f.group.threadId).find((message) => message.relay?.messageId === ask.id)?.relay).toMatchObject({ threadId: current.threadId, askedBy: ana.id });
  expect(f.store.messagesFor(f.group.threadId).find((message) => message.routineRun?.runId === run.id)?.routineRun?.status).toBe("waiting");
  f.store.patchMessage(current.threadId!, ask.id, { card: { ...ask.card!, answered: "allow" } });
  f.groups.relayWork(current.threadId!, f.store.messagesFor(current.threadId!).find((message) => message.id === ask.id)!);
  expect(f.store.messagesFor(f.group.threadId).find((message) => message.relay?.messageId === ask.id)?.card?.answered).toBe("allow");
  f.event(current, { type: "request.resolved", requestId: "permission", behavior: "allow" });
  f.event(current, { type: "item.completed", itemType: "assistant_text", text: "Launch is ready." });
  f.event(current, { type: "turn.completed", ok: true });
  const finished = f.scheduler.listRuns().find((entry) => entry.id === run.id)!;
  f.cards.syncRoutineRunToSource(finished);
  const receipts = f.store.messagesFor(f.group.threadId).filter((message) => message.routineRun?.runId === run.id);
  expect(receipts).toHaveLength(1);
  expect(receipts[0]).toMatchObject({ from: { botId: f.bot.id }, routineRun: { status: "completed", summary: "Launch is ready." } });
  expect(f.store.messagesFor(f.dm.threadId).some((message) => message.routineRun)).toBe(false);
  expect(f.store.messagesFor(f.bot.threadId).some((message) => message.routineRun)).toBe(false);
});

test("DM routines report to their originating DM and are private on listings and live frames", async () => {
  const f = fixture();
  const folder = join(DATA_DIR, `dm-project-${randomUUID()}`);
  f.store.moveTaskFolder(f.bot.id, f.dm.threadId, folder);
  const { routine } = await f.schedule(f.dm.threadId);
  expect(routine.conversation).toEqual({ threadId: f.dm.threadId, requestedBy: ana });
  expect(f.binding.inThread(routine, f.bot.id, f.worker.threadId)).toBe(false);
  const visible = (key: string) => new VisibleSet([{ id: f.bot.id, threadId: f.dm.threadId }], [], { kind: "person", key, admin: true }, () => ({ bot: f.bot.id }), f.store.threadParticipants.bind(f.store));
  expect(routineVisible(routine, visible(ana.id))).toBe(true);
  expect(routineVisible(routine, visible(bob.id))).toBe(false);
  const run = f.scheduler.runNow(routine.id)!;
  await f.scheduler.tick();
  expect(f.store.taskByThread(f.bot.id, f.scheduler.listRuns()[0]!.threadId!)?.cwd).toBe(folder);
  expect(f.store.messagesFor(f.dm.threadId).filter((message) => message.routineRun?.runId === run.id)).toHaveLength(1);
  expect(f.store.messagesFor(f.bot.threadId).some((message) => message.routineRun)).toBe(false);
  expect(routineVisible(f.scheduler.listRuns()[0]!, visible(bob.id))).toBe(false);
});

test("the same instructions in different conversations are independent; chat cannot change a guessed foreign routine", async () => {
  const f = fixture();
  const { routine } = await f.schedule();
  const dm = await f.schedule(f.dm.threadId, ana, "Private launch report");
  expect(dm.routine.id).not.toBe(routine.id);
  await expect(f.requests.submit({ botId: f.bot.id, threadId: f.dm.threadId, proposal: { action: "pause", routineId: routine.id } })).rejects.toThrow("not in this conversation");
  await expect(f.schedule(f.worker.threadId, ana, "Duplicate")).rejects.toThrow("already exists");
  await f.requests.submit({ botId: f.bot.id, threadId: f.worker.threadId, proposal: { action: "pause", routineId: routine.id } });
  expect(f.scheduler.listRoutines().find((entry) => entry.id === routine.id)?.enabled).toBe(false);
  expect(f.scheduler.listRoutines().find((entry) => entry.id === dm.routine.id)?.enabled).toBe(true);
});

test("a restart keeps the destination and one report, without repeating interrupted work", async () => {
  const f = fixture();
  const { routine } = await f.schedule();
  const run = f.scheduler.runNow(routine.id)!;
  await f.scheduler.tick();
  const restarted = f.restart();
  expect(restarted.listRoutines()[0]?.conversation).toEqual(routine.conversation);
  const failed = restarted.listRuns().find((entry) => entry.id === run.id)!;
  expect(failed.status).toBe("failed");
  expect(f.store.messagesFor(f.group.threadId).filter((message) => message.routineRun?.runId === run.id)).toHaveLength(1);
  await restarted.tick();
  expect(f.starts).toHaveLength(1);
});

test("removed people and bots cannot keep dispatching routines; a later person cannot take over an old request", async () => {
  const f = fixture();
  const delayedCard = f.store.appendMessage(f.worker.threadId, { role: "user", kind: "text", text: "From Ana", sender: ana });
  const card = f.store.appendMessage(f.worker.threadId, { role: "bot", kind: "options", text: "A saved card" });
  f.store.appendMessage(f.worker.threadId, { role: "user", kind: "text", text: "From Bob", sender: bob });
  expect(delayedCard.sender).toBeDefined();
  expect(f.binding.bind({ botId: f.bot.id, threadId: f.worker.threadId, messageId: card.id })?.requestedBy).toEqual(ana);
  const { routine } = await f.schedule();
  f.groups.byId(f.group.id)!.people = [bob.id];
  const run = f.scheduler.runNow(routine.id)!;
  await f.scheduler.tick();
  expect(f.starts).toHaveLength(0);
  expect(f.scheduler.listRuns().find((entry) => entry.id === run.id)?.error).toContain("left the conversation");
  expect(f.scheduler.listRoutines().find((entry) => entry.id === routine.id)).toMatchObject({ enabled: false, nextRunAt: null });
  f.groups.byId(f.group.id)!.people = [ana.id, bob.id];
  f.groups.byId(f.group.id)!.bots = [];
  expect(f.binding.canRun({ botId: f.bot.id, conversation: routine.conversation })).toContain("no longer in its conversation");
});

test("a routine's destination survives Undo deletion and cannot be redirected by calendar input", async () => {
  const f = fixture();
  const { routine } = await f.schedule();
  expect(() => f.scheduler.update(routine.id, { resultsThreadId: f.dm.threadId })).toThrow("reporting conversation");
  const deleted = await f.requests.submit({ botId: f.bot.id, threadId: f.worker.threadId, proposal: { action: "delete", routineId: routine.id } });
  const undone = f.requests.undo({ botId: f.bot.id, threadId: f.worker.threadId, requestId: deleted.requestId });
  expect(undone).toMatchObject({ claimed: true, state: "undone" });
  expect(f.scheduler.listRoutines()[0]?.conversation).toEqual(routine.conversation);
  expect(f.groups.delete(caller, f.group.id).status).toBe(409);
});

test("chat edits, pause and resume preserve the destination; stopping a run does not pause future work", async () => {
  const f = fixture(); const { routine } = await f.schedule();
  const change = (action: string, changes?: unknown) => f.requests.submit({ botId: f.bot.id, threadId: f.worker.threadId, proposal: { action, routineId: routine.id, ...(changes ? { changes } : {}) } });
  await change("update", { name: "Later launch report", instructions: "Report blockers first.", schedule: { type: "weekly", time: "10:00", weekdays: ["friday"] } });
  expect(f.scheduler.listRoutines().find((entry) => entry.id === routine.id)).toMatchObject({ name: "Later launch report", prompt: "Report blockers first.", schedule: { type: "daily", time: "10:00", weekdays: [5] }, conversation: routine.conversation });
  await change("pause"); expect(f.scheduler.listRoutines().find((entry) => entry.id === routine.id)?.nextRunAt).toBeNull();
  await change("resume"); expect(f.scheduler.listRoutines().find((entry) => entry.id === routine.id)?.nextRunAt).toBeGreaterThan(Date.now());
  await change("run_now"); await f.scheduler.tick();
  const run = f.scheduler.listRuns().find((entry) => entry.routineId === routine.id)!;
  await f.scheduler.cancelRun(run.id);
  expect(f.scheduler.listRuns().find((entry) => entry.id === run.id)?.status).toBe("cancelled");
  expect(f.scheduler.listRoutines().find((entry) => entry.id === routine.id)?.enabled).toBe(true);
});

test("a routine proposal in the group remains confirmable after conversation recovery", async () => {
  const f = fixture();
  f.store.appendMessage(f.worker.threadId, { role: "user", kind: "text", text: "Schedule a report", sender: ana });
  const proposal = await f.requests.propose({ botId: f.bot.id, threadId: f.worker.threadId, proposal: { action: "create", routine: { name: "Reviewed report", instructions: "Report after review.", schedule: { type: "weekly", time: "09:00", weekdays: ["friday"] } } } });
  const original = f.store.messagesFor(f.worker.threadId).find((message) => message.id === proposal.messageId)!;
  const copy = f.store.appendMessage(f.group.threadId, { role: "bot", kind: "options", card: original.card, from: { botId: f.bot.id, name: f.bot.name, color: "blue" }, relay: { threadId: f.worker.threadId, messageId: original.id, askedBy: ana.id } });
  f.groups.initialize();
  expect(f.store.messagesFor(f.group.threadId).find((message) => message.id === copy.id)?.card?.expired).not.toBe(true);
  expect(f.requests.resolve({ botId: f.bot.id, threadId: f.worker.threadId, requestId: proposal.requestId, behavior: "allow" })).toMatchObject({ state: "applied" });
  expect(f.scheduler.listRoutines()[0]?.conversation).toMatchObject({ id: f.group.id, requestedBy: ana });
});

test("acknowledging failures never changes another conversation's runs", async () => {
  const f = fixture();
  const group = (await f.schedule()).routine;
  const dm = (await f.schedule(f.dm.threadId)).routine;
  for (const routine of [group, dm]) {
    const queued = f.scheduler.runNow(routine.id)!; await f.scheduler.tick();
    const run = f.scheduler.listRuns().find((entry) => entry.id === queued.id)!;
    f.event(run, { type: "turn.completed", ok: false, stopReason: "Fixture failure" });
  }
  expect(f.scheduler.markAllSeen((run) => run.conversation?.threadId === f.dm.threadId)).toMatchObject([{ routineId: dm.id }]);
  expect(f.scheduler.listRuns().find((run) => run.routineId === group.id)?.seenAt).toBeUndefined();
});
