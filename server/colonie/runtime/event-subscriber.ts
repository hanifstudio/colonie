// The runtime event bus: one subscriber that folds provider events into stored messages, live turn state, Local VM leases and delegation watches. Moved out of index.ts at S3.44; the wiring at the bottom of index.ts passes the server state it reaches.
import type { RuntimeEvent } from "../../contracts.ts";
import type { Message } from "../../persistence/store.ts";
import { isPersistentQuestionCard, shouldSettleRequestCard } from "../../../shared/ask-question.ts";
import { failedTurnTool } from "../../../shared/failed-turn.ts";
import { approvalHeldNote, approvalHeldReason, autoVerdict, deliverFullAccessApproval } from "../../auto-approve.ts";
import { deleteAttachment, saveImage } from "../../colonie/chat/attachments.ts";
import { screenSurfaceForTool, screenTouchingTool } from "../../colonie/computer/screen-frame-gate.ts";
import { modelContextWindow } from "../../colonie/providers/model-context-window.ts";
import { commandAllowlistCandidate } from "../../command-allowlist.ts";
import { DATA_DIR } from "../../config.ts";
import { appendDecision } from "../../decision-log.ts";
import { RETRY_MAX_ATTEMPTS } from "../../drivers/retry.ts";
import { decodeGeneratedImage } from "../../generated-image.ts";
import { buildNotification } from "../../notify.ts";
import { redactSecretsInText } from "../../redact.ts";
import { narrateTool } from "../../tts/speech-text.ts";

/** Everything this block reaches in the server; see the header. */
export interface RuntimeEventSubscriberDeps {
  // ponytail: one permissive shape instead of hand-typed lines for each name;
  // tighten it when this block gets tests of its own.
  finalizeDelegationWatch: () => any;
  [name: string]: any;
}

