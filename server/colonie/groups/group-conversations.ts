// Conversations of several people and bots: groups (a name, people, bots)
// and DMs between two people. Colonie is where people and bots work
// together (owner, October 22).
//
// A conversation has its own thread; only its people see it, admins
// included, and in a Local workspace its one person is this computer's
// owner. People write in it; a bot answers when someone @mentions it (a bot
// the writer can see joins on its first mention). Each bot has a private
// execution session per conversation. Answers and approval cards appear in
// the conversation. Transcript, metadata, and execution intents share SQLite.
import { randomUUID } from "node:crypto";

import { commandReceipt } from "../../commands.ts";
import { conversationWork, deleteConversationRecord, loadConversationRecords, saveConversationRecords, type ConversationWork } from "../../persistence/conversation-db.ts";
import { createConversationWork, type ConversationAsk } from "./conversation-work.ts";
import { mentionedBots, type Message, type Store } from "../../persistence/store.ts";
import { mentionsHere } from "../../../shared/mention-boundary.ts";
import { conversationFilePath, conversationFolder, listConversationFiles, removeConversationFolder } from "../workspace/workspace.ts";

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
  /** When each bot last caught up, by bot id: a mention hands it only what
   * was said since (its engine session keeps the rest). */
  seenAt?: Record<string, number>;
  /** Stable message cursor: timestamps may collide or move backwards. */
  seenThrough?: Record<string, string>;
  /** Instructions every bot reads here ("focus on the IGRS project"). */
  instructions?: string;
  /** What each bot was last told about the group (people, bots,
   * instructions), by bot id: told again only when it changes. */
  toldAbout?: Record<string, string>;
  /** Who answers a message that names no one; absent is the lead. */
  responder?: GroupResponder;
}

/** Who answers a group message that names no one (owner, October 30): its
 * lead bot (one chosen, or by default the Chief of Staff, else the first bot
 * added), every bot, or only bots that are named. */
export type GroupResponder = { kind: "lead"; botId?: string } | { kind: "everyone" } | { kind: "mentions" };

function groupResponder(value: unknown): GroupResponder | null {
  if (!value || typeof value !== "object") return null;
  const { kind, botId } = value as { kind?: unknown; botId?: unknown };
  if (kind === "everyone" || kind === "mentions") return { kind };
  if (kind === "lead") return typeof botId === "string" && botId ? { kind, botId } : { kind };
  return null;
}

