// A bot that finishes a piece of work usually says where it put it: "I saved the plan in budget.md".
// Only a Markdown link turns that into a file the group can open, and bots forget to write one. So when an
// answer names a file that really is in the group's project folder, the first mention becomes the link.
// The folder is the proof: a name that is not a listed file is never touched, so prose and examples stay prose.

const NAME_LIMIT = 200;
const FILE_NAME = /^[\w][\w.-]*\.[A-Za-z0-9]{1,8}$/;

/** Turn the first plain or backticked mention of each listed file into `[name](path)`.
 * Mentions inside code fences, inside an existing link, or inside a URL are left alone; a bare name
 * that two listed files share is skipped, since it is not clear which one was meant. */
export function linkNamedFiles(text: string, files: readonly string[]): string {
  const usable = files.filter((path) => path.length <= NAME_LIMIT && path.split("/").every((part) => FILE_NAME.test(part) || /^[\w.-]+$/.test(part)) && FILE_NAME.test(path.split("/").at(-1)!));
  if (!usable.length || !text) return text;
  const byBase = new Map<string, string[]>();
  for (const path of usable) { const base = path.split("/").at(-1)!; byBase.set(base, [...(byBase.get(base) ?? []), path]); }
  // what each name stands for: the full path always; the bare name only when it is unique
  const targets = new Map<string, string>();
  for (const path of usable) if ((byBase.get(path.split("/").at(-1)!)?.length ?? 0) === 1 || path.includes("/")) targets.set(path, path);
  for (const [base, paths] of byBase) if (paths.length === 1 && !targets.has(base)) targets.set(base, paths[0]!);
  const names = [...targets.keys()].sort((a, b) => b.length - a.length);
  const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // outside fences; a name between ` ` or standing alone, not glued to other word characters or a path
  const mention = new RegExp(`(^|[\\s(\\["'“])(\`?)(${escaped.join("|")})(\`?)(?=$|[\\s)\\]"'”,;:!?]|\\.(?:$|[\\s)\\]"'”]))`, "g");
  const done = new Set<string>();
  return text.split(/(```[\s\S]*?```)/g).map((part, index) => {
    if (index % 2 === 1) return part;
    return part.replace(mention, (whole, before: string, tickOpen: string, name: string, tickClose: string, offset: number) => {
      const path = targets.get(name)!;
      if (done.has(path) || Boolean(tickOpen) !== Boolean(tickClose)) return whole;
      // already inside a link's text or a link/url target
      const head = part.slice(0, offset + before.length);
      if (/\]\([^)\s]*$/.test(head) || /\[[^\]\n]*$/.test(head) || /https?:\/\/\S*$/.test(head)) return whole;
      done.add(path);
      return `${before}[${name}](${path})`;
    });
  }).join("");
}