export function createRuntimeEventSubscriber(deps: RuntimeEventSubscriberDeps) {
  const {
    finalizeDelegationWatch,
    SCREEN_SETTLE_TIMEOUT_MS, approvalModeForTurn, askMessageByRequest, bookTurnUsage,
    botForThread, broadcast, clearInternalTurn, commandAllowlist, directRequestOwners, directTurnBots, directTurnDispatchClaims,
    directTurnGenerationByThread, drainComputerResumes, drainConnectorResumes,
    drainDelegationWakes, drainQueuedSends, drainSecretResumes, drainTeamSetupResumes,
    finalScreenFrame, handoffs, isInternalTurn, isUnattended, lastReply, liveTurnByThread, nativeReviewNoticed, notify,
    pendingCommandRules, pokeScreenPoller, providerLabel, registry,
    releaseTurnResources, reportIncident, retryDelegationsWaitingOn, routineSourceOwner,
    routineSourceThread, routines, scheduleTurnDigest, screenPollers, sessionModelByThread,
    settleTrackedRequest, settleWaitingOnPersonChips, settlingResourceOwners,
    shouldIgnoreProviderEvent, showWaitingOnPersonChip, store, toolMessageByItem,
    turnAttachmentKey, turnAttachmentsByTurn, turnContext, turnPromptBytes, turnResourceOwners,
    turnStartedAt, turnTriggers, turnUsage, watchdog
  } = deps;
return (event: RuntimeEvent) => {
  if (shouldIgnoreProviderEvent(event)) return;
  const privateImageEvent = event.type === "item.completed" && event.itemType === "assistant_image";
  // The durable message patch below is the public frame. Sending raw base64
  // through runtime SSE would multiply large bytes across every app window.
  if (!privateImageEvent) {
    // Exact executable input is internal matching metadata, not inspector UI.
    // The event bus's persistence redactor does not scrub its live event.
    const publicEvent = event.type === "request.opened" ? { ...event, command: undefined } : event;
    broadcast({ kind: "runtime", event: publicEvent });
  }
  const routineRun = privateImageEvent ? null : (routines()?.handleRuntimeEvent(event) ?? null);
  const ownerBot = store.botByThread(event.threadId);
  const bot = ownerBot ? botForThread(ownerBot.id, event.threadId) ?? undefined : undefined;
  // Stored room threads run no turns; only a bot's own threads fold events.
  if (!bot) return;
  const pushMessage = (m: Omit<Message, "id" | "at">) => {
    const owner = directRequestOwners.get(event.threadId);
    const proven = owner?.messageId && !owner.stopped && owner.generation === directTurnGenerationByThread.get(event.threadId) &&
      owner.turnId && (!event.turnId || event.turnId === owner.turnId);
    const message = store.appendMessage(event.threadId, proven ? { ...m, requestMessageId: owner.messageId } : m);
    return message;
  };
  handoffs().onEvent(event);

  if (event.turnId) liveTurnByThread.set(event.threadId, event.turnId);
  const requestOwner = directRequestOwners.get(event.threadId);
  if (requestOwner && event.turnId && !requestOwner.turnId && event.type === "turn.started" &&
      directTurnDispatchClaims.get(event.threadId)?.id === requestOwner.generation) requestOwner.turnId = event.turnId;
  const liveTurnId = event.turnId ?? liveTurnByThread.get(event.threadId);
  switch (event.type) {
    case "turn.started":
      turnStartedAt.set(event.threadId, Date.now());
      break;
    case "session.started":
      if (event.sessionId && event.providerInstanceId) {
        store.setResumeCursor(bot.id, event.providerInstanceId, event.sessionId, event.threadId);
      }
      if (typeof event.model === "string" && event.model) sessionModelByThread.set(event.threadId, event.model);
      break;
    case "item.completed":
      if (event.itemType === "assistant_text") {
        const text = event.text;
        pushMessage({ role: "bot", kind: "text", text, turnId: event.turnId });
        // kept so "finished" can say what it finished with, rather than
        // just that something ended
        lastReply.set(event.threadId, text);
      } else if (event.itemType === "assistant_image") {
        try {
          const decoded = decodeGeneratedImage(event.data);
          const saved = saveImage(decoded.bytes, decoded.mime);
          const key = turnAttachmentKey(event.threadId, event.turnId);
          const current = turnAttachmentsByTurn.get(key) ?? [];
          current.push({ kind: "image", path: saved.path, mime: saved.mime });
          turnAttachmentsByTurn.set(key, current);
        } catch (error) {
          pushMessage({
            role: "bot",
            kind: "activity",
            tool: {
              name: `generated image could not be attached — ${error instanceof Error ? error.message : "invalid image"}`.slice(0, 160),
              ok: false,
            },
          });
        }
      } else if (event.itemType === "tool" && event.itemId) {
        const itemKey = `${event.threadId}:${event.itemId}`;
        const messageId = toolMessageByItem.get(itemKey);
        let toolName = "tool";
        if (messageId) {
          // the whole tool object is replaced, so carry `spoken` across —
          // dropping it here would silently un-narrate every completed tool
          const existing = store.messagesFor(event.threadId).find((m: any) => m.id === messageId)?.tool;
          toolName = existing?.name ?? "tool";
          store.patchMessage(event.threadId, messageId, {
            tool: { ...existing, name: toolName, ok: event.ok, output: event.output },
          });
          toolMessageByItem.delete(itemKey);
        }
        // the bot just acted ON ITS SCREEN — refresh the preview now. Only
        // computer tools can change the screen, and each capture competes
        // with the agent for the boat's command endpoint, so a bot grinding
        // through file edits must not trigger one per tool. The refresh is
        // deliberately broad (a computer_exec may well have launched a
        // window); whether the turn has EARNED a settled screenshot is the
        // narrower question, and only the allow-list answers it.
        if (bot) {
          const touches = screenTouchingTool(toolName);
          const surface = screenSurfaceForTool(toolName);
          if (touches || /computer|screenshot|click|type_text|press_key|scroll|open_url|wait_for|browser_/i.test(toolName)) {
            pokeScreenPoller()(event.threadId, touches, surface);
          }
        }
      }
      break;
    case "item.started":
      if (event.itemType === "tool") {
        // ask_bot's raw tool chip is redundant — the internal endpoint
        // appends a richer "Messaged @X" chip linking to the channel
        if (event.title?.endsWith("__ask_bot")) break;
        const name = event.title ?? "tool";
        // narration is folded in here, once, so call mode can read the
        // chip aloud without re-deriving it — and so the phrase a user
        // hears and the chip they see can never drift apart
        const message = pushMessage({
          role: "bot",
          kind: "activity",
          tool: { name, spoken: narrateTool(name) ?? undefined, summary: event.summary, input: event.input, itemId: event.itemId ?? event.eventId },
          // attributed to its turn so the digest can count it
          turnId: liveTurnId,
        });
        if (event.itemId) toolMessageByItem.set(`${event.threadId}:${event.itemId}`, message.id);
      }
      break;
    case "request.opened": {
      // A structured ask carries the model's own options and has no
      // allow/deny answer, so it is a question no matter which channel the
      // provider routed it through — and, like every question, no approval
      // mode may ever answer it for the person.
      const permission = event.requestType === "permission" && !event.questions?.length;
      // A permission request here is one the provider left for a person: its
      // own mode already ran (Ask, Edits, Auto's reviewer, Custom's config).
      // Only the person's explicit Full access or exact saved command answers.
      // Approve for me allows a web search. The app does not guess whether
      // the action is safe. A QUESTION always reaches the human — even Full
      // access never invents an answer.
      const asker = bot;
      const unattended = permission && asker && event.requestId ? isUnattended(asker.id, event.threadId) : false;
      // Only the person's explicit Full access or exact saved command answers.
      const effectiveApprovalMode = asker ? approvalModeForTurn(asker, isInternalTurn(event.threadId)) : "ask";
      // Native shell descriptors are distinct from computer/MCP permissions;
      // choosing a local desktop must not disable an exact shell grant.
      const command = permission && asker && event.requestId && !event.requiresExplicitApproval && event.command
        ? commandAllowlistCandidate({ ...event.command, providerInstanceId: event.providerInstanceId ?? asker.modelSelection.instanceId })
        : null;
      const verdict = permission && asker && event.requestId
        ? autoVerdict(effectiveApprovalMode, event.tool, {
          requiresExplicitApproval: event.requiresExplicitApproval,
          commandAllowed: Boolean(command && commandAllowlist.matches(asker.id, command)),
        })
        : null;
      // Auto's reviewer is the engine's own. Claude accepts `--permission-mode
      // auto` for any model and starts in Manual without a word when auto is
      // unavailable (Haiku 4.5, Sonnet 4.5, an org that disabled it), so the
      // bot asks about everything. Say once per session why, and what stops it.
      if (
        permission &&
        asker &&
        event.nativeReview === "inactive" &&
        effectiveApprovalMode === "auto" &&
        !nativeReviewNoticed.has(event.threadId)
      ) {
        nativeReviewNoticed.add(event.threadId);
        const model = sessionModelByThread.get(event.threadId);
        pushMessage({
          role: "bot",
          kind: "activity",
          tool: {
            name: `Approve for me: ${providerLabel(event.provider)}'s automatic reviewer is not available${model ? ` for ${model}` : ""}, so this bot asks before each action. Choose a model it supports, or Full access, to stop the prompts.`,
            ok: true,
          },
        });
      }
      if (verdict?.approve && asker && event.requestId) {
        const settled = verdict.approve;
        const instance = event.providerInstanceId
          ? registry.get(event.providerInstanceId)
          : registry.get(asker.modelSelection.instanceId);
        const requestId = event.requestId;
        const { tool, summary } = event;
        const sourceGeneration = directTurnGenerationByThread.get(event.threadId);
        const isCurrent = () => !shouldIgnoreProviderEvent(event) &&
          sourceGeneration !== undefined && directTurnGenerationByThread.get(event.threadId) === sourceGeneration;
        // The chip is written only AFTER the provider takes the answer.
        // Claiming approval first and correcting later means a moment
        // where the transcript says "approved" over a request nothing
        // answered — and if the provider is gone entirely, forever.
        void (async () => {
          const outcome = await deliverFullAccessApproval(instance?.adapter, event.threadId, requestId, event.turnId, isCurrent);
          if (!isCurrent()) return;
          if (outcome !== "allowed-once") {
            watchdog.setWaitingOnHuman(event.threadId, false);
            if (outcome !== "unavailable") pushMessage({
              role: "bot", kind: "activity",
              tool: outcome === "rejected"
                ? { name: `The provider rejected this action despite ${verdict.source === "command-allowlist" ? "the saved command permission" : "Full access"}.`, ok: false }
                : failedTurnTool("could not deliver approval to the provider; retry the task after reconnecting."),
            });
            return;
          }
          pushMessage({
            role: "bot",
            kind: "activity",
            tool: { name: `${settled}: ${summary.slice(0, 120)}`, ok: true },
          });
          // Log only once the provider has actually taken the answer.
          appendDecision(DATA_DIR, {
            threadId: event.threadId,
            requestId,
            botId: asker.id,
            botName: asker.name,
            tool,
            summary,
            decision: "auto-approved",
            source: verdict.source,
          });
        })().catch(() => {
          // A receipt failure must neither crash the server nor manufacture
          // a new permission request after the provider took our answer.
          console.error("[approval] Could not record the provider approval result.");
        });
        break;
      }
      const heldContext = { source: verdict?.source, permission };
      // A structured ask (Claude's AskUserQuestion) is a question whatever
      // the provider routed it as: it has no allow/deny answer, only the
      // model's own options. The card carries them so the person can choose.
      const questions = event.questions?.length ? event.questions : undefined;
      const message = pushMessage({
        role: "bot",
        kind: "options",
        card: {
          title:
            permission && event.approvalScope === "local-computer"
              ? "Local computer approval"
              : permission
                ? "Approval needed"
                : "Your bot has a question",
          subtitle: event.summary,
          options: event.choices?.length ? event.choices : permission ? ["Allow", "Deny"] : [],
          requestId: event.requestId,
          requestType: permission ? "permission" : "question",
          tool: permission ? event.tool : undefined,
          questionRequest: questions
            ? { version: 1, questions, ...(event.origin === "output" ? { origin: "output" as const } : {}) }
            : undefined,
          commandAllowlist: command ?? undefined,
          // Provider-owned session grants remain separate from exact commands.
          allowSession: permission && event.allowSession && !event.requiresExplicitApproval ? true : undefined,
          // The text stays for cards saved before heldCode existed, and for
          // clients that do not know the key yet.
          held: approvalHeldReason(heldContext),
          heldCode: approvalHeldNote(heldContext),
          approvalScope: event.approvalScope,
        },
      });
      if (event.requestId) askMessageByRequest.set(`${event.threadId}:${event.requestId}`, message.id);
      if (command && asker && event.requestId) pendingCommandRules.set(`${event.threadId}:${event.requestId}`, { botId: asker.id, candidate: command });
      // Every card that reaches a human is a decision too: "the provider
      // left this for you, in this mode". `question` marks the cards no
      // rule may ever answer; a permission card without a verdict (no known
      // asker, or no requestId to answer through) can only mean nothing was
      // granted.
      appendDecision(DATA_DIR, {
        threadId: event.threadId,
        requestId: event.requestId,
        botId: asker?.id,
        botName: asker?.name,
        tool: event.tool,
        summary: event.summary,
        decision: "card-shown",
        source: !permission ? "question" : verdict ? verdict.source : "no-grant",
        origin: !permission && event.origin === "output" ? "output" : undefined,
        unattended: unattended || undefined,
      });
      // Notify from HERE, not from a separate subscriber on request.opened:
      // this is the branch where a card actually reached a human. Anything
      // Full access answered took the early return above and never buzzes.
      if (asker) {
        const card = store.messagesFor(event.threadId).find((candidate: any) => candidate.id === message.id)?.card;
        if (card && !card.answered) {
          // the bot is not working now — it is waiting on a person
          if (bot) store.setTaskActivity(bot.id, event.threadId, "waiting-on-you");
          else if (asker.busy) store.setActivity(asker.id, "waiting-on-you");
          if (event.requestId) showWaitingOnPersonChip()(event.threadId, event.requestId, asker, permission ? "approval" : "answer");
          const notificationBot = (routineRun && routineSourceOwner()(routineRun)?.bot) || asker;
          notify(buildNotification(
            permission ? "approval" : "question",
            notificationBot,
            (routineRun && routineSourceThread()(routineRun)) || event.threadId,
            event.summary,
          ));
        }
      }
      break;
    }
    case "request.resolved": {
      if (event.requestId) pendingCommandRules.delete(`${event.threadId}:${event.requestId}`);
      if (event.requestId) settleWaitingOnPersonChips()(event.threadId, event.requestId);
      // answered (by whoever): the turn is working again, unless it settled
      if (store.taskByThread(bot.id, event.threadId)?.activity === "waiting-on-you") {
        store.setTaskActivity(bot.id, event.threadId, "working");
      }
      const messageId = event.requestId ? askMessageByRequest.get(`${event.threadId}:${event.requestId}`) : null;
      if (messageId) {
        const existing = store.messagesFor(event.threadId).find((m: any) => m.id === messageId);
        if (existing?.card && !existing.card.answered) {
          if (shouldSettleRequestCard(existing.card, event.source)) {
            store.patchMessage(event.threadId, messageId, {
              card: {
                ...existing.card,
                answered: event.behavior,
                dismissed: isPersistentQuestionCard(existing.card) ? false : event.source !== "user",
              },
            });
          }
        }
        if (event.requestId) askMessageByRequest.delete(`${event.threadId}:${event.requestId}`);
      }
      break;
    }
    case "turn.retrying":
      // the driver is about to relaunch the turn after a transient failure;
      // the activity chip keeps the bot visibly busy through the backoff
      pushMessage({
        role: "bot",
        kind: "activity",
        tool: { name: `retrying — attempt ${event.attempt + 1}/${RETRY_MAX_ATTEMPTS} in ${Math.round(event.delayMs / 1000)}s — ${event.reason}`, ok: true },
      });
      break;
    case "runtime.notice":
      // informational: the turn carries on. The prefix keeps it a status row
      // the person always sees (src/lib/activity-runs.ts), never a tool step
      // hidden with Tool calls off.
      pushMessage({ role: "bot", kind: "activity", tool: { name: `notice: ${event.message.slice(0, 240)}`, ok: true } });
      break;
    case "runtime.error":
      pushMessage({
        role: "bot",
        kind: "activity",
        tool: failedTurnTool(event.message, event),
      });
      // a setup error means the engine could not even start: the bot is
      // dead until something changes, not merely idle. The next successful
      // dispatch moves it to working; turn.completed (which follows a setup
      // failure) is told to leave "dead" alone.
      if (event.setup && bot) store.setTaskActivity(bot.id, event.threadId, "dead");
      break;
    case "thread.token-usage.updated":
      // running totals for the turn in flight; folded into the task's
      // tally at turn.completed (below) so retries never double-count
      turnUsage.set(event.threadId, { input: event.input, output: event.output, cachedInput: event.cachedInput });
      if (event.contextTokens !== undefined || event.contextWindow !== undefined) {
        turnContext.set(event.threadId, { tokens: event.contextTokens, window: event.contextWindow });
      }
      break;
    case "turn.completed": {
      settleWaitingOnPersonChips()(event.threadId);
      // A peer-started turn settles as coordination, not as news. What keeps
      // that classification from outliving its turn is the rewrite at
      // dispatch, not this line — releasing it here too is hygiene, so a
      // thread nobody types in again (a deleted bot's) is not held forever.
      const internal = isInternalTurn(event.threadId);
      clearInternalTurn(event.threadId);
      const generatedKey = turnAttachmentKey(event.threadId, event.turnId);
      const generated = turnAttachmentsByTurn.get(generatedKey) ?? [];
      turnAttachmentsByTurn.delete(generatedKey);
      // A turn that never completed never lands its half-said note: parked
      // audio is deleted when the settle is not ok (person stop, provider
      // failure) rather than posted as if the turn finished (#1742).
      // Generated images keep their long-standing settle-anyway behavior.
      for (const attachment of generated) {
        if (event.ok || attachment.kind !== "audio") continue;
        deleteAttachment(attachment.path);
      }
      const settled = event.ok || !generated.length
        ? generated
        : generated.filter((attachment: any) => attachment.kind !== "audio");
      if (settled.length) {
        const response = [...store.messagesFor(event.threadId)].reverse().find(
          (message) =>
            message.role === "bot" &&
            message.kind === "text" &&
            message.turnId === event.turnId,
        );
        // A voice note's text is its transcript: the visible caption search,
        // compaction and notifications read (#1740 decision 3).
        const transcript = settled
          .filter((attachment: any) => attachment.kind === "audio" && attachment.text)
          .map((attachment: any) => attachment.text!.trim())
          .filter(Boolean)
          .join("\n\n");
        const staged = settled.map((attachment: any) =>
          attachment.kind === "audio"
            ? { kind: "audio" as const, path: attachment.path, mime: attachment.mime }
            : attachment,
        );
        if (response) {
          store.patchMessage(event.threadId, response.id, {
            attachments: [...(response.attachments ?? []), ...staged],
            // The note's text is its transcript and stays visible beside a
            // written epilogue: the wire audio carries no text, so letting
            // the epilogue replace it would erase what was said (#1740
            // decision 3).
            ...(transcript
              ? {
                  text: [response.text?.trim(), redactSecretsInText(transcript)]
                    .filter(Boolean)
                    .join("\n\n"),
                }
              : {}),
          });
        } else {
          // Some turns have no textual epilogue. Keep the attachment as the
          // terminal assistant response instead of inventing model words; a
          // voice note's own text is the visible transcript there.
          pushMessage({
            role: "bot",
            kind: "text",
            text: transcript,
            attachments: staged,
            turnId: event.turnId,
          });
        }
      }
      if (event.turnId) {
        const terminal = store.markTerminalAssistantMessage(event.threadId, event.turnId);
        if (terminal) store.patchMessage(event.threadId, terminal.id, { turnSucceeded: event.ok });
      }
      const reply = lastReply.get(event.threadId) ?? "";
      lastReply.delete(event.threadId);
      // A run that broke — not one the person stopped, and not a routine's,
      // which reports through its own failure path — is the Chief's to see.
      // A lazy computer-claim rejection already reported its failure and
      // interrupted the turn; Claude settles that interrupt as
      // exit_before_result, not "interrupted", so this generation's marker
      // keeps the same failure from reporting a second incident.
      // A turn parked at the computer ceiling (#1651) settles itself the
      // same way: interrupted for a resume, not broken.
      const lazyClaimAlreadyReported = event.stopReason === "exit_before_result" &&
        turnResourceOwners.get(event.threadId)?.lazyClaimFailureReported === true;
      const computerParked = event.stopReason === "exit_before_result" &&
        turnResourceOwners.get(event.threadId)?.computerParkedOn !== undefined;
      if (!event.ok && event.stopReason !== "interrupted" && !lazyClaimAlreadyReported && !computerParked && !routines()?.runForThread(event.threadId)) {
        const broken = bot;
        if (broken) reportIncident()({ kind: "failed", bot: broken, threadId: event.threadId, detail: event.stopReason?.trim() || "the run ended without a result" });
      }
      const lastReported = turnUsage.get(event.threadId);
      turnUsage.delete(event.threadId);
      const lastContext = turnContext.get(event.threadId);
      turnContext.delete(event.threadId);
      // Only 1:1 task turns are tallied for now.
      if (bot) {
        const resourceOwner = turnResourceOwners.get(event.threadId);
        const generation = directTurnGenerationByThread.get(event.threadId);
        const isCurrent = () => directTurnGenerationByThread.get(event.threadId) === generation &&
          Boolean(store.taskByThread(bot.id, event.threadId));
        const settleDirectTurn = (resumeQueued = false) => {
          // Resource claims can outlive a deleted thread, but a stale capture
          // must never release a replacement generation's VM or busy state.
          const ownsResources = resourceOwner &&
            turnResourceOwners.get(event.threadId)?.generation === resourceOwner.generation;
          if (ownsResources) {
          }
          releaseTurnResources(resourceOwner);
          if (!isCurrent()) return;
          if (store.taskByThread(bot.id, event.threadId)?.activity !== "dead") {
            store.setTaskActivity(bot.id, event.threadId, resourceOwner?.computerParkedOn !== undefined ? "parked.computer" : "idle");
          }
          directTurnBots.delete(event.threadId);
          // Ordinary completion still drains from the existing bus subscribers.
          // An asynchronous screenshot finishes after those subscribers ran.
          if (resumeQueued) {
            retryDelegationsWaitingOn()(bot.id);
            drainQueuedSends()();
            drainConnectorResumes()();
            drainComputerResumes()();
            drainSecretResumes()();
            drainTeamSetupResumes()();
            drainDelegationWakes()();
          }
          settleTrackedRequest(event.threadId);
        };
        // bank what this turn spent before the bot broadcast carries the
        // task list to every window. The driver's own per-turn figure
        // (turn.completed.usage) is authoritative; a driver that only
        // streams the running indicator falls back to its last value.
        const tokens = event.usage ?? lastReported;
        // the context figure: what the last model call's prompt held, with
        // the window from the driver or, failing that, the model's family
        const contextModel = store.taskByThread(bot.id, event.threadId)?.modelSelection?.model ?? bot.modelSelection.model;
        store.addTaskUsage(bot.id, event.threadId, {
          input: tokens?.input,
          output: tokens?.output,
          cachedInput: tokens?.cachedInput,
          costUsd: event.cost ?? null,
          context: { tokens: lastContext?.tokens, window: lastContext?.window ?? modelContextWindow(contextModel) },
        });
        // and write the same figures to the month's ledger, which outlives
        // the task and answers "what did we spend, by whom" for a period
        const settledTask = store.taskByThread(bot.id, event.threadId);
        const selection = settledTask?.modelSelection ?? bot.modelSelection;
        // A provider that omitted a context measurement must not reuse a
        // stale reading from a different model or a pre-compaction session.
        const measuredSelection = directTurnBots.get(event.threadId)?.modelSelection ?? selection;
        store.patchTask(bot.id, event.threadId, { lastContextModel: Number.isFinite(lastContext?.tokens) && (lastContext?.tokens ?? 0) > 0
          ? `${measuredSelection.instanceId}:${measuredSelection.model}` : undefined });
        const promptBytes = turnPromptBytes.get(event.threadId);
        turnPromptBytes.delete(event.threadId);
        bookTurnUsage({
          botId: bot.id,
          botName: bot.name,
          threadId: event.threadId,
          instanceId: selection.instanceId,
          driverKind: registry.get(selection.instanceId)?.driverKind ?? "unknown",
          model: selection.model,
          input: tokens?.input ?? 0,
          output: tokens?.output ?? 0,
          ...(typeof tokens?.cachedInput === "number" ? { cachedInput: tokens.cachedInput } : {}),
          ...(promptBytes ? { promptBytes } : {}),
          costUsd: event.cost ?? null,
          trigger: routineRun
            ? { kind: "routine", routineId: routineRun.routineId, label: routineRun.routineName }
            : internal
              ? { kind: "bot", ...(settledTask?.openedBy?.botId ? { botId: settledTask.openedBy.botId } : {}) }
              : turnTriggers.get(event.threadId) ?? { kind: "owner" },
        });
        const digestSettled = event.turnId ? scheduleTurnDigest({
            botId: bot.id,
            botName: bot.name,
            threadId: event.threadId,
            turnId: event.turnId,
            succeeded: event.ok,
            driverKind: registry.get(selection.instanceId)?.driverKind,
            instanceId: selection.instanceId,
            reply,
            isCurrent,
            ...(tokens ? { usage: { input: tokens.input ?? 0, output: tokens.output ?? 0, ...(typeof tokens.cachedInput === "number" ? { cachedInput: tokens.cachedInput } : {}), costUsd: event.cost ?? null } } : {}),
          }) : Promise.resolve();
        if (resourceOwner) settlingResourceOwners.set(resourceOwner.threadId, resourceOwner.generation);
        liveTurnByThread.delete(event.threadId);
        const routineReportThread = routineRun ? routineSourceThread()(routineRun) : null;
        // A routine's result belongs to its reporting thread's unread state.
        // Its internal execution should not light up the sidebar as well.
        // Neither should a peer's hop: the exchange is already recorded in the
        // pair channel and chipped into both threads, which is the whole of
        // what the person needs to be able to find it.
        if (!routineReportThread && !internal) store.patchTask(bot.id, event.threadId, { unread: true });
        // A failed peer turn stays a chip too. The bot that delegated is woken
        // with the failure and answers the person in its own thread — buzzing
        // here as well would ring twice for one piece of news.
        if ((!routineRun || routineRun.status === "completed") && !internal) {
          // the frame carries the bot's avatar so every desktop client can
          // show the notification under that bot's own face
          const completionDetail = routineRun
            ? reply || routineRun.output || routineRun.routineName
            : reply;
          const notificationBot = (routineRun && routineSourceOwner()(routineRun)?.bot) || bot;
          notify(buildNotification("done", notificationBot, routineReportThread ?? event.threadId, completionDetail, { avatarUrl: notificationBot.avatarUrl }));
        }
        if (screenPollers().has(event.threadId)) {
          // the last live frame becomes a settled inline screen message —
          // the screenshot-in-chat moment. One fresh capture first, so the
          // frame shows the turn's END state (the final tool's poke may
          // still be in flight).
          //
          // Keep the thread busy until its bounded final capture releases
          // the screen: an accepted follow-up must not take the desktop
          // before the END-state frame is captured.
          const settleLeafId = store.activePath(event.threadId).at(-1)?.id;
          let timeout: ReturnType<typeof setTimeout>;
          const screenSettled = Promise.race([
            finalScreenFrame()(bot.id, event.threadId),
            new Promise<null>((resolve) => { timeout = setTimeout(() => resolve(null), SCREEN_SETTLE_TIMEOUT_MS()); }),
          ]).then((frame) => {
            if (frame && isCurrent()) {
              store.insertMessageAfter(event.threadId, settleLeafId, { role: "bot", kind: "screen", png: frame.png, mime: frame.mime });
            }
          }).catch(() => {}).finally(() => {
            clearTimeout(timeout);
          });
          void Promise.all([screenSettled, digestSettled]).finally(() => settleDirectTurn(true));
        } else {
          void digestSettled.finally(() => settleDirectTurn(true));
        }
      }
      // A delegated turn's terminal state belongs in the A⇄B channel:
      // the request was mirrored there when the delegation drained, and a
      // channel that only ever shows requests is half a record. Mirror the
      // reply on success; mirror a failed/stopped terminal chip otherwise.
      const delegationFailureName = !event.ok && event.stopReason?.trim()
        ? `Delegated turn did not finish — ${event.stopReason.trim().slice(0, 120)}`
        : undefined;
      finalizeDelegationWatch()(event.threadId, event.ok, reply, delegationFailureName);
      break;
    }
  }
};
}
