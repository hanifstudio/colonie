// Conversations of several people and bots: groups (a name, people, bots)
// and DMs between two people. Colonie is where people and bots work
// together (owner, October 22).
//
// A conversation has its own thread; only its people see it, admins
// included, and in a Local workspace its one person is this computer's
// owner. People write in it; a bot answers when someone @mentions it (a bot
// the writer can see joins on its first mention). It works in a thread of
// its own for this conversation, which the person who asked can open (to
// follow its work or answer its questions), handed the conversation's
// recent messages; its answer comes back into the conversation, replacing
// a "working on it" line. Records live in <data>/group-conversations.json
// (0600); messages in the store like any thread's.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { writeFileAtomic } from "../../persistence/atomic.ts";
import { mentionedBots, type Message, type Store } from "../../persistence/store.ts";

export interface GroupConversation {
  id: string;
  threadId: string;
  kind: "group" | "dm";
  /** A group's name; a DM has none (each side sees the other person). */
  name: string;
  /** Person keys; in a Local workspace the one key is LOCAL_PERSON. */
  people: string[];
  bots: string[];
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  /** When each person last read it, by person key. */
  readAt: Record<string, number>;
  /** When each person was last @mentioned in it, by person key. */
  mentionedAt?: Record<string, number>;
  /** Each bot's own working thread for this conversation. */
  botThreads: Record<string, string>;
  /** Routines a bot scheduled while answering here: each run reports here. */
  routines?: string[];
  /** The message each reported run left here, so a run reports once. */
  routineRuns?: Record<string, string>;
}

/** Who is asking: a person of a Shared workspace, or this computer's owner. */
export interface Caller { key: string; name: string; seesBot: (botId: string) => boolean }

export const LOCAL_PERSON = "owner";
const CONTEXT_MESSAGES = 30;
const CONTEXT_CHARS = 12_000;

type Answer = { status: number; body: unknown };
const fail = (status: number, error: string): Answer => ({ status, body: { error } });

