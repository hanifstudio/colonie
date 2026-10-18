// Deleting a bot, all of it: the peer approvals, the delegations, the queued
// team-setup resumes, the direct turns, the calendar calls, the webhooks, the
// browser session and the Local VM the bot was leasing. It is the longest
// teardown in the server and it deliberately runs in one place, because a
// teardown that half-runs leaves the next bot holding a machine or a session that
// the deleted bot still thinks it owns. The wiring at the bottom of `index.ts`
// hands it the state it cleans up.
import { rm as removeDirectory } from "node:fs/promises";
import { containerComputerAction, containerComputerStatus, perBotLocalVmTarget, type LocalVmTarget } from "../../colonie/computer/container-computer.ts";
import { type TeamSetupRequest } from "../../../shared/team-setup.ts";
import { cancelPeerApprovalsFor } from "../../colonie/peers/peer-approval.ts";
import { discardDelegations } from "../../colonie/peers/delegations.ts";
import { existsSync } from "node:fs";
import { localVmMode } from "../../config.ts";
import { requireBrowserCleanupAcknowledged } from "../../colonie/computer/browser-lifecycle-cleanup.ts";

/** The live state and helpers a bot teardown has to reach; getters where the
 * binding is reassigned while the server runs or declared below the wiring. */
export interface DeleteBotDeps {
  // ponytail: one permissive shape instead of hand-typed lines. Tighten it if a
  // teardown test ever needs the deps checked.
  [name: string]: any;
}

