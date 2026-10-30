// Bind scheduled work to the saved request's conversation and person.
import type { Store } from "../../persistence/store.ts";
import type { GroupConversations } from "../groups/group-conversations.ts";
import { canReachPeer } from "../peers/peer-roster.ts";
import type { Routine, RoutineConversation, RoutineRequestCommit, RoutineRun } from "./routines.ts";

export function createConversationRoutines(deps: { store: Store; groups: GroupConversations; local: () => boolean }) {
  const { store, groups } = deps;

  function bind(request: Pick<RoutineRequestCommit, "botId" | "threadId" | "messageId">): RoutineConversation | undefined {
    const task = store.taskByThread(request.botId, request.threadId);
    if (!task) return undefined;
    const messages = store.messagesFor(request.threadId);
    const cardIndex = messages.findIndex((message) => message.id === request.messageId);
    const sender = messages.slice(0, cardIndex < 0 ? undefined : cardIndex).findLast((message) => message.role === "user")?.sender;
    const requestedBy = sender?.id ? { id: sender.id, name: sender.name }
      : deps.local() ? { id: "owner", name: "You" } : undefined;
    if (task.forConversation) {
      const group = groups.byId(task.forConversation);
      if (!group || !group.bots.includes(request.botId)) throw new Error("This bot is no longer in the conversation.");
      if (!requestedBy || !group.people.includes(requestedBy.id)) throw new Error("The person who requested this routine is no longer in the conversation.");
      return { id: group.id, threadId: group.threadId, requestedBy };
    }
    return { threadId: request.threadId, ...(requestedBy ? { requestedBy } : {}) };
  }

  function recover(routine: Routine): RoutineConversation | undefined {
    if (routine.conversation || !routine.sourceThreadId || !store.taskByThread(routine.botId, routine.sourceThreadId)) return routine.conversation;
    const source = store.taskByThread(routine.botId, routine.sourceThreadId)!;
    // An existing DM routine may have an explicitly chosen results thread.
    // Keep that choice; new chat routines bind their origin at creation.
    if (!source.forConversation && routine.resultsThreadId && routine.resultsThreadId !== routine.sourceThreadId) return undefined;
    const message = store.messagesFor(routine.sourceThreadId).find((entry) => entry.card?.routineRequest?.resultId === routine.id);
    if (!message) return undefined;
    try { return bind({ botId: routine.botId, threadId: routine.sourceThreadId, messageId: message.id }); }
    catch { return undefined; }
  }

  function canRun(run: Pick<RoutineRun, "botId" | "conversation">): string | null {
    const context = run.conversation;
    if (!context) return null;
    if (context.id) {
      const group = groups.byId(context.id);
      if (!group || group.threadId !== context.threadId || !group.bots.includes(run.botId)) return "The routine's bot is no longer in its conversation. Pause or delete the routine here.";
      if (!context.requestedBy || !group.people.includes(context.requestedBy.id)) return "The person responsible for this routine left the conversation. Create a new routine to continue.";
    } else {
      const sourceBot = store.botByThread(context.threadId);
      const task = sourceBot && store.taskByThread(sourceBot.id, context.threadId);
      if (!task || task.forConversation || task.routineRunId) return "The conversation for this routine no longer exists.";
      const executor = store.bot(run.botId);
      if (!executor || (sourceBot.id !== executor.id && !canReachPeer(sourceBot, executor))) return "The bot responsible for this routine can no longer work with this conversation.";
      if (!deps.local() && (!context.requestedBy || !task.participants?.includes(context.requestedBy.id))) return "The person responsible for this routine is no longer in its conversation.";
    }
    return null;
  }

  function inThread(routine: Pick<Routine, "conversation" | "sourceThreadId" | "resultsThreadId">, botId: string, threadId: string): boolean {
    const task = store.taskByThread(botId, threadId);
    const context = routine.conversation;
    if (context?.id) return task?.forConversation === context.id;
    if (task?.forConversation) return false;
    return (context?.threadId ?? routine.sourceThreadId ?? routine.resultsThreadId) === threadId;
  }

  function createTask(botId: string, title: string, activate = false, run?: RoutineRun) {
    const context = run?.conversation;
    const sourceBot = context && !context.id ? store.botByThread(context.threadId) : undefined;
    const source = sourceBot && context ? store.taskByThread(sourceBot.id, context.threadId) : undefined;
    const people = context?.id ? groups.byId(context.id)?.people : source?.participants;
    const task = store.createTask(botId, title, activate, sourceBot?.id === botId ? source?.projectId : undefined, undefined, undefined, undefined, people,
      context?.id ? { forConversation: context.id } : undefined);
    if (task && source?.cwd) store.moveTaskFolder(botId, task.threadId, source.cwd);
    return task;
  }

  function turnContext(run: RoutineRun | null | undefined, prompt: string) {
    const context = run?.conversation;
    const group = context?.id ? groups.byId(context.id) : undefined;
    const providerPrompt = group ? `${group.kind === "dm" ? "This is scheduled work for a direct message." : `This is scheduled work for the group "${group.name}".`}\nReport the requested work; Colonie sends your answer to that conversation. Work in its project folder.\n${group.instructions ? `Group instructions:\n${group.instructions}\n` : ""}\n${prompt}` : prompt;
    return {
      ...(context?.requestedBy ? { sender: context.requestedBy } : {}),
      ...(group ? { providerPrompt, providerRecoveryPrompt: providerPrompt } : {}),
    };
  }

  return { bind, recover, canRun, inThread, createTask, turnContext };
}
