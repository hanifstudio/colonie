// The three parked-turn resume tables: a connector/credential/computer card that came back marks its message and parks a resume when the bot cannot admit a turn yet, and the drain re-dispatches each when it can.
import { isTurnAdmissionBlocked } from "../../colonie/chat/turn-dispatch-guard.ts";
import type { Message } from "../../persistence/store.ts";

/** Everything this cluster reaches in the server; see the header. */
export interface ResumeTablesDeps {
  // ponytail: one permissive shape instead of hand-typed lines for each name;
  // tighten it when this cluster gets tests of its own.
  [name: string]: any;
}

export function createResumeTables(deps: ResumeTablesDeps) {
  const {
    activeInternalGenerationByThread, canAdmitDirectTurn, connectorThread, pendingConnectorResumes,
    startTurn, store, threadBusy, turnResources
  } = deps;

function connectorMessage(botId: string, threadId: string, messageId: string) {
  if (!connectorThread(botId, threadId)) return null;
  const message = store.messagesFor(threadId).find((candidate: Message) => candidate.id === messageId);
  return message?.kind === "connector" && message.connector ? message : null;
}

function connectorCards(threadId: string, resumeKey: string) {
  return store.messagesFor(threadId).filter(
    (message: Message) => message.kind === "connector" && message.connector?.resumeKey === resumeKey,
  );
}

function markConnectorResumeFailed(threadId: string, resumeKey: string, error: string) {
  for (const message of connectorCards(threadId, resumeKey)) {
    if (!message.connector) continue;
    store.patchMessage(threadId, message.id, {
      connector: { ...message.connector, resumed: false, error: error.slice(0, 180) },
    });
  }
}

function dispatchConnectorResume(entry: { botId: string; threadId: string; resumeKey: string; labels: string[] }) {
  const owner = connectorThread(entry.botId, entry.threadId);
  if (!owner) return;
  const names = entry.labels.join(", ");
  const prompt = `Colonie connection update: the user securely connected ${names}. Continue the task that paused for this connection. Do not ask them to connect it again.`;
  if (!canAdmitDirectTurn(entry.botId, entry.threadId)) {
    pendingConnectorResumes.set(`${entry.threadId}:${entry.resumeKey}`, entry);
    return;
  }
  void startTurn(entry.botId, prompt, {
    threadId: entry.threadId,
    cardContinuation: true,
    onDispatchError: (message: string) => markConnectorResumeFailed(entry.threadId, entry.resumeKey, message),
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (isTurnAdmissionBlocked(error)) pendingConnectorResumes.set(`${entry.threadId}:${entry.resumeKey}`, entry);
    else markConnectorResumeFailed(entry.threadId, entry.resumeKey, message);
  });
}

function maybeResumeConnectors(botId: string, threadId: string, resumeKey: string) {
  const cards = connectorCards(threadId, resumeKey);
  if (!cards.length || cards.some((message: Message) => message.connector?.dismissed || message.connector?.status !== "connected")) return false;
  if (cards.every((message: Message) => message.connector?.resumed)) return true;
  const labels = cards.map((message: Message) => message.connector!.label);
  for (const message of cards) {
    store.patchMessage(threadId, message.id, { connector: { ...message.connector!, resumed: true, error: undefined } });
  }
  dispatchConnectorResume({ botId, threadId, resumeKey, labels });
  return true;
}

function drainConnectorResumes() {
  for (const [key, entry] of pendingConnectorResumes) {
    if (!canAdmitDirectTurn(entry.botId, entry.threadId)) continue;
    pendingConnectorResumes.delete(key);
    dispatchConnectorResume(entry);
  }
}

/** A turn parked at the computer wait ceiling (#1651): settled, with this
 * entry registered until the seat it queued on frees. Mirrors the connector
 * and secret resume tables. */
type ComputerResumeEntry = {
  botId: string;
  threadId: string;
  /** The seat the turn parked on; the drain fires only when it frees. */
  resource: string;
  /** The parked turn's generation. A drain that sees the thread busy under
   * THIS generation is inside the turn's own settle window (the lazy-claim
   * park registers before its interrupt lands) and must keep the entry; a
   * different generation means a newer turn superseded the parked work. */
  generation: string;
  /** The newest user message when the turn parked. A later ask replaces the
   * parked work instead of racing it, so the drain drops a superseded entry. */
  afterMessageId?: string;
};
const pendingComputerResumes = new Map<string, ComputerResumeEntry>();

function registerComputerResume(entry: ComputerResumeEntry): void {
  // One per thread: the newest park replaces an older one.
  pendingComputerResumes.set(entry.threadId, entry);
  // The seat may already be free (it freed before this park registered):
  // an idle install would otherwise never drain. #1651.
  queueMicrotask(drainComputerResumes);
}

function markComputerResumeFailed(entry: ComputerResumeEntry, message: string): void {
  const owner = connectorThread(entry.botId, entry.threadId);
  if (!owner) return;
  store.appendMessage(entry.threadId, {
    role: "bot", kind: "activity",
    tool: { name: `Parked turn could not continue: ${message.slice(0, 160)}`, ok: false },
  });
}

function dispatchComputerResume(entry: ComputerResumeEntry): void {
  const owner = connectorThread(entry.botId, entry.threadId);
  if (!owner) return;
  const prompt = "Colonie computer update: the computer this conversation waited for is free again. Continue the task that parked waiting for it.";
  void startTurn(entry.botId, prompt, {
    threadId: entry.threadId,
    cardContinuation: true,
    onDispatchError: (message: string) => markComputerResumeFailed(entry, message),
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (isTurnAdmissionBlocked(error)) pendingComputerResumes.set(entry.threadId, entry);
    else markComputerResumeFailed(entry, message);
  });
}

function drainComputerResumes(): void {
  for (const [key, entry] of pendingComputerResumes) {
    if (!connectorThread(entry.botId, entry.threadId)) {
      pendingComputerResumes.delete(key);
      continue;
    }
    // A newer ask replaced the parked work: the resume is stale, not blocked.
    const latestUser = store.activePath(entry.threadId).findLast((message: Message) => message.role === "user")?.id;
    if (entry.afterMessageId !== undefined && latestUser !== entry.afterMessageId) {
      pendingComputerResumes.delete(key);
      continue;
    }
    // A newer generation owns the thread — a new turn superseded the parked
    // one — so the parked resume is stale too. The parked turn's OWN
    // generation is still current while it settles: the lazy-claim park
    // registers its resume before the interrupt lands, and a drain in that
    // window must keep the entry (#1651), not read busy as superseded.
    const activeGeneration = activeInternalGenerationByThread.get(entry.threadId);
    if (activeGeneration !== undefined && activeGeneration !== entry.generation) {
      pendingComputerResumes.delete(key);
      continue;
    }
    // Busy under the parked generation: the turn is still settling. Keep the
    // entry; the next drain (its completion, the next release) dispatches.
    if (threadBusy(entry.botId, entry.threadId)) continue;
    if (!turnResources.free(entry.resource)) continue;
    pendingComputerResumes.delete(key);
    dispatchComputerResume(entry);
  }
}

type SecretResumeEntry = {
  botId: string;
  threadId: string;
  messageId: string;
  label: string;
  outcome: "provided" | "dismissed";
};
const pendingSecretResumes = new Map<string, SecretResumeEntry>();

function secretMessage(botId: string, threadId: string, messageId: string): Message | null {
  const owner = connectorThread(botId, threadId);
  if (!owner) return null;
  // A credential card is actionable only while it is visible on the chosen
  // conversation branch.
  const message = store.activePath(threadId).find((candidate: Message) => candidate.id === messageId);
  return message?.kind === "secret" && message.secret ? message : null;
}

function currentSecretState(botId: string, threadId: string, messageId: string) {
  const message = secretMessage(botId, threadId, messageId);
  if (!message?.secret) return null;
  return {
    provided: message.secret.provided === true,
    resumed: message.secret.resumed === true,
  };
}

function markSecretResumeFailed(threadId: string, messageId: string, error: string) {
  const message = store.messagesFor(threadId).find((candidate: Message) => candidate.id === messageId);
  if (!message?.secret) return;
  store.patchMessage(threadId, message.id, {
    secret: { ...message.secret, resumed: false, error: error.slice(0, 180) },
  });
}

function dispatchSecretResume(entry: SecretResumeEntry) {
  const owner = connectorThread(entry.botId, entry.threadId);
  if (!owner) return;
  const prompt =
    entry.outcome === "provided"
      ? `Colonie credential update: the user securely provided ${entry.label}. Continue the task that paused for it. You do not receive the secret and must not ask them to paste it into chat.`
      : `Colonie credential update: the user declined to provide ${entry.label}. Continue without it if possible, or briefly explain the limitation. Do not ask them to paste it into chat.`;
  if (!canAdmitDirectTurn(entry.botId, entry.threadId)) {
    pendingSecretResumes.set(`${entry.threadId}:${entry.messageId}`, entry);
    return;
  }
  void startTurn(entry.botId, prompt, {
    threadId: entry.threadId,
    cardContinuation: true,
    onDispatchError: (message: string) => markSecretResumeFailed(entry.threadId, entry.messageId, message),
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (isTurnAdmissionBlocked(error)) {
      pendingSecretResumes.set(`${entry.threadId}:${entry.messageId}`, entry);
    } else {
      markSecretResumeFailed(entry.threadId, entry.messageId, message);
    }
  });
}

function resumeSecretCard(botId: string, threadId: string, messageId: string, outcome: SecretResumeEntry["outcome"]) {
  const message = secretMessage(botId, threadId, messageId);
  if (!message?.secret) return false;
  if (message.secret.resumed) return true;
  store.patchMessage(threadId, message.id, {
    secret: {
      ...message.secret,
      provided: outcome === "provided" ? true : message.secret.provided,
      dismissed: outcome === "dismissed" ? true : message.secret.dismissed,
      resumed: true,
      error: undefined,
    },
  });
  dispatchSecretResume({ botId, threadId, messageId, label: message.secret.label, outcome });
  return true;
}

function drainSecretResumes() {
  for (const [key, entry] of pendingSecretResumes) {
    if (!canAdmitDirectTurn(entry.botId, entry.threadId)) continue;
    pendingSecretResumes.delete(key);
    dispatchSecretResume(entry);
  }
}


  return {
    connectorMessage,
    maybeResumeConnectors,
    drainConnectorResumes,
    pendingComputerResumes,
    registerComputerResume,
    drainComputerResumes,
    secretMessage,
    currentSecretState,
    resumeSecretCard,
    drainSecretResumes,
  };
}
