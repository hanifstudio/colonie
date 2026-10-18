// What a restart or workspace restore does to the user's in-flight words: a dispatch claim committed before its transcript or provider work left the outcome unknown, so each such row is recovered as a user line plus a review notice and counted as handed to resumed sessions rather than handed to a model for a second execution; then the steered, aside and channel queues are restored from their journals.
import { restoreAsideMessages } from "../../colonie/chat/aside-queue.ts";
import { restoreChannelMessages } from "../../colonie/chat/channel-queue.ts";
import { recordHanded, type HandedState } from "../../colonie/chat/delta-context.ts";
import { restoreSteeredMessages } from "../../colonie/chat/steer-queue.ts";
import { chatFollowups, settleChatFollowups } from "../../persistence/message-db.ts";

/** Everything this cluster reaches in the server; see the header. */
export interface BootRecoveryDeps {
  // ponytail: one permissive shape instead of hand-typed lines for each name;
  // tighten it when this cluster gets tests of its own.
  [name: string]: any;
}

export function createBootRecovery(deps: BootRecoveryDeps) {
  const {
    isContextMessage, store
  } = deps;


// A dispatch claim is deliberately committed before transcript/provider work.
// If we died after that point, its outcome is unknown: recover the user's words
// and a review notice, never hand them to a model for a second execution.
for (const row of chatFollowups()) {
  if (row.status !== "dispatching" && row.status !== "interrupted") continue;
  const owned = row.kind === "channel"
    ? Boolean(store.groupByThread(row.threadId)?.id === row.ownerId)
    : Boolean(store.taskByThread(row.ownerId, row.threadId));
  if (!owned) { settleChatFollowups([row.id], "cancelled"); continue; }
  settleChatFollowups([row.id], "interrupted");
  const messages = store.messagesFor(row.threadId);
  const recovered = messages.find((message: any) => message.queueId === row.id && message.role === "user") ?? store.appendMessage(row.threadId, {
    // Aside rows recover enveloped: the words may already have run mid-turn,
    // and the recovered line must keep saying whose context it was.
    role: "user", kind: "text", text: row.kind === "aside" ? row.payload.prompt ?? row.payload.text : row.payload.text, replyToId: row.payload.replyToId,
    sendId: row.payload.sendId, queueId: row.id, sender: row.payload.sender,
    ...(row.kind === "channel" ? { channelMode: row.payload.mode, via: row.payload.via } : {}),
    ...(row.kind === "bot" && row.payload.via === "call" ? { via: "call" as const } : {}),
    ...(row.kind === "aside" ? {
      aside: true,
      peerAsk: row.payload.aside
        ? { botId: row.payload.aside.fromBotId, name: row.payload.aside.fromBotName, ...(row.payload.aside.unattended ? { unattended: true } : {}) }
        : undefined,
    } : {}),
  });
  // Nor as a message a resumed session has not seen: count it as handed.
  const recoveredTask = row.kind !== "channel" ? store.taskByThread(row.ownerId, row.threadId) : undefined;
  const order = store.activePath(row.threadId).filter(isContextMessage).map((m: any) => m.id);
  for (const [instanceId, state] of Object.entries(recoveredTask?.handedMessages ?? {}) as Array<[string, HandedState]>) {
    if (state.session !== undefined) store.setHandedMessages(row.ownerId, row.threadId, instanceId, recordHanded(state, order, [recovered.id]));
  }
  if (!messages.some((message: any) => message.queueId === row.id && message.kind === "activity")) {
    store.appendMessage(row.threadId, {
      role: "bot", kind: "activity", queueId: row.id,
      tool: { name: "Queued follow-up interrupted by restart or restore — it may have already run. Review the result before sending it again.", ok: false },
    });
  }
  // The FULL-sync retirement also flushes both transcript writes. Retrying
  // this sendId now finds the canonical message, without a permanent journal scan.
  settleChatFollowups([row.id], null);
}
restoreSteeredMessages();
restoreAsideMessages(store);
restoreChannelMessages();}