export function createGroupConversations(deps: {
  file: string;
  store: () => Store;
  /** People of the workspace who can be named, by address. */
  directory: () => Array<{ email: string; name?: string; avatar?: string }>;
  /** Whether this address may sign in to the workspace. */
  isMember: (email: string) => boolean;
  keyOf: (email: string) => string;
  /** Start (or queue) a bot's turn in one of its threads. */
  runBotTurn: (botId: string, threadId: string, text: string, sender: { name: string }) => Promise<void>;
  /** Membership or a record changed: who sees which thread is recomputed. */
  onChange?: () => void;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  let records: GroupConversation[] = [];
  try {
    const raw = JSON.parse(readFileSync(deps.file, "utf8"));
    if (Array.isArray(raw)) records = raw as GroupConversation[];
  } catch { /* none yet */ }
  const save = () => {
    writeFileAtomic(deps.file, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
    deps.onChange?.();
  };
  /** A bot's working thread → the conversation lines waiting for its
   * answers, oldest first: a mention while it works queues a turn, and each
   * turn that ends answers the oldest line. */
  type Pending = { conversationId: string; messageId: string; botId: string; since: number; asker: string };
  const waiting = new Map<string, Pending[]>();
  /** Waiting lines live in memory: after a restart none can be answered, so
   * a line left "working on it" (or waiting for a person) says it stopped. */
  let settledLeftovers = false;
  const settleLeftovers = () => {
    if (settledLeftovers) return;
    settledLeftovers = true;
    const store = deps.store();
    for (const record of records) {
      // work made before it was marked as the conversation's
      for (const [botId, threadId] of Object.entries(record.botThreads)) {
        if (store.taskByThread(botId, threadId) && !store.taskByThread(botId, threadId)?.forConversation) store.patchTask(botId, threadId, { forConversation: record.id });
      }
      for (const message of store.messagesFor(record.threadId)) {
        if (message.role !== "bot" || !message.from) continue;
        if (message.workThread || message.text === `${message.from.name} is working on it…`) {
          store.patchMessage(record.threadId, message.id, { text: `${message.from.name} stopped when Colonie restarted. Mention it again to ask.`, workThread: undefined, working: undefined });
        }
      }
    }
  };

  const byId = (id: string) => records.find((record) => record.id === id);
  const mine = (caller: Caller, id: string) => {
    const record = byId(id);
    return record && record.people.includes(caller.key) ? record : undefined;
  };
  const known = () => new Map(deps.directory().map((entry) => [deps.keyOf(entry.email), entry]));

  function wire(record: GroupConversation, caller: Caller) {
    const names = known();
    const people = record.people.map((key) => {
      const entry = names.get(key);
      return { key, email: entry?.email ?? "", name: key === caller.key ? caller.name : entry?.name || entry?.email || "Someone", you: key === caller.key, ...(entry?.avatar ? { avatar: entry.avatar } : {}) };
    });
    const others = people.filter((person) => !person.you);
    const messages = deps.store().messagesFor(record.threadId);
    const last = messages.at(-1);
    const said = messages.findLast((message) => !message.notice && message.text?.trim());
    const speaker = !said ? "" : said.role === "bot" ? said.from?.name ?? "Bot" : said.sender?.id === caller.key ? "You" : said.sender?.name ?? "Someone";
    return {
      id: record.id, threadId: record.threadId, kind: record.kind,
      title: record.kind === "dm" ? others[0]?.name ?? "Direct message" : record.name,
      name: record.name, people, bots: record.bots,
      lastMessageAt: last?.at ?? record.createdAt,
      // the last thing said, for the sidebar's second line
      preview: said ? `${speaker}: ${said.text!.trim().replace(/\s+/g, " ").slice(0, 120)}` : "",
      unread: Boolean(last && last.at > (record.readAt[caller.key] ?? 0) && last.sender?.id !== caller.key),
      mentioned: (record.mentionedAt?.[caller.key] ?? 0) > (record.readAt[caller.key] ?? 0),
    };
  }

  const nameOf = (key: string) => { const entry = known().get(key); return entry?.name || entry?.email || "Someone"; };
  /** A line about the conversation itself; it also tells every member's app. */
  const notice = (record: GroupConversation, text: string) =>
    deps.store().appendMessage(record.threadId, { role: "bot", kind: "text", text, notice: true });

  /** People named by address: on this workspace's list, never the caller twice. */
  function peopleFor(caller: Caller, emails: unknown): string[] | Answer {
    const keys = [caller.key];
    for (const raw of Array.isArray(emails) ? emails : []) {
      const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
      if (!email) continue;
      if (!email.includes("@") || !deps.isMember(email)) return fail(400, `${email} is not in this workspace. Invite them to the workspace first.`);
      const key = deps.keyOf(email);
      if (!keys.includes(key)) keys.push(key);
    }
    return keys;
  }
  function botsFor(caller: Caller, ids: unknown): string[] | Answer {
    const bots: string[] = [];
    for (const id of Array.isArray(ids) ? ids : []) {
      if (typeof id !== "string" || !deps.store().bot(id) || !caller.seesBot(id)) return fail(400, "One of those bots is not in this workspace.");
      if (!bots.includes(id)) bots.push(id);
    }
    return bots;
  }

  /** What a bot is handed when mentioned: who is here, the recent messages, the ask. */
  function brief(record: GroupConversation, botName: string, asker: string, text: string): string {
    const lines: string[] = [];
    let size = 0;
    for (const message of deps.store().messagesFor(record.threadId).slice(-CONTEXT_MESSAGES - 1, -1).reverse()) {
      if (message.kind !== "text" || message.notice || !message.text?.trim()) continue;
      const who = message.role === "bot" ? message.from?.name ?? "A bot" : message.sender?.name ?? "Someone";
      const line = `${who}: ${message.text.trim()}`;
      if (size + line.length > CONTEXT_CHARS) break;
      size += line.length;
      lines.unshift(line);
    }
    const where = record.kind === "dm" ? "a direct message between people" : `the group "${record.name}"`;
    return [
      `You were mentioned in ${where}. Its people and bots read your answer there; answer ${asker}, briefly and to the point.`,
      ...(lines.length ? ["", "Recent messages:", ...lines] : []),
      "", `${asker} wrote to ${botName}:`, text,
    ].join("\n");
  }

  async function mention(record: GroupConversation, caller: Caller, text: string) {
    const store = deps.store();
    const candidates = store.bots.filter((bot) => record.bots.includes(bot.id) || caller.seesBot(bot.id));
    for (const bot of mentionedBots(text, candidates)) {
      if (!record.bots.includes(bot.id)) { record.bots.push(bot.id); save(); }
      let threadId = record.botThreads[bot.id];
      if (!threadId || !store.taskByThread(bot.id, threadId)) {
        const task = store.createTask(bot.id, record.kind === "dm" ? "Work for a direct message" : `Work for ${record.name}`, false, undefined, undefined, undefined, undefined, [caller.key]);
        if (!task) continue;
        threadId = task.threadId;
        store.patchTask(bot.id, threadId, { forConversation: record.id });
        record.botThreads[bot.id] = threadId;
        save();
      } else if (!(store.threadParticipants(threadId) ?? []).includes(caller.key)) {
        // whoever asks can open the bot's work for this conversation
        store.setThreadParticipants(threadId, [...(store.threadParticipants(threadId) ?? []), caller.key]);
      }
      const line = store.appendMessage(record.threadId, {
        role: "bot", kind: "text", text: `${bot.name} is working on it…`, working: true,
        from: { botId: bot.id, name: bot.name, color: bot.color ?? "" },
      });
      const pending: Pending = { conversationId: record.id, messageId: line.id, botId: bot.id, since: line.at, asker: caller.name };
      waiting.set(threadId, [...(waiting.get(threadId) ?? []), pending]);
      try {
        await deps.runBotTurn(bot.id, threadId, brief(record, bot.name, caller.name, text), { name: caller.name });
      } catch (error) {
        waiting.set(threadId, (waiting.get(threadId) ?? []).filter((entry) => entry !== pending));
        store.patchMessage(record.threadId, line.id, { text: `${bot.name} could not start: ${(error as Error).message}` });
      }
    }
  }

  return {
    byThread(threadId: string): GroupConversation | undefined {
      return records.find((record) => record.threadId === threadId);
    },

    list(caller: Caller): Answer {
      settleLeftovers();
      const mineAll = records.filter((record) => record.people.includes(caller.key)).map((record) => wire(record, caller));
      return { status: 200, body: { conversations: mineAll.sort((a, b) => b.lastMessageAt - a.lastMessageAt) } };
    },

    create(caller: Caller, input: { kind?: unknown; name?: unknown; emails?: unknown; bots?: unknown }): Answer {
      const kind = input.kind === "dm" ? "dm" : "group";
      const people = peopleFor(caller, input.emails);
      if (!Array.isArray(people)) return people;
      const bots = botsFor(caller, input.bots);
      if (!Array.isArray(bots)) return bots;
      if (kind === "dm") {
        if (people.length !== 2) return fail(400, "A direct message is between you and one other person.");
        const existing = records.find((record) => record.kind === "dm" && record.people.length === 2 && people.every((key) => record.people.includes(key)));
        if (existing) return { status: 200, body: wire(existing, caller) };
      }
      const name = typeof input.name === "string" ? input.name.trim().replace(/\s+/g, " ").slice(0, 60) : "";
      if (kind === "group" && !name) return fail(400, "Give the group a name.");
      const at = now();
      const record: GroupConversation = {
        id: randomUUID(), threadId: randomUUID(), kind, name: kind === "group" ? name : "",
        people, bots: kind === "group" ? bots : [], createdBy: caller.key, createdAt: at, updatedAt: at, readAt: { [caller.key]: at }, botThreads: {},
      };
      records = [...records, record];
      save();
      const others = [...people.filter((key) => key !== caller.key).map(nameOf), ...bots.map((id) => deps.store().bot(id)?.name ?? "a bot")];
      notice(record, kind === "dm" ? `${caller.name} started this conversation.` : `${caller.name} made the group${others.length ? ` with ${others.join(", ")}` : ""}.`);
      return { status: 201, body: wire(record, caller) };
    },

    messages(caller: Caller, id: string): Answer {
      const record = mine(caller, id);
      if (!record) return fail(404, "no such conversation");
      return { status: 200, body: { messages: deps.store().messagesFor(record.threadId).slice(-200) } };
    },

    async post(caller: Caller, id: string, rawText: unknown): Promise<Answer> {
      const record = mine(caller, id);
      if (!record) return fail(404, "no such conversation");
      const text = typeof rawText === "string" ? rawText.trim() : "";
      if (!text) return fail(400, "text required");
      const message = deps.store().appendMessage(record.threadId, { role: "user", kind: "text", text, sender: { name: caller.name, id: caller.key } });
      record.updatedAt = message.at;
      record.readAt[caller.key] = message.at;
      // @Name of a person here marks the conversation for them.
      const people = record.people.filter((key) => key !== caller.key).map((key) => ({ key, name: nameOf(key) }));
      for (const person of mentionedBots(text, people)) (record.mentionedAt ??= {})[person.key] = message.at;
      save();
      void mention(record, caller, text);
      return { status: 201, body: { message } };
    },

    read(caller: Caller, id: string): Answer {
      const record = mine(caller, id);
      if (!record) return fail(404, "no such conversation");
      record.readAt[caller.key] = now();
      save();
      return { status: 200, body: { ok: true } };
    },

    add(caller: Caller, id: string, input: { emails?: unknown; bots?: unknown }): Answer {
      const record = mine(caller, id);
      if (!record) return fail(404, "no such conversation");
      if (record.kind === "dm" && Array.isArray(input.emails) && input.emails.length) return fail(400, "Make a group to talk with more people.");
      const people = peopleFor(caller, input.emails);
      if (!Array.isArray(people)) return people;
      const bots = botsFor(caller, input.bots);
      if (!Array.isArray(bots)) return bots;
      const newPeople = people.filter((key) => !record.people.includes(key));
      const newBots = bots.filter((id) => !record.bots.includes(id));
      record.people = [...new Set([...record.people, ...people])];
      record.bots = [...new Set([...record.bots, ...bots])];
      save();
      const added = [...newPeople.map(nameOf), ...newBots.map((botId) => deps.store().bot(botId)?.name ?? "a bot")];
      if (added.length) notice(record, `${caller.name} added ${added.join(", ")}.`);
      return { status: 200, body: wire(record, caller) };
    },

    leave(caller: Caller, id: string): Answer {
      const record = mine(caller, id);
      if (!record) return fail(404, "no such conversation");
      record.people = record.people.filter((key) => key !== caller.key);
      save();
      notice(record, `${caller.name} left.`);
      return { status: 200, body: { ok: true } };
    },

    /** A bot's turn ended: its answer replaces the waiting line. */
    /** A routine a bot scheduled from its work for a conversation reports
     * to that conversation. False when the thread is no conversation's. */
    attachRoutine(botId: string, workThreadId: string, routineId: string): boolean {
      const record = records.find((entry) => entry.botThreads[botId] === workThreadId);
      if (!record) return false;
      record.routines = [...new Set([...(record.routines ?? []), routineId])];
      save();
      return true;
    },

    /** A finished run of such a routine: its report in the conversation, from
     * its bot, once per run. Answers the conversation's thread when the
     * routine reports to one. */
    routineRunFinished(run: { id: string; routineId: string; botId: string; routineName: string; status: string; output?: string; error?: string }): string | undefined {
      const record = records.find((entry) => entry.routines?.includes(run.routineId));
      if (!record) return undefined;
      if (!["completed", "failed", "missed"].includes(run.status) || record.routineRuns?.[run.id]) return record.threadId;
      const bot = deps.store().bot(run.botId);
      if (!bot) return record.threadId;
      const said = run.status === "completed"
        ? run.output?.trim() || `${run.routineName}: done.`
        : `${run.routineName} ${run.status === "missed" ? "was missed" : "failed"}${run.error ? `: ${run.error}` : "."}`;
      const message = deps.store().appendMessage(record.threadId, {
        role: "bot", kind: "text", text: said.slice(0, 20_000),
        from: { botId: bot.id, name: bot.name, color: bot.color ?? "" },
      });
      record.routineRuns = { ...record.routineRuns, [run.id]: message.id };
      save();
      return record.threadId;
    },

    /** The bot stopped for a person (an approval, a question, a secret)
     * in its own work thread, where the card is: the waiting line says so
     * and offers the way there, or the group only ever sees "working on it". */
    needsPerson(threadId: string, what: string) {
      const pending = waiting.get(threadId)?.[0];
      if (!pending) return;
      const record = byId(pending.conversationId);
      const bot = deps.store().bot(pending.botId);
      if (!record || !bot) return;
      deps.store().patchMessage(record.threadId, pending.messageId, {
        text: `${bot.name} needs ${pending.asker} for ${what} before it can go on.`,
        workThread: { botId: bot.id, threadId }, working: undefined,
      });
    },

    /** A bot's turn ended: its answer replaces the oldest waiting line. */
    turnCompleted(threadId: string, ok: boolean) {
      const queue = waiting.get(threadId) ?? [];
      const pending = queue.shift();
      if (!pending) return;
      if (queue.length) waiting.set(threadId, queue); else waiting.delete(threadId);
      const record = byId(pending.conversationId);
      if (!record) return;
      const answer = [...deps.store().messagesFor(threadId)].reverse().find((message: Message) => message.role === "bot" && message.kind === "text" && message.at >= pending.since && message.text?.trim());
      const bot = deps.store().bot(pending.botId);
      deps.store().patchMessage(record.threadId, pending.messageId, {
        text: ok && answer?.text ? answer.text : `${bot?.name ?? "The bot"} could not answer this time. Ask again in a moment.`,
        workThread: undefined, working: undefined,
      });
    },
  };
}

export type GroupConversations = ReturnType<typeof createGroupConversations>;
