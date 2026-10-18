// One thread of a bot: rename it, switch its model, set how it approves, pin it
// to a surface, or delete it. Deleting a thread also forgets what only that
// thread knew — its handoff, its digest state, its staged skill cleanups.
import { approvalModeFor } from "../../shared/approval-mode.ts";
import type { ModelSelection, WireBot, WireTask } from "../../shared/wire.ts";
import type { RoutineManager } from "../colonie/routines/routines.ts";
import type { BotRecord, Store, TaskRecord } from "../persistence/store.ts";
import { parseSurface } from "../surface.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface BotTaskRouteDeps {
  store: Store;
  desktopManaged: boolean;
  handoffs: { forget: (threadId: string) => void };
  directTurnGenerationByThread: Map<string, string>;
  routines: () => RoutineManager | null;
  wireBot: (bot: BotRecord) => WireBot;
  wireTask: (task: TaskRecord, botModel: ModelSelection) => WireTask;
  publicBot: (bot: BotRecord) => Record<string, unknown>;
  messagePage: (threadId: string, limit: number | undefined) => Record<string, unknown>;
  pageSize: (raw: string | null) => number | null | undefined;
  threadBusy: (botId: string, threadId: string) => boolean;
  checkedModelSelection: (
    raw: unknown,
    current?: { selection: ModelSelection; busy: boolean },
    requireAvailableModel?: boolean,
  ) => { ok: true; selection: ModelSelection } | { ok: false; status: number; error: string };
  checkedTaskModelSwitch: (
    current: BotRecord,
    raw: unknown,
    updateBotDefault: boolean,
    resetApprovalToAsk: boolean,
    requireAvailableModel?: boolean,
    trusted?: boolean,
  ) => { ok: true; selection: ModelSelection } | { ok: false; status: number; error: string };
  supportsApprovalMode: (selection: ModelSelection | undefined, mode: "ask" | "auto" | "edits") => boolean;
  clearTurnDigestState: (threadId: string) => void;
  settleDirectFollowup: (generation: string | undefined) => void;
  cancelTeamSetupResumesForThread: (threadId: string) => void;
  revokeInternalCapabilitiesForThread: (threadId: string) => void;
  stagedSkillCleanupsForThread: (threadId: string) => Array<{ botId: string; stagedId: string }>;
  rejectDeletedThreadSkillStages: (cleanups: Array<{ botId: string; stagedId: string }>) => void;
}

