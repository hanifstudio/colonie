/** A built-in command, or one of the bot's guides by name. */
export type ComposerSlashCommandId = "learn" | "setup" | `guide:${string}`;

export interface ComposerSlashCommand {
  id: ComposerSlashCommandId;
  label: string;
  description: string;
}

/** What picking a command leaves in the draft. A guide becomes a plain
 * request to use it, in the person's own words, which they can still edit;
 * the bot reads the guide (read_skill) because its index names it. */
export function slashReplacement(id: ComposerSlashCommandId): string {
  if (id === "learn") return "/learn ";
  if (id === "setup") return "/setup ";
  return `Use your guide "${id.slice("guide:".length)}": `;
}

export interface ComposerSlashTrigger {
  query: string;
  start: number;
  end: number;
}

/** Slash commands configure the whole send, so they are offered only at the
 * beginning of a draft and only while the first token is being typed. */
export function composerSlashTrigger(text: string, caretInput: number): ComposerSlashTrigger | null {
  const caret = Math.max(0, Math.min(text.length, Math.floor(caretInput)));
  const prefix = text.slice(0, caret);
  const match = /^\/([a-z0-9-]*)$/i.exec(prefix);
  if (!match) return null;
  return { query: match[1] ?? "", start: 0, end: caret };
}

/** Replace the active slash token and return the caret position immediately
 * after the inserted text. */
export function replaceComposerSlashTrigger(
  text: string,
  trigger: ComposerSlashTrigger,
  replacement: string,
): { text: string; caret: number } {
  const next = `${text.slice(0, trigger.start)}${replacement}${text.slice(trigger.end)}`;
  return { text: next, caret: trigger.start + replacement.length };
}