export function createBotDeletion(deps: DeleteBotDeps) {
  const {
    browserCleanup, browserLive, calendarCalls, cancelTeamSetupResumesForThread, cfg,
    clearTurnDigestState, commsBus, computerControl, computerControlRevision, directTurnBots,
    directTurnGenerationByThread, forgetTemporaryBrowser, hasDirectDispatch,
    interruptAllDirectThreads, lastReply, localVmActiveThreads, localVmFlags, localVmIdles,
    localVmLeaseFor, localVmLeases, localVmLifecycleBusy, localVmOwnerBusy, localVmSeen,
    pendingTeamSetupResumes, purgeTurnAttachmentsForThread, revokeInternalCapabilitiesForThread,
    routines, settleDirectFollowup, stopScreenPoller, store, webhooks
  } = deps;
async function deleteBotWithLifecycle(botId: string, revalidate: () => void = () => {}, setupRequest?: TeamSetupRequest) {
  const deletionResponse = (status: number, body: { error?: string; ok?: boolean }) => ({ status, body });
      revalidate();
      const bot = store.bot(botId);
      if (!bot) return deletionResponse( 404, { error: "no such bot" });
      if (localVmFlags.modeChangeBusy) {
        return deletionResponse(409, { error: "Local VM settings are being updated — wait before deleting this bot" });
      }
      const activeRoutine = routines()!.activeRunForBot(bot.id);
      if (activeRoutine) {
        return deletionResponse( 409, {
          error: "stop this bot's active routine before deleting the bot",
        });
      }
      // A direct turn that has already claimed the bot can be setting up its
      // Local VM in the background. Do not let deletion race that work; the
      // person can stop the turn and retry.
      if (bot.busy || hasDirectDispatch(bot.id)) {
        return deletionResponse( 409, { error: "stop this bot's work before deleting it" });
      }
      let claimedLocalVmTarget: LocalVmTarget | null = null;
      try {
        let localVmCleanup: { target: LocalVmTarget; removeContainer: boolean } | null = null;
        if (localVmMode(cfg) === "per-bot") {
          const target = perBotLocalVmTarget(bot.id);
          if (localVmActiveThreads.has(target.key) || localVmLifecycleBusy.has(target.key)) {
            return deletionResponse( 409, { error: "stop this bot's Local VM turn or setup action before deleting the bot" });
          }
          if (localVmLeaseFor(target).current(localVmOwnerBusy)) {
            return deletionResponse(409, { error: "stop this bot's Local VM turn before deleting the bot" });
          }
          // Hold the target from preflight through deletion. A simultaneous
          // mode change or lifecycle route must not recreate the container
          // after we checked it and before its bot owner disappears.
          localVmLifecycleBusy.add(target.key);
          claimedLocalVmTarget = target;
          const vm = await containerComputerStatus(undefined, undefined, target);
          if (!vm.daemonUp && existsSync(target.workspaceDir)) {
            return deletionResponse( 409, {
              error: "start the container runtime so Colonie can remove this bot's Local VM while deleting it",
            });
          }
          if (vm.container !== "missing" && !vm.managed) {
            return deletionResponse(409, {
              error: `The container named ${vm.container_name} was not created by Colonie. Remove it manually before deleting this bot`,
            });
          }
          localVmCleanup = {
            target,
            removeContainer: vm.container !== "missing",
          };
        }

        // Revalidate a reviewed Chief-of-Staff request and establish the
        // browser cleanup intent before the first irreversible local
        // mutation. A stale review or damaged journal therefore leaves every
        // resource intact.
        revalidate();
        const browserCleanupRequest = browserCleanup.prepare("bot", bot.id);
        try {
          if (localVmCleanup) {
            if (localVmCleanup.removeContainer) {
              await containerComputerAction("remove", undefined, undefined, localVmCleanup.target);
            }
            // Unlike the standalone "Delete VM" action, deleting the bot is
            // a complete erasure: its now-ownerless desktop files and browser
            // session must not remain hidden on disk or block the event loop.
            await removeDirectory(localVmCleanup.target.workspaceDir, { recursive: true, force: true });
            localVmSeen.delete(localVmCleanup.target.key);
            localVmIdles.get(localVmCleanup.target.key)?.cancel();
            localVmIdles.delete(localVmCleanup.target.key);
            localVmLeases.forget(localVmCleanup.target.key);
          }
          // a running turn dies with its bot
          // Invalidate every bot-callable bearer before the first asynchronous
          // teardown step. A request that already passed its initial header
          // check is revalidated after its body arrives and must fail closed.
          for (const entry of pendingTeamSetupResumes().values()) {
            if (entry.request.botId === bot.id) cancelTeamSetupResumesForThread()(entry.request.threadId);
          }
          for (const task of store.tasks(bot.id)) {
            cancelTeamSetupResumesForThread()(task.threadId);
            revokeInternalCapabilitiesForThread(task.threadId);
          }
          await interruptAllDirectThreads(bot.id);
          // Deletion removes the thread before a late turn.completed can fold
          // staged provider images into a message, so dispose them here.
          for (const task of store.tasks(bot.id)) {
            purgeTurnAttachmentsForThread(task.threadId);
            clearTurnDigestState(task.threadId);
            settleDirectFollowup(directTurnGenerationByThread.get(task.threadId));
            directTurnGenerationByThread.delete(task.threadId);
            directTurnBots.delete(task.threadId);
          }
          stopScreenPoller(bot.id);
          lastReply.delete(bot.threadId);
          // a peer approval naming this bot can never be meaningfully answered
          // now, and its caller would otherwise wait out the 15-minute timeout
          cancelPeerApprovalsFor(bot.id);
          discardDelegations(commsBus, bot.threadId);
          computerControl.forget(bot.id);
          computerControlRevision.delete(bot.id);
          const target = perBotLocalVmTarget(bot.id);
          localVmIdles.get(target.key)?.cancel();
          localVmIdles.delete(target.key);
          // Provider and local-computer teardown above can await for an
          // arbitrary amount of time. A reviewed Chief deletion is bound to
          // the exact target profile it presented; re-check that receipt at
          // the final durable mutation boundary so a concurrent profile edit
          // cannot be erased under a stale approval.
          revalidate();
          store.deleteBot(bot.id, setupRequest);
          // Removing schedules is not a security revocation. Keep them intact
          // if the bot/receipt write fails, so a failed deletion is retryable.
          routines()!.disableForBot(bot.id);
          webhooks().disableForBot(bot.id);
          calendarCalls()!.removeBot(bot.id);
          browserLive.closeForBot(bot.id);
          await forgetTemporaryBrowser(bot.id);
        } catch (error) {
          if (browserCleanupRequest) {
            // Store removal is already durable once the in-memory owner is
            // gone. A later cleanup error must retain its browser erasure
            // intent for retry instead of aborting a completed deletion.
            if (store.bot(bot.id)) browserCleanup.abort(browserCleanupRequest);
            else browserCleanup.commit(browserCleanupRequest);
          }
          throw error;
        }
        if (browserCleanupRequest) {
          const committedCleanup = browserCleanup.commit(browserCleanupRequest);
          const acknowledged = await browserCleanup.ensure(committedCleanup);
          requireBrowserCleanupAcknowledged(acknowledged, `Browser data for ${bot.name}`);
        }
        return deletionResponse( 200, { ok: true });
      } finally {
        if (claimedLocalVmTarget) localVmLifecycleBusy.delete(claimedLocalVmTarget.key);
      }
}
  return deleteBotWithLifecycle;
}
