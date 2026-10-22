// Groups and DMs between people, as the app reads them (server:
// colonie/groups/group-conversations.ts). Their messages arrive on the live
// stream like any thread's; the store passes each message frame on as a
// THREAD_FRAME event, so the open conversation and the sidebar list follow.
import { useCallback, useEffect, useState } from "react";
import type { Message } from "@/state/store";
import { api } from "@/state/store";

export const THREAD_FRAME = "colonie:thread-frame";
export const CONVERSATIONS_CHANGED = "colonie:conversations-changed";
export const OPEN_NEW_CONVERSATION = "colonie:new-conversation";

export interface ConversationPerson { email: string; name: string; you: boolean }
export interface Conversation {
  id: string; threadId: string; kind: "group" | "dm"; title: string; name: string;
  people: ConversationPerson[]; bots: string[]; lastMessageAt: number; unread: boolean;
}
export interface ThreadFrame { kind: "message" | "message.patch"; threadId: string; message: Message }

export const listConversations = async () => (await api<{ conversations: Conversation[] }>("/api/conversations")).conversations;
export const conversationMessages = async (id: string) => (await api<{ messages: Message[] }>(`/api/conversations/${id}/messages`)).messages;
export const postToConversation = (id: string, text: string) =>
  api<{ message: Message }>(`/api/conversations/${id}/messages`, { method: "POST", body: JSON.stringify({ text }) });
export const markConversationRead = (id: string) => api(`/api/conversations/${id}/read`, { method: "POST" }).catch(() => {});
export const createConversation = (input: { kind: "group" | "dm"; name?: string; emails: string[]; bots: string[] }) =>
  api<Conversation>("/api/conversations", { method: "POST", body: JSON.stringify(input) });
export const addToConversation = (id: string, input: { emails?: string[]; bots?: string[] }) =>
  api<Conversation>(`/api/conversations/${id}/members`, { method: "POST", body: JSON.stringify(input) });
export const leaveConversation = (id: string) => api(`/api/conversations/${id}/members/me`, { method: "DELETE" });
export const workspacePeople = async () => (await api<{ people: Array<{ email: string; name: string }> }>("/api/people")).people;

/** Apply one live frame to a conversation's messages. */
export function withFrame(messages: Message[], frame: ThreadFrame): Message[] {
  if (frame.kind === "message") return messages.some((message) => message.id === frame.message.id) ? messages : [...messages, frame.message];
  return messages.map((message) => (message.id === frame.message.id ? { ...message, ...frame.message } : message));
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
