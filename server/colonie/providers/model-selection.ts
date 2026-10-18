// Engine/model choice: run one Chief assignment turn, default engine selection, moving bots off the removed Computer engine, and per-thread model selection, healing and skill-export collection.
import { type ExportablePackageSkill } from "../../colonie/teams/package-export.ts";
import { approvalModeFor, modelSwitchNeedsAsk } from "../../../shared/approval-mode.ts";
import { type ChiefAssignment } from "../../../shared/colonie-chief.ts";
import { isEffortLevel } from "../../../shared/wire.ts";
import { BOT_PACKAGE_MAX_SKILLS } from "../../colonie/bots/bot-package.ts";
import { newBotDefaultsSchema } from "../../colonie/bots/new-bot-defaults.ts";
import { threadModelFallback, type ThreadEngine} from "../../colonie/chat/thread-model.ts";
import { computerEngineMoveText, removedComputerInstanceIds, writeComputerEngineMoveLines } from "../../colonie/computer/computer-engine-removal.ts";
import { selectDefaultModelSelection } from "../../colonie/providers/default-model-selection.ts";
import { isSkillName } from "../../colonie/skills/skills.ts";
import { saveConfig } from "../../config.ts";
import { isModelVariant, type ModelSelection, type RuntimeEvent} from "../../contracts.ts";
import { type BotRecord } from "../../persistence/store.ts";

/** Everything this cluster reaches in the server; see the header. */
export interface ModelSelectionDeps {
  // ponytail: one permissive shape instead of hand-typed lines for each name;
  // tighten it when this cluster gets tests of its own.
  [name: string]: any;
}

