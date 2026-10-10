/** Friendly display for legacy untitled records; never rewrites saved titles. */
export function conversationTitle(title: string | undefined): string {
  return !title || title === "New thread" || title === "New task" ? "New conversation" : title;
}
