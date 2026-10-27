// Durable group execution. The transcript owns the conversation; a native
// session is private execution state, never another personal chat.
import { randomUUID } from "node:crypto";
import { conversationWork, enqueueConversationWork, saveConversationRecords, saveConversationWork, type ConversationWork } from "../../persistence/conversation-db.ts";
import { mentionedBots, type Store } from "../../persistence/store.ts";
import type { GroupConversation } from "./group-conversations.ts";

type Bot = NonNullable<ReturnType<Store["bot"]>>;
export type ConversationAsk = Pick<ConversationWork, "asker" | "askerKey" | "depth"> & { by?: string; upcoming?: readonly string[]; visited?: readonly string[] };
export function createConversationWork(deps: {
  store: () => Store;
  records: () => GroupConversation[];
  changed: () => void;
  brief: (record: GroupConversation, bot: Bot, work: ConversationWork) => { prompt: string; recoveryPrompt: string; about: string };
  run: (work: ConversationWork, threadId: string, prompt: string, recoveryPrompt: string) => Promise<void>;
  interrupt?: (botId: string, threadId: string) => Promise<void>;
}) {
  const active = new Set<string>();
  const waiting = new Map<string, { work: ConversationWork; done: (finished: boolean) => void }>();
  let retry: ReturnType<typeof setTimeout> | undefined;
  const recordFor = (id: string) => deps.records().find((record) => record.id === id);

  function enqueue(record: GroupConversation, sourceMessageId: string, bots: Bot[], ask: ConversationAsk, text: string) {
    for (const [index, bot] of bots.entries()) enqueueConversationWork({
      id: randomUUID(), conversationId: record.id, sourceMessageId, botId: bot.id,
      text, asker: ask.asker, askerKey: ask.askerKey, depth: ask.depth, by: ask.by,
      upcoming: bots.slice(index + 1).map((entry) => entry.id), visited: [...new Set([...(ask.visited ?? []), ...bots.map((entry) => entry.id)])], status: "queued",
    });
  }

  function finish(work: ConversationWork, ok: boolean, failure?: string) {
    if (conversationWork(work.conversationId).find((entry) => entry.id === work.id)?.status !== "running") return;
    const record = recordFor(work.conversationId);
    if (!record) { saveConversationWork({ ...work, status: "cancelled" }); return; }
    const store = deps.store();
    const bot = store.bot(work.botId);
    const path = work.threadId ? store.activePath(work.threadId) : [];
    const askAt = path.findIndex((message) => message.role === "user" && message.sendId === work.id);
    const answers = askAt < 0 ? [] : path.slice(askAt + 1).filter((message) => message.role === "bot" && message.kind === "text" && message.text?.trim());
    const answer = answers.findLast((message) => message.turnTerminal) ?? answers.at(-1);
    const said = ok && answer?.text ? answer.text : failure ?? `${bot?.name ?? "The bot"} could not answer this time. Ask again in a moment.`;
    const next: GroupConversation = ok && answer ? {
      ...record, seenThrough: { ...record.seenThrough, [work.botId]: work.sourceMessageId },
      toldAbout: { ...record.toldAbout, [work.botId]: work.about ?? "" },
    } : record;
    const commit = () => {
      saveConversationWork({ ...work, status: ok && answer ? "completed" : work.status === "interrupted" ? "interrupted" : "failed" });
      saveConversationRecords(deps.records().map((entry) => entry.id === next.id ? next : entry));
      if (!ok || !answer?.text || !bot || work.depth >= 3) return;
      const candidates = record.bots.filter((id) => id !== bot.id && !work.upcoming.includes(id) && !work.visited?.includes(id)).map((id) => store.bot(id)).filter((entry): entry is Bot => Boolean(entry));
      const targets = mentionedBots(answer.text, candidates);
      if (targets.length) enqueue(record, work.messageId!, targets, { asker: work.asker, askerKey: work.askerKey, depth: work.depth + 1, by: bot.name, visited: work.visited }, answer.text);
    };
    if (work.messageId) store.patchMessage(record.threadId, work.messageId, { text: said, workThread: undefined, working: undefined }, undefined, commit);
    else commit();
    Object.assign(record, next);
    deps.changed();
  }

  async function start(work: ConversationWork): Promise<boolean> {
    const store = deps.store();
    const record = recordFor(work.conversationId);
    const bot = store.bot(work.botId);
    if (!record || !bot || !record.people.includes(work.askerKey) || !record.bots.includes(bot.id) || !store.messagesFor(record.threadId).some((message) => message.id === work.sourceMessageId)) {
      saveConversationWork({ ...work, status: "cancelled" });
      return true;
    }
    // Reuse an orphan left between preparing the task and saving its registry.
    let thread = record.botThreads[bot.id];
    if (!thread || !store.taskByThread(bot.id, thread)) {
      const existing = store.tasks(bot.id).find((task) => task.forConversation === record.id);
      const task = existing ?? store.createTask(bot.id, `Work for ${record.name || "a direct message"}`, false, undefined, undefined, undefined, undefined, [work.askerKey], { forConversation: record.id });
      if (!task) throw new Error("The bot's conversation could not be prepared.");
      thread = task.threadId;
      record.botThreads[bot.id] = thread;
      delete record.seenThrough?.[bot.id];
      delete record.toldAbout?.[bot.id];
      saveConversationRecords(deps.records());
    }
    const participants = store.threadParticipants(thread) ?? [];
    if (!participants.includes(work.askerKey)) store.setThreadParticipants(thread, [...participants, work.askerKey]);
    work.threadId = thread;
    const briefing = deps.brief(record, bot, work);
    work.about = briefing.about;
    work.status = "running";
    const line = { role: "bot" as const, kind: "text" as const, text: `${bot.name} is working on it…`, working: true as const, from: { botId: bot.id, name: bot.name, color: bot.color ?? "" } };
    if (!work.messageId) {
      store.appendMessage(record.threadId, line, undefined, (message) => {
        work.messageId = message.id; work.since = message.at; saveConversationWork(work);
      });
    } else store.patchMessage(record.threadId, work.messageId, line, undefined, () => saveConversationWork(work));
    const threadId = thread;
    return new Promise<boolean>((resolve) => {
      waiting.set(threadId, { work, done: resolve });
      void deps.run(work, threadId, briefing.prompt, briefing.recoveryPrompt).catch((error: unknown) => {
        if (waiting.get(threadId)?.work.id !== work.id) return;
        waiting.delete(threadId);
        const code = (error as { code?: string }).code;
        if (code === "thread_limit" || code === "thread_busy") {
          saveConversationWork({ ...work, status: "queued" });
          retry ??= setTimeout(() => { retry = undefined; wake(); }, 500);
          retry.unref?.();
          resolve(false);
        } else {
          finish(work, false, `${bot.name} could not start: ${error instanceof Error ? error.message : String(error)}`);
          resolve(true);
        }
      });
    });
  }

  async function drain(id: string) {
    if (active.has(id)) return;
    active.add(id);
    try {
      for (;;) {
        const next = conversationWork(id, "queued")[0];
        if (!next || !(await start(next))) break;
      }
    } catch (error) {
      console.error("Could not advance conversation work:", error);
    } finally { active.delete(id); }
  }

  function wake() {
    queueMicrotask(() => {
      for (const id of new Set(conversationWork(undefined, "queued").map((work) => work.conversationId))) void drain(id);
    });
  }

  async function cancel(conversationId: string, askerKey: string) {
    const jobs = conversationWork(conversationId).filter((work) => work.askerKey === askerKey && (work.status === "queued" || work.status === "running"));
    const stops: Promise<void>[] = [];
    for (const work of jobs) {
      const record = recordFor(conversationId);
      const persist = () => saveConversationWork({ ...work, status: "cancelled" });
      if (record && work.messageId) deps.store().patchMessage(record.threadId, work.messageId, { text: "Stopped by the person who asked.", working: undefined, workThread: undefined }, undefined, persist);
      else persist();
      const pending = work.threadId ? waiting.get(work.threadId) : undefined;
      if (pending?.work.id === work.id) {
        waiting.delete(work.threadId!);
        stops.push(Promise.resolve().then(() => deps.interrupt?.(work.botId, work.threadId!)).finally(() => pending.done(true)));
      }
    }
    deps.changed();
    await Promise.all(stops);
    wake();
    return jobs.length;
  }

  return {
    enqueue, wake, cancel,
    pending: (threadId: string) => waiting.get(threadId)?.work,
    initialize() {
      // Running provider calls are indeterminate after a process loss. Never
      // repeat their external effects automatically; safe, undispatched work stays queued.
      for (const work of conversationWork(undefined, "running")) {
        const path = work.threadId ? deps.store().activePath(work.threadId) : [];
        const at = path.findIndex((message) => message.sendId === work.id);
        const terminal = at >= 0 && path.slice(at + 1).some((message) => message.turnTerminal);
        const bot = deps.store().bot(work.botId);
        finish({ ...work, status: "interrupted" }, terminal, `${bot?.name ?? "The bot"} stopped when Colonie restarted. Mention it again to ask.`);
      }
    },
    completed(threadId: string, ok: boolean) {
      const pending = waiting.get(threadId);
      if (pending) {
        waiting.delete(threadId);
        try { finish(pending.work, ok); } finally { pending.done(true); }
      }
      wake();
    },
  };
}
