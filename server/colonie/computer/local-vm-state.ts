// Local-VM/computer state: bot computer-control keys, preview surface resolution, continue-selection, the running-turn engine map, local-VM target/lease/idle helpers, thread release, and the startup + inventory inspection.
import { type TurnOwner } from "../../colonie/chat/turn-resources.ts";
import { type LocalVmSeatHolder } from "../../colonie/computer/local-vm-seat-pool.ts";
import { hasQueuedSteeredMessages } from "../../colonie/chat/steer-queue.ts";
import { SHARED_LOCAL_VM_TARGET, autoLocalVmAttachable, containerComputerAction, containerComputerStatus, containerRuntimeStatus, localVmWorkspaceExists, perBotLocalVmTarget, poolLocalVmTarget, type LocalVmTarget} from "../../colonie/computer/container-computer.ts";
import { LocalVmIdleTimer } from "../../colonie/computer/local-vm-idle.ts";
import { discoverExistingPerBotLocalVms, discoverExistingPoolLocalVms, localVmInventoryEntry, shouldArmLocalVmIdle } from "../../colonie/computer/local-vm-inventory.ts";
import { LocalVmLease } from "../../colonie/computer/local-vm-lease.ts";
import { recordLocalVmIdleStop } from "../../colonie/computer/local-vm-stop-reason.ts";
import { teamComputerOwner, type TeamComputerRecord} from "../../colonie/teams/team-computers.ts";
import { builtInBrowserEnabled, localVmMaxInstances, localVmMode } from "../../config.ts";
import { gatedLocalComputer, readCuaConnection, readCuaUnavailableReason } from "../../local-computer.ts";
import { shouldMountLocalComputer } from "../../local-routing.ts";
import { sectionKey, type BotRecord} from "../../persistence/store.ts";
import { resolveSurface, surfaceLabel } from "../../surface.ts";

/** Everything this cluster reaches in the server; see the header. */
export interface LocalVmStateDeps {
  // ponytail: one permissive shape instead of hand-typed lines for each name;
  // tighten it when this cluster gets tests of its own.
  [name: string]: any;
}