/** Who is asking: a person of a Shared workspace, or this computer's owner. */
export interface Caller { key: string; name: string; seesBot: (botId: string) => boolean; canDeleteGroup?: boolean }

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
  /** This computer's owner, on a Local workspace, where no directory names them. */
  localName?: () => string;
  keyOf: (email: string) => string;
  /** Routines reporting here must be removed before their destination. */
  hasRoutine?: (id: string) => boolean;
  hasRoutinesFor?: (conversationId: string) => boolean;
  routineForThread?: (threadId: string) => { id: string; botId: string; status: string; conversation?: { id?: string; requestedBy?: { id: string; name: string } } } | null;
  /** Start (or queue) a bot's turn in one of its threads. */
  /** The sender names who asked (and, by id, whose secrets the bot may use). */
  runBotTurn: (work: ConversationWork, threadId: string, prompt: string, recoveryPrompt: string) => Promise<void>;
  interruptBotTurn?: (botId: string, threadId: string) => Promise<void>;
  /** Membership or a record changed: who sees which thread is recomputed. */
  onChange?: () => void;
  now?: () => number;
  /** Where project folders live; tests point it at a temporary folder. */
  foldersRoot?: string;
}) {
  const now = deps.now ?? Date.now;
  let records = loadConversationRecords<GroupConversation>(deps.file);
  const changed = () => deps.onChange?.();
  const save = () => { saveConversationRecords(records); changed(); };
  /** A card from a bot's work (an approval, a question, a secret) → its copy
   * in the conversation, so it is answered there. */
  const relayed = new Map<string, string>();
  /** Repair legacy work and expire approval cards whose provider has gone. */
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
        if (message.relay) relayed.set(`${message.relay.threadId}:${message.relay.messageId}`, message.id);
        if (message.role !== "bot" || !message.from) continue;
        // a relayed card the restart left unanswerable
        if (message.relay && message.card?.requestId && !message.card.answered && !message.card.dismissed) {
          // Routine proposals belong to Colonie, not a provider process.
          // Their saved operation remains answerable after a restart.
          const owner = message.card.routineRequest && store.botByThread(message.relay.threadId);
          const original = owner && store.taskByThread(owner.id, message.relay.threadId)
            ? store.messagesFor(message.relay.threadId).find((entry) => entry.id === message.relay!.messageId) : undefined;
          if (original?.card?.routineRequest && original.card.requestId === message.card.requestId) {
            store.patchMessage(record.threadId, message.id, { card: original.card });
            continue;
          }
          store.patchMessage(record.threadId, message.id, { card: { ...message.card, expired: true } });
          continue;
        }
        if (message.working || message.text === `${message.from.name} is working on it…` || /^\S.* is waiting for .+\)\.$/.test(message.text ?? "")) {
          store.patchMessage(record.threadId, message.id, { text: `${message.from.name} stopped when Colonie restarted. Mention it again to ask.`, workThread: undefined, working: undefined, workingSince: undefined });
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
  /** The group's lead: the bot it chose, else its Chief of Staff, else its first bot. */
  const leadOf = (record: GroupConversation) => {
    const store = deps.store();
    const here = record.bots.map((id) => store.bot(id)).filter((bot): bot is NonNullable<typeof bot> => Boolean(bot) && !bot!.hidden);
    const chosen = record.responder?.kind === "lead" ? record.responder.botId : undefined;
    return here.find((bot) => bot.id === chosen) ?? here.find((bot) => bot.chiefOfStaff) ?? here[0];
  };

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
      name: record.name, people, bots: record.bots, instructions: record.instructions ?? "",
      responder: record.responder ?? { kind: "lead" }, leadBotId: record.kind === "group" ? leadOf(record)?.id ?? null : null,
      lastMessageAt: last?.at ?? record.createdAt,
      // the last thing said, for the sidebar's second line
      preview: said ? `${speaker}: ${said.text!.trim().replace(/\s+/g, " ").slice(0, 120)}` : "",
      unread: Boolean(last && last.at > (record.readAt[caller.key] ?? 0) && last.sender?.id !== caller.key),
      mentioned: (record.mentionedAt?.[caller.key] ?? 0) > (record.readAt[caller.key] ?? 0),
      canStop: conversationWork(record.id).some((work) => work.askerKey === caller.key && (work.status === "queued" || work.status === "running")),
    };
  }

  const nameOf = (key: string) => {
    if (key === LOCAL_PERSON) return deps.localName?.() || "You";
    const entry = known().get(key);
    return entry?.name || entry?.email || "Someone";
  };
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

  /** Who and what a group is, for a bot: told the first time and again
   * only when it changes (people, bots and their roles, instructions). */
  function about(record: GroupConversation, bot: { id: string }): string {
    const store = deps.store();
    const people = record.people.map(nameOf);
    const bots = record.bots.map((id) => store.bot(id)).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .map((entry) => entry.id === bot.id ? `${entry.name} (you)` : `${entry.name}${entry.title?.trim() ? ` (${entry.title.trim()})` : ""}`);
    const lines = [
      record.kind === "dm" ? "This is a direct message between people." : `This is the group "${record.name}".`,
      `People: ${people.join(", ")}.`,
      `Bots: ${bots.join(", ")}.`,
      ...(record.kind === "group" && (record.responder?.kind ?? "lead") === "lead" && leadOf(record)?.id === bot.id
        ? ["You lead this group: messages that name no one come to you. Answer them, or hand a part to the bot here best suited to it."] : []),
      ...(bots.length > 1 ? ["To hand part of the work to another bot here, @mention it by name in your answer with a concrete assignment; it answers after you. Keep group work here, not in private ask_bot conversations.",
        `When you finish a delegated part, report its result or blocker to the lead (${leadOf(record)?.name ?? "the first bot"}) using an @mention in your answer, or hand the next step to the appropriate member. Never claim another member has started or finished without a recorded result. Creating a group or accepting work does not prove it is running or safe to leave unattended.`] : []),
      `Your working folder is this ${record.kind === "dm" ? "conversation" : "group"}'s project folder. Everyone here sees its files${bots.length > 1 ? ", and the other bots here work in it too: build on their files rather than redoing them" : ""}. Put files for this ${record.kind === "dm" ? "conversation" : "group"} there.`,
      ...(record.instructions?.trim() ? ["", "Instructions for this group:", record.instructions.trim()] : []),
    ];
    const text = lines.join("\n");
    return text;
  }

  /** What a bot is handed when mentioned: about the group when that is
   * new to it, what was said since it last caught up (its engine session
   * holds everything before), then the ask. */
  function brief(record: GroupConversation, bot: NonNullable<ReturnType<Store["bot"]>>, ask: ConversationWork, fresh = false): { prompt: string; about: string } {
    const messages = deps.store().messagesFor(record.threadId);
    const through = record.seenThrough?.[bot.id];
    const seen = through ? messages.findIndex((message) => message.id === through) : -1;
    const task = ask.threadId ? deps.store().taskByThread(bot.id, ask.threadId) : undefined;
    const instanceId = (task?.modelSelection ?? bot.modelSelection).instanceId;
    const resume = !fresh && seen >= 0 && task?.lastInstanceId === instanceId && typeof task.resumeCursors[instanceId] === "string";
    const said = messages.slice(resume ? seen + 1 : 0).filter((message) =>
      message.id !== ask.sourceMessageId &&
      message.kind === "text" && !message.notice && !message.working && message.text?.trim() &&
      (!resume || message.from?.botId !== bot.id));
    const lines: string[] = [];
    let size = 0;
    for (const message of said.slice(-CONTEXT_MESSAGES).reverse()) {
      const who = message.role === "bot" ? message.from?.name ?? "A bot" : message.sender?.name ?? "Someone";
      const line = `${who}: ${message.text!.trim()}`;
      if (size + line.length > CONTEXT_CHARS) break;
      size += line.length; lines.unshift(line);
    }
    const information = about(record, bot);
    const told = !resume || record.toldAbout?.[bot.id] !== information ? information : null;
    const asked = ask.by ? `${ask.by} (a bot) asked you, for ${ask.asker}`
      : ask.unnamed ? `${ask.asker} wrote to the group without naming anyone, so it comes to you` : `${ask.asker} mentioned you`;
    return { about: information, prompt: [
      `${asked}. Everyone here reads your answer; answer briefly and to the point.`,
      ...(told ? ["", told] : []),
      ...(lines.length ? ["", resume ? "Said since you last spoke:" : "Recent messages:",
        ...(said.length > lines.length ? [`(${said.length - lines.length} earlier messages not shown)`] : []), ...lines] : []),
      "", `${ask.by ?? ask.asker} wrote to you:`, ask.text,
    ].join("\n") };
  }

  const work = createConversationWork({ store: deps.store, records: () => records, changed, lead: leadOf,
    brief: (record, bot, ask) => ({ ...brief(record, bot, ask), recoveryPrompt: brief(record, bot, ask, true).prompt }),
    run: deps.runBotTurn, interrupt: deps.interruptBotTurn });

  function pendingPerson(threadId: string) {
    const pending = work.pending(threadId);
    if (pending) return pending;
    const run = deps.routineForThread?.(threadId);
    const context = run?.conversation;
    const record = context?.id ? byId(context.id) : undefined;
    if (!run || !["running", "waiting"].includes(run.status) || !record || !context?.requestedBy || !record.people.includes(context.requestedBy.id)) return undefined;
    const message = deps.store().messagesFor(record.threadId).find((entry) => entry.routineRun?.runId === run.id);
    return { conversationId: record.id, botId: run.botId, askerKey: context.requestedBy.id, asker: context.requestedBy.name, messageId: message?.id, routine: true as const };
  }

  return {
    initialize() { settleLeftovers(); work.initialize(); },
    wake: work.wake,
    byThread(threadId: string): GroupConversation | undefined {
      return records.find((record) => record.threadId === threadId);
    },
    byId,
    forWorkThread(threadId: string) {
      return records.find((record) => Object.values(record.botThreads).includes(threadId));
    },
    requester: pendingPerson,

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

    async post(caller: Caller, id: string, rawText: unknown, rawSendId?: unknown): Promise<Answer> {
      const record = mine(caller, id);
      if (!record) return fail(404, "no such conversation");
      const text = typeof rawText === "string" ? rawText : "";
      if (!text.trim()) return fail(400, "text required");
      if (rawSendId !== undefined && (typeof rawSendId !== "string" || !rawSendId || rawSendId.length > 160)) return fail(400, "sendId must be a nonempty string of at most 160 characters");
      const command = typeof rawSendId === "string" ? { kind: "conversation.message", key: JSON.stringify([id, caller.key, rawSendId]) } : undefined;
      const receipt = command && commandReceipt<Message>(command.kind, command.key);
      if (receipt) {
        if (receipt.result.text !== text) return fail(409, "sendId already belongs to another message");
        work.wake();
        return { status: 201, body: { message: receipt.result } };
      }
      const store = deps.store();
      const here = record.kind === "group" && mentionsHere(text);
      const named = mentionedBots(text, store.bots.filter((bot) => record.bots.includes(bot.id) || caller.seesBot(bot.id)));
      // @here asks every bot in the group, in the order they joined, after any named first
      const groupBots = () => record.bots.map((botId) => store.bot(botId)).filter((bot): bot is NonNullable<typeof bot> => !!bot && !bot.hidden && caller.seesBot(bot.id) && !named.includes(bot));
      const people = record.people.filter((key) => key !== caller.key).map((key) => ({ key, name: nameOf(key) }));
      const namedPeople = mentionedBots(text, people);
      // a message that names no one goes to the group's lead, or every bot;
      // one that names only a person is for that person
      const responder = record.responder?.kind ?? "lead";
      const unnamed = record.kind === "group" && !here && !named.length && !namedPeople.length && responder !== "mentions";
      const lead = unnamed && responder === "lead" ? leadOf(record) : undefined;
      const bots = here ? [...named, ...groupBots()]
        : unnamed ? (responder === "everyone" ? groupBots() : lead && caller.seesBot(lead.id) ? [lead] : [])
        : named;
      let next = record;
      const message = store.appendMessage(record.threadId, { role: "user", kind: "text", text, sendId: rawSendId as string | undefined, sender: { name: caller.name, id: caller.key } }, command, (message) => {
        next = { ...record, updatedAt: message.at, readAt: { ...record.readAt, [caller.key]: message.at },
          bots: [...new Set([...record.bots, ...bots.map((bot) => bot.id)])], mentionedAt: { ...record.mentionedAt } };
        for (const person of here ? people : namedPeople) next.mentionedAt![person.key] = message.at;
        saveConversationRecords(records.map((entry) => entry.id === next.id ? next : entry));
        const ask: ConversationAsk = { asker: caller.name, askerKey: caller.key, depth: 0, ...(unnamed ? { unnamed: true } : {}) };
        work.enqueue(next, message.id, bots, ask, text);
      });
      Object.assign(record, next);
      changed(); work.wake();
      return { status: 201, body: { message } };
    },

    /** An explicit bot assignment, never a fabricated message from a person.
     * Both the requesting person and the speaking bot must belong here. */
    postAsBot(caller: Caller, botId: string, id: string, text: string, sendId: string): Answer {
      const record = mine(caller, id);
      const store = deps.store();
      const bot = store.bot(botId);
      if (!record || record.kind !== "group" || !record.bots.includes(botId) || !bot || !caller.seesBot(botId)) return fail(404, "No group available for this bot and person.");
      if (!text.trim() || text.length > 20_000) return fail(400, "A message of 1–20000 characters is required.");
      const command = { kind: "conversation.bot-message", key: JSON.stringify([id, caller.key, botId, sendId]) };
      const receipt = commandReceipt<Message>(command.kind, command.key);
      if (receipt) {
        if (receipt.result.text !== text) return fail(409, "requestId already belongs to another message");
        work.wake();
        return { status: 200, body: { state: "accepted", groupId: id, messageId: receipt.result.id } };
      }
      const candidates = record.bots.filter((id) => id !== botId && caller.seesBot(id)).map((id) => store.bot(id)).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry) && !entry!.hidden);
      const named = mentionedBots(text, candidates);
      const lead = leadOf(record);
      const targets = named.length ? named : lead && lead.id !== botId && caller.seesBot(lead.id) ? [lead] : [];
      if (!targets.length) return fail(400, "Name a bot in this group to assign the work to.");
      let next = record;
      const message = store.appendMessage(record.threadId, { role: "bot", kind: "text", text,
        from: { botId: bot.id, name: bot.name, color: bot.color ?? "" } }, command, (message) => {
        next = { ...record, updatedAt: message.at };
        saveConversationRecords(records.map((entry) => entry.id === next.id ? next : entry));
        work.enqueue(next, message.id, targets, { asker: caller.name, askerKey: caller.key, by: bot.name, depth: 0, visited: [bot.id] }, text);
      });
      Object.assign(record, next);
      changed(); work.wake();
      return { status: 201, body: { state: "accepted", groupId: id, messageId: message.id, bots: targets.map((entry) => entry.name), note: "The assignment is queued in the group. Progress, questions and results appear there. Accepted does not mean completed." } };
    },

    /** A group's instructions, which every bot in it reads. */
    update(caller: Caller, id: string, input: { instructions?: unknown; responder?: unknown }): Answer {
      const record = mine(caller, id);
      if (!record) return fail(404, "no such conversation");
      if (record.kind !== "group") return fail(400, "Only a group has instructions.");
      if (input.responder !== undefined) {
        const responder = groupResponder(input.responder);
        if (!responder) return fail(400, "responder must be lead (with an optional botId), everyone, or mentions");
        if (responder.kind === "lead" && responder.botId && !record.bots.includes(responder.botId)) return fail(400, "The lead must be a bot in this group.");
        record.responder = responder;
        save();
        const lead = leadOf(record);
        notice(record, responder.kind === "everyone" ? `${caller.name} set every bot here to answer messages that name no one.`
          : responder.kind === "mentions" ? `${caller.name} set bots here to answer only when named.`
          : `${caller.name} made ${lead?.name ?? "the first bot"} lead this group: it answers messages that name no one.`);
        if (input.instructions === undefined) return { status: 200, body: wire(record, caller) };
      }
      if (typeof input.instructions !== "string") return fail(400, "instructions required");
      const instructions = input.instructions.trim().slice(0, 4000);
      if (instructions === (record.instructions ?? "")) return { status: 200, body: wire(record, caller) };
      record.instructions = instructions;
      save();
      notice(record, instructions ? `${caller.name} updated the group's instructions.` : `${caller.name} cleared the group's instructions.`);
      return { status: 200, body: wire(record, caller) };
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

    /** Take a bot out of the group: it answers here no more; what it said stays. */
    removeBot(caller: Caller, id: string, botId: string): Answer {
      const record = mine(caller, id);
      if (!record) return fail(404, "no such conversation");
      if (!record.bots.includes(botId)) return fail(404, "That bot is not in this conversation.");
      record.bots = record.bots.filter((entry) => entry !== botId);
      if (record.responder?.kind === "lead" && record.responder.botId === botId) record.responder = { kind: "lead" };
      save();
      notice(record, `${caller.name} removed ${deps.store().bot(botId)?.name ?? "a bot"}.`);
      return { status: 200, body: wire(record, caller) };
    },

    async stop(caller: Caller, id: string): Promise<Answer> {
      if (!mine(caller, id)) return fail(404, "no such conversation");
      return { status: 200, body: { stopped: await work.cancel(id, caller.key) } };
    },

    delete(caller: Caller, id: string): Answer {
      const record = mine(caller, id);
      if (!record) return fail(404, "no such conversation");
      if (record.kind !== "group") return fail(400, "Only groups can be deleted.");
      if (!caller.canDeleteGroup) return fail(403, "Only a workspace admin can delete a group.");
      if (conversationWork(id).some((entry) => entry.status === "queued" || entry.status === "running")) return fail(409, "Wait for the group's work to finish before deleting it.");
      if (deps.hasRoutinesFor?.(record.id) || record.routines?.some((routineId) => deps.hasRoutine?.(routineId) ?? true)) return fail(409, "Delete this group's routines before deleting the group.");
      const store = deps.store();
      for (const [botId, threadId] of Object.entries(record.botThreads)) store.deleteTask(botId, threadId);
      store.deleteConversationThread(record.threadId);
      deleteConversationRecord(id);
      records = records.filter((entry) => entry.id !== id);
      removeConversationFolder(id, deps.foldersRoot);
      changed();
      return { status: 200, body: { ok: true } };
    },

    /** Whether this person is in the conversation a bot's work thread serves:
     * they may settle a card relayed from it. */
    worksFor(caller: Caller, workThreadId: string): boolean {
      return records.some((record) => record.people.includes(caller.key) && Object.values(record.botThreads).includes(workThreadId));
    },

    /** The files in the conversation's project folder, for its people. */
    files(caller: Caller, id: string): Answer {
      const record = mine(caller, id);
      if (!record) return fail(404, "no such conversation");
      return { status: 200, body: listConversationFiles(conversationFolder(record.id, deps.foldersRoot)) };
    },

    /** One file of the project folder to download, for its people. */
    file(caller: Caller, id: string, path: unknown): Answer | { status: 200; path: string } {
      const record = mine(caller, id);
      if (!record) return fail(404, "no such conversation");
      const found = typeof path === "string" ? conversationFilePath(conversationFolder(record.id, deps.foldersRoot), path) : null;
      return found ? { status: 200, path: found } : fail(404, "no such file");
    },

    async leave(caller: Caller, id: string): Promise<Answer> {
      const record = mine(caller, id);
      if (!record) return fail(404, "no such conversation");
      await work.cancel(id, caller.key);
      record.people = record.people.filter((key) => key !== caller.key);
      // nor can they open what the bots did for it any more
      for (const threadId of Object.values(record.botThreads)) {
        const participants = deps.store().threadParticipants(threadId);
        if (participants?.includes(caller.key)) deps.store().setThreadParticipants(threadId, participants.filter((key) => key !== caller.key));
      }
      save();
      notice(record, `${caller.name} left.`);
      return { status: 200, body: { ok: true } };
    },

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
      let next = record;
      deps.store().appendMessage(record.threadId, {
        role: "bot", kind: "text", text: said.slice(0, 20_000),
        from: { botId: bot.id, name: bot.name, color: bot.color ?? "" },
      }, { kind: "conversation.routine-result", key: JSON.stringify([record.id, run.id]) }, (message) => {
        next = { ...record, routineRuns: { ...record.routineRuns, [run.id]: message.id } };
        saveConversationRecords(records.map((entry) => entry.id === next.id ? next : entry));
      });
      Object.assign(record, next); changed();
      return record.threadId;
    },

    /** The bot stopped for a person (an approval, a question, a secret)
     * in its own work thread, where the card is: the waiting line says so
     * and offers the way there, or the group only ever sees "working on it". */
    needsPerson(threadId: string, what: string) {
      const pending = pendingPerson(threadId);
      if (!pending?.messageId || "routine" in pending) return;
      const record = byId(pending.conversationId);
      const bot = deps.store().bot(pending.botId);
      if (!record || !bot) return;
      // the card itself is relayed below this line (relayWork)
      deps.store().patchMessage(record.threadId, pending.messageId, {
        text: `${bot.name} is waiting for ${pending.asker} (${what}).`, working: undefined, workingSince: undefined,
      });
    },

    /** A message in a bot's work for a conversation: a card for a person
     * (an approval, a question, a secret, a sign-in) is copied into the conversation,
     * answered there by whoever asked, and kept in step as it is answered. */
    relayWork(threadId: string, message: Message) {
      work.progress(threadId, message);
      const isCard = (message.kind === "options" && Boolean(message.card?.requestId)) || Boolean(message.secretAsk) || Boolean(message.signInAsk) || Boolean(message.computerAsk);
      if (!isCard) return;
      const key = `${threadId}:${message.id}`;
      const copy = relayed.get(key);
      const store = deps.store();
      if (copy) {
        const routineConversation = deps.routineForThread?.(threadId)?.conversation?.id;
        const record = records.find((entry) => entry.id === routineConversation || Object.values(entry.botThreads).includes(threadId));
        if (!record) return;
        store.patchMessage(record.threadId, copy, { card: message.card, secretAsk: message.secretAsk, signInAsk: message.signInAsk, computerAsk: message.computerAsk });
        // answered: the bot carries on
        const pending = pendingPerson(threadId);
        const settled = message.secretAsk ? message.secretAsk.saved : message.signInAsk ? Boolean(message.signInAsk.outcome) : message.card?.answered || message.card?.dismissed;
        const bot = pending && store.bot(pending.botId);
        if (settled && pending?.messageId && bot && !("routine" in pending)) store.patchMessage(record.threadId, pending.messageId, { text: `${bot.name} is working on it…`, working: true });
        return;
      }
      const pending = pendingPerson(threadId);
      if (!pending?.messageId) return;
      const record = byId(pending.conversationId);
      const bot = store.bot(pending.botId);
      if (!record || !bot) return;
      const line = store.appendMessage(record.threadId, {
        role: "bot", kind: message.kind, text: message.text ?? "",
        ...(message.card ? { card: message.card } : {}), ...(message.secretAsk ? { secretAsk: message.secretAsk } : {}),
        ...(message.signInAsk ? { signInAsk: message.signInAsk } : {}),
        ...(message.computerAsk ? { computerAsk: message.computerAsk } : {}),
        from: { botId: bot.id, name: bot.name, color: bot.color ?? "" },
        relay: { threadId, messageId: message.id, askedBy: pending.askerKey, askedByName: pending.asker },
      });
      relayed.set(key, line.id);
    },

    /** A bot's turn ended: its answer replaces the oldest waiting line. */
    turnCompleted: work.completed,
    turnErrored: work.errored,
  };
}

export type GroupConversations = ReturnType<typeof createGroupConversations>;
