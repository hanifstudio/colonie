// Durable group execution. The transcript owns the conversation; a native
// session is private execution state, never another personal chat.
import { randomUUID } from "node:crypto";
import { conversationWork, enqueueConversationWork, saveConversationRecords, saveConversationWork, type ConversationWork } from "../../persistence/conversation-db.ts";
import { mentionedBots, type Store } from "../../persistence/store.ts";
import { failedTurnCause } from "../../../shared/failed-turn.ts";
import type { GroupConversation } from "./group-conversations.ts";

type Bot = NonNullable<ReturnType<Store["bot"]>>;
export type ConversationAsk = Pick<ConversationWork, "asker" | "askerKey" | "depth" | "unnamed"> & { by?: string; upcoming?: readonly string[]; visited?: readonly string[] };
/** A bot must end with "Status: done" or "Status: stuck - what it needs". A
 * reply with neither (such as "I'll continue") is not a finished result. */
export function workEnd(reply: string, handedOn = false): { state: "completed" | "blocked"; text: string; missing?: boolean } {
  const match = /\n?[ \t]*Status:[ \t]*(done|stuck)\b[ \t:-]*([^\n]*)\s*$/i.exec(reply);
  // Handing the work to a teammate is progress, not a block: drop a "stuck"
  // line that sits beside it instead of showing the group a false stop.
  if (match && handedOn && match[1].toLowerCase() === "stuck") return { state: "completed", text: reply.slice(0, match.index).trim() };
  if (!match && handedOn) return { state: "completed", text: reply.trim() };
  if (!match) return { state: "blocked", missing: true, text: `${reply.trim()}\n\nEnded without a result or a stated blocker.` };
  const text = reply.slice(0, match.index).trim();
  if (match[1].toLowerCase() === "done") return { state: "completed", text };
  return { state: "blocked", text: `${text}\n\nStuck: ${match[2].trim() || "no reason given"}`.trim() };
}

/** A reply that only asks whether to go on, or names the next step without doing it, is not a
 * stop: the bot is run again by itself (at most NEXT_STEP_LIMIT times). A question about a named
 * action ("Deploy now?") is a real question and waits for the person. Same idea as openbot's
 * plan continuation (src/backend/agent/plan-continuation.ts), in English and Bahasa Indonesia. */
