import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { DATA_DIR } from "../../config.ts";
import { conversationWork, enqueueConversationWork, type ConversationWork } from "../../persistence/conversation-db.ts";
import { Store, type Message } from "../../persistence/store.ts";
import { commandReceipt } from "../../commands.ts";
import { createGroupConversations } from "./group-conversations.ts";

const caller = { key: "owner", name: "Ana", seesBot: () => true };
const settle = async (condition: () => boolean) => {
  for (let tries = 0; tries < 100; tries++) { if (condition()) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
  throw new Error("Conversation work did not settle");
};

function fixture() {
  const store = new Store(() => ({ instanceId: "codex-acp", model: "agent-default" }));
  const bot = store.createBot({ name: `Nimbus-${randomUUID()}` });
  const file = join(DATA_DIR, `groups-${randomUUID()}.json`);
  const calls: Array<{ work: ConversationWork; threadId: string; prompt: string; recoveryPrompt: string }> = [];
  const stopped: string[] = [];
  const make = () => createGroupConversations({
    file, store: () => store, directory: () => [], isMember: () => true, keyOf: (email) => email,
    interruptBotTurn: async (_botId, threadId) => { stopped.push(threadId); },
    runBotTurn: async (work, threadId, prompt, recoveryPrompt) => {
      calls.push({ work, threadId, prompt, recoveryPrompt });
      store.appendMessage(threadId, { role: "user", kind: "text", text: work.text, sendId: work.id, sender: { id: work.askerKey, name: work.asker } });
    },
  });
  const service = make(); service.initialize();
  const group = service.create(caller, { name: "IGRS", bots: [bot.id] }).body as { id: string; threadId: string };
  const reply = (through: typeof service, text: string) => {
    const call = calls.at(-1)!;
    store.appendMessage(call.threadId, { role: "bot", kind: "text", text, turnTerminal: true });
    through.turnCompleted(call.threadId, true);
  };
  return { store, bot, file, calls, stopped, service, group, make, reply };
}

test("only an admin in the group can delete it, including its transcript and durable record", async () => {
  const f = fixture();
  await f.service.post(caller, f.group.id, "Private group message", "delete-test");
  expect(f.service.delete(caller, f.group.id).status).toBe(403);
  expect(f.service.delete({ ...caller, key: "other", canDeleteGroup: true }, f.group.id).status).toBe(404);
  expect(f.service.delete({ ...caller, canDeleteGroup: true }, f.group.id).status).toBe(200);
  expect(f.service.messages(caller, f.group.id).status).toBe(404);
  expect(f.store.messagesFor(f.group.threadId)).toEqual([]);
  expect(f.make().messages(caller, f.group.id).status).toBe(404);
  expect(commandReceipt("conversation.message", JSON.stringify([f.group.id, caller.key, "delete-test"]))).toBeNull();
});

test("the group deletion endpoint refuses direct messages", () => {
  const f = fixture();
  const dm = f.service.create(caller, { kind: "dm", emails: ["person@example.com"] }).body as { id: string };
  expect(f.service.delete({ ...caller, canDeleteGroup: true }, dm.id).status).toBe(400);
  expect(f.service.messages(caller, dm.id).status).toBe(200);
});

test("a group imported from an older conversation file can be deleted", () => {
  const f = fixture();
  const oldFile = join(DATA_DIR, `old-groups-${randomUUID()}.json`);
  const id = randomUUID();
  const threadId = randomUUID();
  writeFileSync(oldFile, JSON.stringify([{ id, threadId, kind: "group", name: "Older group", people: [caller.key], bots: [], createdBy: caller.key, createdAt: 1, updatedAt: 1, readAt: {}, botThreads: {} }]));
  const make = () => createGroupConversations({ file: oldFile, store: () => f.store, directory: () => [], isMember: () => true, keyOf: (email) => email, runBotTurn: async () => {} });
  const service = make();
  expect(service.messages(caller, id).status).toBe(200);
  expect(service.delete({ ...caller, canDeleteGroup: true }, id).status).toBe(200);
  expect(make().messages(caller, id).status).toBe(404);
});

test("a group with running work cannot be deleted", async () => {
  const f = fixture();
  await f.service.post(caller, f.group.id, `@${f.bot.name} work`, "busy-delete");
  await settle(() => f.calls.length === 1);
  expect(f.service.delete({ ...caller, canDeleteGroup: true }, f.group.id).status).toBe(409);
  f.reply(f.service, "Finished");
  await settle(() => conversationWork(f.group.id)[0]?.status === "completed");
  const botThread = f.calls[0]!.threadId;
  expect(f.service.delete({ ...caller, canDeleteGroup: true }, f.group.id).status).toBe(200);
  expect(f.store.messagesFor(botThread)).toEqual([]);
  expect(conversationWork(f.group.id)).toEqual([]);
});

test("a group with a routine reporting to it cannot be deleted", async () => {
  const f = fixture();
  await f.service.post(caller, f.group.id, `@${f.bot.name} work`, "routine-delete");
  await settle(() => f.calls.length === 1);
  expect(f.service.attachRoutine(f.bot.id, f.calls[0]!.threadId, "routine-1")).toBe(true);
  f.reply(f.service, "Finished");
  await settle(() => conversationWork(f.group.id)[0]?.status === "completed");
  expect(f.service.delete({ ...caller, canDeleteGroup: true }, f.group.id).status).toBe(409);
});

test("a retried group send is one message and one execution; context never becomes the user's words", async () => {
  const f = fixture();
  const text = `  @${f.bot.name} investigate this bug\n `;
  const results = await Promise.all([f.service.post(caller, f.group.id, text, "retry"), f.service.post(caller, f.group.id, text, "retry")]);
  expect(results.map((result) => result.status)).toEqual([201, 201]);
  expect((results[0]!.body as { message: Message }).message.id).toBe((results[1]!.body as { message: Message }).message.id);
  await settle(() => f.calls.length === 1);
  expect(f.calls[0]!.work.text).toBe(text);
  expect(f.calls[0]!.prompt).toContain('This is the group "IGRS".');
  expect(f.store.messagesFor(f.calls[0]!.threadId)[0]!.text).toBe(text);
  expect((await f.service.post(caller, f.group.id, "different words", "retry")).status).toBe(409);
  f.reply(f.service, "Found the issue");
  await settle(() => conversationWork(f.group.id)[0]?.status === "completed");
  expect(f.store.messagesFor(f.group.threadId).filter((message) => !message.notice).map((message) => message.text)).toEqual([text, "Found the issue"]);
});

test("a restart interrupts indeterminate provider work and resumes only undispatched work", async () => {
  const f = fixture();
  await f.service.post(caller, f.group.id, `@${f.bot.name} first`, "first");
  await settle(() => f.calls.length === 1);
  await f.service.post(caller, f.group.id, `@${f.bot.name} second`, "second");
  const firstId = f.calls[0]!.work.id;
  const restarted = f.make(); restarted.initialize(); restarted.wake();
  await settle(() => f.calls.length === 2);
  expect(f.calls[1]!.work.text).toContain("second");
  expect(f.calls.filter((call) => call.work.id === firstId)).toHaveLength(1);
  expect(conversationWork(f.group.id).map((work) => work.status)).toEqual(["interrupted", "running"]);
  expect(f.store.messagesFor(f.group.threadId).some((message) => message.text?.includes("stopped when Colonie restarted"))).toBe(true);
  f.reply(restarted, "Second result");
  await settle(() => conversationWork(f.group.id)[1]?.status === "completed");
});

test("two groups using the same bot have separate sessions and independent queues", async () => {
  const f = fixture();
  const other = f.service.create(caller, { name: "Other", bots: [f.bot.id] }).body as { id: string; threadId: string };
  await f.service.post(caller, f.group.id, `@${f.bot.name} IGRS only`, "same-client-id");
  await f.service.post(caller, other.id, `@${f.bot.name} Other only`, "same-client-id");
  await settle(() => f.calls.length === 2);
  expect(new Set(f.calls.map((call) => call.threadId)).size).toBe(2);
  const igrs = f.calls.find((call) => call.work.conversationId === f.group.id)!;
  const second = f.calls.find((call) => call.work.conversationId === other.id)!;
  expect(igrs.prompt).not.toContain("Other only");
  expect(second.prompt).not.toContain("IGRS only");
  for (const call of [igrs, second]) {
    f.store.appendMessage(call.threadId, { role: "bot", kind: "text", text: call.work.conversationId, turnTerminal: true });
    f.service.turnCompleted(call.threadId, true);
  }
  expect(f.store.messagesFor(f.group.threadId).at(-1)?.text).toBe(f.group.id);
  expect(f.store.messagesFor(other.threadId).at(-1)?.text).toBe(other.id);
});

test("a result persisted just before a crash is recovered without running the provider again", async () => {
  const f = fixture();
  await f.service.post(caller, f.group.id, `@${f.bot.name} bounded work`, "recover");
  await settle(() => f.calls.length === 1);
  f.store.appendMessage(f.calls[0]!.threadId, { role: "bot", kind: "text", text: "Durable answer", turnTerminal: true, turnSucceeded: true });
  const restarted = f.make(); restarted.initialize(); restarted.wake();
  expect(conversationWork(f.group.id)[0]?.status).toBe("completed");
  expect(f.store.messagesFor(f.group.threadId).filter((message) => message.text === "Durable answer")).toHaveLength(1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(f.calls).toHaveLength(1);
});

test.each([false, undefined])("a restart never promotes a failed or unproven answer to completed (%s)", async (outcome) => {
  const f = fixture();
  await f.service.post(caller, f.group.id, `@${f.bot.name} bounded work`, "uncertain");
  await settle(() => f.calls.length === 1);
  f.store.appendMessage(f.calls[0]!.threadId, { role: "bot", kind: "text", text: "Partial answer before a failure", turnTerminal: true, turnSucceeded: outcome });
  const restarted = f.make(); restarted.initialize(); restarted.wake();
  expect(conversationWork(f.group.id)[0]?.status).toBe(outcome === false ? "failed" : "interrupted");
  expect(f.store.messagesFor(f.group.threadId).some((message) => message.text === "Partial answer before a failure")).toBe(false);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(f.calls).toHaveLength(1);
});

test("an expired provider session can rebuild context from the group's own transcript", async () => {
  const f = fixture();
  await f.service.post(caller, f.group.id, `@${f.bot.name} remember the launch is Friday`, "first");
  await settle(() => f.calls.length === 1);
  f.reply(f.service, "Friday noted");
  const threadId = f.calls[0]!.threadId;
  f.store.patchTask(f.bot.id, threadId, { lastInstanceId: "codex-acp", resumeCursors: { "codex-acp": "expired-session" } });
  await f.service.post(caller, f.group.id, `@${f.bot.name} what is next?`, "next");
  await settle(() => f.calls.length === 2);
  const call = f.calls[1]!;
  expect(call.prompt).not.toContain("launch is Friday");
  expect(call.recoveryPrompt).toContain("launch is Friday");
  expect(call.recoveryPrompt).toContain("Friday noted");
  expect(call.recoveryPrompt).toContain('This is the group "IGRS".');
  f.reply(f.service, "Next step");
});

test("an execution intent and its visible message roll back together without notifying the UI", () => {
  const f = fixture();
  const command = { kind: "test.group.post", key: randomUUID() };
  const before = f.store.messagesFor(f.group.threadId).slice();
  const events: unknown[] = [];
  const off = f.store.onChange((event) => { events.push(event); });
  expect(() => f.store.appendMessage(f.group.threadId, { role: "user", kind: "text", text: "not committed" }, command, (message) => {
    enqueueConversationWork({ id: randomUUID(), conversationId: f.group.id, sourceMessageId: message.id, botId: f.bot.id, asker: caller.name, askerKey: caller.key, text: message.text!, depth: 0, upcoming: [], status: "queued" });
    throw new Error("persistence failed");
  })).toThrow("persistence failed");
  off();
  expect(f.store.messagesFor(f.group.threadId)).toEqual(before);
  expect(conversationWork(f.group.id)).toEqual([]);
  expect(commandReceipt(command.kind, command.key)).toBeNull();
  expect(events).toEqual([]);
});

test("stopping affects only the caller's work in this group and ignores a late answer", async () => {
  const f = fixture();
  const member = { ...caller, key: "bob@x.com", name: "Bob" };
  f.service.add(caller, f.group.id, { emails: [member.key] });
  await f.service.post(caller, f.group.id, `@${f.bot.name} first`, "first");
  await settle(() => f.calls.length === 1);
  await f.service.post(caller, f.group.id, `@${f.bot.name} queued`, "queued");
  await f.service.post(member, f.group.id, `@${f.bot.name} Bob's request`, "bob");
  expect((await f.service.stop({ ...caller, key: "stranger" }, f.group.id)).status).toBe(404);
  const oldThread = f.calls[0]!.threadId;
  expect((await f.service.stop(caller, f.group.id)).body).toEqual({ stopped: 2 });
  expect(f.stopped).toEqual([oldThread]);
  await settle(() => f.calls.length === 2);
  expect(f.calls[1]!.work.askerKey).toBe(member.key);
  expect(conversationWork(f.group.id).map((work) => work.status)).toEqual(["cancelled", "cancelled", "running"]);
  const stoppedMessage = f.store.messagesFor(f.group.threadId).find((message) => message.text === "Stopped by the person who asked.");
  expect(stoppedMessage).toBeTruthy();
  f.reply(f.service, "Bob's result");
  f.service.turnCompleted(oldThread, true);
  expect(f.store.messagesFor(f.group.threadId).find((message) => message.id === stoppedMessage!.id)?.text).toBe("Stopped by the person who asked.");
});

test("legacy group work is migrated before snapshots without rewriting the legacy file", () => {
  const f = fixture();
  const oldWork = f.store.createTask(f.bot.id, "Work for Legacy", false)!;
  const legacy = [{ id: randomUUID(), threadId: randomUUID(), kind: "group", name: "Legacy", people: [caller.key], bots: [f.bot.id], createdBy: caller.key, createdAt: 1, updatedAt: 1, readAt: {}, botThreads: { [f.bot.id]: oldWork.threadId } }];
  const realFile = `${f.file}.original`;
  writeFileSync(realFile, JSON.stringify(legacy));
  const service = createGroupConversations({ file: realFile, store: () => f.store, directory: () => [], isMember: () => true, keyOf: (email) => email, runBotTurn: async () => {} });
  service.initialize();
  expect(f.store.taskByThread(f.bot.id, oldWork.threadId)?.forConversation).toBe(legacy[0]!.id);
  expect(readFileSync(realFile, "utf8")).toBe(JSON.stringify(legacy));
});

test("a malformed legacy conversation file fails closed and remains available for recovery", () => {
  const f = fixture();
  const file = `${f.file}.broken`;
  writeFileSync(file, "{broken");
  expect(() => createGroupConversations({ file, store: () => f.store, directory: () => [], isMember: () => true, keyOf: (email) => email, runBotTurn: async () => {} })).toThrow("could not import");
  expect(readFileSync(file, "utf8")).toBe("{broken");
});
