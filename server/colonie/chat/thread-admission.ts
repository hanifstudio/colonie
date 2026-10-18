// What a bot's threads can admit: the state gates every dispatch, routine and
// resume drain reads before it starts work.
//
// These answer from the same stores (the bot records, the live dispatch
// claims and the configured slot count) and from the frozen `admit` policy in
// server/admission.ts; this module is only the state half, so the pure policy
// stays pure. Each function's header says what it refuses.
import { admit } from "../../admission.ts";
import type { BotRecord } from "../../persistence/store.ts";

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

function requestedTaskBot(botId: string, rawThreadId: unknown): BotRecord {
  const profile = store().bot(botId);
  if (!profile) throw Object.assign(new Error("no such bot"), { status: 404 });
  if (rawThreadId !== undefined && (typeof rawThreadId !== "string" || !/^[\w-]+$/.test(rawThreadId))) {
    throw Object.assign(new Error("threadId must be a task id"), { status: 400 });
  }
  const threadId = typeof rawThreadId === "string" ? rawThreadId : profile.threadId;
  const task = store().projectBotForTask(botId, threadId);
  if (!task) throw Object.assign(new Error("no such task"), { status: 404 });
  return task;
}
return { botForThread, threadBusy, botAtThreadCapacity, hasDirectDispatch, canAdmitDirectTurn, unattendedDispatchState, requestedTaskBot };
}
