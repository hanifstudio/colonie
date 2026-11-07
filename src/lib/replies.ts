import type { Message } from "@/state/store";
import { t } from "./i18n";
import { peerLine } from "./peer-message";
import { citationPreviewText } from "./citations";

export function replySnippet(text: string, limit = 160): string {
  const clean = citationPreviewText(text)
    .replace(
      /<attached-(image|file)\s+path="[^"]*"(?:\s+name="[^"]*")?\s*\/>/g,
      (_tag, kind: "image" | "file") => (kind === "image" ? t("chat.reply.image") : t("chat.reply.file")),
    )
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}
/** Who wrote a message, for "Replying to …". In a group several people write, so a person's message names its
 * sender, and "You" only when it is the viewer's own. Without a viewer (a 1:1 chat) it stays as it always was. */
export function replyAuthor(message: Message, fallback?: string, viewerKey?: string): string {
  if (message.authorName) return message.authorName;
  if (message.role === "user") {
    const sender = message.sender;
    if (viewerKey !== undefined && sender?.name && sender.id !== viewerKey) return sender.name;
    return peerLine(message)?.name ?? t("chat.you");
  }
  return message.from?.name ?? fallback ?? t("chat.assistant");
}
