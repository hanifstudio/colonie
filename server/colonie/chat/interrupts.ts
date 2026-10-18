// Stopping a conversation's work at the source: interruptDirectThread revokes one thread's tools, chief lease, memory capture queue and dispatch claim and then asks the running provider adapter to interrupt, and interruptAllDirectThreads does the revoke pass over every busy sibling before any provider teardown. stopBotForEmergencyApprovalDowngrade is the fail-closed compensation Electron's private channel asks for: it forces every full/custom task back to ask, then stops the direct turn and any routine run that may already have captured the wider permissions.
import { isColonieAcpDriver } from "../../../shared/acp.ts";

/** Everything this cluster reaches in the server; see the header. */
export interface ChatInterruptsDeps {
  // ponytail: one permissive shape instead of hand-typed lines for each name;
  // tighten it when this cluster gets tests of its own.
  [name: string]: any;
}

export function createChatInterrupts(deps: ChatInterruptsDeps) {
  const {
    botForThread, cancelDirectTurnDispatch, closeOpenApprovals, colonieChief, colonieMemory,
    colonieMemorySources, colonieTurnByThread, connectedTools, directRequestOwners,
    directTurnDispatchClaims, directTurnGenerationByThread, pendingComputerResumes, registry,
    revokeInternalCapabilitiesForThread, runningTurnInstance, store, routines
  } = deps;
async function interruptDirectThread(botId: string, threadId: string, options?: { preserveComputerResume?: boolean }): Promise<void> {
  connectedTools().cancel(threadId);
  colonieChief().cancelSource(threadId);
  colonieTurnByThread().delete(threadId);
  if (isColonieAcpDriver(registry.get(store().bot(botId)?.modelSelection.instanceId ?? "")?.driverKind)) {
    try { colonieMemory().cancelThread(botId, threadId); }
    catch { console.warn("Colonie memory could not persist its cancelled capture queue."); }
    if (colonieMemorySources().get(threadId)?.botId === botId) colonieMemorySources().delete(threadId);
  }
  // A parked turn has settled its provider but still owns a future resume.
  // Stop cancels that work too. The parking teardown itself preserves it.
  if (!options?.preserveComputerResume && pendingComputerResumes().delete(threadId)
      && store().taskByThread(botId, threadId)?.activity === "parked.computer") {
    store().setTaskActivity(botId, threadId, "idle");
  }
  const requestOwner = directRequestOwners.get(threadId);
  if (requestOwner) {
    requestOwner.stopped = true;
    if (requestOwner.messageId) store().patchMessage(threadId, requestOwner.messageId, { requestCancelled: true });
  }
  const owner = botForThread(botId, threadId);
  const generation = directTurnGenerationByThread.get(threadId);
  cancelDirectTurnDispatch(botId, threadId);
  revokeInternalCapabilitiesForThread(threadId);
  // Main routes Stop to the engine that started the turn; keep this branch's
  // generation fence so a replacement turn's approvals are never closed here.
  await (owner ? runningTurnInstance()(owner, threadId) : null)?.adapter.interruptTurn(threadId);
  if (directTurnGenerationByThread.get(threadId) === generation) closeOpenApprovals()(threadId);
}

async function interruptAllDirectThreads(botId: string): Promise<void> {
  const threads = store().tasks(botId).filter((task: any) => task.busy || directTurnDispatchClaims.has(task.threadId) || pendingComputerResumes().has(task.threadId));
  // Revoke every sibling before yielding to any provider teardown.
  for (const task of threads) {
    cancelDirectTurnDispatch(botId, task.threadId);
    revokeInternalCapabilitiesForThread(task.threadId);
  }
  await Promise.all(threads.map((task: any) => interruptDirectThread(botId, task.threadId)));
}
/** Stop work that may have captured Full/Custom before a fail-closed Ask
 * compensation arrived over Electron's private channel. Cancellation flags
 * are flipped synchronously; the awaited work only drains capabilities and
 * interrupts the already-started provider process. */
async function stopBotForEmergencyApprovalDowngrade(botId: string): Promise<void> {
  const bot = store().bot(botId);
  if (!bot) return;
  for (const task of store().tasks(botId)) {
    if (task.approvalMode === "full" || task.approvalMode === "custom") {
      store().patchTask(botId, task.threadId, { approvalMode: "ask", autoApprove: false, alwaysAllow: [] });
    }
  }
  const directStop = interruptAllDirectThreads(botId);

  const routineRun = routines()?.activeBotRunForBot(bot.id);
  if (routineRun) {
    if (routineRun.threadId) revokeInternalCapabilitiesForThread(routineRun.threadId);
    cancelDirectTurnDispatch(bot.id, routineRun.threadId);
    await routines()!.cancelRun(routineRun.id);
    if (routineRun.threadId) closeOpenApprovals()(routineRun.threadId);
    await directStop;
    return;
  }

  await directStop;
}

  return {
    interruptDirectThread,
    interruptAllDirectThreads,
    stopBotForEmergencyApprovalDowngrade,
  };
}