export function createLocalVmState(deps: LocalVmStateDeps) {
  const {
    autoVmClaims, bindTurnComputer, cfg, computerControl, computerSelectionTurns,
    controlIntegration, directTurnBots, directTurnGenerationByThread, drainQueuedSends,
    hasDirectDispatch, localVmActiveThreads, localVmFlags, localVmIdleMs, localVmIdles,
    localVmLeases, localVmLifecycleBusy, localVmOwnerBusy, localVmSeatPool, localVmSeen,
    localVmThreadTargets, noteLocalVmSeen, registry, routines, 
    startTurn, store, teamComputers, threadBusy
  } = deps;

function botComputerControlKey(bot: BotRecord): string {
  return bot.id;
}

function botComputerControlSnapshot(botId: string) {
  return computerControl.snapshot(botId);
}

function teamComputerInUse(computer: TeamComputerRecord): boolean {
  computer = teamComputers.get(computer.id) ?? computer;
  return computerControl.snapshot(teamComputerOwner(computer.id)).held ||
    store.bots.some((bot: any) => computer.section !== null && sectionKey(bot.section) === computer.section && (
      botHasActiveTurn(bot.id) || Boolean(routines()?.activeRunForBot(bot.id)) || computerControl.snapshot(bot.id).held
    ));
}

/** "Works on: This computer", strict. One mount for a bot thread and a group
 * chat, so the two cannot drift on what they check or how they fail. */
async function mountHostComputer(owner: TurnOwner, botId: string, providerSupportsLocal: boolean) {
  if (!shouldMountLocalComputer({ requested: "local", hostPlatform: process.platform, providerSupportsLocal })) {
    // Name the condition that actually failed: a person told "choose an
    // ACP engine" while already on one has nowhere to go.
    throw new Error(providerSupportsLocal
      ? `local computer control is not available on ${process.platform} — select another destination`
      : "this model cannot control this computer — choose Claude or an ACP model provider, or select another destination");
  }
  const cua = readCuaConnection();
  if (!cua) {
    const reason = readCuaUnavailableReason();
    throw new Error(reason
      ? `CUA Driver is not ready for this computer — ${reason}${process.platform === "darwin" && /(?:Screen Recording|Accessibility).*required/i.test(reason) ? ". Relaunch Colonie after granting the missing macOS permission." : ""}`
      : "CUA Driver is not ready for this computer — check permissions and restart Colonie");
  }
  await bindTurnComputer(owner, "computer:host");
  return gatedLocalComputer(cua, controlIntegration(botId, owner.threadId, owner.generation, "this computer"));
}

function botHasActiveTurn(botId: string): boolean {
  const bot = store.bot(botId);
  return bot?.busy === true ||
    hasDirectDispatch(botId);
}

function turnSurfacePlan(bot: BotRecord, threadId?: string) {
  const instance = registry.get(bot.modelSelection.instanceId);
  return resolveSurface({
    destination: bot.computer,
    pinnedSurface: !threadId ? null : store.taskByThread(bot.id, threadId)?.surface,
    browserOn: builtInBrowserEnabled(cfg) && bot.browser !== false && instance?.adapter.capabilities.browserMcp === true,
  });
}

/** Preview requests carry the selected conversation, not whichever thread
 * happens to be the bot's default. A query never grants lifecycle authority. */
function computerPreviewBot(botId: string, url: URL): BotRecord | null {
  const threadId = url.searchParams.get("threadId");
  if (!threadId) return store.bot(botId);
  const bot = store.projectBotForTask(botId, threadId);
  if (!bot) throw Object.assign(new Error("no such task"), { status: 404 });
  return directTurnBots.get(threadId) ?? bot;
}

async function computerPreviewSurface(bot: BotRecord, threadId?: string) {
  const plan = turnSurfacePlan(bot, threadId);
  const instance = registry.get(bot.modelSelection.instanceId);
  // An engine that cannot control this Mac (Claude and Codex) works on a bot
  // once set to "This Mac" as on Auto, as its turns do (turn-start.ts).
  const hostless = plan.computer === "local" && instance?.adapter.capabilities.localComputerMcp !== true;
  if (plan.computer !== undefined && !hostless) return plan.computer === "off" && plan.browser ? "browser" : plan.computer;
  const target = localVmTargetForStatus(bot.id, threadId);
  if (instance?.adapter.capabilities.computerMcp && localVmSeen.has(target.key)) {
    const vm = await containerComputerStatus(undefined, undefined, target).catch(() => null);
    if (vm && autoLocalVmAttachable(vm)) return "vm";
  }
  if (shouldMountLocalComputer({ requested: undefined, hostPlatform: process.platform,
    providerSupportsLocal: instance?.adapter.capabilities.localComputerMcp === true }) && readCuaConnection()) return "local";
  return plan.browser ? "browser" : "off";
}

function continueComputerSelection(threadId: string, generation: string | undefined, succeeded: boolean): boolean {
  const selection = computerSelectionTurns.get(threadId);
  if (!selection || selection.generation !== generation) return false;
  if (!succeeded || !selection.selected || hasQueuedSteeredMessages(selection.botId, threadId)) {
    computerSelectionTurns.delete(threadId);
    return false; // Let ordinary settlement drain the person's newer request.
  }
  const surface = selection.selected;
  setImmediate(() => {
    // Stop, deletion, a new user send, or any replacement generation wins.
    if (computerSelectionTurns.get(threadId) !== selection || directTurnGenerationByThread.get(threadId) !== generation) return;
    computerSelectionTurns.delete(threadId);
    const bot = store.projectBotForTask(selection.botId, threadId);
    if (!bot || bot.computer === "off" || threadBusy(bot.id, threadId)) return;
    if (store.taskByThread(bot.id, threadId)?.surface !== selection.previousSurface) return;
    if (hasQueuedSteeredMessages(bot.id, threadId)) { drainQueuedSends()(); return; }
    if (store.activePath(threadId).findLast((message: any) => message.role === "user" && message.kind === "text")?.id !== selection.source.id) return;
    // The model picked this surface through select_computer; the person
    // never chose it in the composer or thread settings. It is the
    // machine's record, so a later Works on change may sweep it.
    store.patchTask(bot.id, threadId, { surface, surfaceSource: "auto" });
    const text = `The computer selection is now ${surfaceLabel(surface)}. Continue the user's original request using the tools mounted for this turn; verify the result before claiming success.\n\n${selection.text}`;
    void startTurn()(bot.id, text, { threadId, userMessage: selection.source, computerSelectionContinuation: true }).catch((error: any) => {
      if (store.taskByThread(bot.id, threadId)) store.appendMessage(threadId, { role: "bot", kind: "activity",
        tool: { name: `Could not continue on ${surfaceLabel(surface)}: ${error instanceof Error ? error.message : String(error)}`, ok: false } });
    });
  });
  return true;
}

/** The engine that dispatched each live turn. A bot's settings may change
 * mid-turn; an interrupt or steer must reach the engine actually running. */
const runningTurnEngines = new Map<string, NonNullable<ReturnType<typeof registry.get>>>();
function runningTurnInstance(bot: BotRecord | null | undefined, threadId: string): ReturnType<typeof registry.get> {
  // A turn always runs on the bot's own engine, wherever it works.
  return runningTurnEngines.get(threadId) ?? (bot ? registry.get(bot.modelSelection.instanceId) : null);
}

function localVmTargetForBot(botId: string): LocalVmTarget {
  return localVmMode(cfg) === "per-bot" ? perBotLocalVmTarget(botId) : SHARED_LOCAL_VM_TARGET;
}

function localVmPoolSeatHolder(seat: number): LocalVmSeatHolder | null {
  return localVmLeases.forTarget(poolLocalVmTarget(seat).key).current(localVmOwnerBusy);
}

/** The Local VM a conversation's turn addresses. In pool mode each thread
 * draws a seat with TTL-bounded affinity so it reuses the desktop that
 * holds its login state; other modes are unchanged. */
function localVmTargetForThread(botId: string, threadId: string): LocalVmTarget {
  if (localVmMode(cfg) !== "pool") return localVmTargetForBot(botId);
  return poolLocalVmTarget(localVmSeatPool.assign(threadId, localVmPoolSeatHolder));
}

/** Best-effort seat for read-only surfaces (Computer panel previews,
 * screenshots, status payloads). Records no affinity: a status probe must
 * not steer a later turn onto a desktop its claim would not choose. */
function localVmTargetForStatus(botId: string, threadId?: string): LocalVmTarget {
  if (localVmMode(cfg) !== "pool") return localVmTargetForBot(botId);
  // An in-flight turn keeps its claimed seat even after its affinity TTL
  // decays: prefer the live target so a preview cannot land on another seat.
  const activeTarget = threadId ? localVmThreadTargets.get(threadId) : undefined;
  if (activeTarget) return activeTarget;
  return poolLocalVmTarget((threadId ? localVmSeatPool.affinitySeat(threadId) : null) ?? 0);
}

function localVmLeaseFor(target: LocalVmTarget): LocalVmLease {
  return localVmLeases.forTarget(target.key);
}

function localVmIdleFor(target: LocalVmTarget): LocalVmIdleTimer {
  let idle = localVmIdles.get(target.key);
  if (idle) return idle;
  idle = new LocalVmIdleTimer(
    localVmIdleMs(),
    () => localVmFlags.imageBusy || localVmLifecycleBusy.has(target.key) || localVmActiveThreads.has(target.key),
    async () => {
      localVmLifecycleBusy.add(target.key);
      try {
        const status = await containerComputerStatus(undefined, undefined, target);
        // The pinned VNC startup clears stale X locks. Keep the container's
        // home and installed software so inactivity is a reversible stop.
        if (status.container === "running" && status.managed) {
          const stopped = await containerComputerAction("stop", undefined, undefined, target);
          recordLocalVmIdleStop(target.key, stopped.stopped_at);
        }
      } finally {
        localVmLifecycleBusy.delete(target.key);
      }
    },
  );
  localVmIdles.set(target.key, idle);
  return idle;
}

function releaseLocalVmThread(threadId: string): void {
  // Covers lazy claims too (issue #1361): every settle path funnels through
  // here or through releaseTurnResources, so a turn that ends before its
  // first screen call leaves no claim slot behind.
  autoVmClaims.delete(threadId);
  const target = localVmThreadTargets.get(threadId);
  if (!target) return;
  // Renew affinity at settlement so a turn that consumed part of the TTL
  // still leaves the full window after it ends; failed claims never reach
  // here (no target), so only settled turns renew. A turn longer than the
  // TTL finds its entry expired — touch() alone would drop it — so renew
  // with the seat the turn actually ran on. A target recorded before a
  // mid-turn mode change is not a pool seat; touch still covers that.
  if (localVmMode(cfg) === "pool") {
    const pooled = /^pool:(\d+)$/.exec(target.key);
    if (pooled) localVmSeatPool.renew(threadId, Number(pooled[1]));
    else localVmSeatPool.touch(threadId);
  }
  localVmLeaseFor(target).release(threadId);
  if (localVmActiveThreads.get(target.key) === threadId) localVmActiveThreads.delete(target.key);
  localVmThreadTargets.delete(threadId);
}

// A running VM may have survived an app/server restart. Start its idle
// backstop even if nobody opens Settings or begins a turn this session. The
// bot's current destination is intentionally ignored: moving a bot to Cloud,
// Browser, This computer, Auto, or Off does not delete its old Local VM.
void (async () => {
  if (localVmMode(cfg) === "pool") {
    // Same restore rule as per-bot: idle shutdown preserves the container and
    // its provisioned workspace, so every surviving seat stays Auto-eligible.
    const seats = localVmMaxInstances(cfg);
    for (let seat = 0; seat < seats; seat += 1) {
      const target = poolLocalVmTarget(seat);
      if (localVmWorkspaceExists(target)) localVmSeen.add(target.key);
    }
    const runtime = await containerRuntimeStatus().catch(() => null);
    if (!runtime?.runtime || !runtime.daemonUp) return;
    const existing = await discoverExistingPoolLocalVms(seats, runtime.runtime).catch(() => []);
    const statuses = await Promise.all(existing.map((target) =>
      containerComputerStatus(undefined, undefined, target).catch(() => null),
    ));
    existing.forEach((target, index) => {
      noteLocalVmSeen(target, statuses[index]);
      if (shouldArmLocalVmIdle(statuses[index])) localVmIdleFor(target).touch();
    });
    return;
  }
  if (localVmMode(cfg) !== "per-bot") {
    const status = await containerComputerStatus(undefined, undefined, SHARED_LOCAL_VM_TARGET).catch(() => null);
    noteLocalVmSeen(SHARED_LOCAL_VM_TARGET, status);
    if (shouldArmLocalVmIdle(status)) localVmIdleFor(SHARED_LOCAL_VM_TARGET).touch();
    return;
  }
  // Idle cleanup removes the container, not its provisioned workspace. Restore
  // Auto eligibility before runtime discovery, including when it is offline.
  for (const bot of store.bots) {
    const target = perBotLocalVmTarget(bot.id);
    if (localVmWorkspaceExists(target)) localVmSeen.add(target.key);
  }
  const runtime = await containerRuntimeStatus().catch(() => null);
  if (!runtime?.runtime || !runtime.daemonUp) return;
  const existing = await discoverExistingPerBotLocalVms(store.bots, runtime.runtime).catch(() => []);
  const statuses = await Promise.all(existing.map(({ target }) =>
    containerComputerStatus(undefined, undefined, target).catch(() => null),
  ));
  existing.forEach(({ target }, index) => {
    noteLocalVmSeen(target, statuses[index]);
    if (shouldArmLocalVmIdle(statuses[index])) localVmIdleFor(target).touch();
  });
})().catch(() => {
  // Startup inspection is a backstop, not a reason to keep the app offline.
  // The Settings inventory remains available for a later explicit retry.
});

async function localVmInventoryPayload() {
  const runtime = await containerRuntimeStatus();
  if (!runtime.runtime || !runtime.daemonUp) {
    return {
      instances: [],
      maxInstances: localVmMaxInstances(cfg),
      available: false,
      problem: runtime.runtime ? `Start ${runtime.runtime} first` : "Install a supported container runtime first",
    };
  }
  const existing = await discoverExistingPerBotLocalVms(store.bots, runtime.runtime);
  const statuses = await Promise.all(existing.map(({ target }) =>
    containerComputerStatus(undefined, undefined, target),
  ));
  const instances = existing.flatMap(({ bot, target }, index) => {
    const status = statuses[index];
    if (!status) return [];
    noteLocalVmSeen(target, status);
    const inUse = localVmActiveThreads.has(target.key) ||
      localVmLeaseFor(target).current(localVmOwnerBusy) !== null;
    const entry = localVmInventoryEntry(bot, status, inUse);
    return entry ? [entry] : [];
  });
  return { instances, maxInstances: localVmMaxInstances(cfg), available: true, problem: null };
}


  return {
    botComputerControlKey,
    botComputerControlSnapshot,
    teamComputerInUse,
    mountHostComputer,
    botHasActiveTurn,
    turnSurfacePlan,
    computerPreviewBot,
    computerPreviewSurface,
    continueComputerSelection,
    runningTurnEngines,
    runningTurnInstance,
    localVmTargetForBot,
    localVmPoolSeatHolder,
    localVmTargetForThread,
    localVmTargetForStatus,
    localVmLeaseFor,
    localVmIdleFor,
    releaseLocalVmThread,
    localVmInventoryPayload,
  };
}