export function createModelSelection(deps: ModelSelectionDeps) {
  const {
    bus, cfg, interruptDirectThread, registry, shouldIgnoreProviderEvent,
    startTurn, store, listBotSkills, providerConfigs, providerInstancesChanging, readBotSkillFile,
    threadBusy
  } = deps;
function runColonieAssignment(job: ChiefAssignment, signal: AbortSignal): Promise<string> {
  const threadId = job.targetThreadId;
  if (!threadId) return Promise.reject(new Error("The assignment has no conversation."));
  return new Promise<string>((resolve, reject) => {
    let text = "";
    let done = false;
    const finish = (settle: () => void) => {
      if (done) return;
      done = true;
      unsub();
      signal.removeEventListener("abort", onAbort);
      settle();
    };
    const unsub = bus.subscribe((event: RuntimeEvent) => {
      if (shouldIgnoreProviderEvent(event) || event.threadId !== threadId) return;
      if (event.type === "item.completed" && event.itemType === "assistant_text") text += (text ? "\n" : "") + event.text;
      else if (event.type === "turn.completed") {
        finish(() => event.ok ? resolve(text || "(the bot finished without a text reply)") : reject(new Error(event.stopReason ?? "The task failed.")));
      }
    });
    const onAbort = () => {
      finish(() => reject(Object.assign(new Error("The task was stopped."), { name: "AbortError" })));
      void interruptDirectThread(job.targetBotId, threadId);
    };
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener("abort", onAbort, { once: true });
    const chief = store().bot(job.chiefBotId);
    startTurn()(job.targetBotId, job.message, {
      threadId,
      colonieAssignment: { id: job.id, chiefBotId: job.chiefBotId, chiefName: chief?.name ?? "the Chief",
        sourceThreadId: job.sourceThreadId, ...(job.context ? { context: job.context } : {}) },
      onDispatchError: (reason: any) => finish(() => reject(new Error(reason))),
    }).catch((error: any) => finish(() => reject(error instanceof Error ? error : new Error(String(error)))));
  });
}

// New bots honor setup's saved choice; without one, an engine that can run a
// turn now (Claude first). `null` leaves the saved choice out
// (moveOffComputerEngine).
async function defaultSelection(saved: ModelSelection | null = cfg.defaultModelSelection ?? null) {
  return selectDefaultModelSelection(await registry.describe(), saved ?? undefined);
}

/** The Computer engine was removed: it ran a whole turn on Boat's own agent.
 * Everything still set to it moves, once, to the engine a new bot gets
 * (defaultSelection, the one picker), or the one a new bot would get without
 * the saved choice when that cannot run: the saved default and new-bot
 * defaults, each bot and conversation (Store.retireInstances keeps each one
 * where it worked), and an automatic-recovery backup, which could never run
 * and is cleared. Each moved conversation says so in one plain line. When no
 * engine is available yet it runs again the next time the engines are read
 * (describeInstances): an install, a sign-in, a key or a Company engine. At
 * start it sees what a new bot made then would see; a policy that arrives
 * later refuses an engine for a moved bot the way it does for any bot. */
async function moveOffComputerEngine(): Promise<void> {
  const removed = removedComputerInstanceIds(cfg.instances);
  const named = (selection?: { instanceId: string }) => Boolean(selection && removed.has(selection.instanceId));
  if (named(cfg.automaticRecovery?.backup)) {
    saveConfig({ automaticRecovery: { enabled: false } });
    cfg.automaticRecovery = { enabled: false };
  }
  const defaults = named(cfg.defaultModelSelection) || named(cfg.newBotDefaults?.profile.modelSelection);
  if (!defaults && !store().bots.some((bot: any) => named(bot.modelSelection) || bot.fallback?.some(named) ||
    store().tasks(bot.id).some((task: any) => named(task.modelSelection)))) return;
  let replacement = named(cfg.defaultModelSelection) ? { instanceId: "", model: "" } : await defaultSelection();
  if (!replacement.instanceId) replacement = await defaultSelection(null);
  if (!replacement.instanceId) {
    console.warn("[engines] the Computer engine was removed and no other engine is available yet; its bots move when one is");
    return;
  }
  if (defaults) {
    // One write keeps both saved defaults on the replacement (saveConfig
    // syncs them), and the copies in memory follow at once, so a bot made
    // before the next start never lands on the removed engine.
    const newBotDefaults = cfg.newBotDefaults && newBotDefaultsSchema.parse({
      ...cfg.newBotDefaults, profile: { ...cfg.newBotDefaults.profile, modelSelection: replacement },
    });
    saveConfig(newBotDefaults ? { newBotDefaults } : { defaultModelSelection: replacement });
    cfg.defaultModelSelection = replacement;
    if (newBotDefaults) cfg.newBotDefaults = newBotDefaults;
  }
  const instance = registry.get(replacement.instanceId);
  const engine = instance?.displayName ?? instance?.driverKind ?? replacement.instanceId;
  const moves = store().retireInstances(removed, replacement, {
    driverKind: instance?.driverKind,
  });
  writeComputerEngineMoveLines(moves, (move) => {
    const bot = store().bot(move.botId);
    if (bot) store().appendMessage(move.threadId, { role: "bot", kind: "activity", tool: { name: computerEngineMoveText(move, bot.name, engine), ok: true } });
  });
}
function checkedModelSelection(
  raw: unknown,
  current?: { selection: ModelSelection; busy: boolean },
  requireAvailableModel = false,
): { ok: true; selection: ModelSelection } | { ok: false; status: number; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, status: 400, error: "modelSelection must be an object" };
  }
  const value = raw as { instanceId?: unknown; model?: unknown; effort?: unknown; variant?: unknown };
  if (typeof value.instanceId !== "string" || !value.instanceId.trim()) {
    return { ok: false, status: 400, error: "modelSelection.instanceId is required" };
  }
  if (typeof value.model !== "string" || !value.model.trim()) {
    return { ok: false, status: 400, error: "modelSelection.model is required" };
  }
  const selection: ModelSelection = {
    instanceId: value.instanceId.trim(),
    model: value.model.trim(),
  };
  
  if (value.effort !== undefined) {
    if (!isEffortLevel(value.effort)) {
      return { ok: false, status: 400, error: `effort "${String(value.effort)}" is not recognized` };
    }
    selection.effort = value.effort;
  }
  if (value.variant !== undefined) {
    if (!isModelVariant(value.variant)) {
      return { ok: false, status: 400, error: "variant must be a non-empty model variant ID" };
    }
    if (value.effort !== undefined) {
      return { ok: false, status: 400, error: "choose either a model variant or an effort level" };
    }
    selection.variant = value.variant;
  }
  const changed = current && (
    selection.instanceId !== current.selection.instanceId ||
    selection.model !== current.selection.model ||
    selection.effort !== current.selection.effort ||
    selection.variant !== current.selection.variant
  );
  if (current?.busy && changed) {
    return { ok: false, status: 409, error: "the bot is working — stop it before changing models" };
  }
  const target = registry.get(selection.instanceId);
  if (providerInstancesChanging().has(selection.instanceId)) {
    return { ok: false, status: 409, error: "this provider account is being updated — try again shortly" };
  }
  // Model IDs remain free-form at the app's general API boundary. Custom
  // engines can accept IDs that are not in their discovery catalog, and
  // several drivers only learn the final catalog when a turn starts. The
  // MCP tool applies a stricter discovered-model policy for its own calls.
  if (requireAvailableModel) {
    if (!target) {
      return { ok: false, status: 400, error: `model instance "${selection.instanceId}" is unavailable` };
    }
    const offered =
      selection.model === target.models.default ||
      target.models.options.some((option: any) => option.id === selection.model);
    if (!offered) {
      return {
        ok: false,
        status: 400,
        error: `model "${selection.model}" is not offered by instance "${selection.instanceId}"`,
      };
    }
  }
  const allowed: readonly string[] = target?.adapter.capabilities.effortLevels ?? [];
  if (target && selection.effort !== undefined && !allowed.includes(selection.effort)) {
    return { ok: false, status: 400, error: `effort "${selection.effort}" is not offered by this bot's engine` };
  }
  if (target && selection.variant !== undefined && !target.adapter.capabilities.modelVariants) {
    return { ok: false, status: 400, error: "model variants are not offered by this bot's engine" };
  }
  return { ok: true, selection };
}

