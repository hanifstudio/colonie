// The process's own lifecycle, lifted out of index.ts: what happens once the HTTP listener is up (the queued-send drain, the engine read gate, the presenters, the leftover delegation drain and the periodic sweep) and what a SIGINT/SIGTERM tears down, in order, before the process exits.
import { flushAdminActivity } from "../admin-activity.ts";
import { flushAllMemoryJournals } from "../colonie/memory/memory-journal.ts";
import { discardDelegations, pendingThreads } from "../colonie/peers/delegations.ts";
import { flushUsageLedger } from "../colonie/providers/usage-ledger.ts";
import { DATA_DIR } from "../config.ts";
import { flushDecisionLog } from "../decision-log.ts";
import { closeMessageDb, closeMessageSearch } from "../persistence/message-db.ts";
import { flushAllProfileHistory } from "../profile-versions.ts";
import { createGracefulShutdown } from "../runtime/graceful-shutdown.ts";

/** Everything this cluster reaches in the server; see the header. */
export interface ProcessLifecycleDeps {
  // ponytail: one permissive shape instead of hand-typed lines for each name;
  // tighten it when this cluster gets tests of its own.
  [name: string]: any;
  setFollowupsReady: (value: any) => void,
  setShuttingDown: (value: any) => void,
}

export function createProcessLifecycle(deps: ProcessLifecycleDeps) {
  const {
    DELEGATION_SWEEP_MS, PORT, browserLive, browserRuntime, bus, calendarCalls, colonieChief,
    colonieMemory, commsBus, connectedTools, desktopViewer, drainQueuedSends,
    drainThreadDelegations, enginesRead, expireDelegationsNow,
    forgetTemporaryBrowser, liveCalls, localVmIdles, mcpOAuth, memoryUpkeep, registry, stopLocalVmsOnQuit,
    releaseDataDirLeaseAtExit, revokeAllInternalCapabilities, routines, server, sessions,
    sharedComputerControl, sharedComputers, shuttingDown, store, temporaryBrowserSessions,
    watchdog, webhookIngress, workspaceAccessTimer, setFollowupsReady, setShuttingDown
  } = deps;
server.listen(PORT, "127.0.0.1", async () => {
  console.log(`Colonie server on http://127.0.0.1:${PORT}`);
  // Words queued before the restart start first, ahead of anything sent from
  // now on. Their turns wait for the engines read at start like every turn.
  setFollowupsReady(true);
  drainQueuedSends();
  // The work below wakes delegators, and a woken delegator keeps its session
  // only on an engine that records what it was handed, which that read finds
  // out: it starts once the read is done.
  if (enginesRead()) {
    await enginesRead();
    if (shuttingDown()) return;
  }
  // Startup work uses the same turn dispatcher and local tool endpoint as
  // ordinary chat. Start only once every registry is initialized and the
  // endpoint is listening; earlier dispatch can hit uninitialized bindings.
  routines()!.start();
  memoryUpkeep.start();
  colonieMemory().start();
  const leftover = pendingThreads();
  if (leftover.length) console.log(`delegations: ${leftover.length} thread(s) with queued handoffs from a previous run — draining`);
  for (const threadId of leftover) {
    const run = routines()!.runForThread(threadId);
    // A person can reuse a completed run's task for unrelated work. Only
    // discard the old run's handoffs, not a later user's persisted queue.
    const reused = run?.finishedAt !== undefined && store.botByThread(threadId) &&
      store.activePath(threadId).some((message: any) => message.role === "user" && message.at > run.finishedAt!);
    if (run && !["running", "waiting"].includes(run.status) && !reused) discardDelegations(commsBus, threadId);
    else drainThreadDelegations(threadId);
  }
  // After the boot drain, not before it: that drain already expires stale
  // leftovers, and a sweep ahead of it would wake delegators of stopped
  // routine runs whose handoffs the loop above discards instead.
  setInterval(expireDelegationsNow, DELEGATION_SWEEP_MS).unref();
});

const gracefulShutdown = createGracefulShutdown({
  cleanup: [
    () => {
      setFollowupsReady(false);
      setShuttingDown(true);
      if (workspaceAccessTimer) clearInterval(workspaceAccessTimer);
      // Child MCP processes and the HTTP listener can remain alive while the
      // asynchronous shutdown jobs drain. Invalidate their turn bearers before
      // any cleanup function reaches an await.
      revokeAllInternalCapabilities();
      sharedComputers.close();
      sharedComputerControl.close();
      browserLive.closeAll();
      desktopViewer.closeAll();
      for (const idle of localVmIdles.values()) idle.cancel();
      watchdog.stop();
      routines()?.stop();
      calendarCalls()?.stop();
      memoryUpkeep.stop();
      colonieMemory().stop();
      colonieChief.dispose();
      webhookIngress()?.server.close();
    },
    async () => { await registry.disposeAll(); },
    () => stopLocalVmsOnQuit(),
    async () => {
      await Promise.all([...temporaryBrowserSessions.keys()].map((botId) => forgetTemporaryBrowser(botId)));
      await browserRuntime.closeAll();
    },
    () => liveCalls.shutdown(),
    () => flushAllProfileHistory(),
    () => flushAllMemoryJournals(),
    () => colonieMemory().idle(),
    () => flushUsageLedger(DATA_DIR),
    () => flushDecisionLog(DATA_DIR),
    () => flushAdminActivity(DATA_DIR),
    () => closeMessageSearch(),
  ],
  // Cleanup jobs run concurrently. Release only after they settle (or reach
  // the shutdown deadline), immediately before the process exits, so no new
  // server can overlap with a still-mutating old one.
  exit: (code) => {
    // Streamed text the bus is still merging reaches the log and clients.
    bus.flush();
    try { sessions.close(); }
    catch {
      // An uncleared marker makes saved account sessions require sign-in on
      // the next boot; never label failed persistence a clean shutdown.
      console.error("Session persistence failed during shutdown; account sign-in will be required again.");
      code = 1;
    }
    closeMessageDb();
    mcpOAuth.dispose();
    connectedTools.dispose();
    releaseDataDirLeaseAtExit();
    process.exit(code);
  },
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, gracefulShutdown);
}}