const NEXT_STEP_LIMIT = 2;
const NEXT_STEP_MAX_CHARS = 400;
const GO_ON = "(?:continue|keep going|go on|carry on|lanjut(?:kan)?|teruskan)";
const ASKS_TO_GO_ON = new RegExp(String.raw`^(?:[^?？]*[.!]\s+)?(?:(?:(?:shall|should|can|may)\s+i|(?:do\s+you\s+)?want\s+me\s+to|would\s+you\s+like\s+me\s+to|mau\s+(?:saya|aku|gue)|perlu\s+(?:saya|aku|gue)|boleh\s+(?:saya|aku|gue)|apakah\s+(?:saya|aku|gue)\s+perlu)\s+)?${GO_ON}(?:\s+(?:with|to|on|ke|dengan)\s+(?:the\s+)?(?:next(?:\s+(?:steps?|parts?|items?))?|rest(?:\s+of\s+(?:it|the\s+(?:work|steps|list)))?|remaining(?:\s+(?:steps|work|items))?|langkah\s+berikutnya|sisanya))?\s*\?+$`, "i");
const NAMES_NEXT_STEP = /(?:\blet me now\b|\bnow let me\b|\bi['\u2019]ll now\b|\bi will now\b|\bnext,?\s+i(?:['\u2019]ll| will)\b|\bsekarang\s+(?:saya|aku|gue)\s+(?:akan|bakal)\b|\bselanjutnya\s+(?:saya|aku|gue)\s+(?:akan|bakal)\b)(?!\s+(?:wait|hold|pause|stop|tunggu|berhenti|menunggu)\b)[^.!?\n]{0,100}[.:\u2026]?\s*$/i;
const WAITS_FOR_PERSON = /\b(?:i['\u2019]ll|i will|let me)\s+(?:now\s+)?(?:wait|hold|pause|stop)\b|\bwaiting\s+(?:for|on)\s+(?:you|your)\b|\b(?:saya|aku|gue)\s+(?:akan\s+)?(?:menunggu|tunggu)\b/i;
const lastLine = (reply: string) => (reply.trimEnd().split("\n").at(-1) ?? "").replace(/[*_`>#]/g, "").trim();
/** The reply with its closing "Status:" line removed, as a person reads it. */
const body = (reply: string) => reply.replace(/\n?[ \t]*Status:[ \t]*(?:done|stuck)\b[^\n]*\s*$/i, "").trim();
export function stoppedBeforeNextStep(reply: string): boolean {
  const line = lastLine(body(reply));
  if (/[?？]/.test(line)) return ASKS_TO_GO_ON.test(line);
  if (WAITS_FOR_PERSON.test(line)) return false;
  const text = body(reply);
  return text.length > 0 && text.length <= NEXT_STEP_MAX_CHARS && NAMES_NEXT_STEP.test(text.slice(-160));
}

/** A short reply that only acknowledges ("siap", "noted", "tercatat", "sip", "oke", "terima kasih",
 * "got it") asks nothing. Naming a teammate in it must not wake them, with or without a status line;
 * otherwise two bots keep answering each other. A reply that asks for something is longer or
 * carries a task, so it never matches. */
// What may follow the acknowledging word: only names, politeness, or a short "will do / waiting" closer.
// Anything else (a verb of work such as "tolong cek", "please write") makes it a request.
const ACKNOWLEDGES = /^(?:@\S+\s*[,:]?\s*)*(?:siap|sip|oke|ok|okay|noted|tercatat|dicatat|diterima|paham|dipahami|mengerti|baik|baiklah|ya|yes|got it|understood|roger|thanks|thank you|terima kasih|makasih|mantap|sama-sama)\b(?:\s*[,.!]?\s*(?:@\S+|kak|bro|mas|mba|guys|thanks|terima kasih|makasih|ya|nih|deh|banget|sekali|dong|siap|ok|oke|noted|tercatat))*\s*[.!]*$/i;
export function onlyAcknowledges(reply: string): boolean {
  const text = body(reply).trim();
  return text.length > 0 && text.length <= 80 && !/[?？]/.test(text) && ACKNOWLEDGES.test(text.replace(/[*_`>#]/g, "").trim());
}

/** Hand-offs in one chain before the group is told it stopped. */
const MAX_CHAIN = 8;

export function createConversationWork(deps: {
  store: () => Store;
  records: () => GroupConversation[];
  changed: () => void;
  lead: (record: GroupConversation) => Bot | undefined;
  brief: (record: GroupConversation, bot: Bot, work: ConversationWork) => { prompt: string; recoveryPrompt: string; about: string };
  run: (work: ConversationWork, threadId: string, prompt: string, recoveryPrompt: string) => Promise<void>;
  interrupt?: (botId: string, threadId: string) => Promise<void>;
}) {
  /** Lanes running now: one per bot in a conversation, so different bots
   * work at the same time and one bot takes its own requests in order. */
  const active = new Set<string>();
  const lane = (conversationId: string, botId: string) => `${conversationId}\n${botId}`;
  const waiting = new Map<string, { work: ConversationWork; done: (finished: boolean) => void }>();
  let retry: ReturnType<typeof setTimeout> | undefined;
  const recordFor = (id: string) => deps.records().find((record) => record.id === id);

  function enqueue(record: GroupConversation, sourceMessageId: string, bots: Bot[], ask: ConversationAsk, text: string) {
    for (const [index, bot] of bots.entries()) {
      const work = enqueueConversationWork({
        id: randomUUID(), conversationId: record.id, sourceMessageId, botId: bot.id,
        text, asker: ask.asker, askerKey: ask.askerKey, depth: ask.depth, by: ask.by, ...(ask.unnamed ? { unnamed: true } : {}),
        upcoming: bots.slice(index + 1).map((entry) => entry.id), visited: [...new Set([...(ask.visited ?? []), ...bots.map((entry) => entry.id)])], status: "queued",
      });
      // a bot already busy here says so at once, instead of staying silent
      // until its current work ends
      // until its current work ends (after the message that asked, which may
      // still be being saved)
      if (work.status === "queued" && !work.messageId && active.has(lane(record.id, bot.id))) {
        queueMicrotask(() => {
          const current = conversationWork(record.id).find((entry) => entry.id === work.id);
          if (current?.status !== "queued" || current.messageId || !active.has(lane(record.id, bot.id))) return;
          deps.store().appendMessage(record.threadId, { role: "bot", kind: "text", text: `${bot.name} is finishing something else; this is next.`, working: true,
            from: { botId: bot.id, name: bot.name, color: bot.color ?? "" } }, undefined, (message) => { saveConversationWork({ ...current, messageId: message.id }); });
        });
      }
    }
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
    // Any other bot of the group may be named again (a reviewer is asked twice
    // across a task); a bot queued behind this one is skipped.
    // Bots asked together in the same message answer side by side, not in turn.
    const candidates = bot ? record.bots.filter((id) => id !== bot.id && !work.upcoming.includes(id) &&
      !(work.depth === 0 && !work.by && work.visited?.includes(id)))
      .map((id) => store.bot(id)).filter((entry): entry is Bot => Boolean(entry)) : [];
    // A reply that closes with "Status: done" is an answer, not a request: it may
    // thank or confirm a teammate by name without waking them (no "siap" ping-pong).
    const closes = ok && answer?.text ? /\n?[ \t]*Status:[ \t]*done\b/i.test(answer.text) : false;
    const named = ok && answer?.text && !closes && !onlyAcknowledges(answer.text) ? mentionedBots(answer.text, candidates) : [];
    const capped = named.length > 0 && work.depth >= MAX_CHAIN;
    const targets = capped ? [] : named;
    // a capped hand-off is still a hand-off: it is not asked again for a status
    // a bare "siap" is a complete reply: it needs no status line, so it is not asked for one
    const end = ok && answer?.text ? workEnd(answer.text, named.length > 0 || onlyAcknowledges(answer.text)) : undefined;
    // a failed turn already wrote its cause into the bot's work thread ("error: no activity for 20 minutes…"):
    // say that in the group instead of a generic apology
    const cause = !ok && !failure && askAt >= 0
      ? path.slice(askAt + 1).filter((message) => message.kind === "activity" && message.tool?.ok === false)
        .map((message) => failedTurnCause(message.tool?.name ?? "")).findLast((value): value is string => Boolean(value))
      : undefined;
    const said = end ? end.text : ok && answer?.text ? answer.text
      : failure ?? (cause ? `${bot?.name ?? "The bot"} stopped: ${cause}` : `${bot?.name ?? "The bot"} could not answer this time. Ask again in a moment.`);
    const next: GroupConversation = ok && answer ? {
      ...record, seenThrough: { ...record.seenThrough, [work.botId]: work.sourceMessageId },
      toldAbout: { ...record.toldAbout, [work.botId]: work.about ?? "" },
    } : record;
    // "Shall I continue?" or "now I'll run the tests." is not a stop: go on by itself, twice at most.
    const goesOn = ok && answer?.text && !named.length && !(end?.state === "completed" && /Status:\s*done/i.test(answer.text)) && stoppedBeforeNextStep(answer.text);
    if (goesOn && (work.continued ?? 0) < NEXT_STEP_LIMIT) {
      saveConversationWork({ ...work, status: "queued", continued: (work.continued ?? 0) + 1 });
      if (work.messageId) store.patchMessage(record.threadId, work.messageId, { text: `${bot?.name ?? "The bot"} is continuing (${(work.continued ?? 0) + 1} of ${NEXT_STEP_LIMIT}).`, working: true, workingSince: Date.now() });
      Object.assign(record, next);
      deps.changed();
      wake();
      return;
    }
    if (end?.missing && !work.nudged) {
      // Ask once more, in the same line, before telling the group it ended.
      saveConversationWork({ ...work, status: "queued", nudged: true });
      Object.assign(record, next);
      deps.changed();
      wake();
      return;
    }
    const commit = () => {
      saveConversationWork({ ...work, status: ok && answer ? end?.state ?? "completed" : work.status === "interrupted" ? "interrupted" : "failed" });
      saveConversationRecords(deps.records().map((entry) => entry.id === next.id ? next : entry));
      if (!ok || !answer?.text || !bot) return;
      if (capped) {
        store.appendMessage(record.threadId, { role: "bot", kind: "text", notice: true,
          text: `${bot.name} named ${named.map((entry) => entry.name).join(", ")}, but this chain already passed through ${MAX_CHAIN} bots, so it stopped here. Mention them to continue.` });
      } else if (targets.length) enqueue(record, work.messageId!, targets, { asker: work.asker, askerKey: work.askerKey, depth: work.depth + 1, by: bot.name, visited: work.visited }, end?.text ?? answer.text);
    };
    // an ended-early line offers Continue; a finished one does not
    const final = ok && answer ? end?.state ?? "completed" : work.status === "interrupted" ? "interrupted" : "failed";
    const stoppedBy = final === "completed" ? undefined : { botId: work.botId, reason: final as "blocked" | "interrupted" | "failed" };
    if (work.messageId) store.patchMessage(record.threadId, work.messageId, { text: said, working: undefined, workingSince: undefined, stoppedBy }, undefined, commit);
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
    // the level belongs to the bot (owner, October 29): its work here follows
    // the bot's current level, not the one copied when the thread was made
    store.refreshTaskPermissions(bot.id, thread);
    const participants = store.threadParticipants(thread) ?? [];
    if (!participants.includes(work.askerKey)) store.setThreadParticipants(thread, [...participants, work.askerKey]);
    work.threadId = thread;
    const briefing = deps.brief(record, bot, work);
    work.about = briefing.about;
    // a continuation prompt only for the run that follows a continuation, not for a later status re-ask
    if (work.continued && !work.nudged) briefing.prompt += `\n\nYour last reply here stopped at the next step or asked whether to continue. Do not ask: carry on with the step you named, then finish with "Status: done" or "Status: stuck - what you need".`;
    if (work.nudged) briefing.prompt += `\n\nYour last reply here ended without "Status: done" or "Status: stuck - what you need". Do the work now, or say what blocks you, and end with that status line.`;
    work.status = "running";
    const line = { role: "bot" as const, kind: "text" as const, text: `${bot.name} is working on it…`, working: true as const, workingSince: Date.now(),
      workThread: { botId: bot.id, threadId: thread }, from: { botId: bot.id, name: bot.name, color: bot.color ?? "" } };
    if (!work.messageId) {
      store.appendMessage(record.threadId, line, undefined, (message) => {
        work.messageId = message.id; work.since = message.at; saveConversationWork(work);
      });
    } else {
      work.since = Date.now();
      store.patchMessage(record.threadId, work.messageId, line, undefined, () => saveConversationWork(work));
    }
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

  async function drain(conversationId: string, botId: string) {
    const key = lane(conversationId, botId);
    if (active.has(key)) return;
    active.add(key);
    try {
      for (;;) {
        const next = conversationWork(conversationId, "queued").find((work) => work.botId === botId);
        if (!next || !(await start(next))) break;
      }
    } catch (error) {
      console.error("Could not advance conversation work:", error);
    } finally { active.delete(key); }
  }

  function wake() {
    queueMicrotask(() => {
      const lanes = new Map(conversationWork(undefined, "queued").map((work) => [lane(work.conversationId, work.botId), work]));
      for (const work of lanes.values()) void drain(work.conversationId, work.botId);
    });
  }

  async function cancel(conversationId: string, askerKey: string) {
    const jobs = conversationWork(conversationId).filter((work) => work.askerKey === askerKey && (work.status === "queued" || work.status === "running"));
    const stops: Promise<void>[] = [];
    for (const work of jobs) {
      const record = recordFor(conversationId);
      const persist = () => saveConversationWork({ ...work, status: "cancelled" });
      if (record && work.messageId) deps.store().patchMessage(record.threadId, work.messageId, { text: "Stopped by the person who asked.", working: undefined, workingSince: undefined, workThread: undefined, stoppedBy: { botId: work.botId, reason: "interrupted" } }, undefined, persist);
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
    progress(threadId: string, message: { id: string; role: string; kind: string; text?: string }) {
      const pending = waiting.get(threadId)?.work;
      const record = pending && recordFor(pending.conversationId);
      if (!pending?.messageId || !record || message.role !== "bot" || message.kind !== "text" || !message.text?.trim()) return;
      const path = deps.store().activePath(threadId);
      const askAt = path.findIndex((entry) => entry.role === "user" && entry.sendId === pending.id);
      if (askAt < 0 || !path.slice(askAt + 1).some((entry) => entry.id === message.id)) return;
      // Keep tool details in the execution thread. Public assistant progress
      // appears under its actual author while the answer is still being made.
      // A late patch to an earlier answer cannot become this task's progress.
      const current = deps.store().messagesFor(record.threadId).find((entry) => entry.id === pending.messageId);
      if (current?.working && current.text !== message.text) deps.store().patchMessage(record.threadId, pending.messageId, { text: message.text });
    },
    pending: (threadId: string) => waiting.get(threadId)?.work,
    initialize() {
      // Running provider calls are indeterminate after a process loss. Never
      // repeat their external effects automatically; safe, undispatched work stays queued.
      for (const work of conversationWork(undefined, "running")) {
        const path = work.threadId ? deps.store().activePath(work.threadId) : [];
        const at = path.findIndex((message) => message.sendId === work.id);
        const terminal = at >= 0 ? path.slice(at + 1).findLast((message) => message.role === "bot" && message.kind === "text" && message.turnTerminal) : undefined;
        const failed = terminal?.turnSucceeded === false;
        const bot = deps.store().bot(work.botId);
        // A final text marker also exists on failed turns. Only the runtime's
        // durable success annotation proves that this answer finished.
        finish({ ...work, status: failed ? "running" : "interrupted" }, terminal?.turnSucceeded === true,
          failed ? undefined : `${bot?.name ?? "The bot"} stopped when Colonie restarted. Name it again to continue; it keeps the original ask.`);
      }
    },
    /** A bot's work here could not start (its engine refused the mode, a
     * sign-in, a limit): no completion follows, so the group is told why
     * instead of showing "working" for good. */
    errored(threadId: string, message: string) {
      const pending = waiting.get(threadId);
      if (!pending) return;
      waiting.delete(threadId);
      const name = deps.store().bot(pending.work.botId)?.name ?? "The bot";
      const reason = message.trim().replace(/^error:\s*/i, "").slice(0, 300);
      try { finish(pending.work, false, `${name} could not answer: ${reason}`); } finally { pending.done(true); }
      wake();
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
