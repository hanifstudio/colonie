/** UI-only snippet from a bounded chronological tail, never model context. */
export function conversationPreview(messages: Array<{ kind: string; text?: string }>): string {
  const latest = messages.findLast((message) => message.kind === "text" && message.text?.trim());
  return latest?.text?.replace(/\s+/g, " ").trim().slice(0, 180) ?? "";
}