export function createBotTaskRoutes(deps: BotTaskRouteDeps): RouteHandler {
  return async ({ req, res, path, method, url, auth, json, readBody }) => {
    const {
      store, handoffs, directTurnGenerationByThread, routines, wireBot, wireTask,
      publicBot, messagePage, pageSize, threadBusy, checkedModelSelection, checkedTaskModelSwitch,
      supportsApprovalMode, clearTurnDigestState, settleDirectFollowup, cancelTeamSetupResumesForThread,
      revokeInternalCapabilitiesForThread, stagedSkillCleanupsForThread, rejectDeletedThreadSkillStages,
    } = deps;
    const DESKTOP_MANAGED = deps.desktopManaged;
    let m: RegExpMatchArray | null = null;
    m = path.match(/^\/api\/bots\/([\w-]+)\/tasks\/([\w-]+)$/);
    if (m && method === "POST") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      // Navigation only: execution owns its thread, never this selected id.
      const requestedMessages = url.searchParams.get("messages");
      const switchLimit = pageSize(requestedMessages);
      if (switchLimit === null) return json(res, 400, { error: "messages must be a non-negative whole number" });
      const switched = store.switchTask(bot.id, m[2]);
      if (!switched) return json(res, 404, { error: "no such task" });
      const switchedSettings = { ...wireBot(switched), tasks: store.tasks(switched.id).map((task) => wireTask(task, switched.modelSelection)) };
      // "0" is settings only, a positive page is a bounded transcript, and no
      // parameter is the whole thread — the one branch that materialises it.
      // Search results land through that branch (src/lib/focus-message.ts):
      // the hit can be older than one page.
      const responseBot = requestedMessages === "0"
        ? switchedSettings
        : { ...switchedSettings, ...messagePage(switched.threadId, switchLimit) };
      return json(res, 200, { bot: responseBot });
    }
    if (m && method === "PATCH") {
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: "body must be a JSON object" });
      const current = store.projectBotForTask(m[1], m[2]);
      if (!current) return json(res, 404, { error: "no such task" });
      const allowed = new Set(["title", "projectId", "modelSelection", "updateBotDefault", "resetApprovalToAsk", "approvalMode", "autoApprove", "requireAvailableModel", "pinnedMessageId", "acknowledgeLocalAuto", "archivedAt", "pinned", "snoozedUntil", "surface", "refreshPermissions"]);
      if (Object.keys(body).some((key) => !allowed.has(key))) return json(res, 400, { error: "unsupported thread setting" });
      for (const key of ["requireAvailableModel", "acknowledgeLocalAuto", "updateBotDefault", "resetApprovalToAsk"] as const) {
        if (body[key] !== undefined && typeof body[key] !== "boolean") return json(res, 400, { error: `${key} must be a boolean` });
      }
      if (body.requireAvailableModel === true && body.modelSelection === undefined) return json(res, 400, { error: "requireAvailableModel requires modelSelection" });
      if (body.updateBotDefault === true && body.modelSelection === undefined) return json(res, 400, { error: "updateBotDefault requires modelSelection" });
      if (body.resetApprovalToAsk === true && (body.modelSelection === undefined ||
        (body.approvalMode !== undefined && body.approvalMode !== "ask") || body.autoApprove === true)) {
        return json(res, 400, { error: "resetApprovalToAsk requires a model selection and cannot be combined with another approval mode" });
      }
      if (body.refreshPermissions !== undefined && body.refreshPermissions !== true) {
        return json(res, 400, { error: "refreshPermissions must be true" });
      }
      if (body.refreshPermissions === true) {
        const extra = Object.keys(body).filter((key) => key !== "refreshPermissions" && key !== "acknowledgeLocalAuto");
        if (extra.length) return json(res, 400, { error: "refreshPermissions cannot be combined with other thread settings" });
        const profile = store.bot(m[1]);
        if (!profile) return json(res, 404, { error: "no such bot" });
        if (profile.approvalGrant) return json(res, 409, { error: "the bot's approval mode is still being confirmed" });
        if (threadBusy(profile.id, m[2])) return json(res, 409, { error: "stop this thread before changing its approval mode" });
        const nextMode = approvalModeFor({ ...profile, approvalGrant: undefined });
        // Full and Custom never travel over the bot-reachable HTTP surface.
        // The desktop's private channel copies those levels, and it is also
        // the only way to leave Custom.
        if (nextMode === "full" || nextMode === "custom") {
          return json(res, 403, { error: "Refresh Full or Custom access from the packaged desktop app" });
        }
        if (approvalModeFor(current) === "custom") {
          return json(res, 403, { error: "Leaving Custom approval requires the packaged desktop app" });
        }
        if (!supportsApprovalMode(current.modelSelection, nextMode)) {
          return json(res, 400, { error: "This provider does not support the selected approval level" });
        }
        if (nextMode === "auto" && current.computer === "local" && approvalModeFor(current) !== "auto" && body.acknowledgeLocalAuto !== true) {
          return json(res, 400, { error: "Auto mode on this computer requires confirming the warning first (acknowledgeLocalAuto)" });
        }
        const approvalRank = { ask: 0, edits: 1, auto: 2, full: 3, custom: 4 } as const;
        const widensMode = approvalRank[nextMode] > approvalRank[approvalModeFor(current)];
        const nextAllow = profile.alwaysAllow ?? [];
        const widensAllow = nextAllow.some((key) => !(current.alwaysAllow ?? []).includes(key));
        if ((widensMode || widensAllow) && auth.kind === "loopback" && !DESKTOP_MANAGED && !req.headers.origin && store.bots.some((bot) => bot.busy)) {
          return json(res, 409, { error: "Change approval mode from the app or a paired device while bots are working." });
        }
        const task = store.refreshTaskPermissions(profile.id, m[2]);
        if (!task) return json(res, 404, { error: "no such task" });
        return json(res, 200, { task: wireTask(task, store.bot(profile.id)!.modelSelection), bot: publicBot(store.bot(profile.id)!) });
      }
      const patch: Parameters<typeof store.patchTask>[2] = {};
      if (body.projectId !== undefined) {
        if (body.projectId === null) patch.projectId = undefined;
        else if (typeof body.projectId === "string" && store.project(current.id, body.projectId)) patch.projectId = body.projectId;
        else return json(res, 400, { error: "projectId must belong to this bot, or null to ungroup the thread" });
      }
      if (body.title !== undefined) {
        if (typeof body.title !== "string") return json(res, 400, { error: "title must be a string" });
        patch.title = body.title;
      }
      if (body.archivedAt !== undefined) {
        if (body.archivedAt === null) patch.archivedAt = undefined;
        else if (typeof body.archivedAt === "number" && Number.isFinite(body.archivedAt) && body.archivedAt >= 0) patch.archivedAt = body.archivedAt;
        else return json(res, 400, { error: "archivedAt must be a timestamp, or null to unarchive" });
      }
      if (body.pinned !== undefined) {
        if (typeof body.pinned !== "boolean") return json(res, 400, { error: "pinned must be a boolean" });
        patch.pinned = body.pinned ? true : undefined;
      }
      if (body.snoozedUntil !== undefined) {
        if (body.snoozedUntil === null) patch.snoozedUntil = undefined;
        else if (typeof body.snoozedUntil === "number" && Number.isFinite(body.snoozedUntil) && body.snoozedUntil >= 0) patch.snoozedUntil = body.snoozedUntil;
        else return json(res, 400, { error: "snoozedUntil must be a timestamp, 0 to snooze until activity, or null to wake now" });
      }
      if (body.surface !== undefined) {
        if (threadBusy(current.id, current.threadId)) return json(res, 409, { error: "Stop this thread before changing its computer destination." });
        // Where this conversation works, chosen by the person and recorded as
        // theirs, so a later Works on change never sweeps it. Null follows the
        // bot's Works on again. Reachability is the turn's to judge.
        if (body.surface === null) {
          patch.surface = undefined;
          patch.surfaceSource = undefined;
        } else if (parseSurface(body.surface)) {
          patch.surface = parseSurface(body.surface);
          patch.surfaceSource = "user";
        } else return json(res, 400, { error: "surface must be vm, local, browser, or null to follow the bot" });
      }
      if (body.pinnedMessageId !== undefined) {
        if (body.pinnedMessageId === null || body.pinnedMessageId === "") patch.pinnedMessageId = undefined;
        else if (typeof body.pinnedMessageId === "string" && store.messagesFor(current.threadId).some((message) => message.id === body.pinnedMessageId)) patch.pinnedMessageId = body.pinnedMessageId;
        else return json(res, 400, { error: "pinnedMessageId must belong to this thread" });
      }
      if (body.modelSelection !== undefined) {
        if (current.approvalGrant) return json(res, 409, { error: "the bot's approval mode is still being confirmed" });
        const checked = checkedModelSelection(body.modelSelection, { selection: current.modelSelection, busy: threadBusy(current.id, current.threadId) }, body.requireAvailableModel === true);
        if (!checked.ok) return json(res, checked.status, { error: checked.error });
        patch.modelSelection = checked.selection;
      }
      if (body.approvalMode !== undefined || body.autoApprove !== undefined) {
        if (body.autoApprove !== undefined && typeof body.autoApprove !== "boolean") return json(res, 400, { error: "autoApprove must be a boolean" });
        const mode = body.approvalMode ?? (body.autoApprove ? "auto" : "ask");
        // Elevated modes still require the trusted desktop transition. A
        // thread settings PATCH cannot manufacture that grant.
        if (mode !== "ask" && mode !== "auto" && mode !== "edits") return json(res, 403, { error: "Full and Custom access require trusted desktop confirmation" });
        if (approvalModeFor(current) === "custom") return json(res, 403, { error: "Leaving Custom approval requires confirmation in the packaged desktop app" });
        if (!supportsApprovalMode(patch.modelSelection ?? current.modelSelection, mode)) {
          return json(res, 400, { error: "This provider does not support the selected approval level" });
        }
        if (threadBusy(current.id, current.threadId)) return json(res, 409, { error: "stop this thread before changing its approval mode" });
        if (current.approvalGrant) return json(res, 409, { error: "the bot's approval mode is still being confirmed" });
        if (mode === "auto" && approvalModeFor(current) !== "auto" && auth.kind === "loopback" && !DESKTOP_MANAGED && !req.headers.origin && store.bots.some((bot) => bot.busy)) {
          return json(res, 409, { error: "Change approval mode from the app or a paired device while bots are working." });
        }
        if (mode === "auto" && current.computer === "local" && approvalModeFor(current) !== "auto" && body.acknowledgeLocalAuto !== true) {
          return json(res, 400, { error: "Auto mode on this computer requires confirming the warning first (acknowledgeLocalAuto)" });
        }
        patch.approvalMode = mode;
        patch.autoApprove = mode === "auto";
      }
      if (patch.modelSelection) {
        const checked = checkedTaskModelSwitch({ ...current,
          ...(patch.approvalMode ? { approvalMode: patch.approvalMode, autoApprove: patch.autoApprove } : {}),
        }, patch.modelSelection, body.updateBotDefault === true, body.resetApprovalToAsk === true, body.requireAvailableModel === true);
        if (!checked.ok) return json(res, checked.status, { error: checked.error });
      }
      const task = patch.modelSelection
        ? store.switchTaskModel(m[1], m[2], patch.modelSelection, body.updateBotDefault === true, body.resetApprovalToAsk === true,
          patch)!
        : store.patchTask(m[1], m[2], patch)!;
      return json(res, 200, { task: wireTask(task, store.bot(m[1])!.modelSelection), bot: publicBot(store.bot(m[1])!) });
    }
    if (m && method === "DELETE") {
      const bot = store.bot(m[1]);
      if (!bot || !store.taskByThread(bot.id, m[2])) {
        return json(res, 404, { error: "no such task" });
      }
      if (threadBusy(bot.id, m[2]) || routines()!.isActiveThread(m[2])) {
        return json(res, 409, { error: "this task is running — stop it first" });
      }
      const stagedSkillCleanups = stagedSkillCleanupsForThread(m[2]);
      cancelTeamSetupResumesForThread(m[2]);
      const updated = store.deleteTask(m[1], m[2]);
      if (!updated) return json(res, 404, { error: "no such task" });
      clearTurnDigestState(m[2]);
      revokeInternalCapabilitiesForThread(m[2]);
      handoffs.forget(m[2]);
      settleDirectFollowup(directTurnGenerationByThread.get(m[2]));
      rejectDeletedThreadSkillStages(stagedSkillCleanups);
      return json(res, 200, { bot: publicBot(updated) });
    }
    return PASS;
  };
}
