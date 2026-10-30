import { t } from "./i18n";
import { MAUS_COLORS, type MausColor } from "./mascot";
import { isMentionBoundary, isMentionNameContinuation } from "../../shared/mention-boundary";

export type MentionPeer = { name: string; hidden?: boolean; color?: MausColor };
export type MentionRange = { start: number; end: number; color?: string };

export interface MentionQuery { start: number; end: number; query: string }

/** Search only the mention being edited, never an email, URL, or selection. */
export function mentionQueryAt(text: string, caret: number, selectionEnd = caret): MentionQuery | null {
  if (caret !== selectionEnd || caret < 0 || caret > text.length) return null;
  const before = text.slice(0, caret);
  const start = before.lastIndexOf("@");
  if (start < 0 || !isMentionBoundary(text, start)) return null;
  const query = before.slice(start + 1);
  if (query.length > 128 || /[\r\n@]/u.test(query)) return null;
  return { start, end: caret, query };
}

/** Complete the edited name without losing later text or doubling spaces. */
export function replaceMentionQuery(text: string, query: MentionQuery, name: string) {
  const existing = mentionRanges(text, [{ name }]).find((range) => range.start === query.start && range.end >= query.end);
  const end = existing?.end ?? query.end + (text.slice(query.end).match(/^[\p{L}\p{N}\p{M}_-]*/u)?.[0].length ?? 0);
  const after = text.slice(end);
  const space = after ? "" : " ";
  const inserted = `@${name}${space}`;
  return { text: text.slice(0, query.start) + inserted + after, start: query.start, end, inserted,
    caret: query.start + inserted.length + (after.startsWith(" ") ? 1 : 0) };
}

/** Filter the composer's mention roster without silently truncating it.
 * Large rooms stay fully reachable; the picker itself owns scrolling. */
export function mentionChoicesForQuery<T extends { name: string }>(pool: readonly T[], query: string): T[] {
  const normalized = query.trim().toLowerCase();
  // "@Scout " is a completed tag, not a new search. Closing here lets Enter
  // send instead of selecting the same bot again.
  if (/\s$/u.test(query) && pool.some((choice) => typeof choice.name === "string" && choice.name.toLowerCase() === normalized)) return [];
  return pool.filter((choice) => typeof choice.name === "string" && (!normalized || choice.name.toLowerCase().includes(normalized)));
}

/** Second line of a mention row. A bot shows its title. @everyone shows how
 * many bots that tag reaches. Filtering stays on the name alone. */
export type MentionRowDetail =
  | { kind: "bot"; title: string }
  | { kind: "everyone"; count: number };

export function mentionRowDescription(detail: MentionRowDetail): string {
  switch (detail.kind) {
    case "bot":
      return detail.title.trim();
    case "everyone":
      return detail.count === 1
        ? t("composer.mention.everyoneOne")
        : t("composer.mention.everyoneMany", { count: detail.count });
    default: {
      const unreachable: never = detail;
      return unreachable;
    }
  }
}

/** Display word-start, longest-name matches without coloring Unicode prefixes.
 * Keep offsets in the original string so casing and Unicode remain intact. */
export function mentionRanges(text: string, peers: readonly MentionPeer[], everyone = false): MentionRange[] {
  const candidates = peers.filter((p) => !p.hidden && typeof p.name === "string" && p.name.trim())
    .sort((a, b) => b.name.length - a.name.length);
  const ranges: MentionRange[] = [];
  let at = -1;
  while ((at = text.indexOf("@", at + 1)) !== -1) {
    if (!isMentionBoundary(text, at)) continue;
    const rest = text.slice(at + 1);
    const peer = candidates.find(({ name }) => rest.slice(0, name.length).toLowerCase() === name.toLowerCase()
      && !isMentionNameContinuation(rest.slice(name.length)));
    const all = everyone && rest.slice(0, 8).toLowerCase() === "everyone"
      && !isMentionNameContinuation(rest.slice(8));
    const length = all ? 8 : peer?.name.length;
    if (length === undefined) continue;
    // Only palette values enter CSS. @everyone has no individual bot identity.
    const color = !all && peer?.color && Object.hasOwn(MAUS_COLORS, peer.color) ? MAUS_COLORS[peer.color] : undefined;
    ranges.push({ start: at, end: at + length + 1, ...(color ? { color } : {}) });
    at += length;
  }
  return ranges;
}

type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  data?: { hName: string; hProperties: { className: string; style?: string } };
};

/** Transform text nodes only: links, code and image metadata stay untouched. */
export function remarkMentions({ peers, everyone = false }: { peers: readonly MentionPeer[]; everyone?: boolean }) {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if (!node.children || ["link", "linkReference", "code", "inlineCode"].includes(node.type)) return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== "text" || !child.value) { visit(child); return [child]; }
        const text = child.value;
        const ranges = mentionRanges(text, peers, everyone);
        if (!ranges.length) return [child];
        const result: MarkdownNode[] = [];
        let end = 0;
        for (const range of ranges) {
          if (range.start > end) result.push({ type: "text", value: text.slice(end, range.start) });
          result.push({ type: "mention", data: { hName: "span", hProperties: {
            // in a message (never the editor's mirror) a mention is a chip
            className: "mention-highlight mention-chip",
            ...(range.color ? { style: `--mention-color:${range.color}` } : {}),
          } },
            children: [{ type: "text", value: text.slice(range.start, range.end) }] });
          end = range.end;
        }
        if (end < text.length) result.push({ type: "text", value: text.slice(end) });
        return result;
      });
    };
    visit(tree);
  };
}
