// Who a request is and who may answer: message senders and stable person keys, the card-answer rule (owner/admin, or the person who started the conversation or sent its request), the command-allowlist view, and the decision/card-answerer actors a settled card records.
import { type CommandAllowlistResponse } from "../../shared/command-allowlist.ts";
import { type CardAnswerer, type ResolvedSender } from "../../shared/wire.ts";
import { DATA_DIR } from "../config.ts";
import { withDecisionActor, type DecisionActor } from "../decision-log.ts";
import { hostedWorkspaceConfiguration } from "../enterprise.ts";
import { type Message, type BotRecord } from "../persistence/store.ts";
import { type RequestAuth } from "../request-auth.ts";
import { type SessionRecord } from "../sessions.ts";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";

/** Everything this cluster reaches in the server; see the header. */
export interface IdentityDeps {
  // ponytail: one permissive shape instead of hand-typed lines for each name;
  // tighten it when this cluster gets tests of its own.
  [name: string]: any;
}

export function createIdentity(deps: IdentityDeps) {
  const {
    commandAllowlist, registry, signInAllowList, store, threadStarters
  } = deps;
/** Who a user message is from, when that is someone other than the desktop
 * owner. Loopback is the owner by design, so it stays unstamped and reads as
 * the profile name; a paired or signed-in session names the person, by
 * account email where there is one and otherwise by the device label they
 */
function messageSender(auth: RequestAuth): ResolvedSender | undefined {
  if (auth.kind !== "session") return undefined;
  const name = (auth.session.email ?? auth.session.label ?? "").trim();
  return name ? { name, id: actorKey(auth) } : undefined;
}

/** An opaque, stable key for the person behind a session: their account
 * email when they signed in with one (a new device is still them), else the
 * paired session itself. Hashed, so a message or a thread can carry it
 * without handing other members a session id. */
function personKey(session: Pick<SessionRecord, "id" | "email">): string {
  const basis = session.email ? `email:${session.email.trim().toLowerCase()}` : `session:${session.id}`;
  return `p_${createHash("sha256").update(basis).digest("base64url").slice(0, 22)}`;
}

/** More than one person uses this workspace: portal membership, or an email
 * sign-in list that names members. Only then does who-may-answer narrow. */
function sharedMembership(): boolean {
  return hostedWorkspaceConfiguration()?.portalMembership === true || signInAllowList().members.length > 0;
}

/** The person a user line came from, when a session sent it. A bot's line
 * (peerAsk), the owner, a service, a routine or a webhook names nobody. */
function linePersonKey(message: Message | undefined): string | undefined {
  return message?.role === "user" && !message.peerAsk ? message.sender?.id : undefined;
}

/** The opaque key of whoever sent the request a card belongs to: the
 * message the harness proved started the turn, else the last user line
 * before the card. */
function cardRequesterKey(threadId: string, requestId: string): string | undefined {
  const thread = store().messagesFor(threadId);
  const index = thread.findIndex((message: Message) => message.card?.requestId === requestId);
  if (index < 0) return undefined;
  const card = thread[index]!;
  return linePersonKey(card.requestMessageId
    ? thread.find((message: Message) => message.id === card.requestMessageId)
    : thread.slice(0, index).findLast((message: Message) => message.role === "user"));
}

/** Whose lent computers a status reader may see: the person behind the
 * asking session. */
function sessionLendingPrincipal(auth: RequestAuth): string | null {
  return auth.kind === "session" ? personKey(auth.session) : null;
}

/** Who a session acts as, for lines, openers and answers. */
function actorKey(auth: RequestAuth & { kind: "session" }): string {
  return personKey(auth.session);
}

/** Whose session may answer a card. The provider CLI's own approval modes and
 * the harness's proposals stay exactly as they are; this adds no card, gate
 * or prompt, it only decides whose answer to an existing card counts.
 * - the owner on this machine, and admins: any card;
 * - a session-less caller on a shared server (service trust): decline only;
 * - where several people share the workspace and the card can be traced to
 *   a person (who sent its request, who the thread was opened for, followed
 *   back through threads bots opened for them): those people;
 * - otherwise (one person; or a routine, webhook, Slack, owner-sent or older
 *   thread that names nobody): anyone who may chat, as before. */
function cardAnswerRefusal(auth: RequestAuth, threadId: string, requestId: string, behavior: string): string | null {
  if (auth.kind === "loopback") {
    return auth.trust === "service" && behavior !== "deny"
      ? "A local service can only decline this request. Approve or answer it in Colonie while signed in."
      : null;
  }
  if (!auth.scopes.includes("admin") && store().messagesFor(threadId).some((message: Message) =>
    message.card?.requestId === requestId && message.card.teamMemoryRequest)) {
    return "Only a workspace admin can review shared team memory.";
  }
  if (auth.scopes.includes("admin") || !sharedMembership()) return null;
  const known = [threadStarters.get(threadId), cardRequesterKey(threadId, requestId)].filter((person): person is string => Boolean(person));
  if (!known.length || known.includes(personKey(auth.session))) return null;
  return "Only the person who started this conversation or sent this request, or a workspace admin, can answer this card.";
}

function canManageCommandAllowlist(auth: RequestAuth): boolean {
  return auth.kind === "loopback" ? auth.trust !== "service" : auth.scopes.includes("admin");
}

const COMMAND_ALLOWLIST_DRIVERS = new Set([
  "claudeAgent", "codex", "antigravityAgent", "grokAgent", "opencodeGo", "kimiAgent",
  "droidAgent", "cursorAgent", "qwenAgent", "geminiAgent", "hermesAgent", "customAcp",
]);

function commandAllowlistResponse(bot: BotRecord): CommandAllowlistResponse {
  const instance = registry.get(bot.modelSelection.instanceId);
  const task = store().taskByThread(bot.id, bot.threadId);
  let cwd = task?.cwd !== undefined ? task.cwd : bot.cwd ?? join(realpathSync(DATA_DIR), "task-workspaces", bot.id, bot.threadId);
  if (cwd && existsSync(cwd)) cwd = realpathSync(cwd);
  return {
    rules: commandAllowlist.list(bot.id),
    supported: COMMAND_ALLOWLIST_DRIVERS.has(instance?.driverKind ?? ""),
    context: {
      providerInstanceId: bot.modelSelection.instanceId,
      cwd,
    },
  };
}

function decisionActorFor(auth: RequestAuth): DecisionActor {
  if (auth.kind === "loopback") return auth.trust === "service" ? { kind: "worker" } : { kind: "loopback" };
  const session = auth.session;
  return {
    kind: "session", sessionId: session.id, label: session.label,
    ...(session.email ? { email: session.email } : {}),
    // A portal session's id is its membership grant: never written down.
    ...(session.userId && !session.userId.startsWith("portal:") ? { userId: session.userId } : {}),
  };
}

function cardAnswererFor(auth: RequestAuth): CardAnswerer {
  if (auth.kind === "loopback") return auth.trust === "service" ? { kind: "worker" } : { kind: "loopback" };
  return { kind: "session", name: (auth.session.email ?? auth.session.label ?? "").trim() || "Signed-in user" };
}

/** Answer a card as `auth`: the decision rows written meanwhile name the
 * answerer, and a card this answer settled records who settled it (and
 * `via: "call"` when it was decided by voice on a Live call). A card that
 * was already settled keeps whatever it said. */
async function answeringCardAs(auth: RequestAuth, threadId: string, requestId: string, work: () => Promise<unknown>, via?: "call"): Promise<void> {
  const open = (() => {
    const card = store().messagesFor(threadId).find((message: Message) => message.card?.requestId === requestId)?.card;
    return Boolean(card && !card.answered && !card.dismissed && !card.expired);
  })();
  try {
    await withDecisionActor(decisionActorFor(auth), work, via);
  } finally {
    const message = open ? store().messagesFor(threadId).find((candidate: Message) => candidate.card?.requestId === requestId) : undefined;
    const card = message?.card;
    if (message && card && !card.answeredBy && card.answered !== "unavailable" && (card.answered || card.dismissed)) {
      store().patchMessage(threadId, message.id, { card: { ...card, answeredBy: { ...cardAnswererFor(auth), ...(via ? { via } : {}) } } });
    }
  }
}

  return {
    COMMAND_ALLOWLIST_DRIVERS,
    messageSender,
    personKey,
    sessionLendingPrincipal,
    actorKey,
    cardAnswerRefusal,
    canManageCommandAllowlist,
    commandAllowlistResponse,
    decisionActorFor,
    answeringCardAs,
  };
}
