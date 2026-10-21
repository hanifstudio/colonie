// What a bot's threads can admit: the state gates every dispatch, routine and
// resume drain reads before it starts work.
//
// These answer from the same stores (the bot records, the live dispatch
// claims and the configured slot count) and from the frozen `admit` policy in
// server/admission.ts; this module is only the state half, so the pure policy
// stays pure. Each function's header says what it refuses.
import { admit } from "../../admission.ts";
import type { BotRecord } from "../../persistence/store.ts";
import type { RequestAuth } from "../../request-auth.ts";
import type { OwnThreads } from "./own-threads.ts";

/** Everything this cluster reaches in the server; see the header. */
export interface ThreadAdmissionDeps {
  // ponytail: one permissive shape instead of hand-typed lines for each name;
  // tighten it when this cluster gets tests of its own.
  [name: string]: any;
}

export function createThreadAdmission(deps: ThreadAdmissionDeps) {
  const {
    directTurnBots, directTurnDispatchClaims, maxConcurrentThreads, store
  } = deps;
  /** Each person's own conversations in a Shared workspace; absent means
   * Local, where the bot's current thread is the right one. */
  const ownThreads: OwnThreads | undefined = deps.ownThreads;
  const personOf: ((auth: RequestAuth) => string | null) | undefined = deps.personOf;

function botForThread(botId: string, threadId: string): BotRecord | null {
  return directTurnBots.get(threadId) ?? store().projectBotForTask(botId, threadId) ?? store().bot(botId);
}

function threadBusy(botId: string, threadId: string): boolean {
  return store().taskByThread(botId, threadId)?.busy === true || directTurnDispatchClaims.has(threadId);
}

function botAtThreadCapacity(botId: string): boolean {
  // Setup/dispatch reservations still occupy a slot even if an early
  // completion event has already cleared the stored busy flag.
  return store().tasks(botId).filter((task: { threadId: string }) => threadBusy(botId, task.threadId)).length >= maxConcurrentThreads();
}

function hasDirectDispatch(botId: string): boolean {
  return [...directTurnDispatchClaims.values()].some((claim: { botId: string }) => claim.botId === botId);
}

/** Exactly what startTurn admits for a direct thread: the landing thread
 * itself free, a free capacity slot, and no live group turn. Never the
 * whole-bot busy flag — that is true whenever ANY thread is working,
 * waiting on a person, or has no signal. Delegations and the resume drains
 * share this test so peer and room work waits for a real slot, not total
 * bot idleness. */
function canAdmitDirectTurn(botId: string, threadId: string): boolean {
  return admit("peer", {}, {
    threadBusy: threadBusy(botId, threadId),
    atCapacity: botAtThreadCapacity(botId),
  }).action === "start";
}

/** Routine and webhook dispatch shares startTurn's admission preconditions
 * instead of waiting for whole-bot idleness: a free thread slot and no
 * active group turn. A group turn blocks scheduled starts the same way it
 * blocks every other turn kind; it does not consume a capacity slot. The
 * bot's project folder is not a slot: a fresh run works there beside the
 * bot's other threads (see startTurn's cwd resolution). */
function unattendedDispatchState(botId: string): "ready" | "busy" | "missing" {
  const bot = store().bot(botId);
  const decision = admit("unattended", {}, {
    botPresent: Boolean(bot),
    atCapacity: Boolean(bot) && botAtThreadCapacity(botId),
  });
  if (decision.action === "refuse") return decision.code === "missing" ? "missing" : "busy";
  return "ready";
}

/** The bot as a request acts on it. In a Shared workspace the thread is the
 * person's own: the one the request names, or their current conversation when
 * it names none. A thread they do not take part in, and a person with no
 * conversation yet, answer exactly like a thread that does not exist. A caller
 * that does not name a person (the server's own work) keeps the old lookup. */
function requestedTaskBot(botId: string, rawThreadId: unknown, auth?: RequestAuth): BotRecord {
  const profile = store().bot(botId);
  if (!profile) throw Object.assign(new Error("no such bot"), { status: 404 });
  if (rawThreadId !== undefined && (typeof rawThreadId !== "string" || !/^[\w-]+$/.test(rawThreadId))) {
    throw Object.assign(new Error("threadId must be a task id"), { status: 400 });
  }
  if (ownThreads?.shared() && auth) {
    const person = personOf?.(auth) ?? null;
    const threadId = typeof rawThreadId === "string" ? rawThreadId : ownThreads.currentThread(person, profile);
    const task = threadId ? store().taskByThread(botId, threadId) : undefined;
    if (!person || !task || !(task.participants ?? []).includes(person)) {
      throw Object.assign(new Error("no such task"), { status: 404 });
    }
    return store().projectBotForTask(botId, threadId)!;
  }
  const threadId = typeof rawThreadId === "string" ? rawThreadId : profile.threadId;
  const task = store().projectBotForTask(botId, threadId);
  if (!task) throw Object.assign(new Error("no such task"), { status: 404 });
  return task;
}
/** The conversation a bot-wide change also applies to (a new model, an
 * approval level): the bot's current one in a Local workspace, the person's
 * own in a Shared one, or null when they have none yet. A settings change is
 * about the bot, so a person who has not talked to it may still make it; only
 * the per-conversation part is skipped. */
function selectedTaskBot(botId: string, auth: RequestAuth): BotRecord | null {
  if (ownThreads?.shared()) {
    const profile = store().bot(botId);
    if (!profile || !ownThreads.currentThread(personOf?.(auth) ?? null, profile)) return null;
  }
  return requestedTaskBot(botId, undefined, auth);
}
return { botForThread, threadBusy, botAtThreadCapacity, hasDirectDispatch, canAdmitDirectTurn, unattendedDispatchState, requestedTaskBot, selectedTaskBot };
}
