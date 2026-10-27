// Shell commands an agent may not run in this repo, whichever tool drives it.
// Claude Code calls this as a PreToolUse hook (.claude/settings.json); OpenCode
// calls commandProblem from .opencode/plugins/guard.js. Text matching is a
// net for mistakes, not a sandbox: a determined workaround can pass it, which
// is why the commit hook and CI stand behind it.

const SEP = String.raw`[^;&|\n]*`;
const TEMP_ROOTS = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/"];

const RULES = [
  [new RegExp(String.raw`\bgit\b${SEP}\bpush\b${SEP}(?:--(?:force(?:-with-lease|-if-includes)?|delete|mirror)\b|\s-[a-zA-Z]*[fd](?=\s|$)|\s[+:]\S)`), "force pushes and remote ref deletion are not allowed."],
  [/\bgh\s+(pr\s+(create|merge)|release\s+create|repo\s+(edit|delete|create))\b/, "publishing to GitHub is the owner's step."],
  [/--no-verify\b/, "skipping the commit hook is not allowed; fix what it reports."],
  [new RegExp(String.raw`\bgit\b${SEP}\bcommit\b${SEP}\s-[a-zA-Z]*n`), "git commit -n skips the commit hook; fix what it reports."],
  [/core\.hooksPath\s*(=|\s+)(?!scripts\/git-hooks\b)[^\s;&|]/i, "the commit hook location is fixed (scripts/git-hooks)."],
  [/--unset\S*\s+core\.hooksPath/i, "the commit hook location is fixed (scripts/git-hooks)."],
  [/(~|\$\{?HOME\}?|\/Users\/[^/\s]+)\/\.colonie(-workspaces)?(?![-\w])/, "that is the owner's real Colonie data; use a throwaway folder (docs/verification/README.md).", true],
  [/\.codex\/auth\.json|\.claude\/\.credentials|\/\.ssh\/|\/\.aws\/|\bsecurity\s+find-(generic|internet)-password\b/, "credentials are never read.", true],
];

/** Why a recursive rm is refused: a target outside the repo that is not a temp folder. */
function recursiveRemoveProblem(command) {
  for (const part of command.split(/[;&|\n]+/)) {
    const words = part.trim().split(/\s+/);
    const at = words.findIndex((word) => word === "rm" || word.endsWith("/rm"));
    if (at < 0) continue;
    const args = words.slice(at + 1);
    if (!args.some((arg) => /^-[a-zA-Z]*[rR]/.test(arg) || arg === "--recursive")) continue;
    for (const target of args.filter((arg) => !arg.startsWith("-")).map((arg) => arg.replace(/^["']|["']$/g, ""))) {
      const temp = TEMP_ROOTS.some((root) => target.startsWith(root)) || /^\$\{?TMPDIR\b/.test(target);
      const outside = target.startsWith("/") || target.startsWith("~") || /^\$\{?(HOME|PWD)\b/.test(target)
        || target.split("/").includes("..") || ["", ".", "*", "./*"].includes(target);
      if (outside && !temp) return `rm -r on ${target}: only temp folders and paths inside the repo may be removed recursively.`;
    }
  }
  return null;
}

/** The reason a shell command is refused, or null when it may run. */
export function commandProblem(command) {
  // Flags are read with quoted text blanked out, so a commit message that
  // mentions "-n" is not a flag; paths are read in full, quotes included.
  // The body of a heredoc is text, not a command; a commit message fed with
  // `git commit -F -` is read by neither kind of rule. A heredoc fed to a
  // shell is commands, so it is read in full.
  const toShell = /\b(ba|z|da|k)?sh\b[^\n|;&]*<</.test(command);
  const unheredoc = toShell ? command : command.replace(/(<<-?\s*['"]?(\w+)['"]?[^\n]*\n)[\s\S]*?\n\2[ \t]*(?=\n|$)/g, "$1$2");
  const full = /\bgit\b[^\n]*\bcommit\b[^\n]*-F\s*-/.test(command) ? unheredoc : command;
  const bare = unheredoc.replace(/'[^']*'|"[^"]*"/g, "''");
  for (const [pattern, reason, quoted] of RULES) if (pattern.test(quoted ? full : bare)) return reason;
  return recursiveRemoveProblem(unheredoc);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const command = JSON.parse(input || "{}")?.tool_input?.command ?? "";
  const problem = commandProblem(command);
  if (problem) {
    // Exit code 2 blocks the call; stderr goes back to the model as the reason.
    console.error(`Blocked by scripts/agent-guard.mjs: ${problem}`);
    process.exit(2);
  }
}
