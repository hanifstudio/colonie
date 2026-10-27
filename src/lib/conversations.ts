// Groups and DMs between people, as the app reads them (server:
// colonie/groups/group-conversations.ts). Their messages arrive on the live
// stream like any thread's; the store passes each message frame on as a
// THREAD_FRAME event, so the open conversation and the sidebar list follow.
import { useCallback, useEffect, useState } from "react";
import type { Message } from "@/state/store";
import { api } from "@/state/store";
import { mentionChoicesForQuery, mentionQueryAt } from "./mentions";

export const THREAD_FRAME = "colonie:thread-frame";
export const CONVERSATIONS_CHANGED = "colonie:conversations-changed";
export const OPEN_NEW_CONVERSATION = "colonie:new-conversation";

export interface ConversationPerson { key?: string; email: string; name: string; you: boolean; avatar?: string }
export interface Conversation {
  id: string; threadId: string; kind: "group" | "dm"; title: string; name: string;
  people: ConversationPerson[]; bots: string[]; lastMessageAt: number; unread: boolean;
  /** The last thing said ("Bob: see you"), empty before anything is. */
  preview?: string;
  /** A group's instructions, which every bot in it reads. */
  instructions?: string;
  /** Someone @named the caller since they last read it. */
  mentioned?: boolean;
  canStop?: boolean;
}

/** The "@query" being typed at the end of the text, or null. */
export function mentionQuery(textBeforeCaret: string): string | null {
  return mentionQueryAt(textBeforeCaret, textBeforeCaret.length)?.query ?? null;
}

/** Names that start with the query (people and bots), for the suggestion list. */
export function mentionSuggestions(query: string, names: Array<{ name: string; kind: "person" | "bot" }>) {
  return mentionChoicesForQuery(names, query);
}
export interface ThreadFrame { kind: "message" | "message.patch"; threadId: string; message: Message }

export const listConversations = async () => (await api<{ conversations: Conversation[] }>("/api/conversations")).conversations;
export const conversationMessages = async (id: string) => (await api<{ messages: Message[] }>(`/api/conversations/${id}/messages`)).messages;
export const postToConversation = (id: string, text: string, sendId: string = crypto.randomUUID()) =>
  api<{ message: Message }>(`/api/conversations/${id}/messages`, { method: "POST", body: JSON.stringify({ text, sendId }) });
export const markConversationRead = (id: string) => api(`/api/conversations/${id}/read`, { method: "POST" }).catch(() => {});
export const createConversation = (input: { kind: "group" | "dm"; name?: string; emails: string[]; bots: string[] }) =>
  api<Conversation>("/api/conversations", { method: "POST", body: JSON.stringify(input) });
export const addToConversation = (id: string, input: { emails?: string[]; bots?: string[] }) =>
  api<Conversation>(`/api/conversations/${id}/members`, { method: "POST", body: JSON.stringify(input) });
export const updateConversation = (id: string, input: { instructions: string }) =>
  api<Conversation>(`/api/conversations/${id}`, { method: "PATCH", body: JSON.stringify(input) });
export const leaveConversation = (id: string) => api(`/api/conversations/${id}/members/me`, { method: "DELETE" });
export const stopConversation = (id: string) => api(`/api/conversations/${id}/stop`, { method: "POST" });
export const workspacePeople = async () => (await api<{ people: Array<{ email: string; name: string }> }>("/api/people")).people;

/** Apply one live frame to a conversation's messages. */
export function withFrame(messages: Message[], frame: ThreadFrame): Message[] {
  if (frame.kind === "message") return messages.some((message) => message.id === frame.message.id) ? messages : [...messages, frame.message];
  // a patch frame carries the whole message: take it as it is, so a field
  // the server cleared (working, workThread) is cleared here too
  return messages.map((message) => (message.id === frame.message.id ? frame.message : message));
}

/** The caller's conversations, kept fresh by live messages and changes here. */
export function useConversations(): { conversations: Conversation[] | null; reload: () => void } {
  const [conversations, setConversations] = useState<Conversation[] | null>(null);
  const reload = useCallback(() => { void listConversations().then(setConversations).catch(() => setConversations([])); }, []);
  useEffect(() => {
    reload();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const soon = () => { if (timer) clearTimeout(timer); timer = setTimeout(reload, 400); };
    window.addEventListener(THREAD_FRAME, soon);
    window.addEventListener(CONVERSATIONS_CHANGED, soon);
    return () => { if (timer) clearTimeout(timer); window.removeEventListener(THREAD_FRAME, soon); window.removeEventListener(CONVERSATIONS_CHANGED, soon); };
  }, [reload]);
  return { conversations, reload };
}

/** A conversation's messages as the bot chat shows them: the caller's own on
 * the right; everyone else's (people and bots) on the left, and the first of
 * a run from one sender carries who it is (name, avatar). */
export function asChatMessages(messages: Message[], people: ConversationPerson[]): Message[] {
  const me = people.find((person) => person.you)?.key;
  const byKey = new Map(people.flatMap((person) => person.key ? [[person.key, person] as const] : []));
  let previous = "";
  return messages.map((message) => {
    if (message.notice) { previous = ""; return message; }
    if (message.role === "user" && (!message.sender?.id || message.sender.id === me)) {
      previous = "you";
      const { sender: _mine, ...own } = message;
      return own;
    }
    const bot = message.role === "bot";
    const who = bot ? `bot:${message.from?.botId ?? message.from?.name ?? ""}` : `person:${message.sender?.id ?? message.sender?.name ?? ""}`;
    const first = who !== previous;
    previous = who;
    const person = bot ? undefined : byKey.get(message.sender?.id ?? "");
    const sender = !first ? undefined : bot
      ? { name: message.from?.name ?? "Bot", kind: "bot" as const }
      : { name: person?.name ?? message.sender?.name ?? "Someone", kind: "human" as const, id: message.sender?.id, avatar: person?.avatar, email: person?.email };
    const { sender: _raw, ...rest } = message;
    return { ...rest, role: "bot", ...(sender ? { sender } : {}) } as Message;
  });
}