function checkedTaskModelSwitch(current: BotRecord, raw: unknown, updateBotDefault: boolean,
  resetApprovalToAsk: boolean, requireAvailableModel = false, trusted = false) {
  if (current.approvalGrant) return { ok: false as const, status: 409, error: "Wait for the approval change to finish before switching models" };
  const checked = checkedModelSelection(raw, {
    selection: current.modelSelection, busy: threadBusy(current.id, current.threadId),
  }, requireAvailableModel);
  if (!checked.ok) return checked;
  const profile = store().bot(current.id)!;
  if (updateBotDefault) {
    const defaults = checkedModelSelection(checked.selection, {
      selection: profile.modelSelection, busy: false,
    });
    if (!defaults.ok) return defaults;
  }
  for (const target of updateBotDefault ? [current, profile] : [current]) {
    const mode = approvalModeFor(target);
    if (resetApprovalToAsk && mode === "custom" && !trusted) {
      return { ok: false as const, status: 403, error: "Leaving Custom approval requires confirmation in the packaged desktop app" };
    }
    if (!resetApprovalToAsk && modelSwitchNeedsAsk(mode,
      registry.cliTarget(target.modelSelection.instanceId)?.driverKind,
      registry.cliTarget(checked.selection.instanceId)?.driverKind)) {
      return { ok: false as const, status: 400, error: "Confirm switching this model with Ask permissions first (resetApprovalToAsk)" };
    }
  }
  if (resetApprovalToAsk && threadBusy(current.id, current.threadId)) {
    return { ok: false as const, status: 409, error: "Stop work in the selected scope before switching its permissions" };
  }
  return checked;
}

/** An engine as a turn's start sees it, without waiting on its CLI: the live
 * instance and what its last read said (registry.lastSnapshot). Before the
 * first read it counts as available, so only what is known stops a pick. */
function threadEngine(instanceId: string): ThreadEngine | undefined {
  const live = registry.get(instanceId);
  if (!live) return undefined;
  return {
    instanceId, driverKind: live.driverKind, enabled: live.enabled, models: live.models,
    capabilities: { modelVariants: live.adapter.capabilities.modelVariants === true },
    snapshot: registry.lastSnapshot(instanceId) ?? { state: "available" },
    access: providerConfigs()[instanceId]?.access ?? registry.access(instanceId),
  };
}

/** This thread's own model, when it gives way to its bot's now
 * (threadModelFallback); null when the thread follows its bot or its own
 * model runs as picked. */
function threadModelGivingWay(botId: string, threadId: string): ModelSelection | null {
  const bot = store().bot(botId);
  const own = store().taskByThread(botId, threadId)?.modelSelection;
  if (!bot || !own) return null;
  return threadModelFallback(own, bot.modelSelection, threadEngine) ? own : null;
}

