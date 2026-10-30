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
  /** Who answers a group message that names no one, and the lead it resolves to. */
  responder?: GroupResponder;
  leadBotId?: string | null;
}

export type GroupResponder = { kind: "lead"; botId?: string } | { kind: "everyone" } | { kind: "mentions" };

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
export const updateConversation = (id: string, input: { instructions?: string; responder?: GroupResponder }) =>
  api<Conversation>(`/api/conversations/${id}`, { method: "PATCH", body: JSON.stringify(input) });
export const leaveConversation = (id: string) => api(`/api/conversations/${id}/members/me`, { method: "DELETE" });
export const deleteGroup = (id: string) => api(`/api/conversations/${id}`, { method: "DELETE" });
export const stopConversation = (id: string) => api(`/api/conversations/${id}/stop`, { method: "POST" });
/** A file in a conversation's project folder, by its path inside it. */
export interface ConversationFile { path: string; bytes: number; modifiedAt: number }
export const conversationFiles = (id: string) => api<{ files: ConversationFile[]; truncated: boolean }>(`/api/conversations/${id}/files`);
/** One project file's bytes, for its preview: the group's own grant, not a message's. */
export async function requestConversationFile(id: string, path: string, signal: AbortSignal): Promise<Response> {
  const response = await fetch(`/api/conversations/${id}/files/content?path=${encodeURIComponent(path)}`, { signal });
  if (!response.ok) throw new Error(((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? "load");
  return response;
}
/** Save one project file to the person's computer. */
export async function downloadConversationFile(id: string, path: string): Promise<void> {
  const response = await fetch(`/api/conversations/${id}/files/content?path=${encodeURIComponent(path)}`);
  if (!response.ok) throw new Error(((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? "The file could not be downloaded.");
  const url = URL.createObjectURL(await response.blob());
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = path.split("/").at(-1) ?? "file";
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
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
