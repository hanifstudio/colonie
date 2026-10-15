/** Presentation-only adaptation to Colonie's existing UI. The account API
 * remains authoritative for membership, private conversations and messages. */
import { initialState, type AppState, type Bot, type Group, type Message } from "@/state/store";
import { botColor, conversationTitle, dmPeer, type PlatformBot, type PlatformConversation, type PlatformMessage } from "./colonie-platform";

export function classicMessages(messages: PlatformMessage[], self: string): Message[] {
  return messages.map((message, index) => ({ id: message.id, role: message.senderPrincipalId === self ? "user" : "bot",
    kind: "text", text: message.body, at: Date.parse(message.createdAt),
    parentId: messages[index - 1]?.id ?? null,
    sender: { name: message.senderName, kind: message.senderKind } }));
}

export function classicBot(bot: Pick<PlatformBot, "id" | "name" | "purpose">, conversation?: PlatformConversation, messages: Message[] = [], working = false): Bot {
  return { id: bot.id, name: bot.name, title: "", description: bot.purpose ?? "", soul: bot.purpose,
    threadId: conversation?.id ?? `bot:${bot.id}`, messages, color: botColor(bot.id),
    notifications: true, unread: Boolean(conversation?.unreadCount), busy: working,
    activity: working ? "working" : "idle", computer: "off", modelSelection: { instanceId: "platform", model: "default" } };
}

export function classicConversation(conversation: PlatformConversation, self: string, messages: PlatformMessage[], working: boolean): Bot {
  const peer = dmPeer(conversation, self);
  return classicBot({ id: peer?.botId ?? conversation.id, name: conversationTitle(conversation, self) }, conversation, classicMessages(messages, self), working);
}

export function classicWorkspaceState(input: {
  bots: PlatformBot[]; conversations: PlatformConversation[]; self: string;
  active: PlatformConversation | null; messages: PlatformMessage[]; working: Record<string, boolean>;
}): AppState {
  const bots = input.bots.map((bot) => {
    const dm = input.conversations.find((c) => c.kind === "dm" && dmPeer(c, input.self)?.botId === bot.id);
    return classicBot(bot, dm, dm?.id === input.active?.id ? classicMessages(input.messages, input.self) : [], Boolean(dm && input.working[dm.id]));
  });
  const groups: Group[] = input.conversations.filter((c) => c.kind === "group").map((c) => ({
    id: c.id, threadId: c.id, name: c.title || "Group", createdAt: Date.parse(c.createdAt),
    memberIds: c.participants.flatMap((p) => p.botId ? [p.botId] : []), bulletin: "",
    unread: c.unreadCount > 0, defaultResponder: { kind: "auto" }, working: Boolean(input.working[c.id]),
    messages: c.id === input.active?.id ? classicMessages(input.messages, input.self) : [],
  }));
  const peer = input.active ? dmPeer(input.active, input.self) : null;
  return { ...initialState, bots, groups, connected: true,
    selectedId: input.active ? peer?.botId ?? input.active.id : "" };
}
