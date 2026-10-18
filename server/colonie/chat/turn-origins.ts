// Which turns the harness started rather than the person: two in-memory marks
// the fold and the dispatch paths read.
//
// `unattendedThreads` says a bot is working with nobody at the keyboard — a
// webhook turn, or a turn a webhook-driven bot handed to a teammate. Auto mode
// is a decision someone made for turns they were present for, so these do not
// inherit it: the guard behind auto mode is a pattern list, not a security
// boundary, and it must not stand in for a human at 3am.
//
// Keyed by conversation: typing in one thread never makes a sibling webhook run
// attended. Idle marks expire rather than clearing on turn.completed: bus
// subscribers fire in registration order, and the delegation drain runs AFTER
// the main fold — clearing there would blank the flag before the hop that needs
// to read it. A busy bot never ages out, and a stale mark only ever means "ask
// a human", so this fails closed.
//
// `internalTurnThreads` says a thread's turn in flight was started by another
// BOT — an ask_bot hop, a drained delegation. The person asked ONE bot; the
// fan-out behind that answer is that bot's work, not mail addressed to them, so
// its completion raises no badge and no banner. Anything that genuinely needs a
// human still breaks through from its own path: a card that reached a person, a
// takeover, a peer-approval — none of which run through the completion fold.
//
// Keyed by THREAD because turn.completed carries nothing else, and derived from
// commsDepth, which every peer path already threads through. Every dispatch
// rewrites the flag, so a peer turn that dies before it starts can never
// silence the person's own next turn on that thread.

/** Everything this cluster reaches in the server; see the header. */
export interface TurnOriginsDeps {
  // ponytail: one permissive shape instead of hand-typed lines for each name;
  // tighten it when this cluster gets tests of its own.
  [name: string]: any;
}

export function createTurnOrigins(deps: TurnOriginsDeps) {
  const {
    threadBusy
  } = deps;

const unattendedThreads = new Map<string, { botId: string; at: number }>();
const UNATTENDED_TTL_MS = 30 * 60_000;

function markUnattended(botId: string, threadId: string) {
  unattendedThreads.set(threadId, { botId, at: Date.now() });
}
function clearUnattended(threadId: string) {
  unattendedThreads.delete(threadId);
}
function isUnattended(botId?: string | null, threadId?: string): boolean {
  if (!botId) return false;
  // Legacy peer callers without a thread fail closed if any of the bot's
  // work is unattended. Capability/event callers always pass the exact id.
  if (!threadId) return [...unattendedThreads].some(([id, mark]) => mark.botId === botId && isUnattended(botId, id));
  const mark = unattendedThreads.get(threadId);
  if (!mark || mark.botId !== botId) return false;
  // A long-running turn is still unattended even if its next approval comes
  // more than 30 minutes after the previous one. Only an idle bot may age
  // out; every positive read refreshes the inactivity window.
  if (Date.now() - mark.at > UNATTENDED_TTL_MS && !threadBusy(botId, threadId)) {
    unattendedThreads.delete(threadId);
    return false;
  }
  mark.at = Date.now();
  return true;
}

const internalTurnThreads = new Set<string>();

function markInternalTurn(threadId: string) {
  internalTurnThreads.add(threadId);
}
function clearInternalTurn(threadId: string) {
  internalTurnThreads.delete(threadId);
}
function isInternalTurn(threadId: string): boolean {
  return internalTurnThreads.has(threadId);
}
return { markUnattended, clearUnattended, isUnattended, markInternalTurn, clearInternalTurn, isInternalTurn };
}
