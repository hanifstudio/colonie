// One direct turn's dispatch claim and the provider-turn ownership it leaves behind: the DirectTurnDispatchClaim record and the two control-flow exceptions, the claim map and its phase transitions, cancelled-handshake quarantine and retiring, the staged attachments a retired turn drops, the compaction controllers, and the review of whether a provider event still belongs to a live turn. DirectTurnDispatchClaim is exported as a type for index.ts's own maps.
import { type RuntimeEvent } from "../../contracts.ts";
import { type Message } from "../../persistence/store.ts";
import { deleteAttachment } from "../../colonie/chat/attachments.ts";
import { PendingTurnCancellations, RetiredTurnRegistry, isTurnEventQuarantined } from "../../colonie/chat/turn-dispatch-guard.ts";

/** Everything this cluster reaches in the server; see the header. */
export interface TurnDispatchDeps {
  // ponytail: one permissive shape instead of hand-typed lines for each name;
  // tighten it when this cluster gets tests of its own.
  [name: string]: any;
}

export type DirectTurnDispatchClaim = {
  id: string;
  botId: string;
  threadId: string;
  phase: "setup" | "dispatching";
};

export function createTurnDispatch(deps: TurnDispatchDeps) {
  const {
    cancelTeamSetupResumesForThread, clearTurnDigestState, directTurnDispatchClaims,
    directTurnGenerationByThread, settleTrackedRequest, store, threadBusy
  } = deps;
class DirectTurnSetupCancelled extends Error {}
/** The computer wait ceiling fired (ADR-2, #1651). The turn parks — settled
 * with a registered resume — instead of failing; the carried resource names
 * the seat the resume must wait to free. */
class ComputerWaitParked extends Error {
  readonly resource: string;
  /** The parked turn's generation: the drain distinguishes the turn's own
   * settle window (keep, retry later) from a newer turn that superseded it
   * (delete). */
  readonly generation: string;
  constructor(message: string, resource: string, generation: string) {
    super(message);
    this.resource = resource;
    this.generation = generation;
  }
}
const retiredProviderTurns = new RetiredTurnRegistry();
const pendingCancelledProviderHandshakes = new PendingTurnCancellations();
// One parking lot for provider output staged mid-turn and attached when the
// turn settles: generated images since the beginning, voice notes since #1742.
// Audio entries carry their transcript until the message they land on; the
// wire attachment itself has no text field.
type ParkedTurnAttachment = NonNullable<Message["attachments"]>[number] & { text?: string };

const turnAttachmentsByTurn = new Map<string, Array<ParkedTurnAttachment>>();

function turnAttachmentKey(threadId: string, turnId?: string): string {
  return `${threadId}:${turnId ?? "active"}`;
}

function purgeTurnAttachmentsForThread(threadId: string): void {
  for (const [key, attachments] of turnAttachmentsByTurn) {
    if (!key.startsWith(`${threadId}:`)) continue;
    turnAttachmentsByTurn.delete(key);
    for (const attachment of attachments) {
      deleteAttachment(attachment.path);
    }
  }
}

function markCancelledProviderHandshake(threadId: string, ownerId: string): void {
  pendingCancelledProviderHandshakes.mark(threadId, ownerId);
}

function clearCancelledProviderHandshake(threadId: string, ownerId: string): void {
  pendingCancelledProviderHandshakes.clear(threadId, ownerId);
}

function retireProviderTurn(turnId: string): void {
  retiredProviderTurns.retire(turnId);
  // A stopped/replaced turn is never folded again. Delete only staged files
  // (images, voice notes) that were parked for that exact provider turn so
  // unattached output does not accumulate invisibly on disk.
  for (const [key, attachments] of turnAttachmentsByTurn) {
    if (!key.endsWith(`:${turnId}`)) continue;
    turnAttachmentsByTurn.delete(key);
    for (const attachment of attachments) {
      deleteAttachment(attachment.path);
    }
  }
}

function shouldIgnoreProviderEvent(event: RuntimeEvent): boolean {
  // Some adapters publish completion/error synchronously just before their
  // sendTurn promise resolves. Stop can already have cancelled that handshake,
  // but its returned turn id is not available to retire yet. Quarantine the
  // narrow pre-id window and tombstone any id it reveals; the broad gate is
  // time-bounded so a broken promise cannot suppress a later turn forever.
  if (isTurnEventQuarantined(pendingCancelledProviderHandshakes, retiredProviderTurns, event)) return true;
  if (event.type !== "session.exited" || event.turnId !== undefined) return false;
  const bot = store().botByThread(event.threadId);
  return Boolean(bot && threadBusy()(bot.id, event.threadId));
}

function directTurnClaimIsCurrent(botId: string, claimId: string, threadId: string): boolean {
  const claim = directTurnDispatchClaims().get(threadId);
  return claim?.id === claimId && claim.botId === botId && store().taskByThread(botId, threadId)?.busy === true;
}

function directTurnClaimExists(botId: string, claimId: string, threadId: string): boolean {
  const claim = directTurnDispatchClaims().get(threadId);
  return claim?.id === claimId && claim.botId === botId;
}

function markDirectTurnDispatching(botId: string, claimId: string, threadId: string): boolean {
  if (!directTurnClaimIsCurrent(botId, claimId, threadId)) return false;
  directTurnDispatchClaims().set(threadId, { id: claimId, botId, threadId, phase: "dispatching" });
  return true;
}

function clearDirectTurnDispatch(threadId: string, claimId: string): void {
  if (directTurnDispatchClaims().get(threadId)?.id === claimId) {
    directTurnDispatchClaims().delete(threadId);
    // A fast provider can settle before its dispatch ACK. Its first cleanup
    // still saw this reservation, so releasing it must retry the final fence.
    settleTrackedRequest()(threadId);
  }
}

const compactionControllers = new Map<string, { generation: string; controller: AbortController }>();

function cancelDirectTurnDispatch(botId: string, expectedThreadId?: string): DirectTurnDispatchClaim | null {
  const threadId = expectedThreadId ?? store().bot(botId)?.threadId;
  if (!threadId) return null;
  cancelTeamSetupResumesForThread()(threadId);
  const claim = directTurnDispatchClaims().get(threadId);
  if (!claim || claim.botId !== botId) return null;
  const compacting = compactionControllers.get(threadId);
  if (compacting && compacting.generation === claim.id) compacting.controller.abort(new DirectTurnSetupCancelled("context summarization stopped"));
  directTurnDispatchClaims().delete(threadId);
  if (directTurnGenerationByThread().get(threadId) === claim.id) clearTurnDigestState()(threadId);
  // Setup has not called the adapter yet, so there is no provider handshake
  // (and no unknown turn id) to quarantine. Dispatching is the only phase in
  // which a late provider event can exist.
  if (claim.phase === "dispatching") {
    markCancelledProviderHandshake(claim.threadId, `direct:${claim.id}`);
  }
  // Keep setup ownership until the guarded send resolves and retires its
  // provider turn id. Some adapters can emit completion synchronously just
  // before sendTurn returns; making the bot idle here would let a replacement
  // start early enough for those old events to settle the replacement.
  return claim;
}

  return {
    ComputerWaitParked,
    DirectTurnSetupCancelled,
    cancelDirectTurnDispatch,
    clearCancelledProviderHandshake,
    clearDirectTurnDispatch,
    compactionControllers,
    directTurnClaimExists,
    directTurnClaimIsCurrent,
    markDirectTurnDispatching,
    pendingCancelledProviderHandshakes,
    purgeTurnAttachmentsForThread,
    retireProviderTurn,
    shouldIgnoreProviderEvent,
    turnAttachmentKey,
    turnAttachmentsByTurn,
  };
}