/** The model a turn in this thread would run on now (healThreadModel). */
function turnSelection(botId: string, threadId: string): ModelSelection | undefined {
  return threadModelGivingWay(botId, threadId) ? store().bot(botId)?.modelSelection : store().projectBotForTask(botId, threadId)?.modelSelection;
}

/** A model as a person reads it: its catalog label, after its engine's name
 * while that engine is here. */
function modelName(selection: ModelSelection): string {
  const instance = registry.get(selection.instanceId);
  const label = instance?.models.options.find((option: any) => option.id === selection.model)?.label ?? selection.model;
  return instance ? `${instance.displayName || instance.driverKind} · ${label}` : label;
}

/** A thread's own model that can't run here gives way to its bot's: the turn
 * about to start runs on the bot's model, the thread follows the bot from
 * then on, and one plain line in it says so. Every turn starts through
 * startTurn (a person's message, a routine, a delegation, a webhook, a
 * queued follow-up), so this is the one place it happens; a room turn
 * already runs on each member's own model. */
function healThreadModel(botId: string, threadId: string): void {
  const bot = store().bot(botId);
  const own = threadModelGivingWay(botId, threadId);
  if (!bot || !own || bot.approvalGrant || threadBusy(botId, threadId)) return;
  if (!store().followBotModel(botId, [threadId]).length) return;
  store().appendMessage(threadId, { role: "bot", kind: "activity", tool: {
    name: `notice: This thread's model (${modelName(own)}) isn't available, so it now uses ${bot.name}'s model (${modelName(bot.modelSelection)}).`,
    ok: true,
  } });
}

function checkedExportSkillNames(
  value: unknown,
  bots: readonly BotRecord[],
): { ok: true; names: string[] } | { ok: false; error: string } {
  // Sharing instructions is explicit: ordinary package exports include none.
  if (value === undefined) return { ok: true, names: [] };
  if (!Array.isArray(value) || value.some((name) => typeof name !== "string" || !isSkillName(name))) {
    return { ok: false, error: "skillIds must be a list of exact imported skill names" };
  }
  const names = [...value] as string[];
  if (new Set(names).size !== names.length) return { ok: false, error: "skillIds must not contain duplicates" };
  if (names.length > BOT_PACKAGE_MAX_SKILLS) return { ok: false, error: `skillIds must contain at most ${BOT_PACKAGE_MAX_SKILLS} names` };
  const available = new Set(bots.flatMap((bot) => listBotSkills(bot).map((skill: any) => skill.name)));
  const unknown = names.find((name) => !available.has(name));
  if (unknown) return { ok: false, error: `skillIds contains unknown imported skill "${unknown}"` };
  return { ok: true, names };
}

function collectExportSkills(
  bots: readonly BotRecord[],
  names: readonly string[],
): ReadonlyMap<string, readonly ExportablePackageSkill[]> {
  const selected = new Set(names);
  const byBot = new Map<string, ExportablePackageSkill[]>();
  if (!selected.size) return byBot;
  for (const bot of bots) {
    const assigned: ExportablePackageSkill[] = [];
    for (const listing of listBotSkills(bot)) {
      if (!selected.has(listing.name)) continue;
      const instructions = readBotSkillFile(bot, listing.name);
      if (instructions === null) {
        throw new Error(`Skill "${listing.name}" changed or is unavailable and cannot be exported safely`);
      }
      const skill: ExportablePackageSkill = {
        name: listing.name,
        description: listing.description,
        ...(listing.source ? { source: listing.source } : {}),
        ...(listing.license ? { license: listing.license } : {}),
        ...(listing.compatibility ? { compatibility: listing.compatibility } : {}),
        instructions,
      };
      // The shared exporter validates duplicate bytes and metadata together.
      assigned.push(skill);
    }
    if (assigned.length) byBot.set(bot.id, assigned);
  }
  return byBot;
}

  return {
    runColonieAssignment,
    defaultSelection,
    moveOffComputerEngine,
    checkedModelSelection,
    checkedTaskModelSwitch,
    threadEngine,
    threadModelGivingWay,
    turnSelection,
    modelName,
    healThreadModel,
    checkedExportSkillNames,
    collectExportSkills,
  };
}
